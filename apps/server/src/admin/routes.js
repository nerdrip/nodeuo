// Admin REST API route table. Pure functions: each entry exposes
// `{ method, path, run({ req, params, query, body }) }` and the
// admin-server dispatches on it. Returning a value auto-serializes to
// JSON; returning undefined signals the handler already wrote the
// response (rare — used for binary downloads / streams).
//
// Every route is gated by the admin-server session middleware. Mutations also
// require a same-origin Origin/Referer header.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { composePaperdoll } from './paperdoll.js';
import { scheduleRefreshSurroundings } from '../net/handlers.js';
import { landProvider } from '../world/land-provider.js';
import { tileDataTable, resolveStandingZ } from '../world/movement.js';
import { invalidateLosCache } from '../world/los.js';
import { destroyItem } from '../world/items.js';
import { extMapTileEdit, NODEUO_CAPABILITIES_CURRENT, NodeUOCapability } from '@uo/protocol';
import { AI_GRAPH_NODE_TYPES } from '../world/ai-graphs.js';
import { simulateCombat } from '../systems/combat-simulator.js';
import { animationBodySnapshot, animationFramePng, validateMonsterAnimations } from './animation-catalog.js';
import { staticArtPng, staticArtStatus } from './static-art.js';
import {
  regionDiagnostics, simulateSpawnerDraft, spawnerDiagnostics, spawnerHeatmap, validateLootDraft, validateQuestDraft,
  validateRegionDraft, validateSpawnerDraft,
} from './world-authoring.js';
import * as operational from '../systems/operational-diagnostics.js';
import { CURRENT_SNAPSHOT_VERSION, migrateSnapshot, planSnapshotMigration } from '../world/persistence-migrations.js';
import { buildServerQualityReport, runtimeGovernor } from '../systems/runtime-governor.js';

export function buildHandlers({ sharedCtx, scriptRuntime, scriptsDir, saveDir, persistence, accounts }) {
  const world = sharedCtx?.world;
  const mapProvider = sharedCtx?.landProvider ?? landProvider;
  const undoableAuditMutations = new Map();
  let nextUndoMutationId = 0;

  function registerUndoableMutation(actor, kind, payload) {
    const id = `undo-${Date.now().toString(36)}-${(++nextUndoMutationId).toString(36)}`;
    undoableAuditMutations.set(id, { id, actor: String(actor ?? '').toLowerCase(), kind,
      createdAt: Date.now(), usedAt: 0, ...payload });
    for (const [key, entry] of undoableAuditMutations) {
      if (undoableAuditMutations.size <= 256 && Date.now() - entry.createdAt <= 60 * 60_000) break;
      undoableAuditMutations.delete(key);
    }
    return id;
  }

  function queryInt(query, name, fallback, min, max) {
    const text = query?.get?.(name);
    const raw = text == null || text === '' ? Number.NaN : Number(text);
    const value = Number.isFinite(raw) ? Math.trunc(raw) : fallback;
    return Math.max(min, Math.min(max, value));
  }

  /** Resolve the admin's character mobile(s). Returns array sorted by
   *  slot. Used by every "teleport me" flow so the server picks the
   *  character from the logged-in account, not from a UI-passed serial.
   *
   *  Lookup chain (first hit wins):
   *    1. account.characters[] entries — only populated AFTER the player
   *       finished a CharCreate / CharSelect cycle. Brand-new admin
   *       accounts that only ever logged in via the panel have this
   *       empty.
   *    2. live mobile with matching `mob.accountName` — covers
   *       accounts that played in-game once (mob is stamped at login)
   *       even when the character slot wasn't persisted yet.
   *    3. ANY player-flag mobile owned by an Admin (catches dev / GM
   *       accounts that haven't been bound to an account yet).
   *  We always rank online characters first so prompts default to
   *  whatever the admin is actively playing. */
  function adminCharacters(sessionAccount, preferredSlot) {
    if (!sessionAccount) return [];
    const out = [];
    const seen = new Set();
    const lower = String(sessionAccount).toLowerCase();
    // Path 1 — explicit character slots on the account.
    const acc = accounts?.accounts?.get?.(lower);
    if (acc) {
      for (let i = 0; i < (acc.characters?.length ?? 0); i++) {
        const c = acc.characters[i];
        if (!c) continue;
        const mob = world?.mobiles?.get?.(c.mobileSerial >>> 0);
        out.push({
          slot: i, name: c.name ?? mob?.name ?? '?',
          mobileSerial: c.mobileSerial, mob, online: !!mob?.client,
        });
        seen.add(c.mobileSerial >>> 0);
      }
    }
    // Path 2 — scan world.mobiles for any mob carrying this account name.
    // Helps the very common "I logged in once via the bat, never via
    // CharCreate, but my mob still exists" edge case.
    let seq = out.length;
    for (const mob of (world?.mobiles?.values?.() ?? [])) {
      if (seen.has(mob.serial >>> 0)) continue;
      if (!mob.isPlayer) continue;
      if (String(mob.accountName ?? '').toLowerCase() !== lower) continue;
      out.push({
        slot: seq++, name: mob.name ?? '?',
        mobileSerial: mob.serial >>> 0, mob, online: !!mob.client,
      });
      seen.add(mob.serial >>> 0);
    }
    // Sort online-first so the picker default + auto-tp picks the
    // currently-logged-in character.
    out.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
    if (Number.isFinite(preferredSlot)) {
      const found = out.find((c) => c.slot === preferredSlot);
      if (found) return [found];
    }
    return out;
  }

  const routes = [];
  const repoRoot = path.resolve(scriptsDir, '../../..');
  const featureFile = path.join(saveDir, 'admin-feature-flags.json');
  const alertFile = path.join(saveDir, 'admin-alert-thresholds.json');
  const preferencesFile = path.join(saveDir, 'admin-preferences.json');
  const readJsonState = (file, fallback) => { try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return structuredClone(fallback); } };
  const writeJsonState = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); };
  let featureFlags = readJsonState(featureFile, { revision: 1, flags: {} });
  let alertThresholds = readJsonState(alertFile, { eventLoopLagMs: 100, tickMs: 50, memoryMB: 2048, protocolErrors: 10, parserErrors: 5 });
  let administratorPreferences = readJsonState(preferencesFile, { users: {} });
  const testJobs = new Map();
  const adminClientMetrics = new Map();
  let testJobSequence = 0;

  // ---- Unified content studio ------------------------------------------
  // One metadata catalogue powers dedicated visual editors without copying
  // persistence logic into twenty different pages. Every entry points at the
  // canonical JSON source used by gameplay scripts; writes still go through
  // /api/data-tree/file (backup + optimistic mtime check + optional reload).
  const studioDomains = [
    { id:'mobiles', label:'Mobiles & AI', icon:'🐉', files:['config/monsters.json','config/npcs.json'], preview:'mobile', tags:['body','hue','stats','skills','ai','equipment','loot','resists','mount','pet'] },
    { id:'items', label:'Items', icon:'⚔️', files:['config/items.json','config/item-types.json','config/magic-properties.json'], preview:'item', tags:['art','hue','layer','amount','weight','flags','durability','container','scripts'] },
    { id:'multis', label:'Multis, houses & boats', icon:'🏰', files:['config/housedata.json','world/addons.json','world/addons.generated.json'], preview:'multi', tags:['footprint','house','boat','addon'] },
    { id:'links', label:'Doors, signs & teleporters', icon:'🚪', files:['world/signs.json','world/teleporters.json'], preview:'link', tags:['door','sign','teleporter','links'] },
    { id:'vendors', label:'Vendors & rentals', icon:'🛒', files:['config/vendor-inventory.json','config/store-catalogue.json','world/regional-npcs.json','world/spawns/magincia-bazaar.json'], preview:'vendor', tags:['buy','sell','price','stock','restock','rental'] },
    { id:'crafting', label:'Crafting', icon:'🛠️', files:['config/recipes.json','config/magincia-recipes.json'], preview:'craft', tags:['profession','recipe','requirements','materials','chance','result','dependencies'] },
    { id:'skills', label:'Skills', icon:'📈', files:['config/skills.json'], preview:'skill', tags:['id','cap','gain','handler'] },
    { id:'spells', label:'Spells', icon:'✨', files:['config/spells.json','config/reagents.json'], preview:'spell', tags:['circle','mana','reagents','target','effect','lifecycle'] },
    { id:'combat', label:'Combat & abilities', icon:'🛡️', files:['config/monsters.json','config/items.json','config/poison-levels.json'], preview:'combat', tags:['weapon','speed','damage','ability','requirements','resists'] },
    { id:'loot', label:'Loot tables', icon:'💎', files:['config/loot-tables.json','config/loot-packs.json','world/artifacts.json','world/eodon-artifacts.json'], preview:'loot', tags:['nested','weight','simulation','drop'] },
    { id:'quests', label:'Quests & dialogue', icon:'📜', files:['world/quest-chains.json','world/quests-extracted.json','world/quest-reward-items.json'], preview:'quest', tags:['graph','step','condition','dialog','reward'] },
    { id:'books', label:'Books, BOD & collections', icon:'📚', files:['world/books-extended.json','world/books.servuo.generated.json','world/anniversary-tiers.json'], preview:'book', tags:['book','bod','collection','achievement'] },
    { id:'environment', label:'Weather, seasons & events', icon:'🌦️', files:['world/seasonal-events.json','world/camps.json','world/revamped-dungeons.json'], preview:'environment', tags:['weather','season','day','night','calendar','scheduler'] },
    { id:'world', label:'Regions & world design', icon:'🗺️', files:['world/decorations.json','world/decoratives.json','world/xmlspawners.json'], preview:'world', tags:['region','geometry','guards','music','spawner'] },
    { id:'gumps', label:'Gumps & layouts', icon:'🪟', files:['config/servuo-p2-admin-parity.json'], preview:'gump', tags:['layout','overflow','dialog','client-preview'] },
    { id:'commands', label:'Commands & ACL', icon:'⌨️', files:['config/servuo-p2-admin-parity.json'], preview:'command', tags:['acl','alias','help','duplicate'] },
    { id:'create', label:'Create catalogue', icon:'➕', files:['config/items.json','config/monsters.json','config/housedata.json'], preview:'create', tags:['item','mobile','mount','multi','favorite','recent'] },
  ];

  routes.push({
    method: 'GET', path: '/api/studio/catalog',
    run: () => ({
      domains: studioDomains.map((domain) => ({
        ...domain,
        files: domain.files.filter((rel) => fs.existsSync(path.join(scriptsDir, 'data', rel))),
      })),
      capabilities: {
        drafts: true, optimisticConcurrency: true, diffPreview: true,
        undoRedo: true, importExport: true, bulkEdit: true, liveReload: !!scriptRuntime,
      },
    }),
  });
  routes.push({
    method: 'POST', path: '/api/studio/sandbox/spell',
    run: ({ body }) => {
      const spell = body?.spell;
      if (!spell || Array.isArray(spell) || typeof spell !== 'object') return { error: 'spell object required' };
      const errors = [], warnings = [];
      const words = String(spell.words ?? spell.mantra ?? '').trim();
      const mana = Number(spell.mana ?? spell.manaCost);
      const castMs = Number(spell.delayMs ?? spell.castTimeMs ?? spell.castTime ?? 0);
      const requiresTarget = spell.requiresTarget === true || /object|mobile|item|point|target/i.test(String(spell.target ?? spell.targetKind ?? ''));
      const target = String(spell.target ?? spell.targetKind ?? (requiresTarget ? '' : 'self')).trim();
      if (!words) errors.push({ field: 'words', message: 'missing words/mantra' });
      if (!Number.isFinite(mana) || mana < 0) errors.push({ field: 'mana', message: 'mana cost must be a non-negative number' });
      if (!Number.isFinite(castMs) || castMs < 0 || castMs > 120_000) errors.push({ field: 'castTime', message: 'cast time must be between 0 and 120 seconds' });
      if (requiresTarget && !target) errors.push({ field: 'target', message: 'target kind is required' });
      const all = sharedCtx?.systems?.spells?.allSpells?.() ?? [];
      const id = Number(spell.id ?? spell.spellId);
      const registered = all.find((entry) => (Number.isFinite(id) && entry.id === id)
        || (spell.name && String(entry.name).toLowerCase() === String(spell.name).toLowerCase()));
      if (!registered) warnings.push('No matching live runtime spell; preview validates the authored record only.');
      else {
        if (Number.isFinite(mana) && Number.isFinite(registered.mana) && mana !== registered.mana) warnings.push(`Runtime mana is ${registered.mana}.`);
        if (requiresTarget !== !!registered.requiresTarget) warnings.push(`Runtime target mode is ${registered.requiresTarget ? 'targeted' : 'untargeted'}.`);
      }
      return {
        ok: errors.length === 0, safe: true, executed: false, errors, warnings,
        matchedRuntime: registered ? { id: registered.id, name: registered.name, school: registered.school, mana: registered.mana,
          minSkill: registered.minSkill, delayMs: registered.delayMs, requiresTarget: !!registered.requiresTarget } : null,
        lifecycle: [
          { stage: 'incantation', atMs: 0, detail: words || '(missing)' },
          { stage: 'cast-delay', atMs: 0, durationMs: Number.isFinite(castMs) ? castMs : 0 },
          { stage: 'target', atMs: Number.isFinite(castMs) ? castMs : 0, detail: target || '(missing)' },
          { stage: 'resource-debit', atMs: Number.isFinite(castMs) ? castMs : 0, mana: Number.isFinite(mana) ? mana : null },
          { stage: 'effect', atMs: Number.isFinite(castMs) ? castMs : 0, detail: String(spell.effect ?? spell.handler ?? registered?.name ?? 'effect') },
        ],
      };
    },
  });
  routes.push({
    method: 'GET', path: '/api/studio/art/:itemId',
    run: async ({ params, res }) => {
      const itemId = parseSerial(params.itemId);
      const png = await staticArtPng(itemId);
      if (!png) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'static art not found', ...staticArtStatus(itemId) }));
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(png);
      return undefined;
    },
  });

  routes.push({
    method: 'GET', path: '/api/preferences',
    run: ({ session }) => ({ preferences: administratorPreferences.users?.[String(session?.account ?? '').toLowerCase()] ?? {} }),
  });
  routes.push({
    method: 'PUT', path: '/api/preferences',
    run: ({ session, body }) => {
      const account = String(session?.account ?? '').toLowerCase();
      if (!account) return { error: 'session account missing' };
      const preferences = body?.preferences;
      if (!preferences || Array.isArray(preferences) || typeof preferences !== 'object') return { error: 'preferences object required' };
      const text = JSON.stringify(preferences); if (text.length > 100_000) return { error: 'preferences exceed 100 KB' };
      administratorPreferences.users ??= {}; administratorPreferences.users[account] = JSON.parse(text);
      writeJsonState(preferencesFile, administratorPreferences);
      return { ok: true, preferences: administratorPreferences.users[account] };
    },
  });

  // ---- Operational readiness -------------------------------------------
  routes.push({ method: 'GET', path: '/api/operations/protocol', run: () => operational.protocolSnapshot() });
  routes.push({ method: 'GET', path: '/api/operations/compatibility', run: () => operational.compatibilitySnapshot() });
  routes.push({ method: 'GET', path: '/api/operations/runtime', run: () => operational.runtimeSnapshot() });
  routes.push({ method: 'GET', path: '/api/health/live', run: () => ({ live: runtimeGovernor.health.snapshot().live }) });
  routes.push({ method: 'GET', path: '/api/health/ready', run: () => runtimeGovernor.health.snapshot() });
  routes.push({ method: 'GET', path: '/api/operations/profile', run: ({ query }) => operational.runtimeSnapshot(queryInt(query, 'windowMs', 60_000, 1000, 300_000)) });
  routes.push({ method: 'GET', path: '/api/operations/runtime-governor', run: () => ({
    health: runtimeGovernor.health.snapshot(),
    queues: { visibility: runtimeGovernor.visibility.snapshot(), background: runtimeGovernor.background.snapshot() },
    cache: runtimeGovernor.visibilityCache.snapshot(),
    watchdog: runtimeGovernor.watchdog.snapshot(),
    lifecycle: runtimeGovernor.lifecycle.stats(),
  }) });
  routes.push({ method: 'GET', path: '/api/operations/quality-report', run: () => buildServerQualityReport({
    world, diagnostics: operational, commands: sharedCtx?.commands?.list?.({ includeHidden: true }) ?? [], scripts: scriptRuntime,
  }) });
  routes.push({
    method: 'POST', path: '/api/operations/client-metrics',
    run: ({ body, session }) => {
      const account = String(session?.account ?? 'unknown').toLowerCase();
      const previous = adminClientMetrics.get(account) ?? {};
      const next = { ...previous, account, at: Date.now(), view: String(body?.view ?? previous.view ?? '').slice(0, 160) };
      for (const key of ['mapChunkMs', 'mapFetchMs', 'mapDecodeMs', 'tableRows']) {
        if (body?.[key] == null) continue;
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1_000_000) return { error: `${key} must be a bounded non-negative number` };
        next[key] = value;
      }
      adminClientMetrics.set(account, next);
      return { ok: true, metrics: next };
    },
  });
  routes.push({
    method: 'GET', path: '/api/operations/events',
    run: ({ query }) => {
      const filter = String(query.get('filter') ?? '').toLowerCase(), level = String(query.get('level') ?? '').toLowerCase(), event = String(query.get('event') ?? '').toLowerCase();
      const entries = operational.structuredSnapshot(2000).filter((entry) => (!filter || JSON.stringify(entry).toLowerCase().includes(filter))
        && (!level || String(entry.level).toLowerCase() === level) && (!event || String(entry.event).toLowerCase().includes(event)))
        .slice(0, queryInt(query, 'limit', 200, 1, 2000));
      return { entries, filter, level, event };
    },
  });
  routes.push({ method: 'GET', path: '/api/operations/commands', run: () => sharedCtx?.commands?.usageSnapshot?.() ?? { commands: [] } });
  routes.push({
    method: 'GET', path: '/api/operations/audit',
    run: ({ query }) => {
      const q = String(query.get('q') ?? '').trim().toLowerCase();
      const kind = String(query.get('kind') ?? '').trim().toLowerCase();
      const actor = String(query.get('actor') ?? '').trim().toLowerCase();
      const target = String(query.get('target') ?? '').trim().toLowerCase();
      const okText = String(query.get('ok') ?? '').trim().toLowerCase();
      const entries = operational.auditSnapshot(2000).filter((entry) => {
        if (kind && !String(entry.kind ?? '').toLowerCase().includes(kind)) return false;
        if (actor && !String(entry.actor ?? '').toLowerCase().includes(actor)) return false;
        if (target && !String(entry.target ?? '').toLowerCase().includes(target)) return false;
        if (okText && String(!!entry.ok) !== okText) return false;
        return !q || JSON.stringify(entry).toLowerCase().includes(q);
      }).slice(0, queryInt(query, 'limit', 200, 1, 2000));
      return { entries, filters: { q, kind, actor, target, ok: okText } };
    },
  });
  routes.push({
    method: 'POST', path: '/api/operations/audit/:id/undo',
    run: ({ params, session }) => {
      const mutation = undoableAuditMutations.get(String(params.id));
      if (!mutation) return { error: 'undo operation not found or expired' };
      if (mutation.usedAt) return { error: 'undo operation was already consumed', conflict: true };
      if (mutation.actor && mutation.actor !== String(session?.account ?? '').toLowerCase()) {
        return { error: 'undo operation belongs to another administrator', conflict: true };
      }
      if (mutation.kind !== 'statics.batch') return { error: 'mutation kind is not undoable' };
      const create = sharedCtx?.items?.createItem;
      const destroy = sharedCtx?.items?.destroyItem;
      if (!create || !destroy) return { error: 'item mutation API unavailable' };
      const createdStillPresent = mutation.createdSerials.map((serial) => world.items.get(serial)).filter(Boolean);
      if (createdStillPresent.length !== mutation.createdSerials.length) {
        return { error: 'world changed since this operation; reload before undo', conflict: true };
      }
      const restored = [];
      try {
        for (const snapshot of mutation.removedSnapshots) {
          const item = create(world, snapshot);
          if (snapshot.isDecoration) item.isDecoration = true;
          if (snapshot.script != null) item.script = snapshot.script;
          world.syncSpatialItem?.(item);
          restored.push(item);
        }
      } catch (error) {
        for (const item of restored) { try { destroy(world, item.serial); } catch {} }
        return { error: `undo rolled back: ${error?.message ?? error}` };
      }
      for (const item of createdStillPresent) destroy(world, item.serial);
      mutation.usedAt = Date.now();
      try { invalidateLosCache(); } catch { /* advisory */ }
      for (const mobile of world.onlineMobiles?.() ?? []) {
        if ((mobile.map | 0) !== (mutation.facet | 0) || !mobile.client) continue;
        try { sharedCtx?.refreshSurroundings?.(mobile.client); } catch { /* socket race */ }
      }
      return { ok: true, undoId: mutation.id, restored: restored.length,
        removed: createdStillPresent.length, before: { mutation: mutation.id },
        after: { restoredSerials: restored.map((item) => item.serial >>> 0) } };
    },
  });
  routes.push({
    method: 'POST', path: '/api/operations/integrity',
    run: () => operational.scanWorldIntegrity(world, { spawner: sharedCtx?.spawner }),
  });
  routes.push({
    method: 'POST', path: '/api/operations/save-check',
    run: async ({ body }) => {
      let saved = null;
      if (body?.saveFirst && persistence?.requestSave) saved = await persistence.requestSave(world, saveDir);
      return { saved, verification: operational.verifySaveDirectory(saveDir) };
    },
  });
  routes.push({
    method: 'GET', path: '/api/operations/features',
    run: () => ({
      protocol: 'standard UO + negotiated nodeuo.v1',
      currentMask: NODEUO_CAPABILITIES_CURRENT,
      capabilities: Object.entries(NodeUOCapability).map(([name, bit]) => ({ name, bit, enabled: (NODEUO_CAPABILITIES_CURRENT & bit) === bit })),
      server: {
        huffmanOutgoing: !!sharedCtx?.config?.huffmanOutgoing,
        protocolMode: sharedCtx?.config?.protocolMode,
        scriptWatch: /^(1|true|yes)$/i.test(String(process.env.UO_SCRIPT_WATCH ?? '')),
      },
    }),
  });
  routes.push({
    method: 'GET', path: '/api/operations/scripts',
    run: () => ({
      loaded: scriptRuntime?.loaded?.length ?? 0,
      profile: scriptRuntime?.profile ?? null,
      reloadHistory: scriptRuntime?.reloadHistory?.slice?.(-100)?.reverse?.() ?? [],
      files: (scriptRuntime?.loaded ?? []).filter((entry) => entry?.file)
        .map((entry) => path.relative(scriptsDir, entry.file).replace(/\\/g, '/')),
      commandCollisions: sharedCtx?.commands?.collisions?.map((entry) => ({ name: entry.name, aliasFor: entry.aliasFor })) ?? [],
      aiGraphs: sharedCtx?.aiGraphs?.list?.()?.length ?? 0,
    }),
  });
  routes.push({
    method: 'GET', path: '/api/operations/readiness',
    run: () => {
      const integrity = operational.scanWorldIntegrity(world, { spawner: sharedCtx?.spawner });
      const saves = operational.verifySaveDirectory(saveDir);
      const commands = sharedCtx?.commands?.usageSnapshot?.() ?? { collisions: [] };
      return {
        ok: integrity.ok && saves.ok && !(commands.collisions?.length),
        integrity: { ok: integrity.ok, counts: integrity.counts, scanned: integrity.scanned },
        saves,
        commands: { collisions: commands.collisions?.length ?? 0, errors: commands.commands?.reduce((sum, command) => sum + command.errors, 0) ?? 0 },
        network: operational.protocolSnapshot(),
        runtime: operational.runtimeSnapshot(),
        compatibility: operational.compatibilitySnapshot(),
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/operations/command-catalog',
    run: () => ({
      commands: (sharedCtx?.commands?.list?.({ includeHidden: false }) ?? []).map((command) => ({
        name: command.name, access: command.access ?? 'Admin', help: command.help ?? '',
        aliases: command.aliases ?? [], hidden: !!command.hidden,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      collisions: sharedCtx?.commands?.usageSnapshot?.().collisions ?? [],
    }),
  });

  routes.push({
    method: 'GET', path: '/api/operations/overview',
    run: () => {
      const runtime = operational.runtimeSnapshot();
      const network = operational.protocolSnapshot();
      const compatibility = operational.compatibilitySnapshot();
      const storage = storageSnapshot();
      const memory = process.memoryUsage();
      const aiTicks = runtime.ticks.filter((tick) => /ai|path|spawn/i.test(tick.name));
      const expensiveEntities = [...(sharedCtx?.ai?.diagnostics?.entries?.() ?? [])].map(([serial, diag]) => {
        const mobile = world?.mobiles?.get?.(serial >>> 0);
        return { serial: `0x${(serial >>> 0).toString(16)}`, name: mobile?.name ?? '', behavior: sharedCtx?.ai?.bindings?.get?.(serial)?.behavior ?? '', ...diag };
      }).sort((a, b) => (b.lastTickMs ?? 0) - (a.lastTickMs ?? 0)).slice(0, 50);
      return {
        runtime: { ...runtime, memory: Object.fromEntries(Object.entries(memory).map(([key, bytes]) => [key, bytes])),
          cpu: process.cpuUsage(), activeResources: process.getActiveResourcesInfo?.() ?? [] },
        network: { ...network, sessions: compatibility.sessions, pendingBytes: compatibility.sessions.reduce((sum, session) => sum + (session.pendingBytes ?? 0), 0) },
        scripts: { loaded: scriptRuntime?.loaded?.length ?? 0, collisions: sharedCtx?.commands?.collisions?.length ?? 0,
          profile: scriptRuntime?.profile ?? null, reloadHistory: scriptRuntime?.reloadHistory?.slice?.(-20)?.reverse?.() ?? [] },
        ai: { ticks: aiTicks, expensive: aiTicks.slice().sort((a, b) => b.maxMs - a.maxMs).slice(0, 20),
          expensiveEntities, bindings: sharedCtx?.ai?.bindings?.size ?? 0, scheduler: sharedCtx?.ai?.schedulerDiagnostics ?? null },
        storage,
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/operations/alerts',
    run: () => {
      const runtime = operational.runtimeSnapshot(), protocol = operational.protocolSnapshot(), memoryMB = process.memoryUsage().rss / 1048576;
      const active = [
        runtime.eventLoop.currentLagMs > alertThresholds.eventLoopLagMs && { key: 'event-loop', value: runtime.eventLoop.currentLagMs, threshold: alertThresholds.eventLoopLagMs, href: '#operations' },
        (runtime.ticks[0]?.maxMs ?? 0) > alertThresholds.tickMs && { key: 'tick', value: runtime.ticks[0]?.maxMs ?? 0, threshold: alertThresholds.tickMs, href: '#operations' },
        memoryMB > alertThresholds.memoryMB && { key: 'memory', value: Number(memoryMB.toFixed(1)), threshold: alertThresholds.memoryMB, href: '#operations' },
        protocol.protocolErrors > alertThresholds.protocolErrors && { key: 'protocol', value: protocol.protocolErrors, threshold: alertThresholds.protocolErrors, href: '#operations' },
      ].filter(Boolean);
      return { thresholds: alertThresholds, active, ok: active.length === 0 };
    },
  });
  routes.push({
    method: 'PUT', path: '/api/operations/alerts',
    run: ({ body }) => {
      for (const key of ['eventLoopLagMs', 'tickMs', 'memoryMB', 'protocolErrors', 'parserErrors']) {
        if (body?.[key] != null && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) return { error: `${key} must be a non-negative number` };
      }
      alertThresholds = { ...alertThresholds, ...Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => key in alertThresholds).map(([key, value]) => [key, Number(value)])) };
      writeJsonState(alertFile, alertThresholds);
      return { ok: true, thresholds: alertThresholds };
    },
  });

  const safeSaveFile = (name) => {
    const base = path.basename(String(name ?? ''));
    if (!base || base !== name || !/^[a-zA-Z0-9._-]+$/.test(base)) return null;
    const file = path.resolve(saveDir, base);
    return file.startsWith(path.resolve(saveDir) + path.sep) ? file : null;
  };
  const readSnapshotFile = (name) => {
    const file = safeSaveFile(name);
    if (!file || !fs.existsSync(file)) throw new Error('save file not found');
    const bytes = fs.readFileSync(file);
    const text = /\.gz(?:\.|$)/.test(name) ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
    return { file, bytes, snapshot: JSON.parse(text) };
  };
  const saveFiles = () => {
    try { return fs.readdirSync(saveDir, { withFileTypes: true }).filter((entry) => entry.isFile() && /\.json(?:\.gz)?(?:\.(?:bak|legacy|pre-(?:restore|migration)\.\d+))?$/.test(entry.name)).map((entry) => {
      const stat = fs.statSync(path.join(saveDir, entry.name));
      return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtimeMs, backup: /\.(?:bak|legacy|pre-restore\.)/.test(entry.name) };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt); } catch { return []; }
  };
  const storageSnapshot = () => {
    const files = saveFiles();
    let journal = null;
    try { journal = JSON.parse(fs.readFileSync(path.join(saveDir, 'save-journal.json'), 'utf8')); }
    catch (error) { journal = { status: 'unavailable', error: error.message }; }
    return {
      ...operational.verifySaveDirectory(saveDir),
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      latestModifiedAt: files[0]?.modifiedAt ?? null,
      journal,
      saves: persistence?.diagnostics?.(saveDir) ?? null,
    };
  };
  routes.push({ method: 'GET', path: '/api/backups', run: () => ({ saveDir, files: saveFiles() }) });
  routes.push({
    method: 'POST', path: '/api/backups/verify',
    run: ({ body }) => {
      try { const parsed = readSnapshotFile(String(body?.name ?? '')); return { ok: true, name: body.name, bytes: parsed.bytes.length, version: parsed.snapshot?.version ?? 0,
        records: { mobiles: parsed.snapshot?.mobiles?.length ?? 0, items: parsed.snapshot?.items?.length ?? 0 } }; }
      catch (error) { return { error: error.message, ok: false }; }
    },
  });
  routes.push({
    method: 'POST', path: '/api/backups/restore',
    run: ({ body }) => {
      const source = safeSaveFile(String(body?.source ?? ''));
      const inferred = String(body?.source ?? '').replace(/\.(?:bak|legacy|pre-restore\.\d+)$/, '');
      const targetName = String(body?.target ?? inferred);
      if (!/^(?:players|mobs|items|world|houses|bazaar|world-state)\.json(?:\.gz)?$/.test(targetName)) return { error: 'target is not an allowlisted canonical save file' };
      const target = safeSaveFile(targetName);
      if (!source || !fs.existsSync(source) || !target) return { error: 'source backup not found' };
      try { readSnapshotFile(path.basename(source)); } catch (error) { return { error: `source verification failed: ${error.message}` }; }
      const before = fs.existsSync(target) ? `${target}.pre-restore.${Date.now()}` : null;
      if (before) fs.copyFileSync(target, before);
      const temp = `${target}.restore.tmp`; fs.copyFileSync(source, temp); fs.renameSync(temp, target);
      return { ok: true, source: path.basename(source), target: targetName, rollback: before ? path.basename(before) : null, restartRequired: true };
    },
  });

  routes.push({
    method: 'GET', path: '/api/migrations/plan',
    run: ({ query }) => {
      const name = query.get('file') ?? saveFiles().find((file) => /^(?:world|players|mobs|items)\.json/.test(file.name) && !file.backup)?.name;
      if (!name) return {
        file: null,
        bytes: 0,
        available: false,
        dryRun: true,
        ...planSnapshotMigration({ version: CURRENT_SNAPSHOT_VERSION }),
      };
      try { const { snapshot, bytes } = readSnapshotFile(name); return { file: name, bytes: bytes.length, dryRun: true, ...planSnapshotMigration(snapshot) }; }
      catch (error) { return { error: error.message }; }
    },
  });
  routes.push({
    method: 'POST', path: '/api/migrations/apply',
    run: ({ body }) => {
      const name = String(body?.file ?? '');
      try {
        const { file, snapshot } = readSnapshotFile(name), result = migrateSnapshot(snapshot, { targetVersion: CURRENT_SNAPSHOT_VERSION });
        if (!result.plan.ok) return { error: result.plan.reason, plan: result.plan };
        if (!result.plan.steps.length) return { ok: true, unchanged: true, plan: result.plan };
        const backup = `${file}.pre-migration.${Date.now()}`; fs.copyFileSync(file, backup);
        const jsonText = JSON.stringify(result.snapshot); const output = name.includes('.gz') ? zlib.gzipSync(jsonText) : Buffer.from(jsonText);
        const temp = `${file}.migration.tmp`; fs.writeFileSync(temp, output); fs.renameSync(temp, file);
        return { ok: true, plan: result.plan, backup: path.basename(backup), bytes: output.length, restartRequired: true };
      } catch (error) { return { error: error.message }; }
    },
  });

  routes.push({ method: 'GET', path: '/api/feature-flags', run: () => featureFlags });
  routes.push({
    method: 'PUT', path: '/api/feature-flags',
    run: ({ body }) => {
      const name = String(body?.name ?? '').trim();
      if (!/^[a-z][a-z0-9._-]{1,63}$/.test(name)) return { error: 'invalid feature flag name' };
      const rollout = body?.rollout ?? {};
      featureFlags.flags[name] = {
        enabled: body?.enabled !== false, percent: Math.max(0, Math.min(100, Number(rollout.percent ?? 100))),
        accounts: [...new Set((Array.isArray(rollout.accounts) ? rollout.accounts : []).map(String))].slice(0, 1000),
        shards: [...new Set((Array.isArray(rollout.shards) ? rollout.shards : []).map(String))].slice(0, 100),
        nodeUOOnly: body?.nodeUOOnly !== false, description: String(body?.description ?? '').slice(0, 240), updatedAt: Date.now(),
      };
      featureFlags.revision = (featureFlags.revision | 0) + 1; writeJsonState(featureFile, featureFlags);
      return { ok: true, revision: featureFlags.revision, name, flag: featureFlags.flags[name] };
    },
  });

  routes.push({
    method: 'GET', path: '/api/operations/health',
    run: () => {
      const assets = ['static-atlas.json', 'land-atlas.json', 'anim-atlas.json'].map((name) => {
        const file = path.join(repoRoot, 'apps/client/public/assets', name); try { const stat = fs.statSync(file); JSON.parse(fs.readFileSync(file, 'utf8')); return { name, ok: true, bytes: stat.size }; } catch (error) { return { name, ok: false, error: error.message }; }
      });
      const checks = [
        { name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 20, detail: process.version },
        { name: 'scripts', ok: fs.existsSync(scriptsDir), detail: scriptsDir },
        { name: 'save directory', ok: fs.existsSync(saveDir), detail: saveDir },
        { name: 'world', ok: !!world?.mobiles && !!world?.items, detail: `${world?.mobiles?.size ?? 0} mobiles / ${world?.items?.size ?? 0} items` },
        ...assets,
      ];
      return { ok: checks.every((check) => check.ok), checks, assets };
    },
  });

  const testSuites = {
    'server-unit': { label: 'Server unit/integration', command: 'pnpm', args: ['--filter', '@uo/server', 'test'], timeoutMs: 360_000 },
    'protocol-unit': { label: 'Protocol unit', command: 'pnpm', args: ['--filter', '@uo/protocol', 'test'], timeoutMs: 180_000 },
    'admin-e2e': { label: 'Admin browser E2E', command: 'node', args: ['tools/audit/admin-browser-e2e.mjs'], timeoutMs: 180_000 },
    'quality-smoke': { label: 'NodeUO quality smoke', command: 'node', args: ['tools/audit/nodeuo-quality-suite.mjs'], timeoutMs: 600_000 },
  };
  routes.push({ method: 'GET', path: '/api/test-jobs', run: () => ({ suites: Object.entries(testSuites).map(([id, spec]) => ({ id, label: spec.label })), jobs: [...testJobs.values()].slice(-20).reverse() }) });
  routes.push({
    method: 'POST', path: '/api/test-jobs',
    run: ({ body, session }) => {
      const suite = String(body?.suite ?? ''), spec = testSuites[suite]; if (!spec) return { error: 'unknown or unapproved test suite' };
      if ([...testJobs.values()].some((job) => job.status === 'running')) return { error: 'another admin test job is running' };
      const id = `test-${Date.now().toString(36)}-${++testJobSequence}`;
      const job = { id, suite, label: spec.label, status: 'running', actor: session?.account, startedAt: Date.now(), output: '' }; testJobs.set(id, job);
      const command = process.platform === 'win32' && spec.command === 'pnpm' ? 'pnpm.cmd' : spec.command;
      const child = spawn(command, spec.args, { cwd: repoRoot, shell: false, windowsHide: true, env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });
      const append = (chunk) => { job.output = (job.output + chunk.toString()).slice(-250_000); };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const timer = setTimeout(() => { job.timedOut = true; child.kill(); }, spec.timeoutMs); timer.unref?.();
      child.on('error', (error) => { clearTimeout(timer); job.status = 'failed'; job.error = error.message; job.finishedAt = Date.now(); });
      child.on('close', (code, signal) => { clearTimeout(timer); job.status = code === 0 ? 'passed' : 'failed'; job.exitCode = code; job.signal = signal; job.finishedAt = Date.now(); job.durationMs = job.finishedAt - job.startedAt; });
      return { ok: true, job: { ...job, output: '' } };
    },
  });
  routes.push({ method: 'GET', path: '/api/test-jobs/:id', run: ({ params }) => testJobs.get(params.id) ?? { error: 'test job not found' } });

  routes.push({
    method: 'GET', path: '/api/operations/budgets',
    run: () => {
      const runtime = operational.runtimeSnapshot(), apiStats = operational.adminRequestSnapshot?.() ?? { routes: [] };
      const budgets = { apiP95Ms: 250, mapChunkMs: 180, tableRows: 500, eventLoopP95Ms: 50 };
      const client = [...adminClientMetrics.values()].sort((a, b) => b.at - a.at);
      const violations = [
        runtime.eventLoop.p95LagMs > budgets.eventLoopP95Ms && { metric: 'eventLoopP95Ms', value: runtime.eventLoop.p95LagMs, budget: budgets.eventLoopP95Ms },
        ...apiStats.routes.filter((route) => route.p95Ms > budgets.apiP95Ms).map((route) => ({ metric: `api:${route.route}`, value: route.p95Ms, budget: budgets.apiP95Ms })),
        ...client.filter((row) => row.mapChunkMs > budgets.mapChunkMs).map((row) => ({ metric: `map:${row.account}`, value: row.mapChunkMs, budget: budgets.mapChunkMs })),
        ...client.filter((row) => row.tableRows > budgets.tableRows).map((row) => ({ metric: `table:${row.account}`, value: row.tableRows, budget: budgets.tableRows })),
      ].filter(Boolean);
      return { ok: violations.length === 0, budgets, violations, api: apiStats, runtime: runtime.eventLoop, client };
    },
  });

  // ---- Visual world-authoring data -------------------------------------
  routes.push({
    method: 'GET', path: '/api/regions',
    run: () => ({
      regions: (sharedCtx?.regions?.all?.() ?? sharedCtx?.regions?.regions ?? []).map((region) => ({
        name: region.name, map: region.map, type: region.type ?? 'base', priority: region.priority ?? 0,
        rects: region.rects ?? [], guarded: !!region.guarded, noKill: !!region.noKill,
        noMurder: !!region.noMurder, allowGate: region.allowGate !== false, pvp: !!region.pvp,
        blockedSpells: region.blockedSpells ?? [], music: region.music, ambientSound: region.ambientSound,
        season: region.season,
      })),
      diagnostics: regionDiagnostics(sharedCtx?.regions),
    }),
  });
  routes.push({
    method: 'POST', path: '/api/regions',
    run: ({ body }) => {
      const checked = validateRegionDraft(body);
      if (!checked.ok) return checked;
      const region = sharedCtx?.regions?.upsert?.(checked.value);
      return { ok: !!region, region: checked.value, diagnostics: regionDiagnostics(sharedCtx?.regions) };
    },
  });
  routes.push({
    method: 'DELETE', path: '/api/regions/:name',
    run: ({ params, query }) => ({
      ok: (sharedCtx?.regions?.remove?.(params.name, query.get('map') == null ? null : Number(query.get('map'))) ?? 0) > 0,
    }),
  });
  routes.push({
    method: 'POST', path: '/api/spawners/validate',
    run: ({ body }) => validateSpawnerDraft(body, sharedCtx?.monsters?.kinds?.() ?? []),
  });
  routes.push({
    method: 'GET', path: '/api/spawners/heatmap',
    run: ({ query }) => spawnerHeatmap(sharedCtx?.spawner, world, {
      map: queryInt(query, 'map', 1, 0, 5), cellSize: queryInt(query, 'cellSize', 64, 8, 512),
    }),
  });
  routes.push({
    method: 'GET', path: '/api/loot-tables',
    run: () => ({ tables: (sharedCtx?.loot?.names?.() ?? []).map((name) => sharedCtx.loot.get(name)) }),
  });
  routes.push({
    method: 'POST', path: '/api/loot-tables',
    run: ({ body }) => {
      const checked = validateLootDraft(sharedCtx?.loot, body);
      if (!checked.ok) return checked;
      sharedCtx?.loot?.register?.(checked.value);
      return { ...checked, registered: true };
    },
  });
  routes.push({
    method: 'GET', path: '/api/quests',
    run: () => ({ quests: sharedCtx?.quests?.allQuests?.() ?? [] }),
  });
  routes.push({
    method: 'POST', path: '/api/quests',
    run: ({ body }) => {
      const checked = validateQuestDraft(body);
      if (!checked.ok) return checked;
      sharedCtx?.quests?.registerQuest?.(checked.value);
      return { ...checked, registered: true };
    },
  });

  // ---- Dashboard --------------------------------------------------------
  routes.push({
    method: 'POST', path: '/api/simulate/combat',
    run: ({ body }) => {
      const attacker = world?.mobiles?.get?.(parseSerial(body?.attackerSerial));
      const defender = world?.mobiles?.get?.(parseSerial(body?.defenderSerial));
      return simulateCombat(attacker, defender, { trials: body?.trials, seed: body?.seed });
    },
  });

  routes.push({
    method: 'GET', path: '/api/simulate/loot',
    run: ({ query }) => {
      const table = query.get('table') ?? '';
      if (!table) return { tables: sharedCtx?.loot?.names?.() ?? [] };
      return sharedCtx?.loot?.simulate?.(table, { trials: queryInt(query, 'trials', 10_000, 100, 100_000) })
        ?? { error: 'loot registry unavailable' };
    },
  });

  routes.push({
    method: 'GET', path: '/api/animations/body/:body',
    run: ({ params }) => animationBodySnapshot(parseSerial(params.body)),
  });

  routes.push({
    method: 'GET', path: '/api/animations/validate',
    run: () => validateMonsterAnimations(sharedCtx?.monsters),
  });

  routes.push({
    method: 'GET', path: '/api/animations/frame/:body/:action/:direction/:frame',
    run: async ({ params, res }) => {
      const png = await animationFramePng(
        parseSerial(params.body), Number(params.action), Number(params.direction), Number(params.frame),
      );
      if (!png) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'animation frame not found' }));
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
      res.end(png);
      return undefined;
    },
  });

  routes.push({
    method: 'GET', path: '/api/world/stats',
    run: () => {
      const onlineCount = [...(world?.mobiles?.values?.() ?? [])]
        .filter((m) => !!m.client).length;
      return {
        shard: process.env.UO_SHARD_NAME ?? 'UO-Node',
        uptime: process.uptime() | 0,
        memoryMB: (process.memoryUsage().rss / (1024 * 1024)) | 0,
        mobiles: world?.mobiles?.size ?? 0,
        items: world?.items?.size ?? 0,
        onlinePlayers: onlineCount,
        accounts: accounts?.accounts?.size ?? 0,
        scripts: scriptRuntime?.loaded?.length ?? 0,
        saveDir,
        nodeVersion: process.version,
      };
    },
  });

  routes.push({
    method: 'POST', path: '/api/world/save',
    run: async () => {
      if (!persistence?.requestSave) return { error: 'persistence not wired' };
      const r = await persistence.requestSave(world, saveDir);
      return { ok: true, ...r };
    },
  });

  // Graceful shutdown endpoint — invoked by the control panel
  // BEFORE `taskkill /f` on Windows. Triggers the same SIGINT
  // handler used by Ctrl-C in console mode so the world final-save
  // + houses/bazaar flush + WS close happens cleanly. User report
  // 2026-05-18: "przedmioty z plecaka nie zachowuja się po wyłączeniu
  // servera" — control panel's `taskkill /f` skipped the SIGINT
  // handler entirely, so the 60 s auto-save was the only persistence
  // and anything done since the last tick evaporated.
  //
  // Returns immediately (200 OK) and then schedules the shutdown on
  // the next tick so the response reaches the panel before the
  // process exits.
  routes.push({
    method: 'POST', path: '/api/world/shutdown',
    run: () => {
      setTimeout(() => {
        try { process.kill(process.pid, 'SIGINT'); }
        catch (e) { console.error('[admin] graceful shutdown failed:', e?.message); }
      }, 50);
      return { ok: true, message: 'shutdown signal sent' };
    },
  });

  routes.push({
    method: 'POST', path: '/api/world/broadcast',
    run: ({ body }) => {
      const text = body?.text;
      if (!text || typeof text !== 'string') return { error: 'text required' };
      let count = 0;
      for (const m of (world?.mobiles?.values?.() ?? [])) {
        if (m.client?.sendSystemMessage) {
          m.client.sendSystemMessage(text);
          count++;
        }
      }
      return { ok: true, sentTo: count };
    },
  });

  /**
   * Run a registered admin command (createworld / wipeworld /
   * recreateworld / etc) without an in-game character. Captures
   * sendSystemMessage output into a `messages[]` array so the admin UI
   * can show what happened. Whitelist enforces a small safe set —
   * anything else still requires a player to type `[<cmd>` in-world.
   */
  routes.push({
    method: 'POST', path: '/api/world/cmd',
    run: ({ body, session }) => {
      const SAFE = new Set(['createworld', 'wipeworld', 'recreateworld', 'deleteworld', 'reload']);
      const command = String(body?.command ?? '');
      if (!SAFE.has(command)) return { error: `command not allowed via admin: '${command}'` };
      // Admin audit #8 — destructive verbs require a literal confirm
      // token in the request body. Origin header alone isn't enough if
      // a misconfigured reverse-proxy strips headers — this is a
      // defence-in-depth gate that a benign curl operator must opt
      // into explicitly.
      const DESTRUCTIVE = new Set(['wipeworld', 'deleteworld', 'recreateworld']);
      if (DESTRUCTIVE.has(command) && body?.confirm !== `${command}-yes`) {
        return { error: 'destructive command requires confirm token',
                 expected: `${command}-yes` };
      }
      const commands = sharedCtx?.commands;
      if (!commands?.dispatch) return { error: 'commands registry missing' };
      // Find the admin's character so the command sees a sensible
      // sender (some commands log to the player's chat). Falls back
      // to any online mob if the admin has none.
      const chars = adminCharacters(session?.account);
      const sender = chars.find((c) => c.online)?.mob
                  ?? [...(world?.mobiles?.values?.() ?? [])].find((m) => m.client)
                  ?? null;
      const messages = [];
      const fakeState = {
        sendSystemMessage: (line) => messages.push(String(line)),
        ctx: sharedCtx,
        mobile: sender,
        // Admin REST sessions are always 'Admin' (admin-server.js gates
        // login). Pass it through so the dispatch path's per-command
        // access check (commands.js line 73-79) accepts the call.
        account: { accessLevel: 'Admin', username: session?.account ?? 'admin' },
        accountName: session?.account ?? 'admin',
      };
      const ctx = {
        sender, state: fakeState, world, args: [],
      };
      try {
        const ok = commands.dispatch(command, ctx);
        if (!ok) return { error: `command not registered: '${command}'`, messages };
        return { ok: true, command, messages, sender: sender ? '0x' + (sender.serial >>> 0).toString(16) : null };
      } catch (e) {
        return { error: e.message, messages };
      }
    },
  });

  routes.push({
    method: 'POST', path: '/api/scripts/reload',
    run: async () => {
      if (!scriptRuntime?.load) return { error: 'script runtime not wired' };
      const t0 = Date.now();
      await scriptRuntime.load({ reason: 'admin-api', emitEvent: true });
      return { ok: true, ms: Date.now() - t0, loaded: scriptRuntime.loaded?.length ?? 0 };
    },
  });

  // -------------------------------------------------------------------
  //  Single-script reload — restarts ONE script by relative path
  //  (e.g. `npcs/templates/townspeople.js`). Doesn't touch other
  //  loaded scripts. ScriptRuntime.reloadOne disposes the matching
  //  entry, re-imports the file, and re-runs its default().
  // -------------------------------------------------------------------
  routes.push({
    method: 'POST', path: '/api/scripts/reload-one',
    run: async ({ body }) => {
      const rel = String(body?.rel || '').trim();
      if (!rel) return { error: 'rel script path required (body.rel)' };
      if (!scriptRuntime?.reloadOne) return { error: 'reloadOne unavailable on runtime' };
      const t0 = Date.now();
      const r = await scriptRuntime.reloadOne(rel);
      return { ok: r.ok, ms: Date.now() - t0, ...r };
    },
  });

  // -------------------------------------------------------------------
  //  Data file editor — list / read / write the JSON catalogs under
  //  apps/scripts/src/data/config/ and apps/scripts/src/data/world/.
  //  Used by the admin panel's "Data editor" tab so an operator can
  //  tweak monster stats / NPC archetypes / spawn coords WITHOUT
  //  popping a shell to edit JSON files by hand.
  //
  //  Safety: every write parses the supplied payload as JSON first
  //  (rejects on syntax error), and confines the file path to the
  //  data/ subtree (no parent-dir escape). After write we optionally
  //  trigger scripts:reload so the change goes live.
  // -------------------------------------------------------------------
  const DATA_ROOT = path.resolve(scriptsDir, 'data');
  function _confineToData(rel) {
    const full = path.resolve(DATA_ROOT, rel);
    if (!full.startsWith(DATA_ROOT + path.sep) && full !== DATA_ROOT) {
      throw new Error('path escapes data/ subtree');
    }
    return full;
  }
  function _walkData(dir, prefix = '') {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel  = prefix ? `${prefix}/${name}` : name;
      const st   = fs.statSync(full);
      if (st.isDirectory()) {
        out.push(..._walkData(full, rel));
      } else if (st.isFile() && (name.endsWith('.json') || name.endsWith('.js'))) {
        out.push({ rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
    return out;
  }

  routes.push({
    method: 'GET', path: '/api/data/files',
    run: async () => ({ root: 'apps/scripts/src/data', files: _walkData(DATA_ROOT) }),
  });

  routes.push({
    method: 'GET', path: '/api/data/file',
    run: async ({ query }) => {
      // `query` is a URLSearchParams — use .get(), not direct prop access.
      const rel = String(query.get('rel') ?? '').trim();
      if (!rel) return { error: 'rel param required' };
      try {
        const full = _confineToData(rel);
        if (!fs.existsSync(full)) return { error: 'not found' };
        return { rel, content: fs.readFileSync(full, 'utf8') };
      } catch (e) { return { error: e.message }; }
    },
  });

  routes.push({
    method: 'POST', path: '/api/data/file',
    run: async ({ body }) => {
      const rel = String(body?.rel || '').trim();
      const content = body?.content;
      if (!rel) return { error: 'body.rel required' };
      if (typeof content !== 'string') return { error: 'body.content (string) required' };
      try {
        const full = _confineToData(rel);
        // JSON files: validate before writing — refusing a save with a
        // bad payload protects the live world from a typo that would
        // break the loader on next reload.
        if (rel.endsWith('.json')) {
          try { JSON.parse(content); }
          catch (e) { return { error: `invalid JSON: ${e.message}` }; }
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
        // Auto-reload all scripts when body.reload is true. The
        // hot-watch in scriptRuntime ONLY fires on .js files (file
        // watcher), so JSON edits need an explicit kick.
        let reloaded = null;
        if (body?.reload && scriptRuntime?.load) {
          const t0 = Date.now();
          await scriptRuntime.load({ reason: `admin-data:${rel}`, emitEvent: true });
          reloaded = { ms: Date.now() - t0, loaded: scriptRuntime.loaded?.length ?? 0 };
        }
        return { ok: true, bytes: content.length, reloaded };
      } catch (e) { return { error: e.message }; }
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/data/file',
    run: async ({ query }) => {
      const rel = String(query.get('rel') ?? '').trim();
      if (!rel) return { error: 'rel param required' };
      try {
        const full = _confineToData(rel);
        if (!fs.existsSync(full)) return { error: 'not found' };
        fs.unlinkSync(full);
        return { ok: true };
      } catch (e) { return { error: e.message }; }
    },
  });

  // ---- World locations list (used by admin Iso editor "Go to…" picker) --
  // Mirrors the `[go` LOCATIONS catalogue so the iso editor can centre
  // the canvas on any canonical landmark / town / dungeon / shrine.
  // Cached at module load — the catalogue is static.
  let _locationsCache = null;
  routes.push({
    method: 'GET', path: '/api/locations',
    run: async () => {
      if (_locationsCache) return _locationsCache;
      try {
        const mod = await import('../../../scripts/src/commands/go.js');
        const reg = mod.LOCATIONS_REGISTRY ?? mod._LOCATIONS_FOR_TEST ?? {};
        const out = [];
        for (const [key, loc] of Object.entries(reg)) {
          if (!loc || !Number.isFinite(loc.x)) continue;
          out.push({
            key,
            label: loc.label ?? key,
            x: loc.x | 0, y: loc.y | 0, z: loc.z | 0,
            map: loc.map | 0,
          });
        }
        out.sort((a, b) => a.label.localeCompare(b.label));
        _locationsCache = { locations: out };
        return _locationsCache;
      } catch (e) {
        return { error: `failed to load locations: ${e.message}`, locations: [] };
      }
    },
  });

  // ---- Map editor (admin canvas paint tool) -----------------------------
  // Read a rectangular slice of the land map. Capped to 64×64 tiles per
  // request to keep payloads small (~24 KB). Returns the merged view —
  // overlay edits already applied.
  routes.push({
    method: 'GET', path: '/api/map/slice',
    run: ({ query }) => {
      const facet = queryInt(query, 'facet', 1, 0, 5);
      const x0 = queryInt(query, 'x', 1495, 0, 0xffff);
      const y0 = queryInt(query, 'y', 1625, 0, 0xffff);
      const w = queryInt(query, 'w', 32, 1, 64);
      const h = queryInt(query, 'h', 32, 1, 64);
      const tiles = new Array(w * h);
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) {
          const t = mapProvider.landAt(facet, x0 + dx, y0 + dy);
          tiles[dy * w + dx] = t ? [t.tileId, t.z] : [0, 0];
        }
      }
      return { facet, x: x0, y: y0, w, h, tiles, edits: mapProvider.editCount() };
    },
  });

  // Apply a batch of tile edits. Body: { facet, edits: [{x,y,tileId,z}] }.
  routes.push({
    method: 'POST', path: '/api/map/edit',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const edits = Array.isArray(body?.edits) ? body.edits : [];
      if (!edits.length) return { error: 'no edits' };
      if (edits.length > 4096) return { error: 'too many edits in one batch (max 4096)' };
      let applied = 0;
      // Compute a bounding box of edited tiles so the live-broadcast
      // pass below only re-syncs players actually within range of any
      // change (cheap proxy: refreshSurroundings re-streams the
      // player's full visible chunks).
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const validEdits = [];
      for (const e of edits) {
        if (!Number.isFinite(e?.x) || !Number.isFinite(e?.y) || !Number.isFinite(e?.tileId)) continue;
        if (e.x < 0 || e.y < 0 || e.x > 0xffff || e.y > 0xffff) continue;
        const normalized = { x: e.x | 0, y: e.y | 0, tileId: e.tileId & 0x3fff, z: Math.max(-128, Math.min(127, e.z | 0)) };
        mapProvider.setLandTile(facet, normalized.x, normalized.y, normalized.tileId, normalized.z);
        validEdits.push(normalized);
        if (e.x < minX) minX = e.x; if (e.x > maxX) maxX = e.x;
        if (e.y < minY) minY = e.y; if (e.y > maxY) maxY = e.y;
        applied++;
      }
      // Persist immediately so a server crash doesn't lose the edit
      // session's work. Cheap (sparse JSON) — typically <1ms.
      if (!validEdits.length) return { error: 'no valid edits' };
      const r = mapProvider.saveEditsSync(path.join(saveDir, 'map-edits.json'));
      // LOS cache invalidation — any tile that just changed Z may have
      // become walkable / unwalkable, so cached LOS answers from the
      // last 100 ms are no longer trustworthy. Cheap clear (drops 4096
      // entries max).
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Live tile-push — every connected player on the same facet
      // within ~32 tiles of the edit bounding box gets a 0xBF 0x6E
      // MapTileEdit packet so their local landAt overlay updates and
      // chunk visuals re-mount. No relog / [resync needed any more.
      let broadcast = 0;
      if (applied > 0) {
        const pkt = extMapTileEdit(facet, validEdits);
        const cx = (minX + maxX) >> 1;
        const cy = (minY + maxY) >> 1;
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client) continue;
          if (!m.client.supportsNodeUO?.(NodeUOCapability.WorldEditing)) continue;
          if (m.map !== facet) continue;
          if (Math.abs(m.x - cx) > 32 || Math.abs(m.y - cy) > 32) continue;
          try { m.client.send(pkt); broadcast++; }
          catch { /* socket transient */ }
        }
      }
      return { ok: true, applied, totalEdits: mapProvider.editCount(), broadcast, persist: r };
    },
  });

  // Wipe all overlay edits + delete the persisted file.
  routes.push({
    method: 'POST', path: '/api/map/reset',
    run: () => {
      const all = [...mapProvider.iterEdits()];
      for (const e of all) mapProvider.clearLandTile(e.facet, e.x, e.y);
      try { fs.unlinkSync(path.join(saveDir, 'map-edits.json')); } catch { /* missing */ }
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Restore the original land tiles in connected web clients too. Split
      // large overlays into protocol-safe chunks and only send a chunk to
      // players close enough to see its bounding box.
      let broadcast = 0;
      const byFacet = new Map();
      for (const e of all) {
        const list = byFacet.get(e.facet) ?? [];
        const original = mapProvider.landAt(e.facet, e.x, e.y);
        list.push({ x: e.x, y: e.y, tileId: original?.tileId ?? 0, z: original?.z ?? 0 });
        byFacet.set(e.facet, list);
      }
      for (const [facet, edits] of byFacet) {
        for (let start = 0; start < edits.length; start += 4096) {
          const chunk = edits.slice(start, start + 4096);
          const minX = Math.min(...chunk.map((e) => e.x));
          const maxX = Math.max(...chunk.map((e) => e.x));
          const minY = Math.min(...chunk.map((e) => e.y));
          const maxY = Math.max(...chunk.map((e) => e.y));
          const pkt = extMapTileEdit(facet, chunk);
          for (const mob of (world?.mobiles?.values?.() ?? [])) {
            if (!mob.client || mob.map !== facet) continue;
            if (!mob.client.supportsNodeUO?.(NodeUOCapability.WorldEditing)) continue;
            if (mob.x < minX - 32 || mob.x > maxX + 32 || mob.y < minY - 32 || mob.y > maxY + 32) continue;
            try { mob.client.send(pkt); broadcast++; } catch { /* socket race */ }
          }
        }
      }
      return { ok: true, cleared: all.length, broadcast };
    },
  });
  routes.push({
    method: 'POST', path: '/api/scripts/dry-run',
    run: async ({ body }) => scriptRuntime?.dryRunOne
      ? scriptRuntime.dryRunOne(String(body?.path ?? ''))
      : { ok: false, error: 'dry-run unavailable on runtime' },
  });

  // Tiledata search — pagination + substring match on the static or
  // land tile name. Used by the editor palette browser to let admins
  // discover any 0xNNNN graphic without memorising ids. Cap at 200
  // matches per call so a one-letter query doesn't ship a 4 MB
  // payload. `kind` filters: 'static' (default), 'land', or 'all'.
  routes.push({
    method: 'GET', path: '/api/tiles/search',
    run: ({ query }) => {
      const q = String(query.get('q') ?? '').trim().toLowerCase();
      const kind = query.get('kind') ?? 'static';
      const limit = queryInt(query, 'limit', 80, 1, 200);
      const offset = queryInt(query, 'offset', 0, 0, 100_000);
      const category = String(query.get('category') ?? 'all').trim().toLowerCase();
      const td = tileDataTable();
      const matches = [];
      let total = 0;
      // tiledata.statics is indexed by GLOBAL art id (LAND_COUNT + local).
      // Callers (palette, /api/statics/place, runtime item.itemId) all use
      // LOCAL static ids. Subtract LAND_COUNT when emitting so the wire
      // contract stays LOCAL-only and the editor's atlas lookup adds the
      // offset itself when fetching sprites.
      const LAND_COUNT = (td.land?.length ?? 16384) | 0;
      const categoryOf = (name, type) => {
        if (type === 'land') return 'terrain';
        const n = String(name ?? '').toLowerCase();
        if (/door|gate|portcullis/.test(n)) return 'doors';
        if (/chair|table|bench|bed|throne|stool|desk|bookcase|bookshelf|armoire|dresser/.test(n)) return 'furniture';
        if (/candle|lamp|lantern|torch|brazier|candelabra|fireplace|hearth/.test(n)) return 'lighting';
        if (/tree|plant|flower|grass|rock|boulder|bush|shrub|vine|mushroom|log|stump/.test(n)) return 'nature';
        if (/wall|floor|roof|column|pillar|stair|window|arch|railing|fence|brick|stone|plaster/.test(n)) return 'architecture';
        if (/chest|crate|barrel|box|bag|basket|container|cabinet/.test(n)) return 'containers';
        if (/sign|banner|flag|tapestry|painting|portrait/.test(n)) return 'signs';
        return 'misc';
      };
      const trySource = (arr, type) => {
        const idShift = type === 'static' ? LAND_COUNT : 0;
        for (let i = 0; i < arr.length; i++) {
          const e = arr[i];
          if (!e) continue;
          const name = String(e.name ?? '').toLowerCase();
          if (!name) continue;
          if (name === 'nodraw') continue;
          const outId = i - idShift;
          if (outId < 0) continue;
          const tileCategory = categoryOf(e.name, type);
          if (category !== 'all' && type === 'static' && tileCategory !== category) continue;
          let queryMatches = q === '';
          if (/^0x[0-9a-f]+$/i.test(q)) {
            // Accept either local (matches outId) or global (matches i)
            // hex queries so power users can paste either.
            const want = parseInt(q, 16);
            queryMatches = outId === want || i === want;
          } else if (/^\d+$/.test(q)) {
            const want = parseInt(q, 10);
            queryMatches = outId === want || i === want;
          } else if (q) {
            queryMatches = name.includes(q);
          }
          if (!queryMatches) continue;
          if (total >= offset && matches.length < limit) {
            matches.push({ type, id: outId, name: e.name, height: e.height | 0,
              layer: e.layer | 0, category: tileCategory });
          }
          total++;
        }
      };
      if (kind === 'land' || kind === 'all') trySource(td.land ?? [], 'land');
      if (kind === 'static' || kind === 'all') trySource(td.statics ?? [], 'static');
      return { q, kind, category, offset, limit, count: matches.length,
        total, hasMore: offset + matches.length < total, matches };
    },
  });

  // Read-only overlay dump for the client. Returns every overlay edit
  // for one facet (or all facets if 'facet' query is omitted). The
  // browser client fetches this at boot + on facet change so its
  // local landAt() can apply the same overrides the server uses for
  // walkability — without this, paint strokes from the admin Map
  // Editor showed only on the canvas, not in-game.
  routes.push({
    method: 'GET', path: '/api/map/overlay',
    run: ({ query }) => {
      const wantFacet = query.has('facet') ? Number(query.get('facet')) : null;
      const out = [];
      for (const e of mapProvider.iterEdits()) {
        if (wantFacet != null && e.facet !== wantFacet) continue;
        out.push(e);
      }
      return { facet: wantFacet, edits: out };
    },
  });

  // ---- Static editor (canvas-based item placement) ---------------------
  // Returns every static at every tile in a rectangle. Different from
  // /api/map/slice (which only returns land tile id/z) — this includes
  // ground items + statics from the on-disk map AND from runtime
  // world.items (admin-placed builds, doorgen, etc.).
  routes.push({
    method: 'GET', path: '/api/statics/slice',
    run: ({ query }) => {
      const facet = queryInt(query, 'facet', 1, 0, 5);
      const x0 = queryInt(query, 'x', 1495, 0, 0xffff);
      const y0 = queryInt(query, 'y', 1625, 0, 0xffff);
      const w = queryInt(query, 'w', 32, 1, 64);
      const h = queryInt(query, 'h', 32, 1, 64);
      // Map of `${dx}|${dy}` → array of {tileId, z, hue, source} where
      // source is 'static' (from chunk static layer, fixed) or 'item'
      // (from world.items, mutable via [del / build).
      const cells = {};
      const stackFor = (wx, wy) => {
        const key = `${wx - x0}|${wy - y0}`;
        return (cells[key] ??= []);
      };
      // Decode baked map statics once per 8x8 block. The previous nested
      // tile loop called staticsAt() 4096 times for a 64x64 view and each
      // call rescanned its block's complete variable-length record list.
      if (typeof mapProvider.staticsInRect === 'function') {
        for (const s of mapProvider.staticsInRect(facet, x0, y0, w, h)) {
          stackFor(s.x, s.y).push({ tileId: s.tileId, z: s.z, hue: s.hue, source: 'static' });
        }
      } else {
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          for (const s of mapProvider.staticsAt(facet, x0 + dx, y0 + dy)) {
            stackFor(x0 + dx, y0 + dy).push({ tileId: s.tileId, z: s.z, hue: s.hue, source: 'static' });
          }
        }
      }

      // Runtime items: query all overlapping sector buckets once, then
      // filter into cells. Keep the single-tile fallback for lightweight
      // test fixtures that expose only itemSerialsAt().
      const sectorsReady = world?.sectors
        && (world.items.size === 0 || world.sectors.itemsIndexed?.() > 0);
      const pushRuntime = (it) => {
        if (!it || it.parent != null || (it.map ?? 1) !== facet) return;
        if (it.x < x0 || it.x >= x0 + w || it.y < y0 || it.y >= y0 + h) return;
        stackFor(it.x, it.y).push({
          tileId: it.itemId, z: it.z, hue: it.hue ?? 0,
          source: (it.house != null || it.boat != null || it.multiId != null || it.addon != null || it.addonName != null) ? 'multi' : 'item',
          serial: '0x' + (it.serial >>> 0).toString(16),
        });
      };
      if (sectorsReady && world.sectors.itemSerialsNear) {
        const cx = x0 + ((w - 1) >> 1), cy = y0 + ((h - 1) >> 1);
        const range = Math.ceil(Math.max(w, h) / 2) + 8;
        for (const serial of world.sectors.itemSerialsNear(facet, cx, cy, range)) {
          pushRuntime(world.items.get(serial));
        }
      } else if (sectorsReady && world.sectors.itemSerialsAt) {
        const seen = new Set();
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
          for (const serial of world.sectors.itemSerialsAt(facet, x0 + dx, y0 + dy)) {
            if (seen.has(serial)) continue;
            seen.add(serial); pushRuntime(world.items.get(serial));
          }
        }
      } else {
        for (const it of (world?.items?.values?.() ?? [])) pushRuntime(it);
      }
      return { facet, x: x0, y: y0, w, h, cells };
    },
  });

  // Place a single static at the given tile. Spawned as a runtime item
  // (movable:false, isDecoration:true) so it round-trips through saves
  // and `[del` removes it. Returns the new item's serial.
  routes.push({
    method: 'POST', path: '/api/statics/place',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const x = Number(body?.x ?? 0) | 0;
      const y = Number(body?.y ?? 0) | 0;
      const z = Number(body?.z ?? 0) | 0;
      const itemId = Number(body?.itemId ?? 0) | 0;
      const hue = Number(body?.hue ?? 0) & 0xffff;
      const td = tileDataTable();
      const staticCount = Math.max(0, (td.statics?.length ?? 0) - (td.land?.length ?? 0));
      if (!itemId || itemId < 1 || itemId >= staticCount) {
        return { error: `bad itemId 0x${itemId.toString(16)} (valid local static range: 0x1..0x${Math.max(0, staticCount - 1).toString(16)})` };
      }
      const items = sharedCtx?.items ?? null;
      const createItem = items?.createItem;
      if (!createItem) return { error: 'items.createItem unavailable' };
      const it = createItem(world, { itemId, hue, x, y, z, map: facet, movable: false });
      it.isDecoration = true;
      it.script = 'static';
      // Newly-placed static may block (or pass) LOS — drop the cache
      // so spells / archery checks pick up the change immediately.
      try { invalidateLosCache(); } catch { /* advisory */ }
      // Broadcast worldItemSA to nearby players.
      const wi = sharedCtx?.protocol?.worldItemSA?.({
        serial: it.serial, itemId: it.itemId, hue: it.hue, amount: 1,
        x: it.x, y: it.y, z: it.z, flags: 0x00,
      });
      if (wi) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          m.client.send(wi);
        }
      }
      return { ok: true, serial: '0x' + (it.serial >>> 0).toString(16) };
    },
  });

  // Export a rectangular slice as a "multi" prefab — save the runtime
  // items at every tile in the rect to a named JSON file. Reuse via
  // /api/statics/import-prefab to drop a copy at a new location.
  routes.push({
    method: 'POST', path: '/api/statics/save-prefab',
    run: ({ body }) => {
      const facet = Number(body?.facet ?? 1);
      const x0 = Number(body?.x0) | 0, y0 = Number(body?.y0) | 0;
      const x1 = Number(body?.x1) | 0, y1 = Number(body?.y1) | 0;
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      if (!name) return { error: 'name required (alphanumeric)' };
      // Snap to ascending bounds — operator can pass corners in any order.
      const lx = Math.min(x0, x1), hx = Math.max(x0, x1);
      const ly = Math.min(y0, y1), hy = Math.max(y0, y1);
      const includeFixed = !!body?.includeFixed;
      const tiles = [];
      // Runtime items in range — relative offsets so prefab is portable.
      for (const it of (world?.items?.values?.() ?? [])) {
        if (it.parent != null) continue;
        if ((it.map ?? 1) !== facet) continue;
        if (it.x < lx || it.x > hx || it.y < ly || it.y > hy) continue;
        tiles.push({
          dx: it.x - lx, dy: it.y - ly, z: it.z | 0,
          itemId: it.itemId | 0, hue: it.hue | 0, source: 'item',
        });
      }
      if (includeFixed) {
        for (let y = ly; y <= hy; y++) {
          for (let x = lx; x <= hx; x++) {
            for (const s of mapProvider.staticsAt(facet, x, y)) {
              tiles.push({
                dx: x - lx, dy: y - ly, z: s.z | 0,
                itemId: s.tileId | 0, hue: s.hue | 0, source: 'static',
              });
            }
          }
        }
      }
      const prefab = {
        name, sizeX: hx - lx + 1, sizeY: hy - ly + 1,
        savedAt: new Date().toISOString(),
        sourceFacet: facet, sourceX: lx, sourceY: ly,
        tiles,
      };
      const dir = path.join(saveDir, 'prefabs');
      try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
      const file = path.join(dir, `${name}.json`);
      try { fs.writeFileSync(file, JSON.stringify(prefab, null, 2)); }
      catch (e) { return { error: e.message }; }
      return { ok: true, name, file: `prefabs/${name}.json`, tileCount: tiles.length, sizeX: prefab.sizeX, sizeY: prefab.sizeY };
    },
  });

  // List saved prefabs.
  routes.push({
    method: 'GET', path: '/api/statics/prefabs',
    run: () => {
      const dir = path.join(saveDir, 'prefabs');
      if (!fs.existsSync(dir)) return { prefabs: [] };
      const out = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          out.push({
            name: meta.name, file: `prefabs/${f}`, sizeX: meta.sizeX, sizeY: meta.sizeY,
            tileCount: meta.tiles?.length ?? 0, savedAt: meta.savedAt,
          });
        } catch { /* skip corrupt */ }
      }
      return { prefabs: out };
    },
  });

  // Stamp a saved prefab at (x, y) on the given facet. Items are
  // recreated as runtime items (not the original serials).
  routes.push({
    method: 'POST', path: '/api/statics/import-prefab',
    run: ({ body }) => {
      const name = String(body?.name ?? '').replace(/[^a-z0-9_-]/gi, '_');
      const facet = Number(body?.facet ?? 1);
      const baseX = Number(body?.x) | 0;
      const baseY = Number(body?.y) | 0;
      const file = path.join(saveDir, 'prefabs', `${name}.json`);
      if (!fs.existsSync(file)) return { error: `prefab '${name}' not found` };
      let prefab;
      try { prefab = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { return { error: e.message }; }
      const items = sharedCtx?.items?.createItem;
      if (!items) return { error: 'items.createItem unavailable' };
      let placed = 0;
      const newItems = [];
      for (const t of prefab.tiles ?? []) {
        if (t.source === 'static') continue;  // can't recreate fixed map statics
        try {
          const it = items(world, {
            itemId: t.itemId, hue: t.hue,
            x: baseX + t.dx, y: baseY + t.dy, z: t.z,
            map: facet, movable: false,
          });
          it.isDecoration = true; it.script = 'static';
          newItems.push(it);
          placed++;
        } catch { /* per-tile failures don't block batch */ }
      }
      // Broadcast every new item to nearby players in one pass.
      const wiBuilder = sharedCtx?.protocol?.worldItemSA;
      if (wiBuilder) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - baseX) > 32 || Math.abs(m.y - baseY) > 32) continue;
          for (const it of newItems) {
            if (Math.abs(m.x - it.x) > 18 || Math.abs(m.y - it.y) > 18) continue;
            m.client.send(wiBuilder({
              serial: it.serial, itemId: it.itemId, hue: it.hue, amount: 1,
              x: it.x, y: it.y, z: it.z, flags: 0x00,
            }));
          }
        }
      }
      return { ok: true, name, placed, total: prefab.tiles?.length ?? 0 };
    },
  });

  // Remove a single placed static by serial.
  routes.push({
    method: 'POST', path: '/api/statics/remove',
    run: ({ body }) => {
      const serial = parseSerial(body?.serial);
      if (!serial) return { error: 'serial required' };
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'item not found' };
      const x = it.x, y = it.y, facet = it.map;
      const items = sharedCtx?.items ?? null;
      try { items?.destroyItem?.(world, serial); }
      catch (e) { return { error: e.message }; }
      const rm = sharedCtx?.protocol?.removeEntity?.(serial);
      if (rm) {
        for (const m of (world?.mobiles?.values?.() ?? [])) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          m.client.send(rm);
        }
      }
      return { ok: true };
    },
  });

  // Atomic editor commit. The old UI fired one HTTP request per tile, which
  // was slow and could leave half a brush stroke applied after a disconnect.
  // Validate the complete command first, stage all additions, and only then
  // perform deterministic removals. A failed create rolls every staged item
  // back before returning an error.
  routes.push({
    method: 'POST', path: '/api/statics/batch',
    run: ({ body, session }) => {
      const facet = Number(body?.facet ?? 1) | 0;
      const additions = Array.isArray(body?.additions) ? body.additions : [];
      const removals = [...new Set(Array.isArray(body?.removals) ? body.removals.map(parseSerial).filter(Boolean) : [])];
      if (!additions.length && !removals.length) return { error: 'empty batch' };
      if (additions.length + removals.length > 4096) return { error: 'batch exceeds 4096 mutations' };
      if (facet < 0 || facet > 5) return { error: 'invalid facet' };
      const td = tileDataTable();
      const staticCount = Math.max(0, (td.statics?.length ?? 0) - (td.land?.length ?? 0));
      const normalized = [];
      for (const row of additions) {
        const itemId = Number(row?.itemId) | 0;
        const x = Number(row?.x), y = Number(row?.y), z = Number(row?.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)
            || x < 0 || x > 0xffff || y < 0 || y > 0xffff
            || itemId < 1 || itemId >= staticCount) return { error: 'invalid addition in batch' };
        normalized.push({ itemId, x: x | 0, y: y | 0,
          z: Math.max(-128, Math.min(127, z | 0)), hue: Number(row?.hue ?? 0) & 0xffff });
      }
      const removalSnapshots = [];
      for (const serial of removals) {
        const item = world.items.get(serial);
        if (!item || item.parent != null) return { error: `removal item 0x${serial.toString(16)} not found on ground` };
        removalSnapshots.push({ serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
          amount: item.amount ?? 1, map: item.map, x: item.x, y: item.y, z: item.z,
          name: item.name, movable: item.movable, parent: null, gumpId: item.gumpId ?? 0,
          gridX: item.gridX ?? 0, gridY: item.gridY ?? 0, gridLocation: item.gridLocation ?? 0,
          layer: item.layer ?? 0, template: item.template, isDecoration: !!item.isDecoration,
          script: item.script });
      }
      const create = sharedCtx?.items?.createItem;
      const destroy = sharedCtx?.items?.destroyItem;
      if (!create || !destroy) return { error: 'item mutation API unavailable' };
      const created = [];
      try {
        for (const row of normalized) {
          const item = create(world, { ...row, map: facet, movable: false });
          item.isDecoration = true; item.script = 'static';
          world.syncSpatialItem?.(item);
          created.push(item);
        }
      } catch (error) {
        for (const item of created) { try { destroy(world, item.serial); } catch {} }
        return { error: `batch rolled back: ${error?.message ?? error}`, rolledBack: created.length };
      }
      for (const serial of removals) destroy(world, serial);
      try { invalidateLosCache(); } catch { /* advisory */ }
      // One surrounding refresh per affected client, instead of N packets per
      // tile. Standard clients receive the normal UO item/remove packets.
      const touched = [...created, ...removalSnapshots];
      const removePackets = new Map(removalSnapshots.map((item) => [item.serial,
        sharedCtx?.protocol?.removeEntity?.(item.serial) ?? null]));
      for (const mobile of world.onlineMobiles?.() ?? []) {
        if ((mobile.map | 0) !== facet || !mobile.client) continue;
        for (const item of created) {
          if (Math.max(Math.abs(mobile.x - item.x), Math.abs(mobile.y - item.y)) > 18) continue;
          try { mobile.client.sendItem?.(item); } catch { /* socket race */ }
        }
        for (const item of removalSnapshots) {
          if (Math.max(Math.abs(mobile.x - item.x), Math.abs(mobile.y - item.y)) > 18) continue;
          const packet = removePackets.get(item.serial);
          if (packet) { try { mobile.client.send(packet); } catch { /* socket race */ } }
        }
        try { sharedCtx?.refreshSurroundings?.(mobile.client); } catch { /* advisory */ }
      }
      const auditUndoId = registerUndoableMutation(session?.account, 'statics.batch', {
        facet, createdSerials: created.map((item) => item.serial >>> 0),
        removedSnapshots: removalSnapshots.map(({ serial: _serial, ...snapshot }) => snapshot),
      });
      return { ok: true, added: created.length, removed: removals.length, auditUndoId,
        serials: created.map((item) => `0x${(item.serial >>> 0).toString(16)}`), touched: touched.length };
    },
  });

  // ---- Accounts ---------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/accounts',
    run: () => {
      const list = [...(accounts?.accounts?.values?.() ?? [])].map((a) => ({
        username: a.username,
        accessLevel: a.accessLevel,
        banned: !!a.banned,
        created: a.created,
        lastLogin: a.lastLogin,
        characters: (a.characters ?? []).filter(Boolean).length,
      }));
      return { count: list.length, accounts: list };
    },
  });

  routes.push({
    method: 'GET', path: '/api/accounts/:name',
    run: ({ params }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      const safe = { ...acc };
      delete safe.hash;
      // Resolve character serials → mob snapshots so the UI shows live state.
      const chars = (acc.characters ?? []).map((c) => {
        if (!c) return null;
        const mob = world?.mobiles?.get?.(c.mobileSerial >>> 0);
        return {
          ...c,
          live: mob ? snapshotMobile(mob) : null,
        };
      });
      return { ...safe, characters: chars };
    },
  });

  routes.push({
    method: 'PATCH', path: '/api/accounts/:name',
    run: ({ params, body, session }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      // Admin audit #1/#2/#5 — stored XSS via accessLevel class +
      // privilege escalation. Whitelist the values + refuse self-edit
      // on accessLevel/banned (no admin can de-Admin themselves or
      // re-Admin themselves silently).
      const ALLOWED_LEVELS = new Set(['Player', 'Counselor', 'Seer', 'GameMaster', 'GM', 'Admin']);
      const isSelf = String(session?.account ?? '').toLowerCase() === params.name.toLowerCase();
      if (body && 'accessLevel' in body) {
        if (!ALLOWED_LEVELS.has(body.accessLevel)) {
          return { error: 'invalid accessLevel' };
        }
        if (isSelf) return { error: 'cannot change your own accessLevel' };
        acc.accessLevel = body.accessLevel;
      }
      if (body && 'banned' in body) {
        if (isSelf && body.banned) return { error: 'cannot ban self' };
        acc.banned = !!body.banned;
      }
      accounts.saveSync();
      return { ok: true, account: { username: acc.username, accessLevel: acc.accessLevel, banned: !!acc.banned } };
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/accounts/:name',
    run: ({ params, session }) => {
      const key = params.name.toLowerCase();
      if (String(session?.account ?? '').toLowerCase() === key) {
        return { error: 'cannot delete your own account' };
      }
      const ok = accounts?.accounts?.delete(key);
      if (ok) accounts.saveSync();
      return { ok: !!ok };
    },
  });

  // ---- Mobiles (characters + NPCs) -------------------------------------
  routes.push({
    method: 'GET', path: '/api/mobiles',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onlyPlayers = query.get('players') === '1';
      const kind = query.get('kind') ?? (onlyPlayers ? 'players' : 'all');
      const limit = Math.trunc(Math.max(1, Math.min(500, Number(query.get('limit') ?? 200) || 200)));
      const offset = Math.trunc(Math.max(0, Number(query.get('offset') ?? 0) || 0));
      let count = 0;
      const page = [];
      for (const m of (world?.mobiles?.values?.() ?? [])) {
        const isPlayer = !!m.client || !!m.isPlayer;
        const isVendor = !isPlayer && !!m.vendorKind;
        if (kind === 'players' && !isPlayer) continue;
        if (kind === 'vendors' && !isVendor) continue;
        if (kind === 'npcs' && (isPlayer || isVendor)) continue;
        if (filter && !(m.name ?? '').toLowerCase().includes(filter)
            && !`0x${(m.serial >>> 0).toString(16)}`.includes(filter)) continue;
        if (count >= offset && page.length < limit) page.push(snapshotMobile(m));
        count++;
      }
      return {
        count,
        offset,
        limit,
        mobiles: page,
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/mobiles/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      // Pull worn items + backpack contents for the preview pane.
      // Reverse parent index: ≤10 worn slots + ≤30 pack contents
      // instead of two full 110k walks per request. Bug-hunt #4 A5.
      const equipped = [];
      let backpack = null;
      const idx = world?._childrenByParent;
      const wornIter = idx?.get?.(mob.serial)
        ? Array.from(idx.get(mob.serial), (s) => world.items.get(s)).filter(Boolean)
        : [...(world?.items?.values?.() ?? [])].filter((it) => it.parent === mob.serial);
      for (const it of wornIter) {
        if (it.layer === 21) backpack = it;
        if ((it.layer ?? 0) > 0) equipped.push({
          serial: '0x' + (it.serial >>> 0).toString(16),
          itemId: it.itemId, hue: it.hue, layer: it.layer, name: it.name,
        });
      }
      const packIter = backpack
        ? (idx?.get?.(backpack.serial)
            ? Array.from(idx.get(backpack.serial), (s) => world.items.get(s)).filter(Boolean)
            : [...world.items.values()].filter((it) => it.parent === backpack.serial))
        : [];
      const packContents = packIter.map((it) => ({
        serial: '0x' + (it.serial >>> 0).toString(16),
        itemId: it.itemId, hue: it.hue, amount: it.amount, name: it.name,
      }));
      return {
        ...snapshotMobile(mob),
        equipped,
        backpackContents: packContents,
      };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/teleport',
    run: ({ params, body }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      const x = Number(body?.x), y = Number(body?.y), z = Number(body?.z ?? mob.z);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x,y required' };
      mob.x = x; mob.y = y; mob.z = z;
      if (Number.isFinite(body?.map)) mob.map = body.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kill',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      mob.hp = 0;
      // Bug-hunt #10 #3 — `combat.damage` only adjusts HP; the death
      // path (corpse spawn, notoriety, mob.delete) lives in
      // `corpse.killMobile`. Without this admin "kill" left passive
      // NPCs frozen at HP=0 forever. Try direct call first; fall back
      // to the combat path so any in-flight combat tick still wraps
      // the death via its own damage closure.
      const killMobile = sharedCtx?.corpse?.killMobile
                      ?? sharedCtx?.systems?.corpse?.killMobile;
      if (typeof killMobile === 'function') {
        try { killMobile(world, mob, null); }
        catch (e) { console.error('[admin] kill threw:', e); }
      } else {
        sharedCtx?.handlers?.combat?.damage?.(world, mob, 9999, null);
      }
      return { ok: true };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kick',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob?.client) return { error: 'not online' };
      try { mob.client.close?.(); } catch { /* ignore */ }
      return { ok: true };
    },
  });

  // ---- Items ------------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/items',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onGround = query.get('ground') === '1';
      const limit = Math.trunc(Math.max(1, Math.min(500, Number(query.get('limit') ?? 200) || 200)));
      const offset = Math.trunc(Math.max(0, Number(query.get('offset') ?? 0) || 0));
      let count = 0;
      const page = [];
      for (const it of (world?.items?.values?.() ?? [])) {
        if (onGround && it.parent != null) continue;
        if (filter && !(it.name ?? '').toLowerCase().includes(filter)
            && !`0x${(it.itemId | 0).toString(16)}`.includes(filter)
            && !`0x${(it.serial >>> 0).toString(16)}`.includes(filter)) continue;
        if (count >= offset && page.length < limit) page.push(snapshotItem(it));
        count++;
      }
      return {
        count,
        offset,
        limit,
        items: page,
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      return snapshotItem(it);
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      // Bug-hunt #10 #2: was a raw `world.items.delete(serial)` which
      // bypassed reverse-index unlink + sector removal + child orphan
      // sweep + removeEntity broadcast. Use `destroyItem` so observers
      // immediately stop seeing the item and persistence stays clean.
      destroyItem(world, serial);
      const packet = sharedCtx?.protocol?.removeEntity?.(serial);
      let broadcast = 0;
      if (packet) {
        for (const mob of (world?.mobiles?.values?.() ?? [])) {
          if (!mob.client) continue;
          try { mob.client.send(packet); broadcast++; } catch { /* socket race */ }
        }
      }
      return { ok: true, broadcast };
    },
  });

  const entityContext = (serial) => {
    const id = parseSerial(serial), mobile = world?.mobiles?.get?.(id), item = world?.items?.get?.(id);
    const entity = mobile ?? item;
    if (!entity) return null;
    const regions = (sharedCtx?.regions?.all?.() ?? sharedCtx?.regions?.regions ?? []).filter((region) => (region.map | 0) === (entity.map | 0)
      && (region.rects ?? []).some((rect) => entity.x >= rect.x1 && entity.x <= rect.x2 && entity.y >= rect.y1 && entity.y <= rect.y2))
      .map((region) => ({ name: region.name, type: region.type, priority: region.priority }));
    const spawners = [...(sharedCtx?.spawner?.groups?.values?.() ?? [])].filter((group) => (group.map | 0) === (entity.map | 0) && group.rect
      && entity.x >= group.rect.x1 && entity.x <= group.rect.x2 && entity.y >= group.rect.y1 && entity.y <= group.rect.y2).map((group) => group.id);
    const ownerSerial = item?.parent ?? mobile?.controlMaster ?? null;
    const template = entity.template ?? entity.kind ?? entity.servuoClass ?? null;
    const quickLinks = {
      owner: ownerSerial ? { type: 'entity', serial: ownerSerial >>> 0 } : null,
      regions: regions.map((region) => ({ type: 'region', name: region.name })),
      template: template ? { type: 'template', name: String(template) } : null,
      spawners: spawners.map((id) => ({ type: 'spawner', id })),
    };
    return { type: mobile ? 'mobile' : 'item', entity: mobile ? snapshotMobile(mobile) : snapshotItem(item),
      regions, spawners, quickLinks };
  };
  routes.push({ method: 'GET', path: '/api/live/entity/:serial', run: ({ params }) => entityContext(params.serial) ?? { error: 'entity not found' } });
  routes.push({
    method: 'GET', path: '/api/live/entity/:serial/events',
    run: ({ params, query }) => {
      const id = parseSerial(params.serial), hex = `0x${id.toString(16)}`.toLowerCase(), decimal = String(id), limit = queryInt(query, 'limit', 200, 1, 2000);
      const matches = (entry) => { const text = JSON.stringify(entry).toLowerCase(); return text.includes(hex) || text.includes(decimal); };
      const session = operational.compatibilitySnapshot().sessions.find((entry) => (entry.mobileSerial >>> 0) === id);
      return { serial: hex, packets: session?.packets?.slice(-limit).reverse() ?? [],
        structured: operational.structuredSnapshot(2000).filter(matches).slice(0, limit), audit: operational.auditSnapshot(2000).filter(matches).slice(0, limit) };
    },
  });
  routes.push({
    method: 'GET', path: '/api/live/follow/:serial',
    run: ({ params }) => {
      const context = entityContext(params.serial); if (!context) return { error: 'entity not found' };
      const id = parseSerial(params.serial), session = operational.compatibilitySnapshot().sessions.find((entry) => (entry.mobileSerial >>> 0) === id);
      return { ...context, observedAt: Date.now(), client: session ?? null };
    },
  });
  routes.push({
    method: 'POST', path: '/api/live/mutate',
    run: ({ body }) => {
      const serial = parseSerial(body?.serial), mobile = world?.mobiles?.get?.(serial), item = world?.items?.get?.(serial), action = String(body?.action ?? '');
      if (!mobile && !item) return { error: 'entity not found' };
      if (!['kill', 'delete', 'move', 'hue'].includes(action)) return { error: 'action must be kill, delete, move or hue' };
      const before = mobile ? snapshotMobile(mobile) : snapshotItem(item);
      if (action === 'kill') {
        if (!mobile) return { error: 'kill requires a mobile' };
        mobile.hp = 0;
        const killMobile = sharedCtx?.corpse?.killMobile ?? sharedCtx?.systems?.corpse?.killMobile;
        if (typeof killMobile === 'function') killMobile(world, mobile, null); else world.destroyMobile?.(serial);
      } else if (action === 'delete') {
        if (mobile) world.destroyMobile?.(serial); else destroyItem(world, serial);
      } else if (action === 'move') {
        const entity = mobile ?? item, x = Number(body?.x), y = Number(body?.y), z = Number(body?.z ?? entity.z), map = Number(body?.map ?? entity.map);
        if (![x, y, z, map].every(Number.isFinite)) return { error: 'move requires finite x,y,z,map' };
        entity.x = x | 0; entity.y = y | 0; entity.z = z | 0; entity.map = Math.max(0, Math.min(5, map | 0));
        if (mobile) world?.sectors?.moveMobile?.(mobile); else world?.sectors?.moveItem?.(item);
      } else {
        const hue = Number(body?.hue); if (!Number.isFinite(hue)) return { error: 'hue requires a number' };
        (mobile ?? item).hue = Math.max(0, Math.min(0xffff, hue | 0));
      }
      const afterContext = entityContext(serial);
      return { ok: true, action, serial: `0x${serial.toString(16)}`, before, after: afterContext?.entity ?? null };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const result = sharedCtx?.ai?.inspect?.(serial);
      return result ?? { error: 'mobile has no attached AI behavior' };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai/:serial/path',
    run: ({ params, query }) => {
      const serial = parseSerial(params.serial);
      const target = parseSerial(query.get('target') ?? '0');
      const result = sharedCtx?.ai?.previewPath?.(serial, target);
      return result ?? { error: 'mobile has no attached AI behavior' };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai-graphs',
    run: () => ({ nodeTypes: [...AI_GRAPH_NODE_TYPES], graphs: sharedCtx?.aiGraphs?.list?.() ?? [] }),
  });

  routes.push({
    method: 'PUT', path: '/api/ai-graphs/:id',
    run: ({ params, body }) => sharedCtx?.aiGraphs?.save?.({ ...(body ?? {}), id: params.id })
      ?? { error: 'AI graph registry unavailable' },
  });

  routes.push({
    method: 'DELETE', path: '/api/ai-graphs/:id',
    run: ({ params }) => ({ ok: !!sharedCtx?.aiGraphs?.delete?.(params.id) }),
  });

  routes.push({
    method: 'POST', path: '/api/ai-graphs/:id/attach',
    run: ({ params, body }) => {
      const mob = world?.mobiles?.get?.(parseSerial(body?.serial));
      if (!mob) return { error: 'mobile not found' };
      return sharedCtx?.aiGraphs?.attach?.(mob, params.id)
        ? { ok: true, behavior: mob.aiBehavior } : { error: 'graph not found' };
    },
  });

  // ---- "Teleport ME" — server picks the admin's character ---------------
  //
  // Marcin's request: stop asking the UI for a mobile serial. The admin
  // is logged in, the server knows their account, look up the
  // characters there. If exactly one → teleport it. If more → return
  // 409 + the list so the UI shows a tiny picker modal.
  routes.push({
    method: 'POST', path: '/api/me/teleport',
    run: ({ session, body }) => {
      const chars = adminCharacters(session?.account, Number(body?.slot));
      if (!chars.length) return { error: 'no characters on this admin account' };
      if (chars.length > 1 && body?.slot == null) {
        return { needsPick: true, characters: chars.map((c) => ({
          slot: c.slot, name: c.name, mobileSerial: '0x' + (c.mobileSerial >>> 0).toString(16),
          online: c.online,
        })) };
      }
      const target = chars[0];
      if (!target.mob) return { error: `character "${target.name}" has no live mobile (offline?)` };
      // Resolve destination — three modes: explicit (x,y,z,map),
      // anchor item, anchor spawner. Picked by which body field is set.
      const mob = target.mob;
      let dest = null;
      if (body?.itemSerial) {
        const it = world?.items?.get?.(parseSerial(body.itemSerial));
        if (!it) return { error: 'item not found' };
        let anchor = it; let hops = 0;
        while (anchor.parent && hops++ < 8) {
          const p = world?.items?.get?.(anchor.parent)
                 ?? world?.mobiles?.get?.(anchor.parent);
          if (!p) break; anchor = p;
        }
        dest = { x: anchor.x | 0, y: anchor.y | 0, z: anchor.z | 0, map: anchor.map };
      } else if (body?.spawnerId) {
        const g = sharedCtx?.spawner?.groups?.get?.(body.spawnerId);
        if (!g?.rect) return { error: 'spawner not found' };
        dest = {
          x: ((g.rect.x1 + g.rect.x2) / 2) | 0,
          y: ((g.rect.y1 + g.rect.y2) / 2) | 0,
          z: 0, map: g.map,
        };
      } else if (Number.isFinite(body?.x) && Number.isFinite(body?.y)) {
        dest = { x: body.x | 0, y: body.y | 0, z: (body.z | 0) || mob.z, map: body.map };
      } else {
        return { error: 'pass itemSerial OR spawnerId OR (x,y[,z,map])' };
      }
      // Resolve standing Z so the admin doesn't end up at z=0 inside
      // the foundation of a multi-story building (Britain Bank floor
      // sits at z=20, etc.). Map editor / Static editor send z:0 by
      // convention — we substitute the proper standing z here so the
      // avatar lands ON the visible floor instead of underneath the
      // map. Skip the substitution when caller passed an explicit
      // non-zero z (item / spawner anchors carry meaningful z).
      if ((body?.z | 0) === 0 && (body?.x != null || body?.spawnerId)) {
        try {
          const standZ = resolveStandingZ(dest.map ?? mob.map ?? 1, dest.x, dest.y, dest.z);
          if (Number.isFinite(standZ)) dest.z = standZ;
        } catch { /* fall back to z=0 */ }
      }
      // CRITICAL: just mutating mob.x/y/z server-side leaves the
      // player's client + every nearby observer staring at the OLD
      // tile until the next 0x77 broadcast. Mirror what `[go` (the
      // canonical teleport command) does — remove from pre-observers,
      // update self, broadcast moving to post-observers.
      const protocol = sharedCtx?.protocol;
      const removeEntity = protocol?.removeEntity;
      const mobileUpdate = protocol?.mobileUpdate;
      const mobileMoving = protocol?.mobileMoving;
      const oldMap = mob.map;
      // Pre-observers: anyone within 18 tiles on the SAME map before
      // the move. They get a removeEntity packet.
      const preObservers = [];
      for (const m of world.mobiles.values()) {
        if (!m.client || m === mob) continue;
        if (m.map !== oldMap) continue;
        if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
        preObservers.push(m);
      }
      if (removeEntity) {
        const rm = removeEntity(mob.serial);
        for (const m of preObservers) m.client.send(rm);
      }
      mob.x = dest.x & 0xffff;
      mob.y = dest.y & 0xffff;
      mob.z = (dest.z | 0);
      if (Number.isFinite(dest.map)) mob.map = dest.map | 0;
      world?.sectors?.moveMobile?.(mob);
      // Self: mobileUpdate so the player's client snaps to the new
      // position (and re-requests nearby chunks via the normal flow).
      if (mob.client && mobileUpdate) {
        mob.client.send(mobileUpdate({
          serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0,
          x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
        }));
      }
      // Post-observers: anyone now within 18 tiles on the new map.
      if (mobileMoving) {
        const moving = mobileMoving({
          serial: mob.serial, body: mob.body,
          x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction ?? 0, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
        });
        for (const m of world.mobiles.values()) {
          if (!m.client || m === mob) continue;
          if (m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
          m.client.send(moving);
        }
      }
      // Push every nearby mob/item back to the teleporter — without this,
      // they snap to the new tile but see an empty viewport (the spawn
      // rect's mobs are server-side, but no client packet announces them
      // until the next 0x77 broadcast). Same code path as 0x22 resync.
      // The refresh can serialize hundreds of nearby entities. Defer it so
      // the admin HTTP response and button state are released immediately;
      // mobileUpdate above already moves the player on the client at once.
      if (mob.client) setImmediate(() => {
        try { scheduleRefreshSurroundings(mob.client, { priority: 0 }); }
        catch (e) { console.error('[admin/teleport] refreshSurroundings:', e.message); }
      });
      return {
        ok: true, character: target.name, mobileSerial: '0x' + (mob.serial >>> 0).toString(16),
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      };
    },
  });

  // Teleport ANY mobile to the location of an item. The item may be on the
  // ground (uses item.x/y/z) or worn / contained — in those cases we walk
  // the parent chain to find the eventual ground anchor (the worn-by mobile
  // or the chest's ground tile). Body: `{ mobileSerial: '0x...' }`.
  routes.push({
    method: 'POST', path: '/api/items/:serial/teleport',
    run: ({ params, body }) => {
      const itemSerial = parseSerial(params.serial);
      const mobSerial  = parseSerial(body?.mobileSerial);
      const it = world?.items?.get?.(itemSerial);
      if (!it) return { error: 'item not found' };
      const mob = world?.mobiles?.get?.(mobSerial);
      if (!mob) return { error: 'mobile not found (pass mobileSerial as 0x... in body)' };
      // Resolve to a ground tile by walking parent chain. A worn item's
      // "position" is the wearer's tile; a chest-contained item's
      // position is the chest's tile (which may itself be worn — keep
      // walking, max 8 hops to avoid pathological cycles).
      let anchor = it; let hops = 0;
      while (anchor.parent && hops++ < 8) {
        const p = world?.items?.get?.(anchor.parent)
               ?? world?.mobiles?.get?.(anchor.parent);
        if (!p) break;
        anchor = p;
      }
      if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) {
        return { error: 'item has no resolvable ground position' };
      }
      mob.x = anchor.x | 0;
      mob.y = anchor.y | 0;
      mob.z = anchor.z | 0;
      if (Number.isFinite(anchor.map)) mob.map = anchor.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
               anchorKind: anchor === it ? 'item' : 'parent' };
    },
  });

  // ---- Scripts (read / edit / create / delete) -------------------------
  routes.push({
    method: 'GET', path: '/api/scripts',
    run: () => {
      const tree = walkScriptTree(scriptsDir);
      return { root: scriptsDir, tree };
    },
  });

  routes.push({
    method: 'GET', path: '/api/scripts/file',
    run: ({ query }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      try {
        const content = fs.readFileSync(abs, 'utf8');
        const stat = fs.statSync(abs);
        return { path: rel, size: stat.size, mtime: Math.trunc(stat.mtimeMs), content };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/scripts/file',
    run: async ({ query, body }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      if (!/\.(?:js|mjs)$/i.test(rel)) return { error: 'script path must end in .js or .mjs' };
      if (typeof body?.content !== 'string') return { error: 'content (string) required' };
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const before = fs.existsSync(abs) ? fs.statSync(abs) : null;
        const expectedMtime = Number(body?.expectedMtime);
        if (before && Number.isFinite(expectedMtime)
            && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) {
          return { error: 'script changed on disk since it was opened', conflict: true };
        }
        let backup = null;
        if (before) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const bak = `${abs}.bak.${ts}`;
          fs.copyFileSync(abs, bak);
          backup = path.basename(bak);
        }
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, body.content, 'utf8');
        try { fs.renameSync(tmp, abs); }
        catch (e) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          throw e;
        }
        const stat = fs.statSync(abs);
        let reloaded = null;
        if (body?.reload && scriptRuntime?.reloadOne) {
          const t0 = Date.now();
          reloaded = { ...(await scriptRuntime.reloadOne(rel)), ms: Date.now() - t0 };
        }
        return {
          ok: true, path: rel, size: stat.size,
          mtime: Math.trunc(stat.mtimeMs), backup, reloaded,
        };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/scripts/file',
    run: ({ query }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(scriptsDir, rel);
      if (!abs) return { error: 'bad path' };
      try {
        fs.unlinkSync(abs);
        return { ok: true, path: rel };
      } catch (e) {
        return { error: e.message };
      }
    },
  });

  // ---- Spawners ---------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/spawners',
    run: () => {
      const groups = sharedCtx?.spawner?.groups;
      const list = groups ? [...groups.values()].map((g) => ({
        id: g.id, map: g.map, rect: g.rect,
        kinds: g.kinds, maxCount: g.maxCount,
        active: g.spawnedSerials?.size ?? 0,
        respawnMs: g.respawnMs,
        enabled: g.enabled !== false,
        proximityRange: g.proximityRange ?? 0,
        homeRange: g.homeRange ?? 10,
        roaming: g.roaming ?? 'home',
        team: g.team ?? 0,
        schedule: g.schedule ?? null,
        regionConditions: g.regionConditions ?? null,
        nextSpawnAt: g.nextSpawnAt ?? null,
        // Pre-computed center so the UI's "tp here" button doesn't need
        // to know the rect math. Floor to integer tile.
        center: g.rect ? {
          x: ((g.rect.x1 + g.rect.x2) / 2) | 0,
          y: ((g.rect.y1 + g.rect.y2) / 2) | 0,
        } : null,
        // Actual live spawn positions let the ISO editor show distribution
        // inside a rect instead of representing every group by one centre pin.
        activePositions: [...(g.spawnedSerials ?? [])].slice(0, 100).map((serial) => {
          const mob = world?.mobiles?.get?.(serial >>> 0);
          return mob ? { serial: '0x' + (mob.serial >>> 0).toString(16),
            x: mob.x | 0, y: mob.y | 0, z: mob.z | 0 } : null;
        }).filter(Boolean),
      })) : [];
      return { count: list.length, spawners: list };
    },
  });

  routes.push({
    method: 'POST', path: '/api/spawners/simulate',
    run: ({ body }) => {
      const checked = validateSpawnerDraft(body, sharedCtx?.monsters?.kinds?.() ?? []);
      return { ...checked, simulation: simulateSpawnerDraft(body, { rolls: body?.rolls, seed: body?.seed }) };
    },
  });

  routes.push({
    method: 'GET', path: '/api/spawners/diagnostics',
    run: () => spawnerDiagnostics(sharedCtx?.spawner, world),
  });

  routes.push({
    method: 'GET', path: '/api/spawners/templates',
    run: () => ({ templates: [
      { id: 'vendor', label: 'Vendor', value: { maxCount: 1, respawnMs: [60_000, 180_000], proximityRange: 24, homeRange: 1, roaming: 'stationary', team: 0, kinds: ['banker'] } },
      { id: 'town', label: 'Town life', value: { maxCount: 6, respawnMs: [120_000, 300_000], proximityRange: 36, homeRange: 12, roaming: 'home', team: 0, kinds: [['townsperson', 4], ['guard', 1]] } },
      { id: 'dungeon', label: 'Dungeon encounter', value: { maxCount: 8, respawnMs: [90_000, 240_000], proximityRange: 28, homeRange: 18, roaming: 'home', team: 1, kinds: [['skeleton', 4], ['zombie', 3], ['lich', 1]] } },
      { id: 'event', label: 'Scheduled event', value: { enabled: true, maxCount: 12, respawnMs: [30_000, 90_000], proximityRange: 48, homeRange: 24, roaming: 'home', team: 2, schedule: { days: [5, 6], startHour: 18, endHour: 23 }, kinds: [['orc', 4], ['ettin', 2], ['ogre', 1]] } },
    ] }),
  });

  routes.push({
    method: 'POST', path: '/api/spawners/bulk',
    run: ({ body }) => {
      const sp = sharedCtx?.spawner;
      if (!sp) return { error: 'spawner subsystem not wired' };
      const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String))].slice(0, 5000);
      const action = String(body?.action ?? '');
      if (!['move', 'enable', 'disable', 'delete'].includes(action)) return { error: 'action must be move, enable, disable or delete' };
      const results = [];
      for (const id of ids) {
        const group = sp.groups.get(id);
        if (!group) { results.push({ id, ok: false, error: 'not found' }); continue; }
        if (action === 'delete') sp.remove(id);
        else if (action === 'enable') group.enabled = true;
        else if (action === 'disable') group.enabled = false;
        else {
          const dx = Math.max(-65535, Math.min(65535, Number(body?.dx) | 0));
          const dy = Math.max(-65535, Math.min(65535, Number(body?.dy) | 0));
          group.rect = { x1: group.rect.x1 + dx, y1: group.rect.y1 + dy, x2: group.rect.x2 + dx, y2: group.rect.y2 + dy };
          if (body?.map != null) group.map = Math.max(0, Math.min(5, Number(body.map) | 0));
        }
        results.push({ id, ok: true });
      }
      return { ok: results.every((result) => result.ok), action, changed: results.filter((result) => result.ok).length, results };
    },
  });

  // Add OR replace a spawner — POST /api/spawners with the full group
  // payload. Body shape mirrors `Spawner.add()`:
  //   { id, map, rect:{x1,y1,x2,y2}, kinds:[...], maxCount,
  //     respawnMs:[lo,hi], proximityRange?, homeRange?, team? }
  routes.push({
    method: 'POST', path: '/api/spawners',
    run: ({ body }) => {
      const sp = sharedCtx?.spawner;
      if (!sp) return { error: 'spawner subsystem not wired' };
      const g = body ?? {};
      if (!g.id || typeof g.id !== 'string') return { error: 'id required (string)' };
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(g.id)) {
        return { error: 'id must use 1-80 letters, digits, dot, underscore, colon or dash' };
      }
      const rectValues = [g.rect?.x1, g.rect?.y1, g.rect?.x2, g.rect?.y2].map(Number);
      if (rectValues.some((n) => !Number.isFinite(n))) return { error: 'rect required {x1,y1,x2,y2}' };
      if (!Array.isArray(g.kinds) || g.kinds.length === 0) return { error: 'kinds required' };
      // Validate respawn bounds; the Spawner constructor swaps if reversed.
      if (!Array.isArray(g.respawnMs)) g.respawnMs = [30_000, 120_000];
      g.respawnMs = [
        Math.max(1000, Number(g.respawnMs[0]) || 30_000),
        Math.max(1000, Number(g.respawnMs[1]) || 120_000),
      ];
      g.maxCount = Math.max(1, Math.min(50, (g.maxCount | 0) || 5));
      g.enabled = g.enabled !== false;
      g.proximityRange = Math.max(0, Math.min(256, Number(g.proximityRange) | 0));
      g.homeRange = Math.max(0, Math.min(256, Number(g.homeRange) | 0));
      g.team = Math.max(-1, Math.min(255, Number(g.team) | 0));
      g.roaming = ['stationary', 'home', 'free'].includes(g.roaming) ? g.roaming : 'home';
      if (g.schedule && typeof g.schedule === 'object') {
        g.schedule = {
          days: Array.isArray(g.schedule.days) ? [...new Set(g.schedule.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))] : [],
          startHour: Math.max(0, Math.min(23, Number(g.schedule.startHour) | 0)),
          endHour: Math.max(0, Math.min(24, Number(g.schedule.endHour) | 0)),
        };
      } else g.schedule = null;
      if (g.regionConditions && typeof g.regionConditions === 'object') {
        g.regionConditions = {
          minPlayers: Math.max(0, Math.min(1000, Number(g.regionConditions.minPlayers) | 0)),
          maxPlayers: Math.max(0, Math.min(1000, Number(g.regionConditions.maxPlayers ?? 1000) | 0)),
          region: String(g.regionConditions.region ?? '').trim().slice(0, 80),
        };
      } else g.regionConditions = null;
      const map = Number(g.map);
      g.map = Number.isInteger(map) && map >= 0 && map <= 5 ? map : 1;
      g.rect = {
        x1: Math.min(rectValues[0], rectValues[2]) | 0,
        y1: Math.min(rectValues[1], rectValues[3]) | 0,
        x2: Math.max(rectValues[0], rectValues[2]) | 0,
        y2: Math.max(rectValues[1], rectValues[3]) | 0,
      };
      // Editing a live spawner must retain its tracked mobiles. Dropping the
      // Set orphaned them and the replacement immediately spawned duplicates.
      const previous = sp.groups.get(g.id);
      if (previous) {
        g.spawnedSerials = previous.spawnedSerials;
        g.nextSpawnAt = previous.nextSpawnAt;
      }
      sp.add(g);
      return { ok: true, id: g.id };
    },
  });

  // Remove a spawner by id. Active mobs are NOT despawned — they live
  // out their normal lifecycle (death / decay). Matches ServUO's
  // `Spawner.OnDelete` behaviour.
  routes.push({
    method: 'DELETE', path: '/api/spawners/:id',
    run: ({ params }) => {
      const sp = sharedCtx?.spawner;
      if (!sp) return { error: 'spawner subsystem not wired' };
      const had = sp.groups.has(params.id);
      sp.remove(params.id);
      return { ok: had, id: params.id };
    },
  });

  routes.push({
    method: 'POST', path: '/api/spawners/:id/respawn',
    run: ({ params }) => {
      const group = sharedCtx?.spawner?.groups?.get?.(params.id);
      if (!group) return { error: 'spawner not found' };
      group.nextSpawnAt = 0;
      sharedCtx.spawner.tick?.(Date.now());
      return { ok: true, id: params.id, active: group.spawnedSerials?.size ?? 0, nextSpawnAt: group.nextSpawnAt };
    },
  });

  // Enumerate spawnable monster kinds — fuels the "Add Spawner" modal
  // dropdown in the ISO editor. The monsters registry is the source of
  // truth for which `kind` strings the spawner.factory will resolve.
  routes.push({
    method: 'GET', path: '/api/monster-kinds',
    run: () => {
      const monsters = sharedCtx?.monsters;
      if (!monsters?.kinds) return { count: 0, kinds: [] };
      const kinds = monsters.kinds().map((k) => {
        const cfg = monsters.get(k) ?? {};
        return {
          kind: k,
          name: cfg.name ?? k,
          body: cfg.body ?? null,
          fame: cfg.fame ?? 0,
          // Classification hint for the modal's color-coded label —
          // matches the editor.html spawner-overlay classifier so the
          // dropdown UI can mirror the admin map's red/green coding.
          tier: cfg.fame >= 18000 ? 'boss'
              : cfg.fame >= 8000  ? 'paragon'
              : cfg.fame >= 1500  ? 'monster'
              : cfg.tameable      ? 'tame'
              : 'fauna',
        };
      });
      return { count: kinds.length, kinds };
    },
  });

  // Teleport a mob to the geometric centre of a spawner rect.
  routes.push({
    method: 'POST', path: '/api/spawners/:id/teleport',
    run: ({ params, body }) => {
      const groups = sharedCtx?.spawner?.groups;
      const g = groups?.get?.(params.id);
      if (!g || !g.rect) return { error: 'spawner not found / no rect' };
      const mobSerial = parseSerial(body?.mobileSerial);
      const mob = world?.mobiles?.get?.(mobSerial);
      if (!mob) return { error: 'mobile not found (pass mobileSerial 0x...)' };
      mob.x = ((g.rect.x1 + g.rect.x2) / 2) | 0;
      mob.y = ((g.rect.y1 + g.rect.y2) / 2) | 0;
      mob.z = 0;
      if (Number.isFinite(g.map)) mob.map = g.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map, spawner: g.id };
    },
  });

  // Paperdoll preview — composes the equipped layers on top of the
  // body silhouette into a single PNG so the admin UI can <img src=...>
  // it inline. Returns a 260×324 PNG (CUO paperdoll dims).
  // Layer order matches CUO `PaperDollInteractable` — back-most first.
  routes.push({
    method: 'GET', path: '/api/mobiles/:serial/paperdoll',
    run: async ({ params, res }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return undefined;
      }
      try {
        const png = await composePaperdoll(world, mob);
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-cache',
        });
        res.end(png);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return undefined;
    },
  });

  // ---- Logs (in-memory ring buffer; buildHandlers caller wires this) ---
  routes.push({
    method: 'GET', path: '/api/logs',
    run: ({ query }) => {
      const filter = String(query.get('filter') ?? '').toLowerCase(), level = String(query.get('level') ?? '').toLowerCase();
      const limit = queryInt(query, 'limit', 200, 1, 500);
      const lines = getLogTail(500).filter((entry) => {
        const text = entry.line.toLowerCase();
        return (!filter || text.includes(filter)) && (!level || text.includes(level));
      }).slice(-limit);
      return { lines, count: lines.length, filter, level };
    },
  });

  // ---- Data editor (read/write JSON config under apps/scripts/src/data) ----
  // Every route below is gated by `safeJoinData()` which refuses paths
  // escaping `apps/scripts/src/data/` via `..` or absolute resolution.
  // Writes always drop a `<file>.bak.<ts>` next to the target before
  // overwriting so the operator can roll back a bad edit. Reuses the
  // `DATA_ROOT` const declared higher up by the legacy textarea-editor
  // routes — duplicating it threw `SyntaxError: Identifier 'DATA_ROOT'
  // already declared` on boot.
  function safeJoinData(rel) {
    if (typeof rel !== 'string' || !rel) return null;
    const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (norm.includes('..')) return null;
    if (!/\.json$/i.test(norm)) return null;
    const abs = path.resolve(DATA_ROOT, norm);
    if (!abs.startsWith(DATA_ROOT + path.sep) && abs !== DATA_ROOT) return null;
    return abs;
  }
  function walkDataTree(dir, base = '') {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push({ type: 'dir', name: e.name, path: rel, children: walkDataTree(path.join(dir, e.name), rel) });
      } else if (e.isFile() && /\.json$/i.test(e.name)) {
        let size = 0; let mtime = 0;
        try { const st = fs.statSync(path.join(dir, e.name)); size = st.size; mtime = Math.trunc(st.mtimeMs); }
        catch { /* ignore */ }
        out.push({ type: 'file', name: e.name, path: rel, size, mtime });
      }
    }
    out.sort((a, b) => {
      // Directories first, then files; alphabetical within group.
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  // Note: there are pre-existing /api/data/{files,file} routes higher
  // up that power the legacy textarea editor (flat file list + raw
  // string content). The /api/data-tree/* family below is the parsed/
  // structured variant for the new tree-view visual editor: it returns
  // an actual nested directory tree plus a parsed JSON value (vs raw
  // string) so the client doesn't have to re-parse on every open and
  // PUTs come with a five-deep backup rotation.
  routes.push({
    method: 'GET', path: '/api/data-tree/files',
    run: () => ({ root: 'apps/scripts/src/data', tree: walkDataTree(DATA_ROOT) }),
  });

  routes.push({
    method: 'GET', path: '/api/data-tree/file',
    run: ({ query }) => {
      const abs = safeJoinData(query?.get?.('path'));
      if (!abs) return { error: 'invalid path (must be under apps/scripts/src/data/*.json)' };
      try {
        const text = fs.readFileSync(abs, 'utf8');
        const data = JSON.parse(text);
        const st = fs.statSync(abs);
        return { path: query.get('path'), size: st.size, mtime: Math.trunc(st.mtimeMs), data };
      } catch (e) {
        return { error: `read failed: ${e.message}` };
      }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/data-tree/file',
    run: async ({ query, body }) => {
      const abs = safeJoinData(query?.get?.('path'));
      if (!abs) return { error: 'invalid path (must be under apps/scripts/src/data/*.json)' };
      if (body == null) return { error: 'missing JSON body' };
      const data = body?.data;
      if (data === undefined) return { error: 'body.data required (the JSON value to persist)' };
      try {
        const before = fs.existsSync(abs) ? fs.statSync(abs) : null;
        const expectedMtime = Number(body?.expectedMtime);
        if (before && Number.isFinite(expectedMtime)
            && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) {
          return {
            error: 'file changed on disk since it was opened',
            conflict: true,
            expectedMtime: Math.trunc(expectedMtime),
            actualMtime: Math.trunc(before.mtimeMs),
          };
        }
        // Round-trip through JSON.stringify to guarantee deterministic
        // output + reject NaN/Infinity/functions sneaking through the
        // PUT (those would throw on next server boot).
        const text = JSON.stringify(data, null, body?.pretty === false ? 0 : 2);
        // Backup before overwrite — keeps the last 5 versions so the
        // operator can compare a regression without git history.
        let backup = null;
        if (before) {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const bak = `${abs}.bak.${ts}`;
            fs.copyFileSync(abs, bak);
            backup = path.basename(bak);
            // Prune older backups beyond 5 keepers.
            const dir = path.dirname(abs);
            const base = path.basename(abs);
            const bakRe = new RegExp(`^${base.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\.bak\\.`);
            const baks = fs.readdirSync(dir)
              .filter((f) => bakRe.test(f))
              .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t);
            for (const b of baks.slice(5)) {
              try { fs.unlinkSync(path.join(dir, b.f)); } catch { /* ignore */ }
            }
          } catch (e) {
            return { error: `backup failed; original was not changed: ${e.message}` };
          }
        }
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmp, text, 'utf8');
        try { fs.renameSync(tmp, abs); }
        catch (e) {
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
          throw e;
        }
        const st = fs.statSync(abs);
        let reloaded = null;
        if (body?.reload && scriptRuntime?.load) {
          const t0 = Date.now();
          await scriptRuntime.load({ reason: `admin-data-tree:${query.get('path')}`, emitEvent: true });
          reloaded = { ms: Date.now() - t0, loaded: scriptRuntime.loaded?.length ?? 0 };
        }
        return {
          ok: true,
          path: query.get('path'),
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
          backup,
          reloaded,
          before: before ? { size: before.size, mtime: Math.trunc(before.mtimeMs) } : null,
          after: { size: st.size, mtime: Math.trunc(st.mtimeMs) },
        };
      } catch (e) {
        return { error: `write failed: ${e.message}` };
      }
    },
  });

  return routes;
}

// ---- snapshot helpers ----------------------------------------------------

function snapshotMobile(mob) {
  return {
    serial: '0x' + (mob.serial >>> 0).toString(16),
    name: mob.name,
    body: mob.body,
    hue: mob.hue,
    x: mob.x, y: mob.y, z: mob.z, map: mob.map,
    direction: mob.direction,
    notoriety: mob.notoriety,
    hp: mob.hp, hpMax: mob.hpMax,
    mana: mob.mana, manaMax: mob.manaMax,
    stam: mob.stam, stamMax: mob.stamMax,
    str: mob.str, dex: mob.dex, int: mob.int,
    gold: mob.gold,
    sex: mob.sex,
    isPlayer: !!mob.isPlayer,
    online: !!mob.client,
    accountName: mob.accountName,
    client: mob.client ? {
      id: mob.client.id ?? null,
      version: mob.client.clientVersionString ?? null,
      transport: mob.client.nodeUOTransport ? 'nodeuo.v1' : 'standard-uo',
      capabilities: mob.client.nodeUOCapabilities >>> 0,
      pendingBytes: Number(mob.client.ws?.bufferedAmount ?? mob.client.socket?.writableLength ?? 0) || 0,
    } : null,
    // Civic-NPC tag exposed for the admin "Vendors" filter — without
    // it the UI couldn't tell a banker from a wild orc and the
    // operator's "where are my shopkeepers" lookup blended into the
    // monster list.
    vendorKind: mob.vendorKind ?? null,
    kind: mob.kind ?? null,
  };
}

function snapshotItem(it) {
  return {
    serial: '0x' + (it.serial >>> 0).toString(16),
    itemId: it.itemId, hue: it.hue, amount: it.amount,
    x: it.x, y: it.y, z: it.z, map: it.map,
    parent: it.parent ? '0x' + (it.parent >>> 0).toString(16) : null,
    layer: it.layer,
    name: it.name,
    movable: it.movable,
    gumpId: it.gumpId,
  };
}

function parseSerial(s) {
  if (!s) return 0;
  if (typeof s === 'string' && (s.startsWith('0x') || s.startsWith('0X'))) return parseInt(s, 16) >>> 0;
  return Number(s) >>> 0;
}

function safeJoin(root, rel) {
  if (!rel) return null;
  // Reject path traversal.
  const normalized = path.normalize(rel).replace(/^[/\\]+/, '');
  if (normalized.includes('..')) return null;
  const abs = path.join(root, normalized);
  if (!abs.startsWith(root)) return null;
  return abs;
}

function walkScriptTree(dir, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: rel, children: walkScriptTree(path.join(dir, e.name), rel) });
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
      out.push({ type: 'file', name: e.name, path: rel, size });
    }
  }
  return out;
}

// Tiny ring buffer hooked from main.js via `attachLogHook(line)`.
const LOG_RING = [];
const LOG_MAX = 500;
export function pushLogLine(line) {
  LOG_RING.push({ ts: Date.now(), line: String(line).slice(0, 1024) });
  while (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}
function getLogTail(limit = 200) { return LOG_RING.slice(-Math.max(1, Math.min(LOG_MAX, limit | 0))); }
