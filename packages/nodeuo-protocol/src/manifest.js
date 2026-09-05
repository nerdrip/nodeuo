/** Declarative, isomorphic metadata for NodeUO JSON v2 negotiation. Nothing
 * in this module depends on Node.js APIs, so the exact same validation and
 * fingerprints run in the browser and on the shard. */

export const NODEUO_SCHEMA_VERSION = 7;
export const NODEUO_JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export const NODEUO_FEATURE_DEPENDENCIES = Object.freeze({
  'assets.content-addressed': Object.freeze(['assets.streaming']),
  'assets.chunks': Object.freeze(['assets.streaming', 'assets.content-addressed']),
  'map.prefetch': Object.freeze(['assets.streaming']),
  'movement.reconciliation': Object.freeze(['movement.hints']),
  'world.components': Object.freeze(['world.delta']),
  'party.markers': Object.freeze(['social.state']),
  'housing.collaboration': Object.freeze(['housing.tools']),
  'npc.generative': Object.freeze(['npc.dialog']),
  'localization.message-format': Object.freeze(['ui.structured']),
  'transport.webtransport': Object.freeze(['session.resume']),
  'voice.authorization': Object.freeze(['social.state']),
  'cinematic.timeline': Object.freeze(['ui.structured']),
  'ai.inspector': Object.freeze(['diagnostics.live']),
  'protocol.state-repair': Object.freeze(['world.components']),
  'editor.transactions': Object.freeze(['world.editing']),
  'social.pings': Object.freeze(['social.state']),
  'world.annotations': Object.freeze(['social.state']),
  'editor.collaboration': Object.freeze(['editor.transactions']),
  'protocol.schema-registry': Object.freeze(['protocol.manifest', 'protocol.schema-lifecycle']),
  'world.progressive-snapshot': Object.freeze(['world.components']),
  'world.sector-stream': Object.freeze(['world.components', 'protocol.subscriptions']),
  'network.path-selection': Object.freeze(['flow.qos', 'session.resume']),
  'inventory.transactions': Object.freeze(['transactions.idempotent']),
  'combat.telegraphs': Object.freeze(['combat.timeline']),
  'quest.graph': Object.freeze(['quest.journal']),
  'party.tactics': Object.freeze(['social.state', 'party.markers']),
  'npc.relationships': Object.freeze(['npc.dialog']),
  'ui.accessibility': Object.freeze(['ui.structured']),
  'assets.patchsets': Object.freeze(['assets.streaming', 'assets.content-addressed', 'assets.chunks']),
  'mods.permissions': Object.freeze(['mods.channels']),
  'admin.config-transactions': Object.freeze(['protocol.rpc']),
  'debug.time-travel': Object.freeze(['diagnostics.live', 'spectator.replay']),
  'economy.market-stream': Object.freeze(['vendor.search']),
  'voice.spatial-state': Object.freeze(['voice.authorization']),
  'instance.live-handoff': Object.freeze(['instance.handoff', 'session.resume']),
  'spectator.full-stream': Object.freeze(['spectator.replay', 'world.components']),
  'protocol.privacy-contract': Object.freeze(['protocol.manifest']),
  'protocol.feature-health': Object.freeze(['protocol.manifest']),
  'protocol.renegotiate': Object.freeze(['protocol.manifest', 'protocol.schema-lifecycle']),
  'client.performance-hints': Object.freeze(['flow.qos']),
  'assets.client-profile': Object.freeze(['client.performance-hints', 'protocol.consent']),
  'content.release': Object.freeze(['assets.patchsets']),
  'content.preflight': Object.freeze(['content.release', 'assets.client-profile']),
  'interaction.catalog': Object.freeze(['ui.structured', 'npc.dialog']),
  'world.region-prefetch': Object.freeze(['map.prefetch', 'assets.content-addressed']),
  'diagnostics.trace': Object.freeze(['diagnostics.live', 'protocol.consent']),
  'protocol.consent': Object.freeze(['protocol.privacy-contract']),
  'world.sector-digest': Object.freeze(['world.sector-stream', 'protocol.state-repair']),
  'protocol.errors': Object.freeze(['protocol.causality']),
  'protocol.preconditions': Object.freeze(['transactions.idempotent']),
  'protocol.transactions': Object.freeze(['protocol.preconditions', 'protocol.errors']),
  'protocol.command-schema': Object.freeze(['protocol.manifest']),
  'content.dependencies': Object.freeze(['content.release']),
  'content.preview-session': Object.freeze(['content.dependencies', 'editor.transactions']),
  'combat.preflight': Object.freeze(['combat.timeline']),
  'inventory.views': Object.freeze(['container.delta']),
  'crafting.plan': Object.freeze(['crafting.workbench', 'protocol.preconditions']),
  'world.environment': Object.freeze(['world.timeline']),
  'world.audio-scene': Object.freeze(['world.environment']),
  'accessibility.spatial-cues': Object.freeze(['ui.accessibility', 'world.components']),
  'quest.guidance': Object.freeze(['quest.graph']),
  'support.evidence': Object.freeze(['diagnostics.trace', 'protocol.consent']),
  'moderation.case': Object.freeze(['protocol.consent']),
  'script.catalog': Object.freeze(['protocol.schema-registry']),
  'release.compatibility': Object.freeze(['content.preflight']),
  'trade.receipts': Object.freeze(['trade.audit', 'transactions.idempotent']),
  'protocol.policy': Object.freeze(['protocol.manifest']),
  'protocol.subscription-leases': Object.freeze(['protocol.subscriptions', 'session.resume']),
  'protocol.resumable-streams': Object.freeze(['session.resume']),
  'protocol.retry-policy': Object.freeze(['protocol.errors']),
  'protocol.cost-hints': Object.freeze(['flow.qos', 'protocol.manifest']),
  'protocol.compatibility-fallbacks': Object.freeze(['protocol.manifest']),
  'protocol.conformance': Object.freeze(['protocol.schema-registry', 'protocol.compatibility-fallbacks']),
  'protocol.privacy-labels': Object.freeze(['protocol.privacy-contract']),
  'protocol.signed-content': Object.freeze(['content.release']),
  'diagnostics.client-frame': Object.freeze(['client.performance-hints', 'protocol.consent']),
  'world.layers': Object.freeze(['world.components']),
  'world.live-event-director': Object.freeze(['world.events', 'world.layers', 'world.environment']),
  'world.codex': Object.freeze(['world.components']),
  'party.loot-policy': Object.freeze(['social.state', 'trade.receipts']),
  'ui.safe-schema': Object.freeze(['ui.structured', 'protocol.command-schema']),
});

const BASE_GAMEPLAY = Object.freeze([
  'movement.hints', 'movement.reconciliation', 'combat.cooldowns', 'npc.dialog', 'world.delta',
  'world.components', 'world.timeline', 'container.delta',
  'properties.structured', 'quest.journal', 'social.state', 'session.resume',
  'flow.qos', 'clock.sync', 'protocol.manifest', 'protocol.subscriptions',
  'protocol.state-repair', 'protocol.batch',
  'protocol.rpc', 'protocol.schema-lifecycle', 'transactions.idempotent',
  'ui.structured', 'combat.timeline', 'party.markers',
  'protocol.schema-registry', 'world.progressive-snapshot', 'world.sector-stream',
  'network.path-selection', 'inventory.transactions', 'combat.telegraphs',
  'quest.graph', 'party.tactics', 'npc.relationships', 'ui.accessibility',
  'protocol.privacy-contract',
  'protocol.feature-health', 'protocol.renegotiate', 'client.performance-hints', 'interaction.catalog',
  'protocol.consent', 'world.sector-digest',
  'protocol.causality', 'protocol.errors', 'protocol.preconditions',
  'protocol.transactions', 'protocol.command-schema', 'combat.preflight',
  'inventory.views', 'world.environment', 'quest.guidance', 'moderation.case',
  'protocol.policy', 'protocol.subscription-leases', 'protocol.resumable-streams',
  'protocol.retry-policy', 'protocol.cost-hints', 'protocol.compatibility-fallbacks',
  'world.layers', 'world.codex', 'party.loot-policy', 'ui.safe-schema',
]);

export const NODEUO_FEATURE_PROFILES = Object.freeze({
  full: Object.freeze([]),
  minimal: Object.freeze([
    'world.delta', 'world.components', 'session.resume', 'flow.qos',
    'protocol.manifest', 'protocol.subscriptions', 'protocol.state-repair',
  ]),
  gameplay: BASE_GAMEPLAY,
  enhanced: Object.freeze([
    ...BASE_GAMEPLAY, 'ui.rich-gumps', 'ui.structured', 'crafting.workbench',
    'vendor.search', 'vendor.insights', 'trade.audit', 'assets.streaming',
    'assets.content-addressed', 'map.prefetch', 'party.markers',
    'assets.chunks', 'world.annotations',
    'assets.patchsets', 'economy.market-stream', 'voice.authorization', 'voice.spatial-state',
    'animation.semantic', 'effects.structured', 'combat.timeline',
    'localization.message-format', 'naval.preview', 'cinematic.timeline',
    'social.pings', 'world.events',
    'assets.client-profile', 'content.release', 'content.preflight', 'world.region-prefetch',
    'crafting.plan', 'world.audio-scene', 'accessibility.spatial-cues',
    'diagnostics.trace', 'support.evidence', 'release.compatibility', 'trade.receipts',
    'protocol.privacy-labels', 'protocol.signed-content', 'diagnostics.client-frame',
    'world.live-event-director',
  ]),
  editor: Object.freeze([
    ...BASE_GAMEPLAY, 'ui.rich-gumps', 'ui.structured', 'world.editing',
    'housing.tools', 'housing.collaboration', 'spell.composer',
    'character.specializations', 'assets.streaming', 'assets.content-addressed',
    'assets.chunks', 'map.prefetch', 'mods.channels', 'editor.transactions', 'diagnostics.live',
    'editor.collaboration', 'protocol.rpc',
    'mods.permissions', 'admin.config-transactions', 'assets.patchsets',
    'assets.client-profile', 'content.release', 'content.preflight', 'world.region-prefetch',
    'diagnostics.trace',
    'content.dependencies', 'content.preview-session', 'script.catalog',
    'support.evidence', 'moderation.case',
    'protocol.conformance', 'protocol.privacy-labels', 'protocol.signed-content',
    'diagnostics.client-frame', 'world.live-event-director',
  ]),
  staff: Object.freeze([
    ...BASE_GAMEPLAY, 'diagnostics.live', 'ai.inspector', 'spectator.replay',
    'world.editing', 'housing.tools', 'housing.collaboration',
    'editor.transactions', 'world.events',
    'editor.collaboration', 'protocol.rpc', 'protocol.schema-lifecycle',
    'protocol.schema-registry', 'admin.config-transactions', 'debug.time-travel',
    'spectator.full-stream', 'instance.handoff', 'instance.live-handoff',
    'mods.channels', 'mods.permissions', 'assets.streaming', 'assets.content-addressed',
    'assets.chunks', 'assets.patchsets', 'map.prefetch',
    'assets.client-profile', 'content.release', 'content.preflight', 'world.region-prefetch',
    'diagnostics.trace',
    'content.dependencies', 'content.preview-session', 'script.catalog',
    'support.evidence', 'moderation.case', 'release.compatibility', 'trade.receipts',
    'protocol.conformance', 'protocol.privacy-labels', 'protocol.signed-content',
    'diagnostics.client-frame', 'world.live-event-director',
  ]),
});

const schema = (required = [], properties = {}) => Object.freeze({
  type: 'object', additionalProperties: true, required: Object.freeze(required),
  properties: Object.freeze(properties),
});

const STRING = Object.freeze({ type: 'string', maxLength: 4096 });
const INTEGER = Object.freeze({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const ARRAY = Object.freeze({ type: 'array', maxItems: 4096 });
const OBJECT = Object.freeze({ type: 'object' });
const INVENTORY_MUTATION = schema(['serial', 'x', 'y'], {
  serial: Object.freeze({ type: 'integer', minimum: 1, maximum: 0xffffffff }),
  x: Object.freeze({ type: 'integer', minimum: 0, maximum: 0xffff }),
  y: Object.freeze({ type: 'integer', minimum: 0, maximum: 0xffff }),
});
const INVENTORY_MUTATIONS = Object.freeze({ type: 'array', maxItems: 256, items: INVENTORY_MUTATION });
const ACCESSIBILITY_PREFERENCES = schema([], {
  scale: Object.freeze({ type: 'number', minimum: 0.75, maximum: 3 }),
  contrast: Object.freeze({ type: 'string', enum: Object.freeze(['normal', 'high']) }),
  colorVision: Object.freeze({ type: 'string', enum: Object.freeze([
    'normal', 'protanopia', 'deuteranopia', 'tritanopia',
  ]) }),
  reduceMotion: Object.freeze({ type: 'boolean' }),
  screenReader: Object.freeze({ type: 'boolean' }),
  keyboardNavigation: Object.freeze({ type: 'boolean' }),
});

export const NODEUO_FEATURE_LIFECYCLE = Object.freeze({
  'transport.webtransport': Object.freeze({ status: 'experimental', since: '2.0', replacement: null }),
  'movement.reconciliation': Object.freeze({ status: 'experimental', since: '2.1', replacement: null }),
  'assets.chunks': Object.freeze({ status: 'experimental', since: '2.1', replacement: null }),
  'editor.collaboration': Object.freeze({ status: 'experimental', since: '2.1', replacement: null }),
  'protocol.schema-lifecycle': Object.freeze({ status: 'stable', since: '2.1', replacement: null }),
  'protocol.rpc': Object.freeze({ status: 'stable', since: '2.1', replacement: null }),
  'world.progressive-snapshot': Object.freeze({ status: 'experimental', since: '2.2', replacement: null }),
  'world.sector-stream': Object.freeze({ status: 'experimental', since: '2.2', replacement: null }),
  'network.path-selection': Object.freeze({ status: 'experimental', since: '2.2', replacement: null }),
  'instance.live-handoff': Object.freeze({ status: 'experimental', since: '2.2', replacement: null }),
  'spectator.full-stream': Object.freeze({ status: 'experimental', since: '2.2', replacement: null }),
  'protocol.feature-health': Object.freeze({ status: 'stable', since: '2.3', replacement: null }),
  'protocol.renegotiate': Object.freeze({ status: 'stable', since: '2.4', replacement: null }),
  'client.performance-hints': Object.freeze({ status: 'experimental', since: '2.3', replacement: null }),
  'assets.client-profile': Object.freeze({ status: 'experimental', since: '2.4', replacement: null }),
  'content.release': Object.freeze({ status: 'stable', since: '2.3', replacement: null }),
  'content.preflight': Object.freeze({ status: 'stable', since: '2.4', replacement: null }),
  'interaction.catalog': Object.freeze({ status: 'stable', since: '2.3', replacement: null }),
  'world.region-prefetch': Object.freeze({ status: 'experimental', since: '2.3', replacement: null }),
  'diagnostics.trace': Object.freeze({ status: 'experimental', since: '2.4', replacement: null }),
  'protocol.consent': Object.freeze({ status: 'stable', since: '2.3', replacement: null }),
  'world.sector-digest': Object.freeze({ status: 'experimental', since: '2.3', replacement: null }),
  'protocol.causality': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'protocol.errors': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'protocol.preconditions': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'protocol.transactions': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'protocol.command-schema': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'content.dependencies': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'content.preview-session': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'combat.preflight': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'inventory.views': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'crafting.plan': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'world.environment': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'world.audio-scene': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'accessibility.spatial-cues': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'quest.guidance': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'support.evidence': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'moderation.case': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'script.catalog': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'release.compatibility': Object.freeze({ status: 'stable', since: '2.5', replacement: null }),
  'trade.receipts': Object.freeze({ status: 'experimental', since: '2.5', replacement: null }),
  'protocol.policy': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.subscription-leases': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'protocol.resumable-streams': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'protocol.retry-policy': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.cost-hints': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.compatibility-fallbacks': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.conformance': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.privacy-labels': Object.freeze({ status: 'stable', since: '2.6', replacement: null }),
  'protocol.signed-content': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'diagnostics.client-frame': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'world.layers': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'world.live-event-director': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'world.codex': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'party.loot-policy': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
  'ui.safe-schema': Object.freeze({ status: 'experimental', since: '2.6', replacement: null }),
});

/** Payload schemas focus on stable interoperability boundaries. Feature-
 * specific data can add fields without a protocol-wide version bump. */
export const NODEUO_PAYLOAD_SCHEMAS = Object.freeze({
  // Legacy-mask features also have v2 JSON contracts. These permissive
  // envelopes preserve their established payloads while still giving
  // generators and conformance tooling a complete feature registry.
  'ui.rich-gumps': schema([], { operation: STRING, gump: OBJECT }),
  'spell.composer': schema([], { operation: STRING, spell: OBJECT }),
  'movement.hints': schema([], { operation: STRING, hints: ARRAY }),
  'character.specializations': schema([], { operation: STRING, specialization: STRING }),
  'character.virtues': schema([], { operation: STRING, virtue: STRING }),
  'combat.cooldowns': schema([], { operation: STRING, cooldowns: ARRAY }),
  'naval.preview': schema([], { operation: STRING, position: OBJECT }),
  'housing.tools': schema([], { operation: STRING, houseSerial: INTEGER }),
  'crafting.workbench': schema([], { operation: STRING, recipe: STRING }),
  'skills.insights': schema([], { operation: STRING, skill: STRING }),
  'trade.audit': schema([], { operation: STRING, tradeId: STRING }),
  'vendor.insights': schema([], { operation: STRING, vendorSerial: INTEGER }),
  'world.delta': schema([], { operation: STRING, entities: ARRAY, baseline: INTEGER }),
  'combat.timeline': schema([], { operation: STRING, events: ARRAY, cursor: INTEGER }),
  'ui.structured': schema([], { operation: STRING, document: OBJECT }),
  'quest.journal': schema([], { operation: STRING, questId: STRING }),
  'assets.streaming': schema([], { operation: STRING, name: STRING, offset: INTEGER }),
  'social.state': schema([], { operation: STRING, state: OBJECT }),
  'session.resume': schema([], { operation: STRING, token: STRING }),
  'diagnostics.live': schema([], { operation: STRING, samples: ARRAY }),
  'world.timeline': schema([], { operation: STRING, cursor: INTEGER, events: ARRAY }),
  'world.champion': schema([], { operation: STRING, champion: OBJECT }),
  'animation.semantic': schema([], { operation: STRING, animation: STRING }),
  'effects.structured': schema([], { operation: STRING, effect: OBJECT }),
  'container.delta': schema([], { operation: STRING, containerSerial: INTEGER, items: ARRAY }),
  'properties.structured': schema([], { operation: STRING, serial: INTEGER, properties: ARRAY }),
  'vendor.search': schema([], { operation: STRING, query: STRING, offset: INTEGER, limit: INTEGER }),
  'mods.channels': schema([], { operation: STRING, channel: STRING, payload: OBJECT }),
  'transport.webtransport': schema([], { operation: STRING, endpoint: STRING, token: STRING }),
  'clock.sync': schema([], { clientSentAt: INTEGER, serverReceivedAt: INTEGER, serverSentAt: INTEGER }),
  'transactions.idempotent': schema([], { operation: STRING, idempotencyKey: STRING }),
  'map.prefetch': schema([], { operation: STRING, x: INTEGER, y: INTEGER, map: INTEGER, radius: INTEGER }),
  'localization.message-format': schema([], { operation: STRING, key: STRING, arguments: ARRAY }),
  'party.markers': schema([], { operation: STRING, markers: ARRAY }),
  'spectator.replay': schema([], { operation: STRING, cursor: INTEGER, limit: INTEGER }),
  'ai.inspector': schema([], { operation: STRING, serial: INTEGER, targetSerial: INTEGER, maxNodes: INTEGER }),
  'housing.collaboration': schema([], { operation: STRING, houseSerial: INTEGER, edits: ARRAY }),
  'instance.handoff': schema([], { operation: STRING, instanceId: STRING, token: STRING }),
  'cinematic.timeline': schema([], { operation: STRING, timeline: ARRAY }),
  'voice.authorization': schema([], { operation: STRING, scope: STRING, token: STRING }),
  'npc.generative': schema([], { operation: STRING, npcSerial: INTEGER, message: STRING }),
  'protocol.manifest': schema([], { operation: STRING, fingerprint: STRING }),
  'protocol.subscriptions': schema(['target'], {
    target: STRING, components: ARRAY, fields: ARRAY, maxEntities: INTEGER, rateHz: INTEGER,
  }),
  'protocol.state-repair': schema([], { serials: ARRAY, components: ARRAY, baseline: INTEGER }),
  'protocol.batch': schema([], { maxMessages: INTEGER }),
  'protocol.rpc': schema(['targetFeature', 'method'], {
    targetFeature: STRING, method: STRING, params: OBJECT, timeoutMs: INTEGER,
  }),
  'protocol.schema-lifecycle': schema([], { features: ARRAY }),
  // `world.components` carries snapshots/deltas server->client and bounded
  // resync requests client->server, so neither shape is globally required.
  'world.components': schema([], { baseline: INTEGER, entities: ARRAY, operation: STRING }),
  'movement.reconciliation': schema(['inputSequence', 'accepted'], {
    inputSequence: INTEGER, accepted: Object.freeze({ type: 'boolean' }), position: OBJECT,
  }),
  'world.editing': schema(['operation'], { operation: STRING, edits: ARRAY }),
  'editor.transactions': schema(['operation'], { operation: STRING, transactionId: STRING, mutations: ARRAY }),
  'editor.collaboration': schema(['operation'], {
    operation: STRING, resource: STRING, leaseId: STRING, cursor: OBJECT,
  }),
  'social.pings': schema(['operation'], { operation: STRING, ping: OBJECT }),
  'world.events': schema([], { operation: STRING, cursor: INTEGER, events: ARRAY }),
  'npc.dialog': schema([], { operation: STRING, npcSerial: INTEGER, actions: ARRAY }),
  'assets.content-addressed': schema([], { revision: STRING, files: ARRAY }),
  'assets.chunks': schema(['operation', 'name'], {
    operation: STRING, name: STRING, offset: INTEGER, length: INTEGER, sha256: STRING,
  }),
  'world.annotations': schema(['operation'], { operation: STRING, annotation: OBJECT, scope: STRING }),
  'flow.qos': schema([], { pressure: STRING, bufferedBytes: INTEGER }),
  'protocol.schema-registry': schema([], { operation: STRING, feature: STRING, fingerprint: STRING }),
  'world.progressive-snapshot': schema([], { operation: STRING, radius: INTEGER, cursor: INTEGER }),
  'world.sector-stream': schema([], { operation: STRING, cursor: INTEGER, radius: INTEGER, sectors: ARRAY }),
  'network.path-selection': schema([], { operation: STRING, candidates: ARRAY, metrics: OBJECT }),
  'inventory.transactions': schema(['operation'], {
    operation: STRING, transactionId: STRING, containerSerial: INTEGER,
    mutations: INVENTORY_MUTATIONS, expectedRevision: INTEGER,
  }),
  'combat.telegraphs': schema([], { operation: STRING, cursor: INTEGER, telegraph: OBJECT }),
  'quest.graph': schema([], { operation: STRING, questId: STRING }),
  'party.tactics': schema(['operation'], { operation: STRING, plan: OBJECT, expectedRevision: INTEGER }),
  'npc.relationships': schema([], { operation: STRING, npcSerial: INTEGER }),
  'ui.accessibility': schema([], { operation: STRING, preferences: ACCESSIBILITY_PREFERENCES }),
  'assets.patchsets': schema([], { operation: STRING, fromRevision: STRING, patchsetId: STRING }),
  'mods.permissions': schema([], { operation: STRING, namespace: STRING, permissions: ARRAY }),
  'admin.config-transactions': schema(['operation'], {
    operation: STRING, transactionId: STRING, patch: OBJECT, expectedRevision: INTEGER,
  }),
  'debug.time-travel': schema([], { operation: STRING, cursor: INTEGER, tick: INTEGER, limit: INTEGER }),
  'economy.market-stream': schema([], { operation: STRING, query: STRING, cursor: INTEGER }),
  'voice.spatial-state': schema([], { operation: STRING, position: OBJECT, muted: Object.freeze({ type: 'boolean' }) }),
  'instance.live-handoff': schema([], { operation: STRING, routeId: STRING, token: STRING }),
  'spectator.full-stream': schema([], { operation: STRING, cursor: INTEGER, delayMs: INTEGER }),
  'protocol.privacy-contract': schema([], { operation: STRING }),
  'protocol.feature-health': schema([], { operation: STRING,
    reports: Object.freeze({ type: 'array', maxItems: 64, items: OBJECT }), feature: STRING }),
  'protocol.renegotiate': schema(['operation'], { operation: STRING, epoch: INTEGER,
    reason: STRING, features: ARRAY, manifest: OBJECT }),
  'client.performance-hints': schema([], { operation: STRING,
    fps: Object.freeze({ type: 'number', minimum: 1, maximum: 1000 }),
    frameP95Ms: Object.freeze({ type: 'number', minimum: 0, maximum: 10_000 }),
    memoryMB: Object.freeze({ type: 'number', minimum: 0, maximum: 1_000_000 }),
    desiredRateHz: Object.freeze({ type: 'integer', minimum: 1, maximum: 60 }),
    desiredRadius: Object.freeze({ type: 'integer', minimum: 4, maximum: 64 }),
  }),
  'assets.client-profile': schema([], { operation: STRING, revision: STRING,
    cache: OBJECT, atlas: OBJECT, formats: ARRAY }),
  'content.release': schema([], { operation: STRING, releaseId: STRING, revision: INTEGER }),
  'content.preflight': schema([], { operation: STRING, releaseId: STRING,
    availableBytes: INTEGER, formats: ARRAY }),
  'interaction.catalog': schema(['targetSerial'], { operation: STRING, targetSerial: INTEGER,
    actionId: STRING, expectedRevision: INTEGER }),
  'world.region-prefetch': schema([], { operation: STRING, x: INTEGER, y: INTEGER,
    map: INTEGER, radius: INTEGER, bodies: ARRAY, items: ARRAY }),
  'diagnostics.trace': schema([], { operation: STRING, traceId: STRING, context: OBJECT }),
  'protocol.consent': schema([], { operation: STRING, category: STRING,
    granted: Object.freeze({ type: 'boolean' }), revision: INTEGER }),
  'world.sector-digest': schema([], { operation: STRING, radius: INTEGER,
    cursor: INTEGER, digests: ARRAY }),
  'protocol.causality': schema([], { operation: STRING, traceId: STRING,
    correlationId: STRING, causationId: STRING, transactionId: STRING }),
  'protocol.errors': schema([], { operation: STRING, code: STRING,
    retryable: Object.freeze({ type: 'boolean' }) }),
  'protocol.preconditions': schema([], { operation: STRING, expected: OBJECT, current: OBJECT }),
  'protocol.transactions': schema(['operation'], { operation: STRING, transactionId: STRING,
    actions: Object.freeze({ type: 'array', maxItems: 64, items: OBJECT }), preconditions: OBJECT }),
  'protocol.command-schema': schema([], { operation: STRING, command: STRING }),
  'content.dependencies': schema([], { operation: STRING, node: STRING, depth: INTEGER }),
  'content.preview-session': schema(['operation'], { operation: STRING, sessionId: STRING,
    resources: ARRAY, ttlMs: INTEGER }),
  'combat.preflight': schema(['targetSerial'], { operation: STRING, targetSerial: INTEGER,
    action: STRING, range: INTEGER }),
  'inventory.views': schema([], { operation: STRING, container: STRING, query: STRING,
    itemIds: ARRAY, offset: INTEGER, limit: INTEGER }),
  'crafting.plan': schema([], { operation: STRING, recipes: ARRAY, repetitions: INTEGER }),
  'world.environment': schema([], { operation: STRING }),
  'world.audio-scene': schema([], { operation: STRING, radius: INTEGER }),
  'accessibility.spatial-cues': schema([], { operation: STRING, radius: INTEGER }),
  'quest.guidance': schema([], { operation: STRING, questId: STRING }),
  'support.evidence': schema([], { operation: STRING, traceId: STRING }),
  'moderation.case': schema([], { operation: STRING, category: STRING,
    summary: STRING, eventIds: ARRAY }),
  'script.catalog': schema([], { operation: STRING, query: STRING }),
  'release.compatibility': schema([], { operation: STRING, releaseId: STRING }),
  'trade.receipts': schema([], { operation: STRING, receiptId: STRING, limit: INTEGER }),
  'protocol.policy': schema([], { operation: STRING, feature: STRING }),
  'protocol.subscription-leases': schema([], { operation: STRING, leaseId: STRING,
    target: STRING, ttlMs: INTEGER, cursor: INTEGER }),
  'protocol.resumable-streams': schema([], { operation: STRING, stream: STRING,
    cursor: INTEGER, limit: INTEGER, token: STRING }),
  'protocol.retry-policy': schema([], { operation: STRING, code: STRING, feature: STRING }),
  'protocol.cost-hints': schema([], { operation: STRING, feature: STRING }),
  'protocol.compatibility-fallbacks': schema([], { operation: STRING, feature: STRING }),
  'protocol.conformance': schema([], { operation: STRING, nonce: STRING, probes: ARRAY }),
  'protocol.privacy-labels': schema([], { operation: STRING, feature: STRING }),
  'protocol.signed-content': schema([], { operation: STRING, releaseId: STRING, fingerprint: STRING }),
  'diagnostics.client-frame': schema([], { operation: STRING, samples: ARRAY, renderer: STRING,
    deviceLost: Object.freeze({ type: 'boolean' }) }),
  'world.layers': schema([], { operation: STRING, layer: STRING, targetSerial: INTEGER }),
  'world.live-event-director': schema([], { operation: STRING, eventId: STRING, event: OBJECT }),
  'world.codex': schema([], { operation: STRING, entryId: STRING, entry: OBJECT, query: STRING }),
  'party.loot-policy': schema([], { operation: STRING, policy: OBJECT, expectedRevision: INTEGER }),
  'ui.safe-schema': schema([], { operation: STRING, formId: STRING, values: OBJECT }),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry === undefined ? null : entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Stable 64-bit FNV-1a fingerprint. This detects schema/state mismatches; it
 * is deliberately not presented as a cryptographic signature. */
export function stableJsonFingerprint(value) {
  const source = canonical(value);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    hash ^= BigInt(code & 0xff); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    if (code > 0xff) {
      hash ^= BigInt(code >>> 8); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  }
  return hash.toString(16).padStart(16, '0');
}

export function schemaForFeature(id) {
  return NODEUO_PAYLOAD_SCHEMAS[String(id)] ?? schema();
}

export function schemaDocumentForFeature(id) {
  const featureId = String(id);
  return Object.freeze({
    $schema: NODEUO_JSON_SCHEMA_DIALECT,
    $id: `https://nodeuo.local/protocol/schema/${encodeURIComponent(featureId)}/v${NODEUO_SCHEMA_VERSION}`,
    title: featureId,
    ...schemaForFeature(featureId),
  });
}

export function schemaFingerprintForFeature(id) {
  return `fnv1a64:${stableJsonFingerprint({ version: NODEUO_SCHEMA_VERSION, schema: schemaForFeature(id) })}`;
}

function schemaTypeMatches(value, type) {
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isSafeInteger(value);
  return typeof value === type;
}

const validatorCache = new Map();

function compileValidator(definition) {
  const properties = Object.entries(definition.properties ?? {})
    .map(([key, value]) => [key, compileValidator(value)]);
  const required = [...(definition.required ?? [])];
  const itemValidator = definition.items ? compileValidator(definition.items) : null;
  return (value, path, errors, depth = 0) => {
    if (depth > 16) { errors.push({ path, expected: 'maximum depth 16' }); return; }
    if (definition.type && !schemaTypeMatches(value, definition.type)) {
      errors.push({ path, expected: definition.type }); return;
    }
    if (definition.enum && !definition.enum.includes(value)) errors.push({ path, expected: 'enum' });
    if (typeof value === 'string') {
      if (definition.minLength != null && value.length < definition.minLength) errors.push({ path, expected: `minLength ${definition.minLength}` });
      if (definition.maxLength != null && value.length > definition.maxLength) errors.push({ path, expected: `maxLength ${definition.maxLength}` });
      if (definition.pattern && !(new RegExp(definition.pattern, 'u')).test(value)) errors.push({ path, expected: `pattern ${definition.pattern}` });
    }
    if (typeof value === 'number') {
      if (definition.minimum != null && value < definition.minimum) errors.push({ path, expected: `minimum ${definition.minimum}` });
      if (definition.maximum != null && value > definition.maximum) errors.push({ path, expected: `maximum ${definition.maximum}` });
    }
    if (Array.isArray(value)) {
      if (definition.maxItems != null && value.length > definition.maxItems) errors.push({ path, expected: `maxItems ${definition.maxItems}` });
      if (itemValidator) value.forEach((entry, index) => itemValidator(entry, `${path}[${index}]`, errors, depth + 1));
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push({ path: `${path}.${key}`, expected: 'required' });
      }
      for (const [key, validator] of properties) {
        if (value[key] !== undefined) validator(value[key], `${path}.${key}`, errors, depth + 1);
      }
    }
  };
}

/** Lightweight runtime validator for the stable feature boundary. Deep,
 * feature-specific authorization remains in the authoritative handler. */
export function validateFeaturePayload(id, payload) {
  const current = schemaForFeature(id);
  const errors = [];
  let validator = validatorCache.get(String(id));
  if (!validator) {
    validator = compileValidator(current);
    validatorCache.set(String(id), validator);
  }
  validator(payload, '$', errors);
  return { ok: errors.length === 0, errors };
}

export function pruneFeatureDependencies(features) {
  const rows = new Map((features ?? []).map((entry) => [String(entry.id), entry]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id] of rows) {
      const missing = (NODEUO_FEATURE_DEPENDENCIES[id] ?? []).some((dependency) => !rows.has(dependency));
      if (missing) { rows.delete(id); changed = true; }
    }
  }
  return [...rows.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function profileFeatureIds(name = 'enhanced', available = []) {
  const profile = String(name);
  if (profile === 'full') return pruneFeatureDependencies((available ?? []).map((entry) => ({
    id: typeof entry === 'string' ? entry : entry?.id,
  }))).map((entry) => entry.id);
  const requested = NODEUO_FEATURE_PROFILES[profile] ?? NODEUO_FEATURE_PROFILES.enhanced;
  const allowed = new Set((available ?? []).map((entry) => typeof entry === 'string' ? entry : entry?.id));
  return pruneFeatureDependencies(requested.filter((id) => allowed.has(id)).map((id) => ({ id })))
    .map((entry) => entry.id);
}

export function buildNodeUOManifest(features = []) {
  const normalized = (features ?? []).map((entry) => ({
    id: String(entry.id), minimum: Number(entry.minimum ?? 1), maximum: Number(entry.maximum ?? entry.version ?? 1),
    dependencies: [...(NODEUO_FEATURE_DEPENDENCIES[String(entry.id)] ?? [])],
    schema: schemaFingerprintForFeature(entry.id),
    lifecycle: NODEUO_FEATURE_LIFECYCLE[String(entry.id)] ?? {
      status: 'stable', since: '2.0', replacement: null,
    },
  })).sort((a, b) => a.id.localeCompare(b.id));
  return Object.freeze({
    version: NODEUO_SCHEMA_VERSION,
    fingerprint: `fnv1a64:${stableJsonFingerprint(normalized)}`,
    features: normalized,
    profiles: Object.keys(NODEUO_FEATURE_PROFILES),
  });
}

export function normalizeSubscription(input = {}) {
  const target = String(input.target ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(target)) throw new TypeError('invalid subscription target');
  const names = (value, max) => [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => /^[a-z][a-z0-9._-]{0,63}$/i.test(entry)
      && entry !== '__proto__' && entry !== 'prototype' && entry !== 'constructor'))].slice(0, max);
  const subscription = {
    target,
    components: names(input.components, 32),
    fields: names(input.fields, 128),
    rateHz: Math.max(1, Math.min(60, Number(input.rateHz) | 0 || 30)),
    maxEntities: Math.max(1, Math.min(2048, Number(input.maxEntities) | 0 || 512)),
  };
  if (input.levelOfDetail != null) {
    const value = String(input.levelOfDetail).toLowerCase();
    subscription.levelOfDetail = ['full', 'reduced', 'minimal'].includes(value) ? value : 'full';
  }
  if (input.maxBytesPerSecond != null) {
    subscription.maxBytesPerSecond = Math.max(16 * 1024,
      Math.min(4 * 1024 * 1024, Number(input.maxBytesPerSecond) | 0 || 256 * 1024));
  }
  if (input.area && typeof input.area === 'object') {
    const type = input.area.type === 'rectangle' ? 'rectangle' : 'circle';
    const area = {
      type,
      map: Math.max(0, Math.min(255, Number(input.area.map) | 0)),
      x: Math.max(0, Math.min(0xffff, Number(input.area.x) | 0)),
      y: Math.max(0, Math.min(0xffff, Number(input.area.y) | 0)),
    };
    if (type === 'circle') area.radius = Math.max(1, Math.min(256, Number(input.area.radius) | 0 || 18));
    else {
      area.width = Math.max(1, Math.min(512, Number(input.area.width) | 0 || 36));
      area.height = Math.max(1, Math.min(512, Number(input.area.height) | 0 || 36));
    }
    subscription.area = Object.freeze(area);
  }
  return Object.freeze(subscription);
}
