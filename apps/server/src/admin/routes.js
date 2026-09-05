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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { composePaperdoll, extractGumpTile } from './paperdoll.js';
import { landProvider } from '../world/land-provider.js';
import { invalidateLosCache } from '../world/los.js';
import { simulateCombat } from '../systems/combat-simulator.js';
import { animationBodySnapshot, animationFramePng, validateMonsterAnimations } from './animation-catalog.js';
import { staticArtPng, staticArtStatus } from './static-art.js';
import {
  regionDiagnostics, simulateSpawnerDraft, spawnerDiagnostics, spawnerHeatmap, validateLootDraft, validateQuestDraft,
  validateRegionDraft, validateSpawnerDraft,
} from './world-authoring.js';
import * as operational from '../systems/operational-diagnostics.js';
import { CURRENT_SNAPSHOT_VERSION, migrateSnapshot, planSnapshotMigration } from '../world/persistence-migrations.js';
import { createWorldDatabaseBackup, verifyWorldDatabaseFileSync } from '../world/sqlite-store.js';
import { buildServerQualityReport, runtimeGovernor } from '../systems/runtime-governor.js';
import { runtimeServiceLevels } from '../systems/service-levels.js';
import {
  applyEngineBudgets, DEFAULT_ADMIN_PERFORMANCE_BUDGETS, normalizeClientBudgets,
  normalizeEngineBudgets, normalizePerformanceBudgets,
} from './performance-budgets.js';
import { registerEntityRoutes } from './entity-routes.js';
import { registerWorldEditRoutes } from './world-edit-routes.js';
import { registerAssetRoutes } from './asset-routes.js';
import { registerNodeUORoutes } from './nodeuo-routes.js';
import { registerScriptStudioRoutes } from './script-studio-routes.js';
import { registerOperationsInsightRoutes } from './operations-insights.js';
import { registerAlertRoutes } from './alert-routes.js';
import { registerVerificationRoutes } from './verification-routes.js';
import { registerPlatformRoutes } from './platform-routes.js';
import { registerGameSystemRoutes } from './game-system-routes.js';
import { ContentProfileStore } from './content-profile-store.js';
import { resolveAdminCharacters } from './admin-characters.js';
import { notifyNodeUOAssetChanged } from '../net/handlers/nodeuo-modern.js';
import {
  flattenScriptTree, getLogTail, parseSerial, safeJoin, validateStudioDraft, walkScriptTree,
} from './route-helpers.js';
export { pushLogLine } from './route-helpers.js';

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

  const adminCharacters = (sessionAccount, preferredSlot) => resolveAdminCharacters(
    { world, accounts }, sessionAccount, preferredSlot,
  );

  const routes = [];
  const repoRoot = path.resolve(scriptsDir, '../../..');
  // Documentation belongs to the checked-out engine, not to the mutable
  // scriptsDir supplied to fixtures or an external content pack. Resolving it
  // from this module keeps /docs stable while still allowing the live content
  // inventory below to describe the active scripts directory.
  const sourceRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const featureFile = path.join(saveDir, 'admin-feature-flags.json');
  const performanceBudgetFile = path.join(saveDir, 'admin-performance-budgets.json');
  const preferencesFile = path.join(saveDir, 'admin-preferences.json');
  const readJsonState = (file, fallback) => { try { return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return structuredClone(fallback); } };
  const writeJsonState = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2)); fs.renameSync(temp, file); };
  let featureFlags = readJsonState(featureFile, { revision: 1, flags: {} });
  let performanceBudgets = normalizePerformanceBudgets(
    readJsonState(performanceBudgetFile, DEFAULT_ADMIN_PERFORMANCE_BUDGETS),
  );
  applyEngineBudgets(sharedCtx, performanceBudgets.engine);
  let administratorPreferences = readJsonState(preferencesFile, { users: {} });
  const testJobs = new Map();
  const adminClientMetrics = new Map();
  let testJobSequence = 0;
  const clientAssetsDir = path.join(repoRoot, 'apps/client/public/assets');
  const studioAssetCatalogCache = new Map();
  let studioAppearanceAssets = null;


  function readClientAssetJson(name) {
    const file = path.join(clientAssetsDir, name);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  function uoColorCss(value) {
    const color = Number(value) & 0x7fff;
    const channel = (bits) => Math.round(((color >>> bits) & 31) * 255 / 31).toString(16).padStart(2, '0');
    return `#${channel(10)}${channel(5)}${channel(0)}`;
  }

  function resolveStudioItemAppearance(artId) {
    const id = Number(artId);
    if (!Number.isInteger(id) || id < 0 || id > 0xFFFF) return { error: 'artId must be in range 0..65535' };
    try {
      studioAppearanceAssets ||= {
        tiledata: readClientAssetJson('tiledata.json'),
        gumps: readClientAssetJson('gump-atlas.json'),
        mobiles: (() => {
          try { return readClientAssetJson('mobiles-atlas-index.json'); }
          catch { return readClientAssetJson('mobiles-atlas.json'); }
        })(),
      };
      const tile = studioAppearanceAssets.tiledata?.statics?.[id] ?? null;
      const tiles = studioAppearanceAssets.gumps?.tiles ?? {};
      const equipConv = studioAppearanceAssets.mobiles?.equipConv ?? {};
      const convertedBase = (body) => {
        let gump = Number(equipConv?.[body]?.[id]?.gump ?? 0) | 0;
        if (gump >= 60000) gump -= 60000;
        else if (gump >= 50000) gump -= 50000;
        return gump > 0 ? gump : 0;
      };
      const base = convertedBase(400) || convertedBase(401) || (Number(tile?.animId) | 0);
      const maleCandidate = base > 0 ? base + 50000 : id + 50000;
      const femaleCandidate = base > 0 ? base + 60000 : id + 60000;
      const male = tiles[maleCandidate] ? maleCandidate : 0;
      const femaleSpecific = tiles[femaleCandidate] ? femaleCandidate : 0;
      const female = femaleSpecific || male;
      return {
        artId: id,
        tileName: String(tile?.name ?? '').trim(),
        tileLayer: Number(tile?.layer ?? 0) | 0,
        animationId: Number(tile?.animId ?? 0) | 0,
        maleGumpId: male,
        femaleGumpId: female,
        femaleSpecificGumpId: femaleSpecific,
        source: convertedBase(400) || convertedBase(401) ? 'equipconv'
          : Number(tile?.animId) > 0 ? 'tiledata' : male ? 'legacy-art-offset' : 'missing',
        renderable: !!male,
      };
    } catch (error) {
      return { artId: id, error: `appearance assets unavailable: ${error.message}`, renderable: false };
    }
  }

  // Lazily materialized because atlas manifests are large and must not slow
  // normal shard startup.  The picker requests only one bounded page.
  function studioAssetCatalog(kind) {
    if (studioAssetCatalogCache.has(kind)) return studioAssetCatalogCache.get(kind);
    let entries = [];
    let customAssets = {};
    try { customAssets = JSON.parse(fs.readFileSync(path.join(clientAssetsDir, 'asset-overrides.json'), 'utf8')); }
    catch { /* optional custom asset layer */ }
    if (kind === 'item') {
      const atlas = readClientAssetJson('static-atlas.json');
      let tiledata = {};
      try { tiledata = readClientAssetJson('tiledata.json'); } catch { /* optional */ }
      const seen = new Set();
      entries = Object.entries(atlas.tiles ?? {}).map(([globalId, tile]) => {
        const numeric = Number(globalId);
        const id = numeric >= 0x4000 ? numeric - 0x4000 : numeric;
        if (id < 0 || id > 0xffff || seen.has(id)) return null;
        seen.add(id);
        const name = String(tiledata.statics?.[id]?.name ?? '').trim();
        const custom = customAssets.static?.[id];
        return { id, name: custom?.name || name || `Item 0x${id.toString(16).padStart(4, '0')}`, width: custom?.width ?? tile.w, height: custom?.height ?? tile.h,
          source: custom ? 'custom-override' : 'ultima', preview: `/api/assets/editor/preview/static/${id}` };
      }).filter(Boolean);
      for (const [rawId, custom] of Object.entries(customAssets.static ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom item ${id}`, width: custom.width, height: custom.height,
          source: 'custom', preview: `/api/assets/editor/preview/static/${id}` });
      }
    } else if (kind === 'gump') {
      const atlas = readClientAssetJson('gump-atlas.json');
      entries = Object.entries(atlas.tiles ?? {}).map(([id, tile]) => ({
        id: Number(id), name: `Gump 0x${Number(id).toString(16).padStart(4, '0')}`,
        width: customAssets.gump?.[id]?.width ?? tile.w, height: customAssets.gump?.[id]?.height ?? tile.h,
        source: customAssets.gump?.[id] ? 'custom-override' : 'ultima', preview: `/api/assets/editor/preview/gump/${Number(id)}`,
      }));
      const seen = new Set(entries.map((entry) => entry.id));
      for (const [rawId, custom] of Object.entries(customAssets.gump ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom gump ${id}`, width: custom.width, height: custom.height,
          source: 'custom', preview: `/api/assets/editor/preview/gump/${id}` });
      }
    } else if (kind === 'body') {
      let atlas;
      try { atlas = readClientAssetJson('mobiles-atlas-index.json'); }
      catch { atlas = readClientAssetJson('mobiles-atlas.json'); }
      const names = new Map();
      for (const relative of ['config/monsters.json', 'config/npcs.json']) {
        try {
          const rows = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'data', relative), 'utf8'));
          for (const row of (Array.isArray(rows) ? rows : [])) {
            const body = Number(row?.bodyId ?? row?.body);
            if (!Number.isFinite(body)) continue;
            const label = String(row.name ?? row.definitionId ?? row.kind ?? '').trim();
            if (label) {
              if (!names.has(body)) names.set(body, new Set());
              names.get(body).add(label);
            }
          }
        } catch { /* optional authoring data */ }
      }
      const bodyIds = atlas.shards
        ? Object.values(atlas.shards).flatMap((row) => row.bodyIds ?? [])
        : Object.keys(atlas.bodies ?? {}).map(Number);
      entries = bodyIds.map((id) => {
        const body = Number(id);
        const type = atlas.mobTypes?.[id]?.type;
        const variants = [...(names.get(body) ?? [])];
        const variantLabel = variants.length
          ? `${variants.slice(0, 3).join(' / ')}${variants.length > 3 ? ` (+${variants.length - 3})` : ''}`
          : null;
        const custom = customAssets.animation?.[body];
        return { id: body, name: custom?.name ?? variantLabel ?? `${type ? `${type.toLowerCase()} ` : ''}body 0x${body.toString(16)}`,
          definitions: variants.length,
          source: custom ? 'custom-override' : 'ultima',
          preview: custom ? `/api/assets/editor/preview/animation/${body}` : `/api/studio/body-art/${body}` };
      });
      const seen = new Set(entries.map((entry) => entry.id));
      for (const [rawId, custom] of Object.entries(customAssets.animation ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom mobile ${id}`, definitions: 0,
          source: 'custom', preview: `/api/assets/editor/preview/animation/${id}` });
      }
    } else if (kind === 'hue') {
      const source = readClientAssetJson('hues.json');
      entries = [{ id: 0, name: 'No hue / natural color', color: '#ffffff' }, ...(source.hues ?? []).map((hue, index) => ({
        id: index + 1, name: String(hue.name ?? '').trim() || `Hue ${index + 1}`,
        color: uoColorCss(hue.tableEnd ?? hue.tableStart ?? 0),
      }))];
    }
    entries.sort((a, b) => a.id - b.id);
    studioAssetCatalogCache.set(kind, entries);
    return entries;
  }

  // ---- Unified content studio ------------------------------------------
  // One metadata catalogue powers dedicated visual editors without copying
  // persistence logic into twenty different pages. Every entry points at the
  // canonical JSON source used by gameplay scripts; writes still go through
  // /api/data-tree/file (backup + optimistic mtime check + optional reload).
  const studioDomains = [
    { id:'mobiles', label:'Mobiles & AI', icon:'🐉', files:['config/monsters.json','config/npcs.json'], preview:'mobile', tags:['definitionId','bodyId','hue','stats','skills','ai','equipment','loot','resists','mount','pet'] },
    { id:'items', label:'Item definitions', icon:'⚔️', files:['config/items.json','config/item-types.json'], preview:'item', tags:['definitionId','artId','hue','paperdoll','layer','weight','container','script'] },
    { id:'housing', label:'House customization', icon:'🏠', files:['config/housedata.json'], preview:'housing', tags:['walls','doors','floors','stairs','roofs','styles','pieces','cliloc'] },
    { id:'links', label:'Doors, signs & teleporters', icon:'🚪', files:['world/signs.json','world/teleporters.json'], preview:'link', tags:['door','sign','teleporter','links'] },
    { id:'vendors', label:'Vendor stock & store', icon:'🛒', files:['config/vendor-inventory.json','config/store-catalogue.json'], preview:'vendor', tags:['buy','sell','price','stock','restock','store','sku'] },
    { id:'crafting', label:'Crafting', icon:'🛠️', files:['config/recipes.json','config/magincia-recipes.json'], preview:'craft', tags:['profession','recipe','requirements','materials','chance','result','dependencies'] },
    { id:'skills', label:'Skills', icon:'📈', files:['config/skills.json'], preview:'skill', tags:['id','cap','gain','handler'] },
    { id:'spells', label:'Spells', icon:'✨', files:['config/spells.json','config/reagents.json'], preview:'spell', tags:['circle','mana','reagents','target','effect','lifecycle'] },
    { id:'magic', label:'Magic properties & poison', icon:'🛡️', files:['config/magic-properties.json','config/poison-levels.json'], preview:'combat', tags:['attribute','intensity','poison','damage','chance'] },
    { id:'loot', label:'Loot tables', icon:'💎', files:['config/loot-tables.json','config/loot-packs.json','world/artifacts.json','world/eodon-artifacts.json'], preview:'loot', tags:['nested','weight','simulation','drop'] },
    { id:'quests', label:'Quests & dialogue', icon:'📜', files:['world/quest-chains.json','world/quests-extracted.json','world/quest-reward-items.json'], preview:'quest', tags:['graph','step','condition','dialog','reward'] },
    { id:'books', label:'Books, BOD & collections', icon:'📚', files:['world/books-extended.json','world/books.servuo.generated.json','world/anniversary-tiers.json'], preview:'book', tags:['book','bod','collection','achievement'] },
    { id:'environment', label:'Weather, seasons & events', icon:'🌦️', files:['world/seasonal-events.json','world/camps.json','world/revamped-dungeons.json'], preview:'environment', tags:['weather','season','day','night','calendar','scheduler'] },
    { id:'world', label:'Regions, spawners & world', icon:'🗺️', files:['world/xmlspawners.json'], preview:'world', tags:['region','geometry','guards','music','spawner','spawn area','mobile'] },
    { id:'multis', label:'Multis & buildings', icon:'🏛️', files:[], preview:'multi',
      workbench:'/assets-workbench?kind=multi&embedded=1',
      tags:['multi','house','boat','building','isometric','doors','windows','override','blueprint'] },
    { id:'gumps', label:'Gumps & layouts', icon:'🪟', files:['config/gumps.json','config/server-gump-catalog.json','@client/client-gumps.json'], preview:'gump', tags:['layout','drag','resize','overflow','dialog','client-preview','server-source','json'] },
    { id:'game-systems', label:'Game systems', icon:'🎲', files:['config/game-systems.json'], preview:'game-system', tags:['activity','stages','events','rewards','client','compatibility'] },
  ];
  const clientGumpDefinitionsFile = path.join(sourceRepoRoot, 'apps/client/public/client-gumps.json');
  const studioProfileSources = [];
  const profileSourceRoot = path.join(scriptsDir, 'data');
  const pendingProfileDirs = [profileSourceRoot];
  while (pendingProfileDirs.length) {
    const directory = pendingProfileDirs.pop();
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { /* optional tree */ }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pendingProfileDirs.push(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        studioProfileSources.push({ key: path.relative(profileSourceRoot, file).replaceAll('\\', '/'), file });
      }
    }
  }
  studioProfileSources.push({ key: '@client/client-gumps.json', file: clientGumpDefinitionsFile });
  const contentProfiles = new ContentProfileStore({
    rootDir: path.join(saveDir, 'content-studio-profiles'),
    sources: studioProfileSources,
  });

  const scriptingDocPages = [
    { id:'start', title:'Start', icon:'start', kicker:'model and first script', source:'docs/scripting/getting-started.md' },
    { id:'api', title:'Server API', icon:'api', kicker:'complete API guide', source:'docs/server-scripting.md' },
    { id:'studio', title:'Script Studio', icon:'studio', kicker:'generate, validate, and hot reload', source:'docs/scripting/script-studio.md' },
    { id:'gumps', title:'Gumps', icon:'gumps', kicker:'server, client, and JSON', source:'docs/scripting/gumps.md' },
    { id:'config', title:'Configuration', icon:'config', kicker:'identity and publishing', source:'docs/scripting/configuration.md' },
    { id:'examples', title:'Examples', icon:'examples', kicker:'complete patterns', source:'docs/scripting/examples.md' },
    { id:'data', title:'Data catalog', icon:'data', kicker:'complete file taxonomy', source:'apps/scripts/src/data/README.md' },
    { id:'systems', title:'Game systems', icon:'systems', kicker:'architecture and complete catalog', source:'docs/game-systems/overview.md' },
    { id:'authoring', title:'System tutorial', icon:'authoring', kicker:'add, edit, validate, and publish', source:'docs/game-systems/authoring-tutorial.md' },
    { id:'compatibility', title:'Client compatibility', icon:'compatibility', kicker:'Classic UO and NodeUO behavior', source:'docs/game-systems/compatibility.md' },
    { id:'runtime', title:'Systems API', icon:'runtime', kicker:'scripts, events, persistence, and admin', source:'docs/game-systems/runtime-api.md' },
    { id:'iso-world-editor', title:'ISO world editor', icon:'world', kicker:'terrain, statics, paths, prefabs, houses, and multis', source:'docs/admin/iso-world-editor.md' },
  ];

  const countFiles = (root, extension) => {
    let total = 0;
    const pending = [root];
    while (pending.length) {
      const current = pending.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (!extension || entry.name.endsWith(extension)) total++;
      }
    }
    return total;
  };

  routes.push({
    method: 'GET', path: '/api/docs/scripting',
    run: () => {
      const pages = scriptingDocPages.map((page) => {
        const full = path.join(sourceRepoRoot, ...page.source.split('/'));
        try {
          const stat = fs.statSync(full);
          return { ...page, updatedAt: stat.mtimeMs, content: fs.readFileSync(full, 'utf8') };
        } catch {
          return { ...page, updatedAt: 0, content: `# ${page.title}\n\nDocument \`${page.source}\` is unavailable in this installation.` };
        }
      });
      const readArrayLength = (full) => {
        try { const value = JSON.parse(fs.readFileSync(full, 'utf8')); return Array.isArray(value) ? value.length : 0; }
        catch { return 0; }
      };
      const clientGumps = readArrayLength(path.join(sourceRepoRoot, 'apps/client/public/client-gumps.json'));
      const serverGumps = readArrayLength(path.join(scriptsDir, 'data/config/gumps.json'))
        + readArrayLength(path.join(scriptsDir, 'data/config/server-gump-catalog.json'));
      return {
        version: 1,
        generatedAt: Date.now(),
        pages,
        inventory: {
          scripts: countFiles(scriptsDir, '.js'),
          configs: countFiles(path.join(scriptsDir, 'data/config'), '.json'),
          clientGumps,
          serverGumps,
        },
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/studio/catalog',
    run: () => ({
      domains: studioDomains.map((domain) => ({
        ...domain,
        files: domain.files.filter((rel) => rel === '@client/client-gumps.json'
          ? fs.existsSync(path.join(sourceRepoRoot, 'apps/client/public/client-gumps.json'))
          : fs.existsSync(path.join(scriptsDir, 'data', rel))),
      })),
      capabilities: {
        drafts: true, optimisticConcurrency: true, diffPreview: true,
        undoRedo: true, importExport: true, bulkEdit: true, profiles: true, liveReload: !!scriptRuntime,
      },
    }),
  });
  routes.push({
    method: 'GET', path: '/api/studio/profiles',
    run: () => contentProfiles.state(),
  });
  routes.push({
    method: 'POST', path: '/api/studio/profiles',
    run: ({ session, body }) => contentProfiles.create(body?.label, { actor: session?.account }),
  });
  routes.push({
    method: 'GET', path: '/api/studio/profiles/:id/export',
    run: ({ params }) => contentProfiles.export(params.id),
  });
  routes.push({
    method: 'DELETE', path: '/api/studio/profiles/:id',
    run: ({ session, params }) => contentProfiles.remove(params.id, { actor: session?.account }),
  });
  routes.push({
    method: 'POST', path: '/api/studio/profiles/:id/restore',
    run: async ({ session, params }) => {
      const result = contentProfiles.restore(params.id, { actor: session?.account });
      if (!result.ok) return result;
      studioAssetCatalogCache.clear();
      studioAppearanceAssets = null;
      if (!scriptRuntime?.load) return { ...result, clientRefreshRequired: true };
      const started = Date.now();
      try {
        await scriptRuntime.load({ reason: `content-profile:${params.id}`, emitEvent: true });
        return { ...result, reloaded: { ok: true, ms: Date.now() - started,
          loaded: scriptRuntime.loaded?.length ?? 0 }, clientRefreshRequired: true };
      } catch (error) {
        return { ...result, reloaded: { ok: false, error: error.message }, clientRefreshRequired: true };
      }
    },
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
    method: 'GET', path: '/api/studio/asset-catalog',
    run: ({ query }) => {
      const kind = String(query?.get?.('kind') ?? '').toLowerCase();
      if (!['item', 'gump', 'body', 'hue'].includes(kind)) return { error: 'kind must be item, gump, body, or hue' };
      const offset = queryInt(query, 'offset', 0, 0, 1_000_000);
      const limit = queryInt(query, 'limit', 96, 1, 200);
      const q = String(query?.get?.('q') ?? '').trim().toLowerCase();
      const numeric = q ? Number.parseInt(q.replace(/^0x/, ''), /^0x/.test(q) ? 16 : 10) : Number.NaN;
      const all = studioAssetCatalog(kind);
      const filtered = q ? all.filter((entry) => entry.id === numeric
        || String(entry.name ?? '').toLowerCase().includes(q)
        || `0x${entry.id.toString(16)}`.includes(q)) : all;
      return { kind, offset, limit, total: filtered.length, entries: filtered.slice(offset, offset + limit) };
    },
  });

  routes.push({
    method: 'GET', path: '/api/studio/item-appearance',
    run: ({ query }) => resolveStudioItemAppearance(query?.get?.('artId')),
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
    method: 'GET', path: '/api/studio/body-art/:body',
    run: async ({ params, res }) => {
      const body = parseSerial(params.body);
      const snapshot = animationBodySnapshot(body);
      const action = snapshot.resolvedActions?.idle ?? snapshot.actions?.[0]?.action;
      const actionInfo = snapshot.actions?.find?.((entry) => entry.action === action) ?? snapshot.actions?.[0];
      const direction = actionInfo?.directions?.find?.((entry) => entry.frames > 0)?.direction ?? 0;
      const png = Number.isFinite(action) ? await animationFramePng(body, action, direction, 0) : null;
      if (!png) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `mobile body ${body} has no renderable frame` }));
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
      res.end(png);
      return undefined;
    },
  });

  routes.push({
    method: 'GET', path: '/api/studio/gump-art/:gumpId',
    run: async ({ params, res }) => {
      const gumpId = parseSerial(params.gumpId);
      const png = await extractGumpTile(gumpId);
      if (!png) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `gump art ${gumpId} not found` }));
        return undefined;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(png);
      return undefined;
    },
  });

  let studioScriptCatalogCache = null;
  routes.push({
    method: 'GET', path: '/api/studio/script-catalog',
    run: () => {
      if (studioScriptCatalogCache?.expiresAt > Date.now()) return studioScriptCatalogCache.value;
      const files = flattenScriptTree(walkScriptTree(scriptsDir));
      const aiLive = new Set(sharedCtx?.ai?.behaviors?.keys?.() ?? []);
      const itemLive = new Map((sharedCtx?.systems?.itemScripts?.all?.() ?? [])
        .map((script) => [String(script.name), script]));
      const ai = new Map();
      const items = new Map();
      const spells = new Map();
      for (const entry of files) {
        if (!/\.(?:js|mjs)$/i.test(entry.path)) continue;
        let source = '';
        try { source = fs.readFileSync(path.join(scriptsDir, entry.path), 'utf8'); } catch { continue; }
        if (/^npcs\/ai\//i.test(entry.path)) {
          const names = new Set();
          for (const match of source.matchAll(/registerBehavior\s*\(\s*\{[\s\S]{0,240}?name\s*:\s*['"`]([^'"`]+)['"`]/g)) names.add(match[1]);
          for (const match of source.matchAll(/registerCasterBehavior\s*\([\s\S]{0,180}?name\s*:\s*['"`]([^'"`]+)['"`]/g)) names.add(match[1]);
          if (!names.size && !entry.name.startsWith('_')) names.add(entry.name.replace(/-ai\.(?:js|mjs)$/i, '').replace(/\.(?:js|mjs)$/i, ''));
          for (const name of names) ai.set(name, { name, path: entry.path, live: aiLive.has(name) });
        }
        if (/^items\//i.test(entry.path)) {
          for (const name of itemLive.keys()) {
            const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``];
            if (quoted.some((needle) => source.includes(needle)) && !items.has(name)) {
              const script = itemLive.get(name);
              items.set(name, {
                name, path: entry.path, live: true,
                hooks: Object.keys(script).filter((key) => /^on[A-Z]/.test(key) && typeof script[key] === 'function'),
                hasTick: !!script.hasTick,
              });
            }
          }
        }
        if (/^spells\//i.test(entry.path) && !/(?:^|\/)_(?:helpers?|summon-helpers|field-helpers)\.(?:js|mjs)$/i.test(entry.path)
            && !/(?:^|\/)index\.(?:js|mjs)$/i.test(entry.path)) {
          const reference = entry.path.replace(/^spells\//i, '');
          const declared = source.match(/export\s+default\s*\{[\s\S]{0,500}?\bname\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
          const fallback = path.basename(entry.path).replace(/\.(?:js|mjs)$/i, '').replaceAll('-', ' ');
          const parts = reference.split('/');
          const school = parts.length > 1 ? parts[0] : 'shared';
          const hooks = [...source.matchAll(/^\s*(cast|validate|check|on\w+)\s*\(/gm)].map((match) => match[1]);
          if (declared || hooks.includes('cast')) spells.set(entry.path, {
            name: declared || fallback,
            path: entry.path,
            reference,
            school,
            live: true,
            hooks,
          });
        }
      }
      for (const name of aiLive) if (!ai.has(name)) ai.set(name, { name, path: null, live: true });
      for (const [name, script] of itemLive) if (!items.has(name)) items.set(name, {
        name, path: null, live: true,
        hooks: Object.keys(script).filter((key) => /^on[A-Z]/.test(key) && typeof script[key] === 'function'),
        hasTick: !!script.hasTick,
      });
      const value = {
        ai: [...ai.values()].sort((a, b) => a.name.localeCompare(b.name)),
        items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)),
        spells: [...spells.values()].sort((a, b) => a.school.localeCompare(b.school) || a.name.localeCompare(b.name)),
        files: files.filter((entry) => /\.(?:js|mjs)$/i.test(entry.path)),
        clientGumps: (() => {
          const dir = path.join(sourceRepoRoot, 'apps/client/src/ui/gumps');
          try {
            return fs.readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
              .map((entry) => {
                const source = fs.readFileSync(path.join(dir, entry.name), 'utf8');
                const classes = [...source.matchAll(/export\s+class\s+(\w+)\s+extends\s+(\w+)/g)]
                  .map((match) => ({ name: match[1], extends: match[2] }));
                const type = source.match(/get\s+type\s*\(\)\s*\{\s*return\s+['"`]([^'"`]+)/)?.[1] ?? null;
                return { path: entry.name, name: entry.name.replace(/-gump\.js$/i, '').replaceAll('-', ' '), classes, type };
              })
              .sort((a, b) => a.name.localeCompare(b.name));
          } catch { return []; }
        })(),
      };
      studioScriptCatalogCache = { expiresAt: Date.now() + 5000, value };
      return value;
    },
  });

  routes.push({
    method: 'POST', path: '/api/studio/validate',
    run: ({ body }) => validateStudioDraft(String(body?.domain ?? ''), body?.data, {
      aiNames: new Set(sharedCtx?.ai?.behaviors?.keys?.() ?? []),
      itemScripts: new Set((sharedCtx?.systems?.itemScripts?.all?.() ?? []).map((script) => String(script.name))),
    }),
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
  routes.push({ method: 'GET', path: '/api/operations/profiler', run: () => operational.profilerSnapshot() });
  routes.push({ method: 'GET', path: '/api/operations/admission', run: () => operational.admissionSnapshot() });
  routes.push({ method: 'GET', path: '/api/operations/replay', run: ({ query }) => operational.replaySnapshot(queryInt(query, 'limit', 256, 1, 5000)) });
  routes.push({ method: 'GET', path: '/api/operations/simulation-replay', run: ({ query }) => operational.simulationReplaySnapshot(queryInt(query, 'limit', 256, 1, 5000)) });
  routes.push({ method: 'GET', path: '/api/operations/simulation-replay/export', run: ({ query }) => operational.exportSimulationReplay(queryInt(query, 'limit', 5000, 1, 50_000)) });
  routes.push({
    method: 'PUT', path: '/api/operations/simulation-replay',
    run: ({ body }) => operational.configureSimulationReplay({ enabled: body?.enabled === true,
      captureInputs: body?.captureInputs === true }),
  });
  routes.push({ method: 'POST', path: '/api/operations/simulation-replay/clear', run: () => operational.clearSimulationReplay() });
  routes.push({ method: 'GET', path: '/api/operations/replay/export', run: ({ query }) => operational.exportReplay(queryInt(query, 'limit', 5000, 1, 20_000)) });
  routes.push({
    method: 'PUT', path: '/api/operations/replay',
    run: ({ body }) => operational.configureReplay({ enabled: body?.enabled === true,
      capturePayloads: body?.capturePayloads === true }),
  });
  routes.push({ method: 'POST', path: '/api/operations/replay/clear', run: () => operational.clearReplay() });
  routes.push({
    method: 'POST', path: '/api/operations/cpu-profile',
    run: async ({ body }) => {
      const durationMs = Math.max(25, Math.min(30_000, Number(body?.durationMs) || 1000));
      const result = await operational.captureCpuProfile({ durationMs, reason: 'admin' });
      return { ok: true, id: result.id, startedAt: result.startedAt, durationMs: result.durationMs,
        nodes: result.profile?.nodes?.length ?? 0 };
    },
  });
  routes.push({
    method: 'GET', path: '/api/operations/cpu-profile/:id',
    run: ({ params }) => operational.cpuProfile(params.id) ?? { error: 'CPU profile not found' },
  });
  routes.push({ method: 'GET', path: '/api/operations/service-levels', run: () => operational.serviceLevelSnapshot() });
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
      if (mutation.kind === 'world-editor.multi-place') {
        const result = sharedCtx?.systems?.multiEditor?.remove?.({ multiId: mutation.multiId,
          map: mutation.facet, instanceId: mutation.instanceId, houseId: mutation.houseId });
        if (!result || result.removed == null) return { error: result?.reason ?? 'multi editor bridge is unavailable' };
        if (result.expected < 1) {
          return { error: 'world changed since this operation; the multi instance no longer exists', conflict: true };
        }
        if (result.removed !== result.expected || result.failed?.length) {
          return { error: 'multi removal was incomplete; the housing registry was preserved',
            conflict: true, removed: result.removed, expected: result.expected, failed: result.failed ?? [] };
        }
        if (mutation.houseId != null && result.registryRemoved !== true) {
          return { error: 'multi was removed but its housing registry record could not be removed', conflict: true };
        }
        mutation.usedAt = Date.now();
        return { ok: true, undoId: mutation.id, removed: result.removed,
          before: { multiId: mutation.multiId, instanceId: mutation.instanceId }, after: { removed: result.removed } };
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
    run: () => operational.scanWorldIntegrityAsync(world, { spawner: sharedCtx?.spawner }),
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
    method: 'GET', path: '/api/operations/scripts',
    run: () => ({
      ...(scriptRuntime?.diagnostics?.() ?? {}),
      commandCollisions: sharedCtx?.commands?.collisions?.map((entry) => ({ name: entry.name, aliasFor: entry.aliasFor })) ?? [],
      aiGraphs: sharedCtx?.aiGraphs?.list?.()?.length ?? 0,
    }),
  });
  routes.push({
    method: 'POST', path: '/api/operations/scripts/control',
    run: async ({ body }) => scriptRuntime?.control?.(String(body?.file ?? ''), String(body?.action ?? ''), {
      durationMs: body?.durationMs,
    }) ?? { ok: false, error: 'script runtime unavailable' },
  });
  routes.push({
    method: 'GET', path: '/api/operations/readiness',
    run: async () => {
      const integrity = await operational.scanWorldIntegrityAsync(world, { spawner: sharedCtx?.spawner });
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
          expensiveEntities, bindings: sharedCtx?.ai?.bindings?.size ?? 0,
          scheduler: sharedCtx?.ai?.runtimeSnapshot?.() ?? sharedCtx?.ai?.schedulerDiagnostics ?? null },
        spawner: sharedCtx?.spawner?.runtimeSnapshot?.() ?? null,
        protocolCosts: sharedCtx?.protocolCosts?.snapshot?.({ historyLimit: 60 }) ?? null,
        globalTraffic: sharedCtx?.globalTrafficGovernor?.snapshot?.() ?? null,
        storage,
      };
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
    try { return fs.readdirSync(saveDir, { withFileTypes: true }).filter((entry) => entry.isFile() && (/(?:^world\.sqlite(?:\.backup\.\d+)?$)|(?:\.json(?:\.gz)?(?:\.(?:bak|legacy|pre-(?:restore|migration)\.\d+))?$)/.test(entry.name))).map((entry) => {
      const stat = fs.statSync(path.join(saveDir, entry.name));
      return { name: entry.name, bytes: stat.size, modifiedAt: stat.mtimeMs, backup: /\.(?:bak|legacy|pre-restore\.)/.test(entry.name) };
    }).sort((a, b) => b.modifiedAt - a.modifiedAt); } catch { return []; }
  };
  const storageSnapshot = () => {
    const files = saveFiles();
    return {
      ...operational.verifySaveDirectory(saveDir),
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      latestModifiedAt: files[0]?.modifiedAt ?? null,
      saves: persistence?.diagnostics?.(saveDir) ?? null,
    };
  };
  routes.push({ method: 'GET', path: '/api/backups', run: () => ({ saveDir, files: saveFiles() }) });
  routes.push({
    method: 'POST', path: '/api/backups/create',
    run: async () => {
      if (persistence?.requestSave) await persistence.requestSave(world, saveDir);
      const name = `world.sqlite.backup.${Date.now()}`;
      const result = await createWorldDatabaseBackup(saveDir, path.join(saveDir, name));
      return { ok: true, name, ...result };
    },
  });
  routes.push({
    method: 'POST', path: '/api/backups/verify',
    run: ({ body }) => {
      const name = String(body?.name ?? '');
      if (/^world\.sqlite(?:\.backup\.\d+)?$/.test(name)) {
        const file = safeSaveFile(name);
        return file
          ? { name, ...verifyWorldDatabaseFileSync(file, { cleanupSidecars: true }) }
          : { ok: false, error: 'invalid backup path' };
      }
      try { const parsed = readSnapshotFile(String(body?.name ?? '')); return { ok: true, name: body.name, bytes: parsed.bytes.length, version: parsed.snapshot?.version ?? 0,
        records: { mobiles: parsed.snapshot?.mobiles?.length ?? 0, items: parsed.snapshot?.items?.length ?? 0 } }; }
      catch (error) { return { error: error.message, ok: false }; }
    },
  });
  routes.push({
    method: 'POST', path: '/api/backups/restore',
    run: ({ body }) => {
      if (/^world\.sqlite\.backup\.\d+$/.test(String(body?.source ?? ''))) {
        return { error: 'Online SQLite restore is intentionally disabled. Verify the backup, stop the shard cleanly, then replace world.sqlite while it is offline.' };
      }
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
      const serviceLevels = runtime.serviceLevels ?? operational.serviceLevelSnapshot();
      const metrics = runtimeServiceLevels.policies();
      const budgets = {
        apiP95Ms: metrics.adminRequest.target,
        mapChunkMs: performanceBudgets.client.mapChunkMs,
        tableRows: performanceBudgets.client.tableRows,
        eventLoopP95Ms: metrics.eventLoopLag.target,
      };
      const client = [...adminClientMetrics.values()].sort((a, b) => b.at - a.at);
      const violations = [
        ...Object.values(serviceLevels.metrics).filter((metric) => metric.status === 'degraded' || metric.status === 'critical')
          .map((metric) => ({ metric: `slo:${metric.name}`, value: metric.p95, budget: metric.target, status: metric.status, burnRate: metric.burnRate })),
        ...apiStats.routes.filter((route) => route.p95Ms > budgets.apiP95Ms).map((route) => ({ metric: `api:${route.route}`, value: route.p95Ms, budget: budgets.apiP95Ms })),
        ...client.filter((row) => row.mapChunkMs > budgets.mapChunkMs).map((row) => ({ metric: `map:${row.account}`, value: row.mapChunkMs, budget: budgets.mapChunkMs })),
        ...client.filter((row) => row.tableRows > budgets.tableRows).map((row) => ({ metric: `table:${row.account}`, value: row.tableRows, budget: budgets.tableRows })),
      ].filter(Boolean);
      return { ok: violations.length === 0, revision: performanceBudgets.revision, budgets, policies: metrics,
        engine: { ...performanceBudgets.engine },
        serviceLevels, violations, api: apiStats, runtime: runtime.eventLoop, client };
    },
  });
  routes.push({
    method: 'PUT', path: '/api/operations/budgets',
    run: ({ body }) => {
      const requestedMetrics = body?.metrics ?? {};
      const nextMetrics = {};
      for (const [name, current] of Object.entries(runtimeServiceLevels.policies())) {
        const requested = requestedMetrics[name] ?? {};
        nextMetrics[name] = {
          ...current,
          target: requested.target ?? current.target,
          critical: requested.critical ?? current.critical,
          objective: requested.objective ?? current.objective,
          windowMs: requested.windowMs ?? current.windowMs,
        };
      }
      const requestedClient = body?.client ?? {};
      const nextClient = normalizeClientBudgets(requestedClient, performanceBudgets.client);
      const requestedEngine = body?.engine ?? {};
      const nextEngine = normalizeEngineBudgets(requestedEngine, performanceBudgets.engine);
      performanceBudgets = {
        revision: (performanceBudgets.revision | 0) + 1,
        metrics: runtimeServiceLevels.configure(nextMetrics),
        client: nextClient,
        engine: nextEngine,
      };
      applyEngineBudgets(sharedCtx, nextEngine);
      writeJsonState(performanceBudgetFile, performanceBudgets);
      operational.structuredEvent('performance.budgets.updated', { revision: performanceBudgets.revision });
      return { ok: true, ...performanceBudgets };
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
      const [r, auxiliary] = await Promise.all([
        persistence.requestSave(world, saveDir),
        persistence.requestAuxiliarySave?.('admin') ?? null,
      ]);
      return { ok: true, ...r, auxiliary };
    },
  });

  // Graceful shutdown endpoint — invoked by the control panel
  // BEFORE `taskkill /f` on Windows. Triggers the same SIGINT
  // handler used by Ctrl-C in console mode so the world final-save
  // + houses/bazaar flush + WS close happens cleanly. User report
  // A report that backpack changes disappeared after server shutdown exposed
  // that the control panel's `taskkill /f` skipped the SIGINT
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
        try {
          if (typeof sharedCtx?.requestShutdown === 'function') {
            void sharedCtx.requestShutdown('ADMIN');
          } else {
            process.kill(process.pid, 'SIGINT');
          }
        }
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
      if (!scriptRuntime?.reloadAffected && !scriptRuntime?.reloadOne) return { error: 'incremental reload unavailable on runtime' };
      const t0 = Date.now();
      const r = scriptRuntime.reloadAffected
        ? await scriptRuntime.reloadAffected(rel)
        : await scriptRuntime.reloadOne(rel);
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
  registerWorldEditRoutes(routes, {
    scriptsDir, saveDir, scriptRuntime, world, mapProvider, sharedCtx, queryInt, registerUndoableMutation,
  });


  registerEntityRoutes(routes, {
    accounts, world, sharedCtx, adminCharacters, queryInt,
  });

  registerAssetRoutes(routes, {
    assetsDir: clientAssetsDir,
    multiCatalog: () => sharedCtx?.systems?.multiEditor?.catalog?.() ?? [],
    isMultiInUse: (id) => [...(world?.items?.values?.() ?? [])]
      .some((item) => item?._multiAnchor && (item.multiId | 0) === (id | 0))
      || sharedCtx.boats?.isMultiIdInUse?.(id) === true,
    onChanged: (change) => {
      studioAssetCatalogCache.clear();
      studioAppearanceAssets = null;
      if (change?.kind === 'multi') sharedCtx?.systems?.multiEditor?.invalidate?.();
      world?.events?.emit?.('assets:changed', change);
      notifyNodeUOAssetChanged(sharedCtx.connections, change);
    },
  });
  registerNodeUORoutes(routes, sharedCtx);
  registerScriptStudioRoutes(routes, { scriptsDir, scriptRuntime, sharedCtx });
  registerOperationsInsightRoutes(routes, { scriptsDir, scriptRuntime, sharedCtx, world, saveDir });
  registerAlertRoutes(routes, { saveDir });
  registerVerificationRoutes(routes, { sharedCtx, world });
  registerPlatformRoutes(routes, { sharedCtx });
  registerGameSystemRoutes(routes, { sharedCtx });


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
      if (Buffer.byteLength(body.content, 'utf8') > 1024 * 1024) return { error: 'script exceeds the 1 MiB editor limit' };
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const before = fs.existsSync(abs) ? fs.statSync(abs) : null;
        const expectedMtime = Number(body?.expectedMtime);
        if (before && Number.isFinite(expectedMtime)
            && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) {
          return { error: 'script changed on disk since it was opened', conflict: true };
        }
        // Import a temporary sibling before replacing the source. This checks
        // ESM syntax and relative imports while the currently running script
        // and its on-disk source are still untouched. Utility modules without
        // a default export are valid too, unlike reloadOne's activation check.
        const validationAbs = path.join(path.dirname(abs), `.${path.basename(abs)}.validate-${process.pid}-${Date.now()}.mjs`);
        fs.writeFileSync(validationAbs, body.content, 'utf8');
        try {
          await import(`${pathToFileURL(validationAbs).href}?validate=${Date.now()}`);
        } catch (error) {
          return { error: `validation failed: ${error.message}`, phase: 'validate' };
        } finally {
          try { fs.unlinkSync(validationAbs); } catch { /* ignore */ }
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
          const directlyLoaded = scriptRuntime.loaded?.some?.((entry) => path.resolve(entry.file) === path.resolve(abs));
          if (directlyLoaded) reloaded = { ...(await scriptRuntime.reloadOne(rel)), ms: Date.now() - t0 };
          else if (scriptRuntime.load) {
            await scriptRuntime.load({ reason: `admin-script-dependency:${rel}`, emitEvent: true });
            reloaded = { ok: true, scope: 'all', loaded: scriptRuntime.loaded?.length ?? 0, ms: Date.now() - t0 };
          }
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

  // Engine/client sources belong to this checkout even when scriptsDir points
  // at an external content pack (and in isolated admin-route tests). Deriving
  // these paths from scriptsDir made the client editor silently look outside
  // the repository in those deployments.
  const clientGumpSourceDir = path.join(sourceRepoRoot, 'apps/client/src/ui/gumps');
  const serverSourceDir = path.join(sourceRepoRoot, 'apps/server/src');

  routes.push({
    method: 'GET', path: '/api/studio/server-source',
    run: ({ query }) => {
      const rel = String(query.get('path') ?? '').replace(/^@server\//, '');
      const abs = safeJoin(serverSourceDir, rel);
      if (!abs || !/\.(?:js|mjs)$/i.test(rel)) return { error: 'bad server source path' };
      try {
        const content = fs.readFileSync(abs, 'utf8');
        const stat = fs.statSync(abs);
        return { path: rel, size: stat.size, mtime: Math.trunc(stat.mtimeMs), content };
      } catch (error) { return { error: error.message }; }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/studio/server-source',
    run: async ({ query, body }) => {
      const rel = String(query.get('path') ?? '').replace(/^@server\//, '');
      const abs = safeJoin(serverSourceDir, rel);
      if (!abs || !/\.(?:js|mjs)$/i.test(rel)) return { error: 'bad server source path' };
      if (typeof body?.content !== 'string') return { error: 'content (string) required' };
      if (Buffer.byteLength(body.content, 'utf8') > 1024 * 1024) return { error: 'source exceeds the 1 MiB editor limit' };
      let validationAbs = '';
      try {
        const before = fs.statSync(abs);
        const expectedMtime = Number(body?.expectedMtime);
        if (Number.isFinite(expectedMtime) && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) return { error: 'server source changed on disk since it was opened', conflict: true };
        validationAbs = path.join(path.dirname(abs), `.${path.basename(rel)}.validate-${process.pid}-${Date.now()}.mjs`);
        fs.writeFileSync(validationAbs, body.content, 'utf8');
        const syntax = await new Promise((resolve) => {
          const child = spawn(process.execPath, ['--check', validationAbs], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
          let errorText = '';
          child.stderr.on('data', (chunk) => { errorText += chunk; });
          child.once('error', (error) => resolve({ ok: false, error: error.message }));
          child.once('close', (code) => resolve({ ok: code === 0, error: errorText.trim() }));
        });
        if (!syntax.ok) return { error: `syntax validation failed: ${syntax.error || 'node --check failed'}`, phase: 'validate' };
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${abs}.bak.${stamp}`;
        fs.copyFileSync(abs, backup);
        const temp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temp, body.content, 'utf8');
        fs.renameSync(temp, abs);
        const stat = fs.statSync(abs);
        return { ok: true, path: rel, size: stat.size, mtime: Math.trunc(stat.mtimeMs), backup: path.basename(backup),
          reloaded: { ok: true, scope: 'server-engine', detail: 'Engine source saved; restart the Node server to activate it.' } };
      } catch (error) { return { error: error.message }; }
      finally { if (validationAbs) try { fs.unlinkSync(validationAbs); } catch { /* already removed */ } }
    },
  });

  routes.push({
    method: 'GET', path: '/api/studio/client-gump-definitions',
    run: () => {
      try {
        const text = fs.readFileSync(clientGumpDefinitionsFile, 'utf8');
        const data = JSON.parse(text);
        const stat = fs.statSync(clientGumpDefinitionsFile);
        return { path: '@client/client-gumps.json', size: stat.size, mtime: Math.trunc(stat.mtimeMs), data };
      } catch (error) { return { error: `read failed: ${error.message}` }; }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/studio/client-gump-definitions',
    run: ({ session, body }) => {
      const data = body?.data;
      if (!Array.isArray(data)) return { error: 'client gump definitions must be an array' };
      if (data.length > 2048) return { error: 'client gump definition limit is 2048' };
      const ids = new Set();
      for (let index = 0; index < data.length; index++) {
        const definition = data[index];
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return { error: `record ${index + 1} must be an object` };
        const id = String(definition.definitionId ?? '').trim();
        if (!id) return { error: `record ${index + 1} requires definitionId` };
        if (ids.has(id)) return { error: `duplicate definitionId '${id}'` };
        ids.add(id);
        if (!String(definition.className ?? '').trim() && !String(definition.type ?? '').trim()) return { error: `${id}: className or type is required` };
        if (definition.scope !== 'client') return { error: `${id}: scope must be 'client'` };
        if (definition.controlOverrides != null && !Array.isArray(definition.controlOverrides)) return { error: `${id}: controlOverrides must be an array` };
        if ((definition.controlOverrides?.length ?? 0) > 512) return { error: `${id}: at most 512 control overrides are allowed` };
        const controlIds = new Set();
        for (let overrideIndex = 0; overrideIndex < (definition.controlOverrides?.length ?? 0); overrideIndex++) {
          const override = definition.controlOverrides[overrideIndex];
          if (!override || typeof override !== 'object' || Array.isArray(override)) {
            return { error: `${id}: control override ${overrideIndex + 1} must be an object` };
          }
          const controlId = String(override.controlId ?? '').trim();
          const path = String(override.path ?? '').trim();
          const className = String(override.className ?? '').trim();
          if (!controlId && !path && !className) {
            return { error: `${id}: control override ${overrideIndex + 1} requires controlId, path or className` };
          }
          if (controlId && controlIds.has(controlId)) return { error: `${id}: duplicate controlId '${controlId}'` };
          if (controlId) controlIds.add(controlId);
        }
      }
      try {
        const before = fs.existsSync(clientGumpDefinitionsFile) ? fs.statSync(clientGumpDefinitionsFile) : null;
        const expectedMtime = Number(body?.expectedMtime);
        if (before && Number.isFinite(expectedMtime) && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) {
          return { error: 'client gump catalogue changed on disk since it was opened', conflict: true,
            expectedMtime: Math.trunc(expectedMtime), actualMtime: Math.trunc(before.mtimeMs) };
        }
        contentProfiles.ensureWritableProfile({ actor: session?.account });
        fs.mkdirSync(path.dirname(clientGumpDefinitionsFile), { recursive: true });
        let backup = null;
        if (before) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupFile = `${clientGumpDefinitionsFile}.bak.${stamp}`;
          fs.copyFileSync(clientGumpDefinitionsFile, backupFile);
          backup = path.basename(backupFile);
          const prefix = `${path.basename(clientGumpDefinitionsFile)}.bak.`;
          const backups = fs.readdirSync(path.dirname(clientGumpDefinitionsFile))
            .filter((name) => name.startsWith(prefix))
            .map((name) => ({ name, mtime: fs.statSync(path.join(path.dirname(clientGumpDefinitionsFile), name)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime);
          for (const stale of backups.slice(5)) try { fs.unlinkSync(path.join(path.dirname(clientGumpDefinitionsFile), stale.name)); } catch { /* ignore */ }
        }
        const temp = `${clientGumpDefinitionsFile}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        fs.renameSync(temp, clientGumpDefinitionsFile);
        const stat = fs.statSync(clientGumpDefinitionsFile);
        const profile = contentProfiles.recordFile('@client/client-gumps.json', {
          actor: session?.account, message: 'Published client gump definitions',
        });
        return { ok: true, path: '@client/client-gumps.json', size: stat.size, mtime: Math.trunc(stat.mtimeMs), backup,
          profile,
          reloaded: { ok: true, scope: 'client-json', detail: 'Newly opened client gumps use the updated local catalogue after refresh/reload.' } };
      } catch (error) { return { error: `write failed: ${error.message}` }; }
    },
  });

  routes.push({
    method: 'GET', path: '/api/studio/client-gump-source',
    run: ({ query }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(clientGumpSourceDir, rel);
      if (!abs || !/^[a-z0-9._-]+\.js$/i.test(rel)) return { error: 'bad client gump path' };
      try {
        const content = fs.readFileSync(abs, 'utf8');
        const stat = fs.statSync(abs);
        return { path: rel, size: stat.size, mtime: Math.trunc(stat.mtimeMs), content };
      } catch (error) { return { error: error.message }; }
    },
  });

  routes.push({
    method: 'PUT', path: '/api/studio/client-gump-source',
    run: async ({ query, body }) => {
      const rel = query.get('path') ?? '';
      const abs = safeJoin(clientGumpSourceDir, rel);
      if (!abs || !/^[a-z0-9._-]+\.js$/i.test(rel)) return { error: 'bad client gump path' };
      if (typeof body?.content !== 'string') return { error: 'content (string) required' };
      if (Buffer.byteLength(body.content, 'utf8') > 1024 * 1024) return { error: 'source exceeds the 1 MiB editor limit' };
      let validationAbs = '';
      try {
        const before = fs.statSync(abs);
        const expectedMtime = Number(body?.expectedMtime);
        if (Number.isFinite(expectedMtime) && Math.trunc(before.mtimeMs) !== Math.trunc(expectedMtime)) {
          return { error: 'client gump changed on disk since it was opened', conflict: true };
        }
        validationAbs = path.join(clientGumpSourceDir, `.${path.basename(rel)}.validate-${process.pid}-${Date.now()}.mjs`);
        fs.writeFileSync(validationAbs, body.content, 'utf8');
        const syntax = await new Promise((resolve) => {
          const child = spawn(process.execPath, ['--check', validationAbs], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
          let errorText = '';
          child.stderr.on('data', (chunk) => { errorText += chunk; });
          child.once('error', (error) => resolve({ ok: false, error: error.message }));
          child.once('close', (code) => resolve({ ok: code === 0, error: errorText.trim() }));
        });
        if (!syntax.ok) return { error: `syntax validation failed: ${syntax.error || 'node --check failed'}`, phase: 'validate' };
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${abs}.bak.${ts}`;
        fs.copyFileSync(abs, backup);
        const temp = `${abs}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temp, body.content, 'utf8');
        fs.renameSync(temp, abs);
        const stat = fs.statSync(abs);
        studioScriptCatalogCache = null;
        return { ok: true, path: rel, size: stat.size, mtime: Math.trunc(stat.mtimeMs), backup: path.basename(backup),
          reloaded: { ok: true, scope: 'client', detail: 'Vite reloads the module in development; production requires a client rebuild.' } };
      } catch (error) { return { error: error.message }; }
      finally { if (validationAbs) try { fs.unlinkSync(validationAbs); } catch { /* already removed */ } }
    },
  });

  routes.push({
    method: 'POST', path: '/api/spawners/simulate',
    run: ({ body }) => {
      const spawnKinds = [...new Set([
        ...(sharedCtx?.monsters?.kinds?.() ?? []),
        ...(sharedCtx?.npcs?.kinds?.() ?? []),
      ])];
      const checked = validateSpawnerDraft(body, spawnKinds);
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

  // Enumerate every spawnable definition — hostile monsters and scripted
  // townsfolk share the same visual picker but retain their own definitionId.
  routes.push({
    method: 'GET', path: '/api/monster-kinds',
    run: () => {
      const monsters = sharedCtx?.monsters;
      const npcs = sharedCtx?.npcs;
      const definitions = [
        ...(monsters?.kinds?.() ?? []).map((kind) => ({ kind, cfg: monsters.get(kind) ?? {}, source: 'monster' })),
        ...(npcs?.kinds?.() ?? []).map((kind) => ({ kind, cfg: npcs.get(kind) ?? {}, source: 'npc' })),
      ];
      const seen = new Set();
      const kinds = definitions.filter(({ kind }) => !seen.has(kind) && seen.add(kind)).map(({ kind: k, cfg, source }) => {
        return {
          kind: k,
          name: cfg.name ?? k,
          title: cfg.title ?? '',
          body: cfg.bodyId ?? cfg.body ?? null,
          hue: cfg.hue ?? 0,
          source,
          fame: cfg.fame ?? 0,
          // Classification hint for the modal's color-coded label —
          // matches the editor.html spawner-overlay classifier so the
          // dropdown UI can mirror the admin map's red/green coding.
          tier: source === 'npc' ? 'npc'
              : cfg.fame >= 18000 ? 'boss'
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
  const DATA_ROOT = path.resolve(scriptsDir, 'data');
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
    run: async ({ session, query, body }) => {
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
        contentProfiles.ensureWritableProfile({ actor: session?.account });
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
        const profile = contentProfiles.recordFile(query.get('path'), {
          actor: session?.account, message: `Published ${query.get('path')}`,
        });
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
          profile,
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
