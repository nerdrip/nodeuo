import { NodeUOChannel, NodeUOFeature } from '@uo/nodeuo-protocol';
import { NodeUOJsonKind } from '@uo/nodeuo-protocol';
import { bus } from '../core/event-bus.js';
import { postPrioritizedTask } from '../shared/runtime-governor.js';
import { world } from '../world/world.js';
import { installNodeUOWebTransport } from './nodeuo-webtransport.js';

const ASSET_DOCUMENTS = Object.freeze({
  land: ['tiledata.json', 'tiledata'], static: ['tiledata.json', 'tiledata'],
  animdata: ['animdata.json', 'animdata'], hue: ['hues.json', 'huesMeta'],
  multi: ['multi.json', 'multis'], cliloc: ['cliloc.json', 'cliloc'],
  sound: ['sounds.json', 'sounds'], music: ['music.json', 'music'],
  cursor: ['cursors.json', 'cursorsManifest'],
});

function definedJson(value) {
  if (Array.isArray(value)) return value.map((entry) => entry === undefined ? null : definedJson(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => [key, definedJson(entry)]));
}

function requestFeature(net, feature, payload = {}, options = {}) {
  if (!net?.supportsNodeUO?.(feature)) return Promise.reject(new Error(`${feature} is unavailable`));
  return net.sendNodeUORequest({ capability: feature, payload: definedJson(payload), ...options });
}

export function requestNodeUORpc(net, targetFeature, method, params = {}, options = {}) {
  if (!net?.supportsNodeUO?.('protocol.rpc')) {
    return Promise.reject(new Error('protocol.rpc is unavailable'));
  }
  return net.sendNodeUORpc(targetFeature, method, params, options);
}

export function requestNodeUOAiInspection(net, serial, options = {}) {
  return requestFeature(net, 'ai.inspector', {
    serial: Number(serial) >>> 0,
    includePath: options.includePath !== false,
    targetSerial: Number(options.targetSerial) >>> 0,
    maxNodes: Math.max(128, Math.min(4096, Number(options.maxNodes) | 0 || 2048)),
  }, { ttlMs: 5000 });
}

export function requestNodeUOSpectatorReplay(net, limit = 256) {
  return requestFeature(net, 'spectator.replay', { limit: Math.max(1, Math.min(2000, limit | 0)) },
    { ttlMs: 5000 });
}

export function requestNodeUOInstanceHandoff(net, id = '') {
  return requestFeature(net, 'instance.handoff', { id: String(id).slice(0, 64) }, { ttlMs: 5000 });
}

export function requestNodeUOVoiceAuthorization(net) {
  return requestFeature(net, 'voice.authorization', {}, { ttlMs: 5000 });
}

export function requestNodeUOCinematic(net, id) {
  return requestFeature(net, 'cinematic.timeline', { id: String(id).slice(0, 64) }, { ttlMs: 5000 });
}

export function requestNodeUOManifest(net) {
  return requestFeature(net, 'protocol.manifest', { operation: 'describe' }, { ttlMs: 5000 });
}

export function requestNodeUOSchemaRegistry(net, feature = '') {
  return requestFeature(net, 'protocol.schema-registry', {
    operation: 'describe', feature: String(feature).slice(0, 128),
  }, { ttlMs: 5000 });
}

export function requestNodeUOProgressiveSnapshot(net, radius = 32) {
  return requestFeature(net, 'world.progressive-snapshot', {
    operation: 'start', radius: Math.max(8, Math.min(64, Number(radius) | 0 || 32)),
  }, { ttlMs: 10_000 });
}

export function requestNodeUOSectorChanges(net, cursor = 0, radius = 24) {
  return requestFeature(net, 'world.sector-stream', {
    operation: 'catch-up', cursor: Math.max(0, Number(cursor) || 0),
    radius: Math.max(8, Math.min(64, Number(radius) | 0 || 24)),
  }, { ttlMs: 5000 });
}

export function selectNodeUONetworkPath(net, metrics = {}) {
  return requestFeature(net, 'network.path-selection', {
    operation: 'select', candidates: ['websocket',
      ...(typeof globalThis.WebTransport === 'function' ? ['webtransport'] : [])], metrics,
  }, { ttlMs: 5000 });
}

export function runNodeUOInventoryTransaction(net, operation, containerSerial, options = {}) {
  return requestFeature(net, 'inventory.transactions', {
    operation: String(operation).slice(0, 32), containerSerial: Number(containerSerial) >>> 0,
    transactionId: String(options.transactionId ?? cryptoRandomId()).slice(0, 96),
    expectedRevision: options.expectedRevision,
    mutations: Array.isArray(options.mutations) ? options.mutations.slice(0, 256) : [],
  }, { ttlMs: 5000, idempotencyKey: options.idempotencyKey ?? `inventory:${cryptoRandomId()}` });
}

export function requestNodeUOQuestGraph(net, questId = '') {
  return requestFeature(net, 'quest.graph', { operation: 'get', questId: String(questId).slice(0, 128) },
    { ttlMs: 5000 });
}

export function updateNodeUOPartyTactics(net, operation, plan = null, expectedRevision = undefined) {
  return requestFeature(net, 'party.tactics', { operation, plan, expectedRevision }, {
    ttlMs: 5000, idempotencyKey: `party-tactics:${operation}:${cryptoRandomId()}`,
  });
}

export function requestNodeUONpcRelationships(net, npcSerial = 0) {
  return requestFeature(net, 'npc.relationships', { operation: 'get', npcSerial: Number(npcSerial) >>> 0 },
    { ttlMs: 5000 });
}

/** Authoritative activity catalog and actions. This feature is deliberately
 * JSON-only because the ordinary UO client uses the server's classic gump
 * facade instead of understanding this document shape. */
export function requestNodeUOGameSystems(net, operation = 'open', options = {}) {
  return requestFeature(net, NodeUOFeature.GameSystems ?? 'game.systems', {
    operation: String(operation).slice(0, 32),
    systemId: options.systemId ? String(options.systemId).slice(0, 64) : undefined,
    instanceId: options.instanceId ? String(options.instanceId).slice(0, 160) : undefined,
    actionId: options.actionId ? String(options.actionId).slice(0, 32) : undefined,
    command: options.command ? String(options.command).slice(0, 32) : undefined,
    data: options.data && typeof options.data === 'object' ? options.data : undefined,
    category: options.category ? String(options.category).slice(0, 32) : undefined,
    query: options.query ? String(options.query).slice(0, 96) : undefined,
    amount: options.amount == null ? undefined : Math.max(1, Math.min(1000, Number(options.amount) | 0)),
    limit: options.limit == null ? undefined : Math.max(1, Math.min(100, Number(options.limit) | 0)),
  }, {
    ttlMs: 5000,
    idempotencyKey: ['join', 'leave', 'action', 'special'].includes(operation)
      ? `game-system:${operation}:${options.instanceId ?? options.systemId ?? ''}:${options.actionId ?? ''}:${Date.now()}`
      : undefined,
  });
}

export function updateNodeUOAccessibility(net, preferences = null) {
  return requestFeature(net, 'ui.accessibility', {
    operation: preferences ? 'update' : 'get', preferences: preferences ?? undefined,
  }, { ttlMs: 5000, idempotencyKey: preferences ? `accessibility:${JSON.stringify(preferences)}` : undefined });
}

export function requestNodeUOAssetPatchset(net, fromRevision = '') {
  return requestFeature(net, 'assets.patchsets', {
    operation: 'resolve', fromRevision: String(fromRevision).slice(0, 128),
  }, { ttlMs: 10_000 });
}

export function requestNodeUOModPermissions(net) {
  return requestFeature(net, 'mods.permissions', { operation: 'list' }, { ttlMs: 5000 });
}

export function runNodeUOConfigTransaction(net, operation, transactionId = '', patch = null) {
  return requestFeature(net, 'admin.config-transactions', {
    operation, transactionId, patch: patch ?? undefined,
  }, { ttlMs: 10_000, idempotencyKey: operation === 'commit' ? `config:${transactionId}` : undefined });
}

export function requestNodeUOTimeTravel(net, cursor = 0, limit = 256) {
  return requestFeature(net, 'debug.time-travel', { operation: 'read', cursor, limit }, { ttlMs: 5000 });
}

export function requestNodeUOMarketStream(net, query = '') {
  return requestFeature(net, 'economy.market-stream', { operation: 'search', query }, { ttlMs: 5000 });
}

export function publishNodeUOVoiceSpatialState(net, muted = false) {
  return requestFeature(net, 'voice.spatial-state', { operation: 'update', muted }, { ttlMs: 3000 });
}

export function runNodeUOLiveHandoff(net, operation = 'prepare', routeId = '', token = '') {
  return requestFeature(net, 'instance.live-handoff', { operation, routeId, token }, { ttlMs: 5000,
    idempotencyKey: operation === 'commit' ? `handoff:${token}` : undefined });
}

export function requestNodeUOFullSpectatorStream(net, options = {}) {
  return requestFeature(net, 'spectator.full-stream', { operation: 'snapshot',
    targetSerial: Number(options.targetSerial) >>> 0, cursor: Number(options.cursor) || 0,
    delayMs: Number(options.delayMs) || 0 }, { ttlMs: 5000 });
}

export function requestNodeUOPrivacyContract(net) {
  return requestFeature(net, 'protocol.privacy-contract', { operation: 'describe' }, { ttlMs: 5000 });
}

export function updateNodeUOConsent(net, category = '', granted = undefined, revision = undefined) {
  return requestFeature(net, 'protocol.consent', {
    operation: granted == null ? 'get' : 'update', category: String(category).slice(0, 32),
    granted, revision,
  }, { ttlMs: 5000, idempotencyKey: granted == null ? undefined : `consent:${category}:${granted}:${revision ?? ''}` });
}

export function reportNodeUOFeatureHealth(net, reports = []) {
  return requestFeature(net, 'protocol.feature-health', {
    operation: reports.length ? 'report' : 'query', reports: reports.slice(0, 64),
  }, { ttlMs: 5000, delivery: 'latest' });
}

export function publishNodeUOPerformanceHints(net, metrics = {}) {
  return requestFeature(net, 'client.performance-hints', {
    operation: 'update', fps: Math.max(1, Number(metrics.fps) || 60),
    frameP95Ms: Math.max(0, Number(metrics.frameP95Ms) || 0),
    memoryMB: Math.max(0, Number(metrics.memoryMB) || 0),
    desiredRateHz: Math.max(5, Math.min(60, Number(metrics.desiredRateHz) | 0 || 30)),
    desiredRadius: Math.max(8, Math.min(64, Number(metrics.desiredRadius) | 0 || 24)),
  }, { ttlMs: 3000, delivery: 'latest' });
}

export function publishNodeUOAssetProfile(net, profile = {}) {
  return requestFeature(net, 'assets.client-profile', {
    operation: 'update', revision: String(profile.revision ?? '').slice(0, 128),
    formats: Array.isArray(profile.formats) ? profile.formats : ['png'],
    cache: profile.cache ?? {}, atlas: profile.atlas ?? {},
  }, { ttlMs: 5000, delivery: 'latest' });
}

export function requestNodeUOContentPreflight(net, releaseId = '', profile = {}) {
  return requestFeature(net, 'content.preflight', {
    operation: 'check', releaseId: String(releaseId).slice(0, 128),
    availableBytes: Math.max(0, Number(profile.availableBytes) || 0),
    formats: Array.isArray(profile.formats) ? profile.formats : ['png'],
  }, { ttlMs: 10_000 });
}

export function requestNodeUODiagnosticTrace(net, context = {}) {
  return requestFeature(net, 'diagnostics.trace', {
    operation: 'capture', context,
  }, { ttlMs: 5000 });
}

export function requestNodeUOContentRelease(net) {
  return requestFeature(net, 'content.release', { operation: 'active' }, { ttlMs: 5000 });
}

export function requestNodeUOInteractionCatalog(net, targetSerial, options = {}) {
  return requestFeature(net, 'interaction.catalog', {
    operation: options.actionId ? 'invoke' : 'list', targetSerial: Number(targetSerial) >>> 0,
    actionId: options.actionId, expectedRevision: options.expectedRevision,
  }, { ttlMs: 5000, idempotencyKey: options.actionId ? `interaction:${targetSerial}:${options.actionId}:${Date.now()}` : undefined });
}

export function requestNodeUORegionPrefetch(net, location = {}) {
  return requestFeature(net, 'world.region-prefetch', { operation: 'resolve',
    x: location.x, y: location.y, map: location.map, radius: location.radius ?? 24,
  }, { ttlMs: 5000, delivery: 'latest' });
}

export function requestNodeUOSectorDigests(net, radius = 24) {
  return requestFeature(net, 'world.sector-digest', { operation: 'compare', radius,
    digests: (world.nodeUOSectorDigests?.digests ?? []).slice(0, 128)
      .map(({ sector, digest }) => ({ sector, digest })),
  }, { ttlMs: 5000, delivery: 'latest' });
}

function decodeBase64Url(value) {
  const base64 = String(value).replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function verifyNodeUOAssetPatchset(response) {
  if (!response?.patchset || response.algorithm !== 'Ed25519' || !globalThis.crypto?.subtle) return false;
  const key = await globalThis.crypto.subtle.importKey('spki', decodeBase64Url(response.publicKey),
    { name: 'Ed25519' }, false, ['verify']);
  return globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, decodeBase64Url(response.signature),
    new TextEncoder().encode(JSON.stringify(response.patchset)));
}

export async function verifyNodeUOSignedContent(response) {
  if (!response?.document || response.algorithm !== 'Ed25519' || !globalThis.crypto?.subtle) return false;
  const key = await globalThis.crypto.subtle.importKey('spki', decodeBase64Url(response.publicKey),
    { name: 'Ed25519' }, false, ['verify']);
  return globalThis.crypto.subtle.verify({ name: 'Ed25519' }, key, decodeBase64Url(response.signature),
    new TextEncoder().encode(JSON.stringify(response.document)));
}

export function configureNodeUOSubscription(net, target, options = {}) {
  const name = String(target ?? '').trim().toLowerCase();
  return requestFeature(net, 'protocol.subscriptions', {
    target: name,
    components: Array.isArray(options.components) ? options.components : [],
    fields: Array.isArray(options.fields) ? options.fields : [],
    rateHz: Number(options.rateHz) || 30,
    maxEntities: Number(options.maxEntities) || 512,
    levelOfDetail: options.levelOfDetail,
    maxBytesPerSecond: options.maxBytesPerSecond,
    area: options.area,
  }, {
    ttlMs: 5000,
    idempotencyKey: `subscription:${name}:${JSON.stringify(options)}`.slice(0, 160),
  });
}

export function removeNodeUOSubscription(net, target) {
  const name = String(target ?? '').trim().toLowerCase();
  return requestFeature(net, 'protocol.subscriptions', {
    operation: 'remove', target: name,
  }, { ttlMs: 5000, idempotencyKey: `subscription:remove:${name}` });
}

export function requestNodeUOStateRepair(net, serials, options = {}) {
  return requestFeature(net, 'protocol.state-repair', {
    serials: [...new Set((Array.isArray(serials) ? serials : [serials])
      .map((serial) => Number(serial) >>> 0).filter(Boolean))].slice(0, 64),
    components: Array.isArray(options.components) ? options.components : [],
    fields: Array.isArray(options.fields) ? options.fields : [],
  }, { ttlMs: 5000 });
}

export function publishNodeUOPartyPing(net, ping) {
  return requestFeature(net, 'social.pings', { operation: 'publish', ping }, {
    ttlMs: 5000, idempotencyKey: `party-ping:${cryptoRandomId()}`,
  });
}

export function removeNodeUOPartyPing(net, id) {
  return requestFeature(net, 'social.pings', { operation: 'remove', id: String(id).slice(0, 96) }, {
    ttlMs: 5000, idempotencyKey: `party-ping-remove:${String(id).slice(0, 96)}`,
  });
}

export function requestNodeUOWorldEvents(net, cursor = 0, limit = 64) {
  return requestFeature(net, 'world.events', {
    operation: 'list', cursor: Math.max(0, Number(cursor) >>> 0),
    limit: Math.max(1, Math.min(256, Number(limit) | 0 || 64)),
  }, { ttlMs: 5000 });
}

export function runNodeUOEditorTransaction(net, operation, transactionId = '', mutations = [], options = {}) {
  return requestFeature(net, 'editor.transactions', {
    operation: String(operation).slice(0, 32), transactionId: String(transactionId).slice(0, 96),
    mutations: Array.isArray(mutations) ? mutations.slice(0, 4096) : [],
    leaseId: String(options.leaseId ?? '').slice(0, 96),
  }, {
    ttlMs: 10_000,
    idempotencyKey: operation === 'commit' ? `editor-commit:${String(transactionId).slice(0, 96)}` : undefined,
  });
}

export function updateNodeUOWorldAnnotation(net, operation, annotation = {}, scope = 'personal') {
  return requestFeature(net, 'world.annotations', {
    operation: String(operation ?? 'upsert').slice(0, 32),
    scope: ['personal', 'party', 'guild'].includes(scope) ? scope : 'personal',
    annotation,
  }, { ttlMs: 5000, idempotencyKey: `annotation:${operation}:${annotation.id ?? cryptoRandomId()}` });
}

export function listNodeUOWorldAnnotations(net, scope = 'personal') {
  return requestFeature(net, 'world.annotations', { operation: 'list', scope }, { ttlMs: 5000 });
}

export function updateNodeUOEditorCollaboration(net, operation, resource = '', options = {}) {
  return requestFeature(net, 'editor.collaboration', {
    operation: String(operation ?? 'status').slice(0, 32),
    resource: String(resource).slice(0, 128),
    leaseId: String(options.leaseId ?? '').slice(0, 96),
    cursor: options.cursor,
  }, { ttlMs: 5000 });
}

export function requestNodeUOCausality(net, options = {}) {
  return requestFeature(net, 'protocol.causality', {}, { ttlMs: 3000, ...options });
}

export function describeNodeUOErrors(net, options = {}) {
  return requestFeature(net, 'protocol.errors', {}, { ttlMs: 3000, ...options });
}

export function checkNodeUOPreconditionsRemotely(net, expected, current, options = {}) {
  return requestFeature(net, 'protocol.preconditions', { expected, current }, { ttlMs: 3000, ...options });
}

export function runNodeUOTransaction(net, actions, options = {}) {
  const transactionId = String(options.transactionId ?? cryptoRandomId()).slice(0, 128);
  return requestFeature(net, 'protocol.transactions', {
    operation: options.validateOnly ? 'validate' : 'commit', transactionId,
    actions: Array.isArray(actions) ? actions.slice(0, 64) : [],
    preconditions: options.preconditions,
  }, { ttlMs: 10_000, idempotencyKey: `transaction:${transactionId}`,
    transactionId, preconditions: options.envelopePreconditions, signal: options.signal });
}

export function requestNodeUOCommandSchema(net, command = '', options = {}) {
  return requestFeature(net, 'protocol.command-schema', { command: String(command).slice(0, 96) },
    { ttlMs: 5000, ...options });
}

export function requestNodeUOContentDependencies(net, node = '', options = {}) {
  return requestFeature(net, 'content.dependencies', {
    operation: node ? 'impact' : (options.includeGraph ? 'graph' : 'summary'),
    node: String(node).slice(0, 300), depth: Math.max(1, Math.min(16, Number(options.depth) | 0 || 4)),
  }, { ttlMs: 10_000, signal: options.signal });
}

export function manageNodeUOPreviewSession(net, operation = 'status', resources = [], options = {}) {
  return requestFeature(net, 'content.preview-session', {
    operation, sessionId: options.sessionId,
    resources: Array.isArray(resources) ? resources.slice(0, 256) : [], ttlMs: options.sessionTtlMs,
  }, { ttlMs: 10_000, idempotencyKey: operation === 'start' ? `preview:${cryptoRandomId()}` : undefined,
    signal: options.signal });
}

export function requestNodeUOCombatPreflight(net, targetSerial, action = 'attack', options = {}) {
  return requestFeature(net, 'combat.preflight', {
    targetSerial: Number(targetSerial) >>> 0, action: String(action).slice(0, 64),
    range: Math.max(1, Math.min(24, Number(options.range) | 0 || 1)),
  }, { ttlMs: 1000, delivery: 'latest', signal: options.signal,
    preconditions: options.preconditions });
}

export function requestNodeUOInventoryView(net, container = 'backpack', options = {}) {
  return requestFeature(net, 'inventory.views', {
    container, query: String(options.query ?? '').slice(0, 128),
    itemIds: Array.isArray(options.itemIds) ? options.itemIds.slice(0, 256) : [],
    offset: Math.max(0, Number(options.offset) | 0),
    limit: Math.max(1, Math.min(512, Number(options.limit) | 0 || 100)),
  }, { ttlMs: 5000, signal: options.signal });
}

export function requestNodeUOCraftingPlan(net, recipes, options = {}) {
  return requestFeature(net, 'crafting.plan', {
    recipes: Array.isArray(recipes) ? recipes.slice(0, 64) : [],
    repetitions: Math.max(1, Math.min(1000, Number(options.repetitions) | 0 || 1)),
  }, { ttlMs: 5000, signal: options.signal });
}

export function requestNodeUOEnvironment(net, options = {}) {
  return requestFeature(net, 'world.environment', {}, { ttlMs: 3000, delivery: 'latest', ...options });
}

export function requestNodeUOAudioScene(net, radius = 18, options = {}) {
  return requestFeature(net, 'world.audio-scene', { radius }, { ttlMs: 3000, delivery: 'latest', ...options });
}

export function requestNodeUOSpatialCues(net, radius = 18, options = {}) {
  return requestFeature(net, 'accessibility.spatial-cues', { radius }, { ttlMs: 3000, delivery: 'latest', ...options });
}

export function requestNodeUOQuestGuidance(net, questId = '', options = {}) {
  return requestFeature(net, 'quest.guidance', { questId: String(questId).slice(0, 128) },
    { ttlMs: 5000, ...options });
}

export function requestNodeUOSupportEvidence(net, options = {}) {
  return requestFeature(net, 'support.evidence', {}, { ttlMs: 5000, ...options });
}

export function createNodeUOModerationCase(net, summary, options = {}) {
  return requestFeature(net, 'moderation.case', {
    operation: 'create', summary: String(summary).slice(0, 2000),
    category: String(options.category ?? 'other').slice(0, 64),
    eventIds: Array.isArray(options.eventIds) ? options.eventIds.slice(0, 64) : [],
  }, { ttlMs: 5000, idempotencyKey: options.idempotencyKey ?? `moderation:${cryptoRandomId()}`,
    signal: options.signal });
}

export function requestNodeUOScriptCatalog(net, query = '', options = {}) {
  return requestFeature(net, 'script.catalog', { query: String(query).slice(0, 128) },
    { ttlMs: 10_000, ...options });
}

export function requestNodeUOReleaseCompatibility(net, releaseId = '', options = {}) {
  return requestFeature(net, 'release.compatibility', { releaseId: String(releaseId).slice(0, 128) },
    { ttlMs: 10_000, ...options });
}

export function requestNodeUOTradeReceipts(net, options = {}) {
  return requestFeature(net, 'trade.receipts', {
    receiptId: String(options.receiptId ?? '').slice(0, 128),
    limit: Math.max(1, Math.min(500, Number(options.limit) | 0 || 100)),
  }, { ttlMs: 5000, signal: options.signal });
}

export function requestNodeUOPolicy(net, feature = '', options = {}) {
  return requestFeature(net, 'protocol.policy', { operation: 'describe', feature: String(feature).slice(0, 128) },
    { ttlMs: 5000, ...options });
}

export function manageNodeUOSubscriptionLease(net, operation, options = {}) {
  return requestFeature(net, 'protocol.subscription-leases', {
    operation, leaseId: options.leaseId, target: options.target,
    components: options.components, fields: options.fields, rateHz: options.rateHz,
    maxEntities: options.maxEntities, maxBytesPerSecond: options.maxBytesPerSecond,
    levelOfDetail: options.levelOfDetail, area: options.area, ttlMs: options.ttlMs, cursor: options.cursor,
  }, { ttlMs: 5000, idempotencyKey: `${operation}:${options.leaseId ?? options.target ?? cryptoRandomId()}`,
    signal: options.signal });
}

export function readNodeUOResumableStream(net, stream, options = {}) {
  return requestFeature(net, 'protocol.resumable-streams', { operation: 'read', stream,
    cursor: options.cursor, limit: options.limit, token: options.token }, { ttlMs: 5000, signal: options.signal });
}

export function requestNodeUORetryPolicy(net, code = '', options = {}) {
  return requestFeature(net, 'protocol.retry-policy', { operation: 'describe', code }, { ttlMs: 3000, ...options });
}

export function requestNodeUOCostHints(net, feature = '', options = {}) {
  return requestFeature(net, 'protocol.cost-hints', { operation: 'describe', feature }, { ttlMs: 3000, ...options });
}

export function requestNodeUOCompatibilityFallbacks(net, feature = '', options = {}) {
  return requestFeature(net, 'protocol.compatibility-fallbacks', { operation: 'describe', feature },
    { ttlMs: 3000, ...options });
}

export function runNodeUOConformance(net, probes = [], options = {}) {
  return requestFeature(net, 'protocol.conformance', { operation: 'probe', nonce: cryptoRandomId(),
    probes: Array.isArray(probes) ? probes.slice(0, 128) : [] }, { ttlMs: 10_000, ...options });
}

export function requestNodeUOPrivacyLabels(net, feature = '', options = {}) {
  return requestFeature(net, 'protocol.privacy-labels', { operation: 'describe', feature },
    { ttlMs: 3000, ...options });
}

export function requestNodeUOSignedContent(net, releaseId = '', options = {}) {
  return requestFeature(net, 'protocol.signed-content', { operation: 'resolve', releaseId },
    { ttlMs: 10_000, ...options });
}

export function publishNodeUOClientFrames(net, samples = [], renderer = '', options = {}) {
  return requestFeature(net, 'diagnostics.client-frame', { operation: 'report', renderer,
    deviceLost: options.deviceLost === true, samples: Array.isArray(samples) ? samples.slice(-120) : [] },
    { ttlMs: 3000, delivery: 'latest', signal: options.signal });
}

export function manageNodeUOWorldLayer(net, operation = 'get', layer = '', options = {}) {
  return requestFeature(net, 'world.layers', { operation, layer, targetSerial: Number(options.targetSerial) >>> 0 },
    { ttlMs: 5000, idempotencyKey: operation === 'set' ? `world-layer:${options.targetSerial}:${layer}` : undefined });
}

export function manageNodeUOLiveEvent(net, operation = 'list', event = null, options = {}) {
  return requestFeature(net, 'world.live-event-director', { operation, event, eventId: options.eventId,
    phase: options.phase, status: options.status, expectedRevision: options.expectedRevision,
    includeCompleted: options.includeCompleted }, { ttlMs: 5000, signal: options.signal });
}

export function requestNodeUOCodex(net, query = '', options = {}) {
  return requestFeature(net, 'world.codex', { operation: options.operation ?? 'list', query,
    entryId: options.entryId, entry: options.entry }, { ttlMs: 5000, signal: options.signal });
}

export function manageNodeUOLootPolicy(net, operation = 'get', policy = null, expectedRevision = undefined) {
  return requestFeature(net, 'party.loot-policy', { operation, policy, expectedRevision },
    { ttlMs: 5000, idempotencyKey: operation === 'set' ? `loot-policy:${expectedRevision}:${JSON.stringify(policy)}` : undefined });
}

export function manageNodeUOSafeForm(net, operation = 'list', formId = '', values = null, options = {}) {
  return requestFeature(net, 'ui.safe-schema', { operation, formId, values },
    { ttlMs: 5000, idempotencyKey: operation === 'submit' ? `safe-form:${formId}:${cryptoRandomId()}` : undefined,
      signal: options.signal });
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function fetchAsset(name, revision, expectedSha256 = '', descriptor = null) {
  const url = `/assets/${name}?nodeuo=${encodeURIComponent(revision || Date.now())}`;
  const total = Math.max(0, Number(descriptor?.bytes) | 0);
  const chunkBytes = Math.max(64 * 1024, Math.min(1024 * 1024,
    Number(descriptor?.chunkBytes) | 0 || 256 * 1024));
  let bytes;
  if (descriptor?.ranges && total > chunkBytes) {
    const firstEnd = Math.min(total, chunkBytes) - 1;
    const first = await fetch(url, { cache: 'no-store', credentials: 'same-origin',
      headers: { Range: `bytes=0-${firstEnd}` } });
    if (!first.ok) throw new Error(`${name}: HTTP ${first.status}`);
    if (first.status !== 206) bytes = await first.arrayBuffer();
    else {
      const chunks = new Array(Math.ceil(total / chunkBytes));
      chunks[0] = await first.arrayBuffer();
      let next = 1;
      const download = async () => {
        while (next < chunks.length) {
          const index = next++;
          const start = index * chunkBytes;
          const end = Math.min(total, start + chunkBytes) - 1;
          const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin',
            headers: { Range: `bytes=${start}-${end}` } });
          if (response.status !== 206) throw new Error(`${name}: range ${start}-${end} returned HTTP ${response.status}`);
          chunks[index] = await response.arrayBuffer();
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, chunks.length - 1) }, download));
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { joined.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
      bytes = joined.buffer;
    }
  } else {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    bytes = await response.arrayBuffer();
  }
  if (expectedSha256 && globalThis.crypto?.subtle) {
    const actual = base64Url(await crypto.subtle.digest('SHA-256', bytes));
    if (actual !== expectedSha256) throw new Error(`${name}: SHA-256 integrity check failed`);
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function clearPatchCache(assets) {
  for (const [kind, patches, cache] of [
    ['gump', assets._patches.gumps, assets._gumpTextures],
    ['static', assets._patches.statics, assets._staticTextures],
  ]) {
    for (const id of patches.keys()) {
      assets._releaseCachedTexture?.(cache.get(id));
      cache.delete(id);
      if (kind === 'gump') assets._gumpTextureLoads.delete(id);
      else assets._staticTextureLoads.delete(id);
    }
    patches.clear();
  }
  assets._patches.hues.clear();
}

async function reloadAssets(assets, update) {
  if (!assets?._worldReady) return false;
  const revision = update?.revision;
  const changes = Array.isArray(update?.changed) ? update.changed : [];
  const files = new Map((update?.files ?? []).map((file) => [file.name, file]));
  if (changes.some((entry) => entry?.type === 'patches')) {
    clearPatchCache(assets);
    const file = files.get('patches.json');
    assets.applyPatches(await fetchAsset('patches.json', revision, file?.sha256, file));
  }
  if (changes.some((entry) => entry?.type === 'override')) {
    const file = files.get('asset-overrides.json');
    assets.applyAssetOverrides(await fetchAsset('asset-overrides.json', revision, file?.sha256, file));
  }
  const kinds = new Set(changes.filter((entry) => entry?.type === 'metadata').map((entry) => entry.kind));
  for (const kind of kinds) {
    const record = ASSET_DOCUMENTS[kind];
    if (!record) continue;
    const [name, field] = record;
    const descriptor = files.get(name);
    const document = await fetchAsset(name, revision, descriptor?.sha256, descriptor);
    assets[field] = field === 'cliloc' ? document?.entries : document;
  }
  bus.emit('assets:hot-reload-complete', { revision, changes });
  return true;
}

/** Installs opt-in services that are silent on classic shards. */
export function installNodeUOServices(net, { performanceStats, assets } = {}) {
  const stopWebTransport = installNodeUOWebTransport(net);
  let reload = Promise.resolve();
  const unsubscribe = bus.on('assets:hot-reload', (update) => {
    reload = reload.then(() => reloadAssets(assets, update))
      .catch((error) => bus.emit('nodeuo:notice', { level: 'error', title: 'Assets', text: error.message }));
  });
  const supportedAssetFormats = () => ['png',
    ...(assets?.atlasPageStats?.formats?.ktx2 > 0 ? ['ktx2'] : [])];
  const readStorageProfile = async () => {
    try {
      const estimate = await globalThis.navigator?.storage?.estimate?.();
      return { usage: Number(estimate?.usage) || 0, quota: Number(estimate?.quota) || 0,
        pressure: estimate?.quota ? Number(estimate.usage) / Number(estimate.quota) : 0,
        availableBytes: Math.max(0, Number(estimate?.quota) - Number(estimate?.usage)) || 0 };
    } catch { return { usage: 0, quota: 0, pressure: 0, availableBytes: 0 }; }
  };
  const reportAssetProfile = async () => {
    if (!net.supportsNodeUO?.('assets.client-profile')
        || world.nodeUOConsent?.categories?.performance !== true) return;
    const storage = await readStorageProfile();
    await publishNodeUOAssetProfile(net, {
      revision: world.nodeUOContentRelease?.active?.fingerprint ?? '',
      formats: supportedAssetFormats(), cache: { ...storage, ...(world.nodeUOAssetCache?.state ?? {}) },
      atlas: assets?.atlasPageStats ?? {},
    });
  };
  const serviceWorkerMessage = (event) => {
    const message = event.data ?? {};
    if (message.type === 'nodeuo:cache-progress') {
      bus.emit('assets:cache-progress', message);
      return;
    }
    if (message.type !== 'nodeuo:cache-state') return;
    world.nodeUOAssetCache = message;
    bus.emit('assets:cache-state', message);
    if (message.result?.ok && message.result?.operation === 'stage') {
      globalThis.navigator?.serviceWorker?.controller?.postMessage?.({ type: 'nodeuo:asset-cache',
        operation: 'activate', generation: message.result.generation });
    }
  };
  globalThis.navigator?.serviceWorker?.addEventListener?.('message', serviceWorkerMessage);
  globalThis.navigator?.serviceWorker?.controller?.postMessage?.({ type: 'nodeuo:asset-cache', operation: 'status' });
  const contentReleaseUnsubscribe = bus.on('content:release', async (payload) => {
    const release = payload?.active;
    const controller = globalThis.navigator?.serviceWorker?.controller;
    if (!release?.fingerprint || !controller) return;
    try {
      const storage = await readStorageProfile();
      if (net.supportsNodeUO?.('content.preflight')) {
        const preflight = await requestNodeUOContentPreflight(net, release.id, {
          availableBytes: storage.availableBytes, formats: supportedAssetFormats(),
        });
        world.nodeUOContentPreflight = preflight;
        bus.emit('content:preflight', preflight);
        if (!preflight?.ok) throw new Error(preflight?.warnings?.join('; ') || preflight?.error || 'content preflight failed');
      }
      if (net.supportsNodeUO?.('release.compatibility')) {
        const compatibility = await requestNodeUOReleaseCompatibility(net, release.id);
        world.nodeUOReleaseCompatibility = compatibility;
        bus.emit('content:release-compatibility', compatibility);
        if (compatibility?.compatible === false) throw new Error('client is not compatible with the staged content release');
      }
      controller.postMessage({ type: 'nodeuo:asset-cache', operation: 'stage',
        generation: release.fingerprint, files: release.files ?? [] });
    } catch (error) {
      bus.emit('nodeuo:notice', { level: 'warning', title: 'Content release', text: error.message });
    }
  });
  const consentUnsubscribe = bus.on('nodeuo:consent', () => { void reportAssetProfile().catch(() => {}); });
  const publishDiagnostics = () => {
    const atlas = assets?.atlasPageStats;
    const frameMs = Math.max(0, Number(performanceStats?.frameMs) || 0);
    if (net.supportsNodeUO?.(NodeUOFeature.LiveDiagnostics)) {
      net.sendNodeUOEvent({
        channel: NodeUOChannel.Diagnostics, namespace: 'nodeuo.diagnostics',
        capability: NodeUOFeature.LiveDiagnostics,
        payload: {
          fps: frameMs > 0 ? 1000 / frameMs : 0,
          frameP95Ms: performanceStats?.frameP95Ms,
          heapUsedBytes: performanceStats?.heapUsedBytes,
          gpuBytes: atlas?.estimatedBytes,
          decodeQueue: assets?._decodePool?.stats?.queued,
          bufferedBytes: net.ws?.bufferedAmount,
        },
      });
    }
    if (net.supportsNodeUO?.('diagnostics.client-frame')
        && world.nodeUOConsent?.categories?.performance === true) {
      const samples = (performanceStats?.longTaskHistory ?? []).filter((row) => row?.at > 0)
        .map((row) => ({ at: row.at, frameMs: row.frameMs || row.ms,
          updateMs: row.subsystem === 'update' ? row.ms : 0,
          drawMs: row.subsystem === 'draw' ? row.ms : 0,
          scripts: row.scripts ?? [] })).slice(-32);
      void publishNodeUOClientFrames(net, samples, performanceStats?.renderer ?? '', {
        deviceLost: performanceStats?.deviceLost === true,
      }).catch(() => {});
    }
  };
  let clockSyncInFlight = false;
  let flowUpdateInFlight = false;
  let sectorSyncInFlight = false;
  let subscriptionTier = '';
  let subscriptionLease = null;
  let candidateTier = '';
  let candidateSamples = 0;
  const loadPlatformContracts = async () => {
    const requests = [
      ['protocol.policy', requestNodeUOPolicy, 'nodeUOPolicy', 'nodeuo:policy'],
      ['protocol.compatibility-fallbacks', requestNodeUOCompatibilityFallbacks, 'nodeUOFallbacks', 'nodeuo:fallbacks'],
      ['world.layers', (client) => manageNodeUOWorldLayer(client), 'nodeUOWorldLayer', 'world:layer'],
      ['world.live-event-director', (client) => manageNodeUOLiveEvent(client), 'nodeUOLiveEvents', 'world:live-events'],
      ['world.codex', (client) => requestNodeUOCodex(client), 'nodeUOCodex', 'world:codex'],
      ['ui.safe-schema', (client) => manageNodeUOSafeForm(client), 'nodeUOSafeForms', 'ui:safe-forms'],
    ];
    for (const [feature, request, field, event] of requests) {
      if (!net.supportsNodeUO?.(feature)) continue;
      try {
        const result = await postPrioritizedTask(() => request(net), { priority: 'background' });
        world[field] = result; bus.emit(event, result);
      }
      catch { /* independently negotiated convenience feature */ }
    }
  };
  const synchronizeClock = async () => {
    if (clockSyncInFlight || !net.supportsNodeUO?.('clock.sync')) return;
    clockSyncInFlight = true;
    const clientSentAt = Date.now();
    try {
      const sample = await net.sendNodeUORequest({ capability: 'clock.sync',
        payload: { clientSentAt }, timeoutMs: 3000, ttlMs: 5000 });
      const clientReceivedAt = Date.now();
      const serverReceivedAt = Number(sample?.serverReceivedAt) || clientSentAt;
      const serverSentAt = Number(sample?.serverSentAt) || serverReceivedAt;
      const roundTripMs = Math.max(0, (clientReceivedAt - clientSentAt) - (serverSentAt - serverReceivedAt));
      const offsetMs = ((serverReceivedAt - clientSentAt) + (serverSentAt - clientReceivedAt)) / 2;
      const previous = net.nodeUOClock;
      net.nodeUOClock = {
        synchronizedAt: clientReceivedAt,
        offsetMs: previous ? previous.offsetMs * 0.75 + offsetMs * 0.25 : offsetMs,
        roundTripMs: previous ? previous.roundTripMs * 0.75 + roundTripMs * 0.25 : roundTripMs,
        serverTick: sample?.serverTick ?? null,
        samples: (previous?.samples ?? 0) + 1,
      };
      world.nodeUOClock = net.nodeUOClock;
      bus.emit('nodeuo:clock-sync', net.nodeUOClock);
    } catch { /* optional extension; retry on the next interval */ }
    finally { clockSyncInFlight = false; }
  };
  const replicationTier = () => {
    const p95 = Math.max(0, Number(performanceStats?.frameP95Ms) || 0);
    const buffered = Math.max(0, Number(net.ws?.bufferedAmount) || 0);
    if (p95 > 45 || buffered > (1 << 19)) return { name: 'constrained', rateHz: 10, maxEntities: 512 };
    if (p95 > 25 || buffered > (1 << 17)) return { name: 'balanced', rateHz: 20, maxEntities: 1024 };
    return { name: 'full', rateHz: 30, maxEntities: 2048 };
  };
  const adaptReplication = async ({ force = false } = {}) => {
    if (flowUpdateInFlight || !net.supportsNodeUO?.('protocol.subscriptions')) return;
    const tier = replicationTier();
    if (!force && tier.name === subscriptionTier) {
      candidateTier = '';
      candidateSamples = 0;
      if (subscriptionLease && subscriptionLease.expiresAt - Date.now() < 30_000
          && net.supportsNodeUO?.('protocol.subscription-leases')) {
        try {
          const renewed = await manageNodeUOSubscriptionLease(net, 'renew', {
            leaseId: subscriptionLease.leaseId, ttlMs: 60_000,
          });
          subscriptionLease = renewed.lease ?? subscriptionLease;
        } catch { subscriptionLease = null; subscriptionTier = ''; }
      }
      return;
    }
    if (!force) {
      if (candidateTier !== tier.name) { candidateTier = tier.name; candidateSamples = 1; return; }
      if (++candidateSamples < 2) return;
    }
    flowUpdateInFlight = true;
    try {
      let result;
      if (net.supportsNodeUO?.('protocol.subscription-leases')) {
        if (subscriptionLease) await manageNodeUOSubscriptionLease(net, 'release', {
          leaseId: subscriptionLease.leaseId,
        }).catch(() => {});
        result = await manageNodeUOSubscriptionLease(net, 'acquire', {
          target: 'world.components', ...tier, ttlMs: 60_000,
        });
        subscriptionLease = result.lease ?? null;
        result.active = subscriptionLease ? [subscriptionLease.subscription] : [];
      } else result = await configureNodeUOSubscription(net, 'world.components', tier);
      subscriptionTier = tier.name;
      candidateTier = '';
      candidateSamples = 0;
      world.nodeUOSubscriptions = result;
      bus.emit('nodeuo:replication-tier', { ...tier, active: result?.active ?? [] });
      if (net.supportsNodeUO?.('flow.qos')) {
        const flow = await requestFeature(net, 'flow.qos', {
          pressure: tier.name, frameP95Ms: Number(performanceStats?.frameP95Ms) || 0,
          bufferedBytes: Number(net.ws?.bufferedAmount) || 0,
        }, { ttlMs: 3000 });
        world.nodeUOFlow = flow;
        bus.emit('nodeuo:flow-qos', flow);
      }
      if (net.supportsNodeUO?.('client.performance-hints')
          && world.nodeUOConsent?.categories?.performance === true) {
        await publishNodeUOPerformanceHints(net, {
          fps: Number(performanceStats?.frameMs) > 0 ? 1000 / performanceStats.frameMs : 60,
          frameP95Ms: Number(performanceStats?.frameP95Ms) || 0,
          memoryMB: Number(performanceStats?.heapUsedBytes) / 1048576 || 0,
          desiredRateHz: tier.rateHz,
          desiredRadius: tier.name === 'constrained' ? 16 : tier.name === 'balanced' ? 24 : 32,
        });
      }
    } catch { /* optional adaptive service; retry after the next sample */ }
    finally { flowUpdateInFlight = false; }
  };
  const capabilityUnsubscribe = bus.on('nodeuo:capabilities', () => {
    synchronizeClock();
    void requestNodeUOManifest(net).then((manifest) => {
      world.nodeUOManifest = manifest;
      bus.emit('nodeuo:manifest', manifest);
    }).catch(() => {});
    if (net.supportsNodeUO?.('world.events')) {
      let cursor = 0;
      try { cursor = Number(sessionStorage.getItem('nodeuo.world-events.cursor')) >>> 0; }
      catch { /* storage may be unavailable in hardened browser contexts */ }
      void requestNodeUOWorldEvents(net, cursor).catch(() => {});
    }
    void adaptReplication({ force: true });
    if (net.supportsNodeUO?.('protocol.schema-registry')) void requestNodeUOSchemaRegistry(net).catch(() => {});
    if (net.supportsNodeUO?.('protocol.privacy-contract')) void requestNodeUOPrivacyContract(net).catch(() => {});
    if (net.supportsNodeUO?.('protocol.consent')) void updateNodeUOConsent(net).catch(() => {});
    if (net.supportsNodeUO?.('protocol.feature-health')) void reportNodeUOFeatureHealth(net).catch(() => {});
    if (net.supportsNodeUO?.('content.release')) void requestNodeUOContentRelease(net).catch(() => {});
    if (net.supportsNodeUO?.('mods.permissions')) void requestNodeUOModPermissions(net).catch(() => {});
    if (net.supportsNodeUO?.('ui.accessibility')) void updateNodeUOAccessibility(net).catch(() => {});
    if (net.supportsNodeUO?.('world.environment')) void requestNodeUOEnvironment(net).catch(() => {});
    if (net.supportsNodeUO?.('network.path-selection')) void selectNodeUONetworkPath(net, {
      websocketRttMs: Number(net.nodeUOClock?.roundTripMs) || 0,
    }).catch(() => {});
    void loadPlatformContracts();
    // The server already uses progressive delivery for the login baseline.
    // Explicit requests are reserved for repairing a missed sector history.
    void synchronizeSectors();
  });
  const synchronizeSectors = async () => {
    if (sectorSyncInFlight || !net.supportsNodeUO?.('world.sector-stream')) return;
    sectorSyncInFlight = true;
    let cursor = Number(world.nodeUOSectorCursor) || 0;
    try { cursor = Math.max(cursor, Number(sessionStorage.getItem('nodeuo.world-sector.cursor')) || 0); }
    catch { /* storage can be disabled */ }
    try {
      const result = await requestNodeUOSectorChanges(net, cursor);
      if (result?.resetRequired && net.supportsNodeUO?.('world.progressive-snapshot')) {
        await requestNodeUOProgressiveSnapshot(net);
      }
      if (world.player && net.supportsNodeUO?.('world.region-prefetch')) {
        await requestNodeUORegionPrefetch(net, world.player);
      }
      if (net.supportsNodeUO?.('world.sector-digest')) await requestNodeUOSectorDigests(net);
    } catch { /* the ordinary component stream remains authoritative */ }
    finally { sectorSyncInFlight = false; }
  };
  const markerUnsubscribe = bus.on('marker:party-share', ({ markers } = {}) => {
    if (!net.supportsNodeUO?.('party.markers')) return;
    net.sendNodeUOMessage({ kind: NodeUOJsonKind.Event, feature: 'party.markers',
      idempotencyKey: `marker-sync:${Date.now()}`, payload: { operation: 'sync', markers } });
  });
  const timer = setInterval(publishDiagnostics, 10_000);
  const assetProfileTimer = setInterval(() => { void reportAssetProfile().catch(() => {}); }, 30_000);
  const clockTimer = setInterval(synchronizeClock, 30_000);
  const adaptationTimer = setInterval(adaptReplication, 5000);
  const sectorTimer = setInterval(synchronizeSectors, 10_000);
  const environmentTimer = setInterval(() => {
    if (net.supportsNodeUO?.('world.environment')) void requestNodeUOEnvironment(net).catch(() => {});
  }, 30_000);
  const voiceTimer = setInterval(() => {
    if (net.supportsNodeUO?.('voice.spatial-state') && world.nodeUOConsent?.categories?.voice === true) {
      void publishNodeUOVoiceSpatialState(net).catch(() => {});
    }
  }, 5000);
  return () => { clearInterval(timer); clearInterval(assetProfileTimer); clearInterval(clockTimer); clearInterval(adaptationTimer);
    clearInterval(sectorTimer); clearInterval(environmentTimer); clearInterval(voiceTimer);
    markerUnsubscribe(); consentUnsubscribe(); contentReleaseUnsubscribe(); capabilityUnsubscribe(); unsubscribe();
    if (subscriptionLease && net.supportsNodeUO?.('protocol.subscription-leases')) {
      void manageNodeUOSubscriptionLease(net, 'release', { leaseId: subscriptionLease.leaseId }).catch(() => {});
    }
    globalThis.navigator?.serviceWorker?.removeEventListener?.('message', serviceWorkerMessage); stopWebTransport(); };
}

export { reloadAssets as reloadNodeUOAssets };
