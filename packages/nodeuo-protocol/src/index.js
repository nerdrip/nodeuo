/**
 * NodeUO JSON Protocol v2.
 *
 * This package deliberately does not import @uo/protocol. Original Ultima
 * Online packets and private NodeUO messages are separate protocols sharing a
 * WebSocket connection only when both NodeUO peers selected this subprotocol.
 * UO stays in binary frames; NodeUO v2 always uses text JSON frames.
 */

import { pruneFeatureDependencies } from './manifest.js';
import { normalizeNodeUOCausality, normalizeNodeUOPreconditions } from './contracts.js';

export const NODEUO_JSON_PROTOCOL = 2;
export const NODEUO_JSON_SUBPROTOCOL = 'nodeuo.json.v2';
export const NODEUO_JSON_MAX_BYTES = 512 * 1024;
export const NODEUO_JSON_BATCH_MAX_MESSAGES = 64;
export const NODEUO_JSON_NEGOTIATION_TIMEOUT_MS = 5000;

export const NodeUOJsonKind = Object.freeze({
  Hello: 'hello', Accept: 'accept', Snapshot: 'snapshot', Delta: 'delta',
  Event: 'event', Request: 'request', Result: 'result', Ack: 'ack',
  Subscribe: 'subscribe', Unsubscribe: 'unsubscribe', Resume: 'resume',
  Notice: 'notice', Error: 'error', Ping: 'ping', Pong: 'pong',
  Progress: 'progress', Cancel: 'cancel',
});

export const NodeUOPriority = Object.freeze({
  Critical: 'critical', High: 'high', Normal: 'normal', Background: 'background',
});

export const NodeUODelivery = Object.freeze({
  Reliable: 'reliable', Latest: 'latest', LossTolerant: 'loss-tolerant',
});

const feature = (id, {
  version = 1, minimum = 1, channel = 'control', direction = 'both',
  delivery = NodeUODelivery.Reliable, description = '',
} = {}) => Object.freeze({ id, minimum, maximum: version, channel, direction, delivery, description });

/**
 * The registry is string-keyed and therefore has no bit-count ceiling. A
 * feature evolves independently from the protocol envelope and from every
 * other feature. Only entries with real server/client consumers belong here.
 */
export const NODEUO_FEATURE_CATALOG = Object.freeze([
  feature('ui.rich-gumps', { channel: 'interface' }),
  feature('spell.composer', { channel: 'authoring' }),
  feature('movement.hints', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('movement.reconciliation', { version: 2, channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('world.editing', { channel: 'authoring' }),
  feature('character.specializations', { channel: 'character' }),
  feature('character.virtues', { channel: 'character', delivery: NodeUODelivery.Latest }),
  feature('combat.cooldowns', { channel: 'combat', delivery: NodeUODelivery.Latest }),
  feature('naval.preview', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('housing.tools', { channel: 'authoring' }),
  feature('crafting.workbench', { channel: 'authoring' }),
  feature('skills.insights', { channel: 'character', delivery: NodeUODelivery.Latest }),
  feature('trade.audit', { channel: 'economy' }),
  feature('vendor.insights', { channel: 'economy', delivery: NodeUODelivery.Latest }),
  feature('npc.dialog', { channel: 'dialog' }),
  feature('world.delta', { version: 2, channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('combat.timeline', { channel: 'combat', delivery: NodeUODelivery.LossTolerant }),
  feature('ui.structured', { version: 3, channel: 'interface' }),
  feature('quest.journal', { channel: 'quest' }),
  feature('assets.streaming', { version: 3, channel: 'assets' }),
  feature('assets.chunks', { version: 2, channel: 'assets' }),
  feature('social.state', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('session.resume', { version: 3, channel: 'control' }),
  feature('diagnostics.live', { channel: 'diagnostics', delivery: NodeUODelivery.Latest }),
  feature('world.timeline', { version: 2, channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('world.champion', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('animation.semantic', { channel: 'effects', delivery: NodeUODelivery.LossTolerant }),
  feature('effects.structured', { channel: 'effects', delivery: NodeUODelivery.LossTolerant }),
  feature('container.delta', { channel: 'inventory' }),
  feature('properties.structured', { channel: 'interface' }),
  feature('vendor.search', { channel: 'economy' }),
  feature('mods.channels', { version: 3, channel: 'mods' }),
  feature('transport.webtransport', { version: 2, channel: 'control' }),
  feature('clock.sync', { channel: 'control', delivery: NodeUODelivery.Latest }),
  feature('flow.qos', { channel: 'control' }),
  feature('transactions.idempotent', { channel: 'control' }),
  feature('world.components', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('map.prefetch', { channel: 'assets', delivery: NodeUODelivery.Latest }),
  feature('assets.content-addressed', { channel: 'assets' }),
  feature('localization.message-format', { channel: 'interface' }),
  feature('party.markers', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('spectator.replay', { version: 2, channel: 'spectator', direction: 'server-to-client' }),
  feature('ai.inspector', { version: 2, channel: 'diagnostics' }),
  feature('housing.collaboration', { version: 2, channel: 'authoring' }),
  feature('instance.handoff', { version: 2, channel: 'control' }),
  feature('cinematic.timeline', { channel: 'interface' }),
  feature('voice.authorization', { channel: 'social' }),
  feature('npc.generative', { channel: 'dialog' }),
  feature('protocol.manifest', { channel: 'control' }),
  feature('protocol.subscriptions', { channel: 'control' }),
  feature('protocol.state-repair', { channel: 'control' }),
  feature('protocol.batch', { channel: 'control' }),
  feature('protocol.rpc', { version: 2, channel: 'control' }),
  feature('protocol.schema-lifecycle', { channel: 'control', direction: 'server-to-client' }),
  feature('editor.transactions', { channel: 'authoring' }),
  feature('editor.collaboration', { channel: 'authoring' }),
  feature('social.pings', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('world.annotations', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('world.events', { channel: 'world' }),
  feature('protocol.schema-registry', { channel: 'control' }),
  feature('world.progressive-snapshot', { channel: 'world' }),
  feature('world.sector-stream', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('network.path-selection', { channel: 'control', delivery: NodeUODelivery.Latest }),
  feature('inventory.transactions', { channel: 'inventory' }),
  feature('combat.telegraphs', { channel: 'combat', delivery: NodeUODelivery.Latest }),
  feature('quest.graph', { channel: 'quest' }),
  feature('party.tactics', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('npc.relationships', { channel: 'dialog' }),
  feature('ui.accessibility', { channel: 'interface' }),
  feature('assets.patchsets', { channel: 'assets' }),
  feature('mods.permissions', { channel: 'mods' }),
  feature('admin.config-transactions', { channel: 'authoring' }),
  feature('debug.time-travel', { channel: 'diagnostics' }),
  feature('economy.market-stream', { channel: 'economy', delivery: NodeUODelivery.Latest }),
  feature('voice.spatial-state', { channel: 'social', delivery: NodeUODelivery.Latest }),
  feature('instance.live-handoff', { channel: 'control' }),
  feature('spectator.full-stream', { channel: 'spectator' }),
  feature('protocol.privacy-contract', { channel: 'control' }),
  feature('protocol.feature-health', { channel: 'control', delivery: NodeUODelivery.Latest }),
  feature('protocol.renegotiate', { channel: 'control' }),
  feature('client.performance-hints', { channel: 'diagnostics', delivery: NodeUODelivery.Latest }),
  feature('assets.client-profile', { channel: 'assets', direction: 'client-to-server', delivery: NodeUODelivery.Latest }),
  feature('content.release', { channel: 'assets' }),
  feature('content.preflight', { channel: 'assets' }),
  feature('interaction.catalog', { version: 2, channel: 'interface' }),
  feature('world.region-prefetch', { version: 2, channel: 'assets', delivery: NodeUODelivery.Latest }),
  feature('diagnostics.trace', { channel: 'diagnostics' }),
  feature('protocol.consent', { channel: 'control' }),
  feature('world.sector-digest', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('protocol.causality', { channel: 'control' }),
  feature('protocol.errors', { channel: 'control' }),
  feature('protocol.preconditions', { channel: 'control' }),
  feature('protocol.transactions', { channel: 'control' }),
  feature('protocol.command-schema', { channel: 'control' }),
  feature('content.dependencies', { channel: 'authoring' }),
  feature('content.preview-session', { version: 2, channel: 'authoring' }),
  feature('combat.preflight', { channel: 'combat', delivery: NodeUODelivery.Latest }),
  feature('inventory.views', { channel: 'inventory' }),
  feature('crafting.plan', { channel: 'authoring' }),
  feature('world.environment', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('world.audio-scene', { channel: 'effects', delivery: NodeUODelivery.Latest }),
  feature('accessibility.spatial-cues', { channel: 'interface', delivery: NodeUODelivery.Latest }),
  feature('quest.guidance', { channel: 'quest' }),
  feature('support.evidence', { channel: 'diagnostics' }),
  feature('moderation.case', { version: 2, channel: 'social' }),
  feature('script.catalog', { channel: 'authoring' }),
  feature('release.compatibility', { channel: 'assets' }),
  feature('trade.receipts', { channel: 'economy' }),
  feature('protocol.policy', { channel: 'control' }),
  feature('protocol.subscription-leases', { channel: 'control' }),
  feature('protocol.resumable-streams', { channel: 'control' }),
  feature('protocol.retry-policy', { channel: 'control' }),
  feature('protocol.cost-hints', { channel: 'control' }),
  feature('protocol.compatibility-fallbacks', { channel: 'control' }),
  feature('protocol.conformance', { channel: 'control' }),
  feature('protocol.privacy-labels', { channel: 'control' }),
  feature('protocol.signed-content', { channel: 'assets' }),
  feature('diagnostics.client-frame', { channel: 'diagnostics', direction: 'client-to-server', delivery: NodeUODelivery.Latest }),
  feature('world.layers', { channel: 'world', delivery: NodeUODelivery.Latest }),
  feature('world.live-event-director', { channel: 'world' }),
  feature('world.codex', { channel: 'quest' }),
  feature('party.loot-policy', { channel: 'social' }),
  feature('ui.safe-schema', { channel: 'interface' }),
]);

export const NODEUO_FEATURES = Object.freeze(Object.fromEntries(
  NODEUO_FEATURE_CATALOG.map((entry) => [entry.id, entry]),
));

/** Stable semantic names for negotiated features. Values are protocol IDs,
 * never bit flags. This is the only capability vocabulary used by runtime
 * code; adding a feature does not consume a shared numeric namespace. */
export const NodeUOFeature = Object.freeze({
  RichGumps: 'ui.rich-gumps',
  SpellComposer: 'spell.composer',
  MovementHints: 'movement.hints',
  WorldEditing: 'world.editing',
  Specializations: 'character.specializations',
  CooldownBars: 'combat.cooldowns',
  NavalPreview: 'naval.preview',
  HouseTools: 'housing.tools',
  CraftingWorkbench: 'crafting.workbench',
  SkillInsights: 'skills.insights',
  TradeAudit: 'trade.audit',
  VendorInsights: 'vendor.insights',
  NpcDialog: 'npc.dialog',
  WorldDelta: 'world.delta',
  CombatTimeline: 'combat.timeline',
  StructuredUi: 'ui.structured',
  QuestJournal: 'quest.journal',
  AssetStreaming: 'assets.streaming',
  SocialState: 'social.state',
  SessionResume: 'session.resume',
  LiveDiagnostics: 'diagnostics.live',
  WorldTimeline: 'world.timeline',
  SemanticAnimation: 'animation.semantic',
  StructuredEffects: 'effects.structured',
  ContainerDelta: 'container.delta',
  StructuredProperties: 'properties.structured',
  VendorSearch: 'vendor.search',
  ModChannels: 'mods.channels',
  TransportUpgrade: 'transport.webtransport',
});

// Logical message values live with the JSON protocol. They are strings or
// small payload-local enums; none of them are UO opcodes or global feature
// bits, and adding a feature never consumes a shared numeric namespace.
export const NodeUOSpellComposerMessage = Object.freeze({
  Open: 1, Save: 2, Result: 3, Publish: 4, Scribe: 5,
});
export const NodeUOSpecializationMessage = Object.freeze({ Open: 1, Allocate: 2, Result: 3, Reset: 4 });
export const NodeUOCooldownMessage = Object.freeze({ Start: 1, Remove: 2, Snapshot: 3 });
export const NodeUONavalMessage = Object.freeze({ ShowRange: 1, HideRange: 2 });
export const NodeUOHouseToolsMessage = Object.freeze({
  Snapshot: 1, Undo: 2, Redo: 3, Validate: 4,
  Copy: 5, Paste: 6, SaveTemplate: 7, ApplyTemplate: 8, Result: 9,
});
export const NodeUONpcDialogMessage = Object.freeze({ Open: 1, Select: 2, Close: 3 });
export const NodeUOChannel = Object.freeze({
  Control: 0, World: 1, Combat: 2, Interface: 3, Quest: 4,
  Assets: 5, Social: 6, Diagnostics: 7, Mods: 8,
});
export const NodeUOChannelMessage = Object.freeze({
  Snapshot: 1, Delta: 2, Ack: 3, Request: 4, Result: 5,
  Event: 6, Subscribe: 7, Unsubscribe: 8, Resume: 9, Notice: 10,
});
export const NodeUOChannelFlag = Object.freeze({
  AckRequired: 1 << 0, Replace: 1 << 1, Urgent: 1 << 2, LossTolerant: 1 << 3,
});
export const NodeUOWorldDeltaKind = Object.freeze({ Snapshot: 1, Delta: 2, Ack: 3, Resync: 4 });
export const NodeUOEntityType = Object.freeze({ Mobile: 1, Item: 2 });
export const NodeUOWorldField = Object.freeze({
  Position: 1 << 0, Appearance: 1 << 1, Vitals: 1 << 2,
  Parent: 1 << 3, Status: 1 << 4, Removed: 1 << 15,
});

export const NODEUO_NAMESPACE_FEATURE = Object.freeze({
  'nodeuo.timeline': 'world.timeline', 'nodeuo.animation': 'animation.semantic',
  'nodeuo.effects': 'effects.structured', 'nodeuo.combat': 'combat.timeline',
  'nodeuo.container': 'container.delta', 'nodeuo.properties': 'properties.structured',
  'nodeuo.vendor': 'vendor.search', 'nodeuo.quest': 'quest.journal',
  'nodeuo.assets': 'assets.streaming', 'nodeuo.party': 'social.state',
  'nodeuo.ui': 'ui.structured', 'nodeuo.notice': 'ui.structured',
  'nodeuo.localization': 'localization.message-format', 'nodeuo.resume': 'session.resume',
  'nodeuo.diagnostics': 'diagnostics.live', 'nodeuo.transport': 'transport.webtransport',
});

const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/i;
const KINDS = new Set(Object.values(NodeUOJsonKind));
const PRIORITIES = new Set(Object.values(NodeUOPriority));
const DELIVERIES = new Set(Object.values(NodeUODelivery));
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function safeInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function validateJsonTree(value, depth = 0, budget = { nodes: 50_000 }) {
  if (--budget.nodes < 0) throw new RangeError('NodeUO JSON value is too complex');
  if (depth > 16) throw new RangeError('NodeUO JSON nesting exceeds 16 levels');
  if (value == null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NodeUO JSON numbers must be finite');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 128 * 1024) throw new RangeError('NodeUO JSON string is too large');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new RangeError('NodeUO JSON array is too large');
    value.forEach((entry) => validateJsonTree(entry, depth + 1, budget));
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('NodeUO payload must contain only plain JSON values');
  }
  const entries = Object.entries(value);
  if (entries.length > 2048) throw new RangeError('NodeUO JSON object has too many keys');
  for (const [key, entry] of entries) {
    if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`forbidden NodeUO JSON key: ${key}`);
    if (key.length > 128) throw new RangeError('NodeUO JSON key is too long');
    validateJsonTree(entry, depth + 1, budget);
  }
}

export function normalizeFeatureList(features, { knownOnly = false } = {}) {
  if (!Array.isArray(features)) return [];
  const normalized = new Map();
  for (const raw of features.slice(0, 4096)) {
    const id = String(typeof raw === 'string' ? raw : raw?.id ?? '').trim().toLowerCase();
    if (!SAFE_ID.test(id) || (knownOnly && !NODEUO_FEATURES[id])) continue;
    const catalog = NODEUO_FEATURES[id];
    const minimum = safeInteger(raw?.minimum ?? raw?.min ?? catalog?.minimum ?? 1, 1, 65535, 1);
    const maximum = safeInteger(raw?.maximum ?? raw?.max ?? raw?.version ?? catalog?.maximum ?? minimum,
      minimum, 65535, minimum);
    normalized.set(id, { id, minimum, maximum });
  }
  return [...normalized.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function negotiateFeatures(offered, supported) {
  const client = new Map(normalizeFeatureList(supported).map((entry) => [entry.id, entry]));
  const result = [];
  for (const server of normalizeFeatureList(offered)) {
    const local = client.get(server.id);
    if (!local) continue;
    const minimum = Math.max(server.minimum, local.minimum);
    const version = Math.min(server.maximum, local.maximum);
    if (version >= minimum) result.push({ id: server.id, version });
  }
  return pruneFeatureDependencies(result);
}

export function featureIdForNamespace(namespace) {
  const id = String(namespace ?? '').trim().toLowerCase();
  return NODEUO_NAMESPACE_FEATURE[id] ?? (SAFE_ID.test(id) ? id : null);
}

export function createNodeUOMessage({
  kind = NodeUOJsonKind.Event, feature = 'protocol.session', featureVersion = 1,
  channel, id, replyTo, seq, ack, priority = NodeUOPriority.Normal,
  delivery = NodeUODelivery.Reliable, ttlMs, sentAt = Date.now(), replace,
  expectedRevision, revision, idempotencyKey, requiresAck = false, payload = {},
  traceId, correlationId, causationId, transactionId, deadlineAt, preconditions,
} = {}) {
  const normalizedFeature = String(feature ?? '').trim().toLowerCase();
  if (!KINDS.has(kind)) throw new TypeError(`unknown NodeUO message kind: ${kind}`);
  if (!SAFE_ID.test(normalizedFeature)) throw new TypeError('invalid NodeUO feature id');
  if (!PRIORITIES.has(priority)) throw new TypeError('invalid NodeUO priority');
  if (!DELIVERIES.has(delivery)) throw new TypeError('invalid NodeUO delivery policy');
  validateJsonTree(payload);
  const message = {
    nodeuo: NODEUO_JSON_PROTOCOL, kind, feature: normalizedFeature,
    featureVersion: safeInteger(featureVersion, 1, 65535, 1),
    channel: String(channel ?? NODEUO_FEATURES[normalizedFeature]?.channel ?? 'custom').slice(0, 64),
    priority, delivery, sentAt: safeInteger(sentAt, 0), payload,
  };
  if (id != null) message.id = String(id).slice(0, 128);
  if (replyTo != null) message.replyTo = String(replyTo).slice(0, 128);
  if (seq != null) message.seq = safeInteger(seq, 0);
  if (ack != null) message.ack = safeInteger(ack, 0);
  if (ttlMs != null) message.ttlMs = safeInteger(ttlMs, 1, 300_000, 1000);
  if (replace != null) message.replace = String(replace).slice(0, 160);
  if (expectedRevision != null) message.expectedRevision = safeInteger(expectedRevision, 0);
  if (revision != null) message.revision = safeInteger(revision, 0);
  if (idempotencyKey != null) message.idempotencyKey = String(idempotencyKey).slice(0, 160);
  if (requiresAck) message.requiresAck = true;
  Object.assign(message, normalizeNodeUOCausality({ traceId, correlationId, causationId, transactionId }));
  if (deadlineAt != null) message.deadlineAt = safeInteger(deadlineAt, 0);
  if (preconditions != null) {
    const normalized = normalizeNodeUOPreconditions(preconditions);
    if (Object.keys(normalized).length) message.preconditions = normalized;
  }
  return message;
}

export function serializeNodeUOMessage(message, { maxBytes = NODEUO_JSON_MAX_BYTES } = {}) {
  const normalized = createNodeUOMessage(message);
  const text = JSON.stringify(normalized);
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RangeError(`NodeUO message exceeds ${maxBytes} bytes`);
  return text;
}

export function parseNodeUOMessage(text, { maxBytes = NODEUO_JSON_MAX_BYTES } = {}) {
  if (typeof text !== 'string') throw new TypeError('NodeUO v2 requires a text WebSocket frame');
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RangeError(`NodeUO message exceeds ${maxBytes} bytes`);
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.nodeuo !== NODEUO_JSON_PROTOCOL) {
    throw new TypeError('not a NodeUO JSON v2 message');
  }
  return createNodeUOMessage(raw);
}

/** A text frame may carry one envelope or a bounded array of envelopes. This
 * reduces WebSocket/syscall overhead without changing the human-readable JSON
 * protocol or mixing private data into the UO byte stream. */
export function serializeNodeUOFrame(messages, { maxBytes = NODEUO_JSON_MAX_BYTES } = {}) {
  const source = Array.isArray(messages) ? messages : [messages];
  if (!source.length || source.length > NODEUO_JSON_BATCH_MAX_MESSAGES) {
    throw new RangeError(`NodeUO frame must contain 1-${NODEUO_JSON_BATCH_MAX_MESSAGES} messages`);
  }
  if (source.length === 1) return serializeNodeUOMessage(source[0], { maxBytes });
  const text = JSON.stringify(source.map((message) => createNodeUOMessage(message)));
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RangeError(`NodeUO frame exceeds ${maxBytes} bytes`);
  return text;
}

export function parseNodeUOFrame(text, { maxBytes = NODEUO_JSON_MAX_BYTES } = {}) {
  if (typeof text !== 'string') throw new TypeError('NodeUO v2 requires a text WebSocket frame');
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new RangeError(`NodeUO frame exceeds ${maxBytes} bytes`);
  const raw = JSON.parse(text);
  const source = Array.isArray(raw) ? raw : [raw];
  if (!source.length || source.length > NODEUO_JSON_BATCH_MAX_MESSAGES) {
    throw new RangeError(`NodeUO frame must contain 1-${NODEUO_JSON_BATCH_MAX_MESSAGES} messages`);
  }
  return source.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || message.nodeuo !== NODEUO_JSON_PROTOCOL) throw new TypeError('not a NodeUO JSON v2 message');
    return createNodeUOMessage(message);
  });
}

export function isNodeUOMessageExpired(message, now = Date.now()) {
  return Number.isFinite(message?.ttlMs) && now > Number(message.sentAt) + Number(message.ttlMs);
}

export function advertisedFeatureList({ webTransport = true, include = null } = {}) {
  const filter = include ? new Set(include) : null;
  return NODEUO_FEATURE_CATALOG
    .filter((entry) => webTransport || entry.id !== 'transport.webtransport')
    .filter((entry) => !filter || filter.has(entry.id))
    .map((entry) => ({ id: entry.id, minimum: entry.minimum, maximum: entry.maximum }));
}

export * from './manifest.js';
export * from './rpc.js';
export * from './contracts.js';
export * from './codegen.js';
