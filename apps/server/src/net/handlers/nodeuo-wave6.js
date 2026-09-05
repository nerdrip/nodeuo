import crypto from 'node:crypto';
import {
  checkNodeUOPreconditions,
  createNodeUOError,
  NodeUOErrorCode,
} from '@uo/nodeuo-protocol';
import { childrenOf } from '../../world/items.js';
import { lineOfSight } from '../../world/los.js';
import { currentNodeUORequestContext, requestTraceSnapshot } from '../../systems/request-context.js';

const previewSessions = new Map();
const moderationCases = [];
const MAX_CASES = 10_000;
const ACCESS = Object.freeze({ Player: 0, Counselor: 1, Counsellor: 1, Seer: 2,
  GM: 3, GameMaster: 3, Admin: 4, Administrator: 4 });
const ACCESS_NORMALIZED = new Map(Object.entries(ACCESS).map(([name, rank]) => [name.toLowerCase(), rank]));

function clean(value, max = 256) { return String(value ?? '').trim().slice(0, max); }
function accessRank(value) { return ACCESS_NORMALIZED.get(clean(value, 32).toLowerCase()) ?? 0; }
function isStaff(state) { return accessRank(state?.account?.accessLevel) >= ACCESS.Seer; }
function hasConsent(state, category) { return state?.mobile?._nodeUOConsent?.categories?.[category] === true; }

function commandSchema(state, payload) {
  const requested = clean(payload.command, 96).toLowerCase();
  const actualAccess = accessRank(state?.account?.accessLevel);
  const commands = (state.ctx.commands?.list?.() ?? []).filter((entry) => !requested || entry.name === requested)
    .filter((entry) => actualAccess >= accessRank(entry.access ?? 'Admin'))
    .slice(0, 1000).map((entry) => ({
      name: entry.name, help: clean(entry.help, 1000), access: entry.access ?? 'Admin',
      aliases: (entry.aliases ?? []).slice(0, 32),
      arguments: entry.arguments ?? entry.argsSchema ?? {
        type: 'array', items: { type: 'string' }, maxItems: 64,
        description: clean(entry.help, 1000),
      },
      supportsDryRun: entry.dryRun === true,
    }));
  return { ok: true, revision: state.ctx.scriptRuntime?.generation ?? 0, commands };
}

function contentDependencies(state, payload) {
  if (!isStaff(state)) return createNodeUOError(NodeUOErrorCode.PermissionDenied, 'staff access required');
  const graph = state.ctx.contentDependencies;
  if (!graph) return createNodeUOError(NodeUOErrorCode.Unavailable, 'content dependency graph unavailable');
  const operation = clean(payload.operation || 'summary', 32).toLowerCase();
  if (operation === 'impact') return graph.impact(payload.node, payload.depth);
  return { ok: true, ...graph.snapshot({ includeGraph: operation === 'graph' }) };
}

function cleanupPreviewSessions(now = Date.now()) {
  // New shards use the durable control-plane service. Keep the local map as a
  // compatibility fallback for focused handler tests and embedders that build
  // a minimal context without the full verification suite.
  for (const [id, row] of previewSessions) if (row.expiresAt <= now || row.state?._closed) previewSessions.delete(id);
}

function contentPreviewSession(state, payload) {
  if (!isStaff(state)) return createNodeUOError(NodeUOErrorCode.PermissionDenied, 'staff access required');
  cleanupPreviewSessions();
  const operation = clean(payload.operation, 32).toLowerCase();
  if (operation === 'end') {
    const id = clean(payload.sessionId, 128);
    if (state.ctx.platformOperations) {
      const result = state.ctx.platformOperations.endPreview(id || state._nodeUOPreviewSession, state.accountName);
      if (result.ok && state._nodeUOPreviewSession === (id || state._nodeUOPreviewSession)) delete state._nodeUOPreviewSession;
      return result.ok ? result : createNodeUOError(NodeUOErrorCode.NotFound, result.error);
    }
    const row = previewSessions.get(id);
    if (!row || row.state !== state) return createNodeUOError(NodeUOErrorCode.NotFound, 'preview session not found');
    previewSessions.delete(id); if (state._nodeUOPreviewSession === id) delete state._nodeUOPreviewSession;
    return { ok: true, sessionId: id, ended: true };
  }
  if (operation === 'status') {
    if (state.ctx.platformOperations) {
      if (!payload.sessionId && !state._nodeUOPreviewSession) return { ok: true, session: null };
      const result = state.ctx.platformOperations.preview(payload.sessionId || state._nodeUOPreviewSession);
      return result.ok ? result : { ok: true, session: null };
    }
    const row = previewSessions.get(state._nodeUOPreviewSession);
    return { ok: true, session: row ? { ...row, state: undefined } : null };
  }
  if (operation === 'mutate') {
    const result = state.ctx.platformOperations?.mutatePreview?.(
      payload.sessionId || state._nodeUOPreviewSession, payload.mutations, state.accountName,
    );
    return result ?? createNodeUOError(NodeUOErrorCode.Unavailable, 'preview service unavailable');
  }
  if (operation === 'simulate') {
    const result = state.ctx.platformOperations?.simulatePreview?.(
      payload.sessionId || state._nodeUOPreviewSession, payload.event, payload.payload, state.accountName,
    );
    return result ?? createNodeUOError(NodeUOErrorCode.Unavailable, 'preview service unavailable');
  }
  if (operation !== 'start') return createNodeUOError(NodeUOErrorCode.InvalidArgument, 'operation must be start, status or end');
  const resources = [...new Set((Array.isArray(payload.resources) ? payload.resources : [])
    .map((value) => clean(value, 300)).filter(Boolean))].slice(0, 256);
  const invalid = resources.filter((resource) => state.ctx.contentDependencies?.impact?.(resource)?.ok !== true);
  if (invalid.length) return createNodeUOError(NodeUOErrorCode.PreconditionsFailed,
    'one or more preview resources do not exist', { details: { invalid }, recovery: 'refresh-content-graph' });
  const now = Date.now(); const ttlMs = Math.max(30_000, Math.min(30 * 60_000, Number(payload.ttlMs) | 0 || 5 * 60_000));
  if (state.ctx.platformOperations) {
    const result = state.ctx.platformOperations.startPreview({ actor: state.accountName, resources, ttlMs,
      baseline: { world: { mobiles: state.ctx.world?.mobiles?.size ?? 0, items: state.ctx.world?.items?.size ?? 0 },
        scripts: state.ctx.scriptRuntime?.generation ?? 0,
        dependencies: state.ctx.contentDependencies?.snapshot?.()?.revision ?? null } });
    if (result.ok) state._nodeUOPreviewSession = result.session.sessionId;
    return result;
  }
  const sessionId = crypto.randomUUID();
  const row = { sessionId, state, account: state.accountName, resources, createdAt: now, expiresAt: now + ttlMs,
    isolated: true, externalEffects: false };
  previewSessions.set(sessionId, row); state._nodeUOPreviewSession = sessionId;
  return { ok: true, session: { ...row, state: undefined } };
}

function combatPreflight(state, payload) {
  const actor = state.mobile; const serial = Number(payload.targetSerial) >>> 0;
  const target = state.ctx.world?.mobiles?.get?.(serial) ?? state.ctx.world?.items?.get?.(serial);
  if (!actor || !target) return createNodeUOError(NodeUOErrorCode.NotFound, 'actor or target unavailable');
  const range = Math.max(1, Math.min(24, Number(payload.range) | 0 || 1));
  const distance = actor.map === target.map
    ? Math.max(Math.abs(actor.x - target.x), Math.abs(actor.y - target.y)) : Number.POSITIVE_INFINITY;
  const visible = serial === actor.serial || state._visibleMobiles?.has?.(serial) || state._visibleItems?.has?.(serial);
  const los = visible && actor.map === target.map ? lineOfSight(actor.map, actor, target) : false;
  const reasons = [];
  if (actor.dead) reasons.push('actor-dead');
  if (target.dead) reasons.push('target-dead');
  if (!visible) reasons.push('target-not-visible');
  if (distance > range) reasons.push('out-of-range');
  if (!los) reasons.push('no-line-of-sight');
  return { ok: true, allowed: reasons.length === 0, targetSerial: serial,
    action: clean(payload.action || 'attack', 64), distance: Number.isFinite(distance) ? distance : null,
    range, lineOfSight: los, reasons, authoritativeAt: Date.now(), validForMs: 250 };
}

function ownedRootContainer(state, requested) {
  const world = state.ctx.world; const actor = state.mobile;
  if (!actor) return null;
  const worn = [...childrenOf(world, actor.serial)];
  if (requested === 'bank') return worn.find((item) => item.layer === 0x1d || item.isBankBox);
  if (requested === 'backpack' || !requested) return worn.find((item) => item.layer === 21);
  const serial = Number(requested) >>> 0; const original = world.items.get(serial);
  let item = original; const seen = new Set();
  for (let depth = 0; item && depth < 32; depth++) {
    if (seen.has(item.serial)) return null; seen.add(item.serial);
    if ((item.parent >>> 0) === (actor.serial >>> 0)) return original;
    item = world.items.get(item.parent >>> 0);
  }
  return null;
}

function inventoryView(state, payload) {
  const container = ownedRootContainer(state, clean(payload.container || 'backpack', 64).toLowerCase());
  if (!container) return createNodeUOError(NodeUOErrorCode.NotFound, 'owned inventory container not found');
  const query = clean(payload.query, 128).toLowerCase();
  const itemIds = new Set((Array.isArray(payload.itemIds) ? payload.itemIds : []).slice(0, 256).map(Number));
  const offset = Math.max(0, Math.min(100_000, Number(payload.offset) | 0));
  const limit = Math.max(1, Math.min(512, Number(payload.limit) | 0 || 100));
  const all = [...childrenOf(state.ctx.world, container.serial)].filter((item) => (
    (!query || clean(item.name || `0x${(item.itemId | 0).toString(16)}`, 256).toLowerCase().includes(query))
    && (!itemIds.size || itemIds.has(item.itemId | 0))
  )).sort((a, b) => clean(a.name).localeCompare(clean(b.name)) || (a.serial >>> 0) - (b.serial >>> 0));
  return { ok: true, containerSerial: container.serial >>> 0, offset, total: all.length,
    items: all.slice(offset, offset + limit).map((item) => ({ serial: item.serial >>> 0,
      itemId: item.itemId | 0, hue: item.hue | 0, amount: Math.max(0, item.amount | 0),
      name: clean(item.name || `item 0x${(item.itemId | 0).toString(16)}`, 128),
      x: item.gridX | 0, y: item.gridY | 0 })) };
}

function craftingPlan(state, payload) {
  const requested = (Array.isArray(payload.recipes) ? payload.recipes : []).slice(0, 64);
  const repetitions = Math.max(1, Math.min(1000, Number(payload.repetitions) | 0 || 1));
  const all = state.ctx.systems?.crafting?.allRecipes?.() ?? [];
  const byId = new Map(all.map((recipe) => [String(recipe.id), recipe]));
  const pack = ownedRootContainer(state, 'backpack');
  const inventory = new Map();
  for (const item of pack ? childrenOf(state.ctx.world, pack.serial) : []) {
    inventory.set(item.itemId | 0, (inventory.get(item.itemId | 0) ?? 0) + Math.max(0, item.amount | 0));
  }
  const requirements = new Map(); const steps = []; const missingRecipes = [];
  for (const source of requested) {
    const id = String(source?.id ?? source); const count = Math.max(1, Math.min(1000, Number(source?.count) | 0 || repetitions));
    const recipe = byId.get(id);
    if (!recipe) { missingRecipes.push(id); continue; }
    steps.push({ id: recipe.id, name: clean(recipe.name, 160), count, outputItemId: recipe.outputItemId | 0,
      outputCount: Math.max(1, recipe.outputCount | 0 || 1) * count });
    for (const input of recipe.inputs ?? []) requirements.set(input.itemId | 0,
      (requirements.get(input.itemId | 0) ?? 0) + Math.max(1, input.count | 0 || 1) * count);
  }
  const materials = [...requirements].map(([itemId, required]) => ({ itemId, required,
    available: inventory.get(itemId) ?? 0, missing: Math.max(0, required - (inventory.get(itemId) ?? 0)) }));
  return { ok: missingRecipes.length === 0, executable: missingRecipes.length === 0 && materials.every((row) => !row.missing),
    steps, materials, missingRecipes, preconditions: { alive: state.mobile?.dead !== true,
      mobileSerial: state.mobile?.serial >>> 0 }, fingerprint: crypto.createHash('sha256')
      .update(JSON.stringify({ steps, materials })).digest('hex') };
}

function environment(state) {
  const cycle = state.ctx.dayNight;
  const now = Date.now();
  return { ok: true, serverTime: now, hour: cycle?.hourOfDay?.(now) ?? null,
    phase: cycle?.currentPhase?.(now) ?? null, lightLevel: cycle?.currentLevel?.(now) ?? null,
    season: cycle?.season ?? null, weather: { kind: cycle?.weatherKind ?? null,
      intensity: cycle?.weatherIntensity ?? 0, temperature: cycle?.weatherTemperature ?? 0 } };
}

function audioScene(state, payload) {
  const actor = state.mobile; if (!actor) return createNodeUOError(NodeUOErrorCode.Unavailable, 'player unavailable');
  const radius = Math.max(4, Math.min(32, Number(payload.radius) | 0 || 18)); const emitters = [];
  for (const serial of state.ctx.world.sectors?.itemSerialsNear?.(actor.map, actor.x, actor.y, radius) ?? []) {
    const item = state.ctx.world.items.get(serial); const soundId = Number(item?.ambientSound ?? item?.soundId);
    if (!item || item.parent || !Number.isFinite(soundId)) continue;
    emitters.push({ serial: item.serial >>> 0, soundId: soundId | 0, x: item.x | 0, y: item.y | 0,
      z: item.z | 0, gain: Math.max(0, Math.min(1, Number(item.soundGain) || 1)), loop: item.soundLoop !== false });
    if (emitters.length >= 128) break;
  }
  return { ok: true, listener: { x: actor.x, y: actor.y, z: actor.z, map: actor.map }, radius,
    environment: environment(state), emitters };
}

function spatialCues(state, payload) {
  const actor = state.mobile; if (!actor) return createNodeUOError(NodeUOErrorCode.Unavailable, 'player unavailable');
  const radius = Math.max(4, Math.min(32, Number(payload.radius) | 0 || 18)); const cues = [];
  const append = (entity, type) => {
    if (!entity || entity.map !== actor.map) return;
    const dx = entity.x - actor.x; const dy = entity.y - actor.y; const distance = Math.max(Math.abs(dx), Math.abs(dy));
    if (distance > radius) return;
    cues.push({ serial: entity.serial >>> 0, type, label: clean(entity.name || type, 128), distance,
      directionRadians: Math.atan2(dy, dx), elevation: (entity.z | 0) - (actor.z | 0),
      priority: type === 'mobile' && (entity.notoriety >= 5 || entity.combatant === actor.serial) ? 'danger' : 'normal',
      interactable: type === 'item' ? entity.movable !== false : !entity.dead });
  };
  for (const serial of state._visibleMobiles ?? []) append(state.ctx.world.mobiles.get(serial), 'mobile');
  for (const serial of state._visibleItems ?? []) append(state.ctx.world.items.get(serial), 'item');
  cues.sort((a, b) => (a.priority === 'danger' ? -1 : 0) - (b.priority === 'danger' ? -1 : 0) || a.distance - b.distance);
  return { ok: true, radius, cues: cues.slice(0, 256) };
}

function questGuidance(state, payload) {
  const source = state.mobile?.activeQuests ?? [];
  const active = Array.isArray(source) ? source : Object.entries(source).map(([id, value]) => ({ id, ...value }));
  const requested = clean(payload.questId, 128);
  const quests = active.filter((entry) => !requested || String(entry.id) === requested).slice(0, 128).map((entry) => {
    const definition = state.ctx.quests?.getQuest?.(entry.id); const objectives = definition?.objectives ?? entry.objectives ?? [];
    const nextIndex = objectives.findIndex((objective, index) => (entry.progress?.[index] ?? 0) < (objective.count ?? 1));
    const objective = nextIndex >= 0 ? objectives[nextIndex] : null;
    return { id: clean(entry.id, 128), complete: !objective, next: objective ? {
      index: nextIndex, kind: clean(objective.kind ?? objective.type, 64),
      target: clean(objective.target ?? objective.resource ?? objective.region ?? objective.npc, 256),
      required: Math.max(1, objective.count | 0 || 1), progress: Math.max(0, entry.progress?.[nextIndex] | 0),
      hint: clean(objective.hint ?? objective.description, 512),
    } : null };
  });
  return { ok: true, quests };
}

function supportEvidence(state) {
  if (!hasConsent(state, 'diagnostics')) return createNodeUOError(NodeUOErrorCode.PermissionDenied,
    'diagnostics consent is required', { recovery: 'request-consent' });
  const context = currentNodeUORequestContext();
  return { ok: true, capturedAt: Date.now(), traceId: context?.traceId,
    session: { id: state.id, transport: state.transportKind, protocol: state.nodeUOProtocol,
      negotiatedFeatures: state.nodeUOFeatures?.size ?? 0, roundTripMs: state.roundTripMs },
    network: { bufferedBytes: Number(state.ws?.bufferedAmount) || 0,
      stats: { ...state.nodeUOJsonStats }, bandwidth: state.nodeUOBandwidth?.snapshot?.() ?? null },
    client: state.nodeUOClientDiagnostics ?? null,
    traces: requestTraceSnapshot({ correlationId: context?.correlationId, limit: 25 }),
    privacy: { rawPackets: false, chat: false, credentials: false } };
}

function moderationCase(state, payload) {
  const operation = clean(payload.operation || 'create', 32).toLowerCase();
  if (operation === 'list') {
    if (!isStaff(state)) return createNodeUOError(NodeUOErrorCode.PermissionDenied, 'staff access required');
    if (state.ctx.platformOperations) return state.ctx.platformOperations.listModerationCases({
      status: clean(payload.status, 32), category: clean(payload.category, 64),
      query: clean(payload.query, 128), limit: payload.limit, offset: payload.offset,
    });
    return { ok: true, cases: moderationCases.slice(-Math.max(1, Math.min(500, Number(payload.limit) | 0 || 100))).reverse() };
  }
  if (operation === 'update') {
    if (!isStaff(state)) return createNodeUOError(NodeUOErrorCode.PermissionDenied, 'staff access required');
    const result = state.ctx.platformOperations?.updateModerationCase?.(payload.caseId, payload, state.accountName);
    return result ?? createNodeUOError(NodeUOErrorCode.Unavailable, 'moderation store unavailable');
  }
  if (!hasConsent(state, 'diagnostics')) return createNodeUOError(NodeUOErrorCode.PermissionDenied,
    'diagnostics consent is required', { recovery: 'request-consent' });
  const now = Date.now(); const previous = Number(state._nodeUOModerationCreateAt) || 0;
  if (!isStaff(state) && now - previous < 30_000) return createNodeUOError(NodeUOErrorCode.RateLimited,
    'wait before creating another moderation case', { retryable: true, retryAfterMs: 30_000 - (now - previous) });
  const summary = clean(payload.summary, 2000); if (!summary) return createNodeUOError(NodeUOErrorCode.InvalidArgument, 'summary is required');
  state._nodeUOModerationCreateAt = now;
  if (state.ctx.platformOperations) return state.ctx.platformOperations.createModerationCase({
    reporter: state.accountName, mobileSerial: state.mobile?.serial,
    category: payload.category, summary, eventIds: payload.eventIds,
  });
  const row = { id: crypto.randomUUID(), createdAt: Date.now(), status: 'open', reporter: state.accountName,
    mobileSerial: state.mobile?.serial >>> 0, category: clean(payload.category || 'other', 64), summary,
    eventIds: (Array.isArray(payload.eventIds) ? payload.eventIds : []).map((value) => clean(value, 128)).filter(Boolean).slice(0, 64) };
  moderationCases.push(row); if (moderationCases.length > MAX_CASES) moderationCases.splice(0, moderationCases.length - MAX_CASES);
  return { ok: true, case: row };
}

function scriptCatalog(state, payload) {
  if (!isStaff(state)) return createNodeUOError(NodeUOErrorCode.PermissionDenied, 'staff access required');
  const query = clean(payload.query, 128).toLowerCase();
  const graph = state.ctx.contentDependencies?.snapshot?.({ includeGraph: true });
  const scripts = (graph?.nodes ?? []).filter((node) => node.kind === 'script'
    && (!query || node.path.toLowerCase().includes(query))).slice(0, 2000);
  return { ok: true, revision: graph?.revision ?? null, scripts,
    runtime: { generation: state.ctx.scriptRuntime?.generation ?? 0,
      loaded: (state.ctx.scriptRuntime?.loaded ?? []).length,
      commands: state.ctx.commands?.list?.().length ?? 0,
      aiBehaviors: state.ctx.ai?.behaviors?.size ?? 0 },
    previewSession: state.ctx.platformOperations?.preview?.(state._nodeUOPreviewSession)?.session?.sessionId
      ?? previewSessions.get(state._nodeUOPreviewSession)?.sessionId ?? null };
}

function releaseCompatibility(state, payload) {
  const result = state.ctx.contentReleases?.preflight?.(payload.releaseId,
    [...(state.ctx.connections ?? [])].filter((peer) => peer._nodeUOAssetProfile).map((peer) => peer._nodeUOAssetProfile));
  if (!result) return createNodeUOError(NodeUOErrorCode.Unavailable, 'content release manager unavailable');
  const profile = state._nodeUOAssetProfile;
  return { ...result, compatible: result.ok && !(result.warnings ?? []).some((warning) => /exceeds|missing/i.test(warning)),
    client: profile ? { formats: profile.formats, cache: profile.cache, revision: profile.revision } : null,
    negotiated: [...(state.nodeUOFeatures ?? [])].map(([id, version]) => ({ id, version })) };
}

function tradeReceipts(state, payload) {
  const principal = state.accountName || String(state.mobile?.serial >>> 0);
  const account = `mobile:${principal}`;
  const rows = state.ctx.economyLedger?.receipts?.({ account,
    id: clean(payload.receiptId, 128) || undefined, limit: payload.limit }) ?? [];
  return { ok: true, verified: state.ctx.economyLedger?.verify?.().ok ?? false, receipts: rows };
}

function protocolTransaction(state, payload) {
  const operation = clean(payload.operation, 32).toLowerCase(); const actions = Array.isArray(payload.actions) ? payload.actions.slice(0, 64) : [];
  if (!['validate', 'commit'].includes(operation) || !actions.length) {
    return createNodeUOError(NodeUOErrorCode.InvalidArgument, 'a validate or commit operation with actions is required');
  }
  const current = { alive: state.mobile?.dead !== true, inWorld: state.stage === 'inWorld',
    mobileSerial: state.mobile?.serial >>> 0, map: state.mobile?.map ?? null };
  const checked = checkNodeUOPreconditions(payload.preconditions, current);
  if (!checked.ok) return createNodeUOError(NodeUOErrorCode.PreconditionsFailed, 'transaction preconditions failed', { details: checked.failed });
  const allowed = new Set(['consent.update', 'accessibility.update']);
  const invalid = actions.find((action) => !allowed.has(clean(action?.type, 64).toLowerCase()));
  if (invalid) return createNodeUOError(NodeUOErrorCode.Unsupported, `unsupported transactional action: ${clean(invalid.type)}`,
    { details: { allowedActions: [...allowed] } });
  if (operation === 'validate') return { ok: true, valid: true, actions: actions.length, current, allowedActions: [...allowed] };
  const beforeConsent = structuredClone(state.mobile._nodeUOConsent ?? { revision: 1, categories: {} });
  const beforeAccessibility = structuredClone(state.mobile.nodeUOAccessibility ?? {});
  try {
    for (const action of actions) {
      const type = clean(action.type, 64).toLowerCase();
      if (type === 'consent.update') {
        const category = clean(action.category, 32); if (!['performance', 'diagnostics', 'voice', 'personalization'].includes(category)) throw new Error(`invalid consent category ${category}`);
        state.mobile._nodeUOConsent ??= { revision: 1, categories: {} };
        state.mobile._nodeUOConsent.categories[category] = action.granted === true; state.mobile._nodeUOConsent.revision++;
      } else if (type === 'accessibility.update') {
        const next = action.preferences && typeof action.preferences === 'object' ? action.preferences : {};
        state.mobile.nodeUOAccessibility = { ...state.mobile.nodeUOAccessibility, ...next };
      }
    }
  } catch (error) {
    state.mobile._nodeUOConsent = beforeConsent; state.mobile.nodeUOAccessibility = beforeAccessibility;
    return createNodeUOError(NodeUOErrorCode.InvalidArgument, `transaction rolled back: ${error.message}`);
  }
  return { ok: true, transactionId: clean(payload.transactionId, 128) || crypto.randomUUID(), committed: actions.length };
}

export function handleNodeUOWave6Feature(state, message) {
  const payload = message.payload ?? {};
  switch (message.feature) {
    case 'protocol.causality': return { ok: true, context: currentNodeUORequestContext() };
    case 'protocol.errors': return { ok: true, codes: Object.values(NodeUOErrorCode) };
    case 'protocol.preconditions': return { ok: true, ...checkNodeUOPreconditions(payload.expected, payload.current) };
    case 'protocol.transactions': return protocolTransaction(state, payload);
    case 'protocol.command-schema': return commandSchema(state, payload);
    case 'content.dependencies': return contentDependencies(state, payload);
    case 'content.preview-session': return contentPreviewSession(state, payload);
    case 'combat.preflight': return combatPreflight(state, payload);
    case 'inventory.views': return inventoryView(state, payload);
    case 'crafting.plan': return craftingPlan(state, payload);
    case 'world.environment': return environment(state);
    case 'world.audio-scene': return audioScene(state, payload);
    case 'accessibility.spatial-cues': return spatialCues(state, payload);
    case 'quest.guidance': return questGuidance(state, payload);
    case 'support.evidence': return supportEvidence(state);
    case 'moderation.case': return moderationCase(state, payload);
    case 'script.catalog': return scriptCatalog(state, payload);
    case 'release.compatibility': return releaseCompatibility(state, payload);
    case 'trade.receipts': return tradeReceipts(state, payload);
    default: return undefined;
  }
}

export function cleanupNodeUOWave6State(state) {
  if (state?._nodeUOPreviewSession) state.ctx?.platformOperations?.endPreview?.(
    state._nodeUOPreviewSession, state.accountName,
  );
  for (const [id, row] of previewSessions) if (row.state === state) previewSessions.delete(id);
  delete state?._nodeUOPreviewSession;
}
