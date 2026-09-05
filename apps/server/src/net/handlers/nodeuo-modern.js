import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { playerAnimation } from '@uo/protocol';
import {
  buildNodeUOManifest,
  createNodeUOMessage,
  featureIdForNamespace,
  NodeUOChannel,
  NodeUOChannelFlag,
  NodeUOChannelMessage,
  NodeUODelivery,
  NodeUOEntityType,
  NodeUOFeature,
  NodeUOJsonKind,
  NodeUOPriority,
  NodeUOWorldField,
  NODEUO_JSON_SCHEMA_DIALECT,
  NODEUO_SCHEMA_VERSION,
  normalizeSubscription,
  schemaDocumentForFeature,
  stableJsonFingerprint,
  validateFeaturePayload,
  checkNodeUOPreconditions,
  createNodeUOError,
  isNodeUOError,
  NodeUOErrorCode,
} from '@uo/nodeuo-protocol';
import { nearbyClients } from '../../world/visibility.js';
import { EntityDirty } from '../../world/interest-management.js';
import { dispatchNodeUORpc } from './nodeuo-rpc.js';
import {
  currentNodeUORequestContext,
  finishNodeUORequestContext,
} from '../../systems/request-context.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..', '..', '..', '..', 'client', 'public', 'assets');
const MAX_MESSAGES_PER_SECOND = 120;
const RESUME_TTL_MS = 2 * 60_000;
const MAX_RESUME_TOKENS = 10_000;
let nextBaseline = 0;
const resumeTokens = new Map();
const modChannels = new Map();
const assetDigestCache = new Map();

const CHANNEL_CAPABILITY = Object.freeze({
  [NodeUOChannel.Control]: NodeUOFeature.SessionResume,
  [NodeUOChannel.World]: NodeUOFeature.WorldTimeline,
  [NodeUOChannel.Combat]: NodeUOFeature.CombatTimeline,
  [NodeUOChannel.Interface]: NodeUOFeature.StructuredUi,
  [NodeUOChannel.Quest]: NodeUOFeature.QuestJournal,
  [NodeUOChannel.Assets]: NodeUOFeature.AssetStreaming,
  [NodeUOChannel.Social]: NodeUOFeature.SocialState,
  [NodeUOChannel.Diagnostics]: NodeUOFeature.LiveDiagnostics,
  [NodeUOChannel.Mods]: NodeUOFeature.ModChannels,
});

const NAMESPACE_CAPABILITY = Object.freeze({
  'nodeuo.timeline': NodeUOFeature.WorldTimeline,
  'nodeuo.animation': NodeUOFeature.SemanticAnimation,
  'nodeuo.effects': NodeUOFeature.StructuredEffects,
  'nodeuo.combat': NodeUOFeature.CombatTimeline,
  'nodeuo.container': NodeUOFeature.ContainerDelta,
  'nodeuo.properties': NodeUOFeature.StructuredProperties,
  'nodeuo.vendor': NodeUOFeature.VendorSearch,
  'nodeuo.quest': NodeUOFeature.QuestJournal,
  'nodeuo.assets': NodeUOFeature.AssetStreaming,
  'nodeuo.party': NodeUOFeature.SocialState,
  'nodeuo.ui': NodeUOFeature.StructuredUi,
  'nodeuo.notice': NodeUOFeature.StructuredUi,
  'nodeuo.resume': NodeUOFeature.SessionResume,
  'nodeuo.diagnostics': NodeUOFeature.LiveDiagnostics,
  'nodeuo.transport': NodeUOFeature.TransportUpgrade,
});

function capabilityFor(namespace, channel) {
  return NAMESPACE_CAPABILITY[namespace] ?? CHANNEL_CAPABILITY[channel] ?? null;
}

function rateAllowed(state, now = Date.now()) {
  const rate = state._nodeUOModernRate ??= { since: now, count: 0, rejected: 0 };
  if (now - rate.since >= 1000) { rate.since = now; rate.count = 0; }
  if (++rate.count <= MAX_MESSAGES_PER_SECOND) return true;
  rate.rejected++;
  return false;
}

function sequenceFor(state, namespace) {
  state._nodeUOSequences ??= new Map();
  const value = ((state._nodeUOSequences.get(namespace) ?? 0) + 1) >>> 0 || 1;
  state._nodeUOSequences.set(namespace, value);
  return value;
}

const JSON_KIND = Object.freeze({
  [NodeUOChannelMessage.Snapshot]: NodeUOJsonKind.Snapshot,
  [NodeUOChannelMessage.Delta]: NodeUOJsonKind.Delta,
  [NodeUOChannelMessage.Ack]: NodeUOJsonKind.Ack,
  [NodeUOChannelMessage.Request]: NodeUOJsonKind.Request,
  [NodeUOChannelMessage.Result]: NodeUOJsonKind.Result,
  [NodeUOChannelMessage.Event]: NodeUOJsonKind.Event,
  [NodeUOChannelMessage.Subscribe]: NodeUOJsonKind.Subscribe,
  [NodeUOChannelMessage.Unsubscribe]: NodeUOJsonKind.Unsubscribe,
  [NodeUOChannelMessage.Resume]: NodeUOJsonKind.Resume,
  [NodeUOChannelMessage.Notice]: NodeUOJsonKind.Notice,
});

/** Native v2 sender used by engine systems and scripts. */
export function sendNodeUOFeature(state, {
  feature, kind = NodeUOJsonKind.Event, payload = {}, id, replyTo, seq, ack,
  priority = NodeUOPriority.Normal, delivery = NodeUODelivery.Reliable,
  ttlMs, replace, expectedRevision, revision, idempotencyKey, requiresAck = false,
  traceId, correlationId, causationId, transactionId, deadlineAt, preconditions,
} = {}) {
  const resolved = String(feature ?? '').trim().toLowerCase();
  if (!resolved || !state?.supportsNodeUO?.(resolved) || !state.nodeUOJsonTransport) return false;
  const activeContext = currentNodeUORequestContext();
  const message = createNodeUOMessage({
    feature: resolved, featureVersion: state.nodeUOFeatures.get(resolved) ?? 1,
    kind, payload, id, replyTo, seq, ack, priority, delivery, ttlMs, replace,
    expectedRevision, revision, idempotencyKey, requiresAck,
    traceId: traceId ?? activeContext?.traceId,
    correlationId: correlationId ?? activeContext?.correlationId,
    causationId: causationId ?? activeContext?.requestId ?? activeContext?.causationId,
    transactionId: transactionId ?? activeContext?.transactionId,
    deadlineAt, preconditions,
  });
  const sent = state.sendNodeUOMessage(message);
  if (sent && requiresAck && message.seq) {
    state._nodeUOPendingAcks ??= new Map();
    const now = Date.now();
    for (const [key, pending] of state._nodeUOPendingAcks) {
      if (now - pending.sentAt > 30_000) state._nodeUOPendingAcks.delete(key);
    }
    const key = `${resolved}:${message.seq}`;
    state._nodeUOPendingAcks.set(key, { feature: resolved, seq: message.seq, sentAt: now,
      bytes: Buffer.byteLength(JSON.stringify(message)) });
    while (state._nodeUOPendingAcks.size > 2048) state._nodeUOPendingAcks.delete(state._nodeUOPendingAcks.keys().next().value);
  }
  return sent;
}

/** Send a typed NodeUO event. Private features never fall back to UO bytes. */
export function sendNodeUOEvent(state, {
  feature, eventKind = 0, requestId = 0, payload = {}, jsonKind = NodeUOJsonKind.Event,
  priority = NodeUOPriority.Normal, delivery = NodeUODelivery.Reliable,
} = {}) {
  return sendNodeUOFeature(state, {
    feature, kind: jsonKind, priority, delivery,
    payload: { eventKind, requestId: Number(requestId) >>> 0, data: payload },
  });
}

export function sendNodeUOChannel(state, {
  channel, namespace, kind = NodeUOChannelMessage.Event, flags = 0,
  requestId = 0, payload = {}, capability = capabilityFor(namespace, channel), feature: requestedFeature,
} = {}) {
  if (!state?.nodeUOJsonTransport) return false;
  const sequence = sequenceFor(state, namespace || String(channel));
  const modEnvelope = channel === NodeUOChannel.Mods || capability === NodeUOFeature.ModChannels;
  const feature = requestedFeature ?? (modEnvelope ? NodeUOFeature.ModChannels
    : (featureIdForNamespace(namespace) ?? capability));
  if (!feature || !state.supportsNodeUO?.(feature)) return false;
  const jsonPayload = modEnvelope ? { namespace, data: payload } : payload;
  const delivery = (flags & NodeUOChannelFlag.LossTolerant)
    ? NodeUODelivery.LossTolerant : (flags & NodeUOChannelFlag.Replace) ? NodeUODelivery.Latest : NodeUODelivery.Reliable;
  const priority = (flags & NodeUOChannelFlag.Urgent) ? NodeUOPriority.High : NodeUOPriority.Normal;
  const sent = sendNodeUOFeature(state, {
    feature, kind: JSON_KIND[kind] ?? NodeUOJsonKind.Event, payload: jsonPayload, seq: sequence,
    id: requestId ? `s.${requestId}` : undefined,
    priority, delivery, ttlMs: delivery === NodeUODelivery.LossTolerant ? 1000 : undefined,
    replace: (flags & NodeUOChannelFlag.Replace) ? `${feature}:${payload?.serial ?? ''}` : undefined,
    requiresAck: !!(flags & NodeUOChannelFlag.AckRequired),
  });
  return sent ? sequence : false;
}

function statusBits(entity) {
  return (entity.dead ? 1 : 0) | (entity.hidden ? 2 : 0) | (entity.poisoned ? 4 : 0)
    | (entity.frozen ? 8 : 0) | (entity.invulnerable ? 16 : 0);
}

export function entityDeltaRow(entity, mask, kind = null) {
  if (!entity) return null;
  const entityType = kind === 'item' || (kind == null && entity.itemId != null)
    ? NodeUOEntityType.Item : NodeUOEntityType.Mobile;
  return {
    serial: entity.serial, entityType, mask,
    x: entity.x, y: entity.y, z: entity.z, map: entity.map, direction: entity.direction,
    artId: entityType === NodeUOEntityType.Mobile ? entity.body : (entity.multiId ?? entity.itemId),
    hue: entity.hue, flags: entity.flags, notoriety: entity.notoriety, amount: entity.amount,
    hp: entity.hp, hpMax: entity.hpMax, mana: entity.mana, manaMax: entity.manaMax,
    stam: entity.stam, stamMax: entity.stamMax, parent: entity.parent, layer: entity.layer,
    statusBits: statusBits(entity),
  };
}

function componentEntityRow(row, revision = 0, subscription = null, viewer = null) {
  const components = {};
  if (row.mask & NodeUOWorldField.Position) components.position = {
    x: row.x, y: row.y, z: row.z, map: row.map, direction: row.direction,
  };
  if (row.mask & NodeUOWorldField.Appearance) components.appearance = {
    artId: row.artId, hue: row.hue, flags: row.flags, notoriety: row.notoriety, amount: row.amount,
  };
  if (row.mask & NodeUOWorldField.Vitals) components.vitals = {
    hp: row.hp, hpMax: row.hpMax, mana: row.mana, manaMax: row.manaMax,
    stamina: row.stam, staminaMax: row.stamMax,
  };
  if (row.mask & NodeUOWorldField.Status) components.status = {
    dead: !!(row.statusBits & 1), hidden: !!(row.statusBits & 2), poisoned: !!(row.statusBits & 4),
    frozen: !!(row.statusBits & 8), invulnerable: !!(row.statusBits & 16),
  };
  if (row.mask & NodeUOWorldField.Parent) components.containment = { parent: row.parent, layer: row.layer };
  // JSON has no representation for undefined. Remove absent optional fields
  // before validation and hashing so the wire payload and fingerprint always
  // describe the same value.
  for (const values of Object.values(components)) {
    for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  }
  const wantedComponents = subscription?.components?.length ? new Set(subscription.components) : null;
  const wantedFields = subscription?.fields?.length ? new Set(subscription.fields) : null;
  const distance = viewer && row.map === viewer.map
    ? Math.max(Math.abs((row.x ?? viewer.x) - viewer.x), Math.abs((row.y ?? viewer.y) - viewer.y)) : 0;
  const lod = subscription?.levelOfDetail;
  if (lod === 'minimal' && distance > 8) {
    delete components.vitals; delete components.status; delete components.containment;
  } else if (lod === 'reduced' && distance > 12) {
    delete components.vitals; delete components.status;
  }
  for (const [name, values] of Object.entries(components)) {
    if (wantedComponents && !wantedComponents.has(name)) { delete components[name]; continue; }
    if (!wantedFields) continue;
    for (const key of Object.keys(values)) {
      if (!wantedFields.has(key) && !wantedFields.has(`${name}.${key}`)) delete values[key];
    }
    if (!Object.keys(values).length) delete components[name];
  }
  const entity = {
    serial: row.serial >>> 0,
    type: row.entityType === NodeUOEntityType.Mobile ? 'mobile' : 'item',
    revision: Number(revision) >>> 0,
    components,
  };
  entity.stateHash = `fnv1a64:${stableJsonFingerprint(entity)}`;
  return entity;
}

function worldSubscription(state) {
  for (const target of ['world.components', 'world.delta']) {
    const subscription = state?._nodeUOSubscriptions?.get?.(target);
    if (!subscription) continue;
    if (subscription._leaseId) {
      const lease = state?._nodeUOSubscriptionLeases?.get?.(subscription._leaseId);
      if (!lease || lease.expiresAt <= Date.now()) {
        state._nodeUOSubscriptionLeases?.delete?.(subscription._leaseId);
        state._nodeUOSubscriptions.delete(target);
        continue;
      }
    }
    return subscription;
  }
  return state?._nodeUOAdaptiveSubscription ?? null;
}

function componentFeature(state) {
  return state.supportsNodeUO?.('world.components') ? 'world.components' : 'world.delta';
}

function visibleTo(state, serial, kind) {
  if ((state.mobile?.serial >>> 0) === (serial >>> 0)) return true;
  return kind === 'item' ? state._visibleItems?.has?.(serial) : state._visibleMobiles?.has?.(serial);
}

function wireMaskForChange(dirty, entity) {
  if ((dirty & EntityDirty.Created) || dirty === EntityDirty.All) {
    return entity?.itemId != null
      ? NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Parent
      : NodeUOWorldField.Position | NodeUOWorldField.Appearance
        | NodeUOWorldField.Vitals | NodeUOWorldField.Status;
  }
  let mask = 0;
  if (dirty & EntityDirty.Position) mask |= NodeUOWorldField.Position;
  if (dirty & EntityDirty.Appearance) mask |= NodeUOWorldField.Appearance | NodeUOWorldField.Status;
  if (dirty & EntityDirty.Vitals) mask |= NodeUOWorldField.Vitals | NodeUOWorldField.Status;
  if (dirty & EntityDirty.Parent) mask |= NodeUOWorldField.Parent | NodeUOWorldField.Position;
  if (dirty & EntityDirty.Properties) mask |= NodeUOWorldField.Appearance | NodeUOWorldField.Status;
  return mask;
}

function subscriptionAllowsEntity(subscription, entity, viewer) {
  const area = subscription?.area;
  if (!area || !entity) return true;
  if ((entity.serial >>> 0) === (viewer?.serial >>> 0)) return true;
  if ((entity.map | 0) !== (area.map | 0)) return false;
  const dx = Math.abs((entity.x | 0) - area.x);
  const dy = Math.abs((entity.y | 0) - area.y);
  return area.type === 'rectangle'
    ? dx * 2 <= area.width && dy * 2 <= area.height
    : dx * dx + dy * dy <= area.radius * area.radius;
}

function visibleSnapshot(state) {
  const rows = [];
  const mobileMask = NodeUOWorldField.Position | NodeUOWorldField.Appearance
    | NodeUOWorldField.Vitals | NodeUOWorldField.Status;
  const itemMask = NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Parent;
  const seen = new Set();
  const addMobile = (serial) => {
    const entity = state.ctx.world.mobiles.get(serial >>> 0);
    if (entity && !seen.has(entity.serial)) { seen.add(entity.serial); rows.push(entityDeltaRow(entity, mobileMask, 'mobile')); }
  };
  addMobile(state.mobile?.serial);
  for (const serial of state._visibleMobiles ?? []) addMobile(serial);
  for (const serial of state._visibleItems ?? []) {
    const entity = state.ctx.world.items.get(serial >>> 0);
    if (entity) rows.push(entityDeltaRow(entity, itemMask, 'item'));
  }
  return rows;
}

export function sendNodeUOWorldSnapshot(state) {
  if (!state.supportsNodeUO?.(NodeUOFeature.WorldDelta) || !state.mobile) return false;
  const baseline = (++nextBaseline) >>> 0 || ++nextBaseline;
  const subscription = worldSubscription(state);
  const visible = visibleSnapshot(state)
    .filter((row) => subscriptionAllowsEntity(subscription, row, state.mobile));
  const rows = visible.slice(0, subscription?.maxEntities ?? visible.length);
  const chunks = Math.max(1, Math.ceil(rows.length / 250));
  state._nodeUOWorldKnown = new Set(rows.map((row) => row.serial >>> 0));
  state._nodeUOWorld = { baseline, sequence: 1, finalSequence: chunks, acknowledged: 0, ready: false, sent: 0, resyncs: 0 };
  for (let chunk = 0; chunk < chunks; chunk++) {
    const entities = rows.slice(chunk * 250, (chunk + 1) * 250);
    const sequence = state._nodeUOWorld.sequence++;
    sendNodeUOFeature(state, {
      feature: componentFeature(state), kind: NodeUOJsonKind.Snapshot, seq: sequence,
      delivery: NodeUODelivery.Reliable, requiresAck: true,
      payload: { baseline, finalSequence: chunks, entities: entities.map((row) => componentEntityRow(row,
        state.ctx.world?.interest?.revision?.(row.serial) ?? 0, subscription, state.mobile)) },
    });
    state._nodeUOWorld.sent += entities.length;
  }
  return true;
}

export function sendNodeUOProgressiveSnapshot(state, { radii = [8, 18, 32] } = {}) {
  if (!state?.mobile || !state.supportsNodeUO?.('world.progressive-snapshot')) return false;
  const baseline = (++nextBaseline) >>> 0 || ++nextBaseline;
  const subscription = worldSubscription(state);
  const limits = [...new Set((Array.isArray(radii) ? radii : [8, 18, 32])
    .map((value) => Math.max(4, Math.min(64, Number(value) | 0))))].sort((a, b) => a - b);
  const rows = visibleSnapshot(state).filter((row) => subscriptionAllowsEntity(subscription, row, state.mobile));
  const phases = limits.map((radius) => ({ radius, rows: [] }));
  phases.push({ radius: null, rows: [] });
  for (const row of rows.slice(0, subscription?.maxEntities ?? rows.length)) {
    const distance = row.serial === state.mobile.serial ? 0
      : Math.max(Math.abs((row.x | 0) - state.mobile.x), Math.abs((row.y | 0) - state.mobile.y));
    const phase = phases.find((entry) => entry.radius == null || distance <= entry.radius);
    phase.rows.push(row);
  }
  const chunks = [];
  for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
    const phase = phases[phaseIndex];
    for (let offset = 0; offset < phase.rows.length; offset += 250) {
      chunks.push({ phase: phaseIndex, radius: phase.radius, rows: phase.rows.slice(offset, offset + 250) });
    }
  }
  if (!chunks.length) chunks.push({ phase: 0, radius: limits[0] ?? 8, rows: [] });
  state._nodeUOWorldKnown = new Set(rows.map((row) => row.serial >>> 0));
  state._nodeUOWorld = { baseline, sequence: 1, finalSequence: chunks.length,
    acknowledged: 0, ready: false, sent: 0, resyncs: 0 };
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const sequence = state._nodeUOWorld.sequence++;
    sendNodeUOFeature(state, { feature: 'world.progressive-snapshot', kind: NodeUOJsonKind.Snapshot,
      seq: sequence, delivery: NodeUODelivery.Reliable, requiresAck: true,
      payload: { baseline, sequence, finalSequence: chunks.length, phase: chunk.phase,
        radius: chunk.radius, complete: index === chunks.length - 1,
        entities: chunk.rows.map((row) => componentEntityRow(row,
          state.ctx.world.interest?.revision?.(row.serial) ?? 0, subscription, state.mobile)) } });
    state._nodeUOWorld.sent += chunk.rows.length;
  }
  return { ok: true, baseline, phases: phases.length, chunks: chunks.length, entities: rows.length };
}

export function trySendNodeUOEntityDelta(state, serial, mask) {
  return trySendNodeUOEntityBatch(state, [{ serial, mask }]);
}

function deferPositionBatch(state, changes, subscription) {
  const now = Date.now();
  if (now >= (state._nodeUOReplicationNextAt ?? 0)) return false;
  state._nodeUOReplicationPending ??= new Map();
  for (const change of changes) {
    const serial = Number(change.serial) >>> 0;
    const previous = state._nodeUOReplicationPending.get(serial);
    state._nodeUOReplicationPending.set(serial, {
      serial, mask: (Number(previous?.mask) | Number(change.mask)) & 0xffff,
    });
  }
  if (state._nodeUOReplicationTimer) return true;
  const flush = () => {
    state._nodeUOReplicationTimer = null;
    if (state._closed || !state._nodeUOReplicationPending?.size) return;
    const pending = [...state._nodeUOReplicationPending.values()].slice(0, subscription.maxEntities);
    state._nodeUOReplicationPending.clear();
    state._nodeUOReplicationNextAt = 0;
    trySendNodeUOEntityBatch(state, pending);
  };
  const delay = Math.max(1, state._nodeUOReplicationNextAt - now);
  state._nodeUOReplicationTimer = state.ctx.scheduler?.once
    ? state.ctx.scheduler.once(`nodeuo-replication:${state.id}`, delay, flush)
    : setTimeout(flush, delay);
  state._nodeUOReplicationTimer.unref?.();
  return true;
}

/** Batch coalesced authoritative mutations into one JSON message per viewer. */
export function trySendNodeUOEntityBatch(state, changes) {
  const sync = state?._nodeUOWorld;
  if (!sync?.ready || !state.supportsNodeUO?.(NodeUOFeature.WorldDelta)) return false;
  const normalized = [];
  for (const change of (changes ?? []).slice(0, 512)) {
    const serial = Number(change?.serial) >>> 0;
    const entity = state.ctx.world.mobiles.get(serial) ?? state.ctx.world.items.get(serial);
    if (!entity) continue;
    const mask = Number(change?.mask) & 0xffff;
    if (!mask) continue;
    normalized.push({ serial, mask, entity, row: entityDeltaRow(entity, mask) });
  }
  if (!normalized.length) return false;
  const subscription = worldSubscription(state);
  const subscribed = normalized.filter(({ entity }) => subscriptionAllowsEntity(subscription, entity, state.mobile))
    .slice(0, subscription?.maxEntities ?? 512);
  if (!subscribed.length) return false;
  state._nodeUOWorldKnown ??= new Set();
  for (const entry of subscribed) state._nodeUOWorldKnown.add(entry.serial >>> 0);
  const positionOnly = subscribed.every((entry) => entry.mask === NodeUOWorldField.Position);
  if (positionOnly && subscription && deferPositionBatch(state, subscribed, subscription)) return true;
  if (!positionOnly && state._nodeUOReplicationPending) {
    for (const entry of subscribed) state._nodeUOReplicationPending.delete(entry.serial);
  }
  if (positionOnly && subscription) {
    state._nodeUOReplicationNextAt = Date.now() + Math.ceil(1000 / Math.max(1, subscription.rateHz));
  }
  const sequence = sync.sequence++;
  const delivery = positionOnly ? NodeUODelivery.Latest : NodeUODelivery.Reliable;
  sendNodeUOFeature(state, {
    feature: componentFeature(state), kind: NodeUOJsonKind.Delta, seq: sequence, delivery,
    ttlMs: delivery === NodeUODelivery.Latest ? 1000 : undefined,
    replace: delivery === NodeUODelivery.Latest ? 'world.positions' : undefined,
    requiresAck: delivery === NodeUODelivery.Reliable,
    payload: { baseline: sync.baseline, entities: subscribed.map(({ serial, row }) => componentEntityRow(row,
        state.ctx.world?.interest?.revision?.(serial) ?? 0, subscription, state.mobile)) },
  });
  sync.sent += subscribed.length;
  return true;
}

export function trySendNodeUOEntityRemoved(state, serialLike) {
  const sync = state?._nodeUOWorld;
  const serial = Number(serialLike) >>> 0;
  if (!serial || !sync?.ready || !state.supportsNodeUO?.(NodeUOFeature.WorldDelta)) return false;
  const sequence = sync.sequence++;
  sendNodeUOFeature(state, {
    feature: componentFeature(state), kind: NodeUOJsonKind.Delta, seq: sequence, requiresAck: true,
    payload: { baseline: sync.baseline, entities: [{ serial, type: 'entity', removed: true,
      stateHash: `fnv1a64:${stableJsonFingerprint({ serial, type: 'entity', removed: true })}` }] },
  });
  state._nodeUOWorldKnown?.delete(serial);
  sync.sent++;
  return true;
}

export function assetManifest() {
  const names = ['asset-overrides.json', 'patches.json', 'tiledata.json', 'hues.json',
    'animdata.json', 'multi.json', 'cliloc.json', 'sounds.json', 'music.json', 'cursors.json'];
  const files = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(ASSETS, name));
      const cacheKey = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      let digest = assetDigestCache.get(name);
      if (!digest || digest.cacheKey !== cacheKey) {
        digest = { cacheKey,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSETS, name))).digest('base64url') };
        assetDigestCache.set(name, digest);
      }
      files.push({ name, bytes: stat.size, revision: Math.trunc(stat.mtimeMs),
        sha256: digest.sha256, url: `/assets/${encodeURIComponent(name)}`,
        contentType: 'application/json', ranges: true, chunkBytes: 256 * 1024 });
    } catch { /* optional */ }
  }
  const revision = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 24);
  return { schema: 3, revision, algorithm: 'sha-256', trust: 'same-origin-https',
    transfer: { rangeUnit: 'bytes', resumable: true, maxParallel: 4 }, files };
}

function partySnapshot(state) {
  const party = state.ctx.partyRegistry?.partyOf?.(state.mobile?.serial);
  const memberSerials = party?.members instanceof Set ? [...party.members]
    : Array.isArray(party?.members) ? party.members : [state.mobile?.serial];
  const members = memberSerials.map((serial) => {
    const mob = state.ctx.world.mobiles.get(serial >>> 0);
    return mob ? {
      serial: mob.serial, name: mob.name, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      hp: mob.hp, hpMax: mob.hpMax, mana: mob.mana, manaMax: mob.manaMax,
      canLoot: !!party?.canLoot?.get?.(serial),
    } : { serial: serial >>> 0 };
  });
  return { partyId: party?.id ?? null, leader: party?.leader ?? state.mobile?.serial, members };
}

export function sendNodeUOPartySnapshot(state) {
  if (!state?.supportsNodeUO?.(NodeUOFeature.SocialState)) return false;
  return !!sendNodeUOChannel(state, {
    channel: NodeUOChannel.Social, namespace: 'nodeuo.party', kind: NodeUOChannelMessage.Snapshot,
    flags: NodeUOChannelFlag.Replace, payload: partySnapshot(state),
  });
}

function cleanQuestSnapshot(state) {
  const source = state.mobile?.activeQuests ?? {};
  const quests = Array.isArray(source) ? source : Object.entries(source).map(([id, value]) => ({ id, ...value }));
  return { quests: quests.slice(0, 256).map((quest) => ({
    id: String(quest?.id ?? quest?.kind ?? '').slice(0, 128),
    title: String(quest?.title ?? quest?.name ?? quest?.id ?? '').slice(0, 256),
    stage: quest?.stage ?? quest?.step ?? 0, progress: quest?.progress ?? null,
    objectives: Array.isArray(quest?.objectives) ? quest.objectives.slice(0, 32) : [],
    rewards: Array.isArray(quest?.rewards) ? quest.rewards.slice(0, 32) : [],
  })) };
}

function issueResume(state) {
  if (!state.supportsNodeUO?.(NodeUOFeature.SessionResume)) return false;
  const token = crypto.randomBytes(24).toString('base64url');
  const record = {
    account: state.accountName, mobileSerial: state.mobile?.serial >>> 0,
    features: new Map(state.nodeUOFeatures ?? []),
    sequences: state._nodeUOSequences ??= new Map(),
    acknowledgements: state._nodeUOChannelAcks ??= new Map(),
    world: state._nodeUOWorld ?? null,
    issuedAt: Date.now(),
    expiresAt: Date.now() + RESUME_TTL_MS,
  };
  resumeTokens.set(token, record);
  state._nodeUOResumeToken = token;
  while (resumeTokens.size > MAX_RESUME_TOKENS) resumeTokens.delete(resumeTokens.keys().next().value);
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Control, namespace: 'nodeuo.resume',
    kind: NodeUOChannelMessage.Snapshot, flags: NodeUOChannelFlag.AckRequired,
    payload: { token, expiresAt: record.expiresAt,
      baseline: record.world?.baseline ?? 0,
      sequences: Object.fromEntries(record.sequences),
      features: Object.fromEntries(record.features) },
  });
  return true;
}

/** Freeze the live cursors into the single-use resume record before NetState
 * clears per-session maps. Without this checkpoint the record retained Map
 * references that cleanup emptied, making resume appear successful while
 * restoring no sequence state. */
export function checkpointNodeUOResume(state) {
  const record = resumeTokens.get(String(state?._nodeUOResumeToken ?? ''));
  if (!record || record.account !== state.accountName) return false;
  record.features = new Map(state.nodeUOFeatures ?? []);
  record.sequences = new Map(state._nodeUOSequences ?? []);
  record.acknowledgements = new Map(state._nodeUOChannelAcks ?? []);
  record.world = state._nodeUOWorld ? { ...state._nodeUOWorld } : null;
  record.expiresAt = Date.now() + RESUME_TTL_MS;
  return true;
}

function consumeResume(state, token, client = {}) {
  const record = resumeTokens.get(String(token));
  if (record) resumeTokens.delete(String(token));
  const ok = !!record && record.expiresAt >= Date.now()
    && record.account === state.accountName
    && (!record.mobileSerial || record.mobileSerial === (state.mobile?.serial >>> 0));
  if (!ok) return { ok: false, restored: null, reason: 'resume token is invalid or expired' };
  state._nodeUOSequences ??= new Map();
  state._nodeUOChannelAcks ??= new Map();
  for (const [feature, sequence] of record.sequences) {
    const negotiated = featureIdForNamespace(feature) ?? feature;
    if (state.supportsNodeUO?.(negotiated)) state._nodeUOSequences.set(feature,
      Math.max(state._nodeUOSequences.get(feature) ?? 0, Number(sequence) >>> 0));
  }
  for (const [feature, ack] of record.acknowledgements) {
    const negotiated = featureIdForNamespace(feature) ?? feature;
    if (state.supportsNodeUO?.(negotiated)) state._nodeUOChannelAcks.set(feature, Number(ack) >>> 0);
  }
  const requestedBaseline = Number(client.baseline) >>> 0;
  const currentBaseline = state._nodeUOWorld?.baseline ?? 0;
  return {
    ok: true,
    restored: {
      mobileSerial: record.mobileSerial,
      resumedAt: Date.now(),
      ageMs: Math.max(0, Date.now() - record.issuedAt),
      mode: requestedBaseline && requestedBaseline === currentBaseline ? 'delta' : 'current-snapshot',
      baseline: currentBaseline,
      previousBaseline: record.world?.baseline ?? 0,
      sequences: Object.fromEntries(state._nodeUOSequences),
      acknowledged: Object.fromEntries(state._nodeUOChannelAcks),
      cursors: client.cursors && typeof client.cursors === 'object' ? client.cursors : {},
    },
  };
}

export function initializeNodeUOModern(state) {
  if (!state?.mobile || !state.nodeUOProtocol) return false;
  const settings = state.ctx.nodeUOSettings?.snapshot?.() ?? {};
  // v2 clients can consume the initial world in near-to-far phases. Do not
  // also send the legacy all-at-once component snapshot: that duplicated the
  // largest login payload and briefly doubled client-side reconciliation.
  if (state.nodeUOJsonTransport && state.supportsNodeUO?.('world.progressive-snapshot')) {
    sendNodeUOProgressiveSnapshot(state);
  } else sendNodeUOWorldSnapshot(state);
  const day = state.ctx.dayNight;
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.World, namespace: 'nodeuo.timeline', kind: NodeUOChannelMessage.Snapshot,
    payload: { serverTime: Date.now(), season: day?.season ?? 1, lightLevel: day?.currentLevel?.() ?? 0,
      weather: day?.weatherKind ?? 0xFE, gameMinute: day?.gameMinute ?? null },
  });
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Quest, namespace: 'nodeuo.quest', kind: NodeUOChannelMessage.Snapshot,
    payload: cleanQuestSnapshot(state),
  });
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Assets, namespace: 'nodeuo.assets', kind: NodeUOChannelMessage.Snapshot,
    feature: state.nodeUOJsonTransport && state.supportsNodeUO?.('assets.content-addressed')
      ? 'assets.content-addressed' : undefined,
    payload: assetManifest(),
  });
  sendNodeUOPartySnapshot(state);
  if (state.nodeUOJsonTransport && state.supportsNodeUO?.('map.prefetch')) {
    const centerX = Math.floor((state.mobile.x | 0) / 8);
    const centerY = Math.floor((state.mobile.y | 0) / 8);
    const chunks = [];
    for (let radius = 0; radius <= 2; radius++) {
      for (let y = centerY - radius; y <= centerY + radius; y++) {
        for (let x = centerX - radius; x <= centerX + radius; x++) {
          if (Math.max(Math.abs(x - centerX), Math.abs(y - centerY)) !== radius) continue;
          chunks.push({ x, y, priority: radius });
        }
      }
    }
    const bodies = [...(state._visibleMobiles ?? [])].slice(0, 128)
      .map((serial) => state.ctx.world.mobiles.get(serial)?.body).filter(Number.isFinite);
    sendNodeUOFeature(state, { feature: 'map.prefetch', kind: NodeUOJsonKind.Snapshot,
      delivery: NodeUODelivery.Latest, replace: 'map-prefetch',
      payload: { facet: state.mobile.map | 0, center: { x: centerX, y: centerY }, chunks,
        bodies: [...new Set(bodies)].slice(0, 64) } });
  }
  if (state.nodeUOJsonTransport) sendNodeUOFeature(state, {
    feature: 'flow.qos', kind: NodeUOJsonKind.Snapshot,
    payload: {
      softPendingBytes: state.backpressureLimits?.soft ?? 1024 * 1024,
      hardPendingBytes: state.backpressureLimits?.hard ?? 4 * 1024 * 1024,
      maxMessagesPerSecond: MAX_MESSAGES_PER_SECOND,
      policies: {
        reliable: 'ordered', latest: 'coalesced-under-pressure',
        'loss-tolerant': 'dropped-under-pressure',
      },
    },
  });
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Interface, namespace: 'nodeuo.ui', kind: NodeUOChannelMessage.Snapshot,
    payload: { schema: 1, theme: settings.theme ?? state.ctx.config?.nodeUOTheme ?? { variables: {} },
      features: Object.fromEntries(state.nodeUOFeatures ?? []) },
  });
  const locale = String(state.language ?? state.mobile?.language ?? 'en').slice(0, 12).toLowerCase();
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Interface, namespace: 'nodeuo.localization', kind: NodeUOChannelMessage.Snapshot,
    payload: { locale, fallback: 'en', strings: settings.localization?.[locale] ?? state.ctx.config?.nodeUOLocalization?.[locale] ?? {} },
  });
  sendNodeUOChannel(state, {
    channel: NodeUOChannel.Interface, namespace: 'nodeuo.notice', kind: NodeUOChannelMessage.Notice,
    payload: { id: 'connected', level: 'info', title: state.ctx.config?.shardName ?? 'NodeUO',
      text: 'Enhanced NodeUO protocol active.', at: Date.now() },
  });
  issueResume(state);
  const url = String(settings.webTransportUrl ?? state.ctx.config?.nodeUOWebTransportUrl ?? '').trim();
  if (url) sendNodeUOChannel(state, {
    channel: NodeUOChannel.Control, namespace: 'nodeuo.transport', kind: NodeUOChannelMessage.Snapshot,
    payload: { url, mode: 'webtransport-h3', fallback: 'websocket', optional: true },
  });
  return true;
}

export function vendorSearch(state, payload, vendors) {
  const serial = Number(payload?.vendorSerial) >>> 0;
  const actor = state.mobile;
  if (!actor) return { ok: false, error: 'player unavailable', entries: [] };
  const sources = serial ? [[serial, vendors?.get?.(serial)]] : [...(vendors?.entries?.() ?? [])];
  const query = String(payload?.query ?? '').trim().toLowerCase().slice(0, 128);
  const category = String(payload?.kind ?? '').trim().toLowerCase().slice(0, 32);
  const property = String(payload?.property ?? '').trim().toLowerCase().slice(0, 64);
  const minPrice = Math.max(0, Number(payload?.minPrice) | 0);
  const maxPrice = Math.max(0, Number(payload?.maxPrice) | 0);
  const offset = Math.max(0, Number(payload?.offset) | 0);
  const limit = Math.max(1, Math.min(100, Number(payload?.limit) | 0 || 40));
  const rows = [];
  for (const [vendorSerial, cfg] of sources.slice(0, 4096)) {
    const vendor = state.ctx.world.mobiles.get(vendorSerial >>> 0);
    if (!vendor || (serial && (vendor.map !== actor.map
        || Math.max(Math.abs(vendor.x - actor.x), Math.abs(vendor.y - actor.y)) > 12))) continue;
    const stock = typeof cfg?.listStock === 'function' ? cfg.listStock() : cfg?.buyStock;
    for (const entry of Array.isArray(stock) ? stock : []) {
      const text = `${entry.name ?? entry.description ?? ''} ${entry.itemId ?? ''}`.toLowerCase();
      const price = Math.max(0, entry.price | 0);
      const props = Array.isArray(entry.properties) ? entry.properties.join(' ').toLowerCase() : String(entry.property ?? '').toLowerCase();
      if ((query && !text.includes(query)) || (category && String(entry.kind ?? entry.category ?? '').toLowerCase() !== category)
          || (property && !props.includes(property)) || price < minPrice || (maxPrice && price > maxPrice)) continue;
      rows.push({ vendorSerial: vendor.serial, vendorName: String(vendor.name ?? '').slice(0, 128),
        x: vendor.x | 0, y: vendor.y | 0, map: vendor.map | 0,
        serial: entry.serial >>> 0, itemId: entry.itemId | 0, hue: entry.hue | 0,
        amount: Math.max(0, entry.amount | 0), price,
        name: String(entry.name ?? entry.description ?? '').slice(0, 256) });
      if (rows.length >= 10_000) break;
    }
    if (rows.length >= 10_000) break;
  }
  const sort = String(payload?.sort ?? 'asc');
  rows.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
    : sort === 'desc' ? (a, b) => b.price - a.price : (a, b) => a.price - b.price);
  return { ok: true, vendorSerial: serial || null, offset, limit, total: rows.length,
    truncated: rows.length >= 10_000, entries: rows.slice(offset, offset + limit) };
}

function structuredProperties(state, serialLike) {
  const serial = Number(serialLike) >>> 0;
  const source = state.ctx.propertyProvider?.(serial, state);
  if (!source) return { ok: false, serial, entries: [] };
  return { ok: true, serial, hash: source.hash ?? null,
    entries: (source.entries ?? []).slice(0, 128).map((entry) => ({
      cliloc: Number(entry.cliloc) >>> 0, args: String(entry.args ?? '').slice(0, 2048),
    })) };
}

function sanitizeDiagnostics(payload) {
  const metric = (value, max) => Math.max(0, Math.min(max, Number(value) || 0));
  return {
    at: Date.now(), fps: metric(payload?.fps, 1000), frameP95Ms: metric(payload?.frameP95Ms, 60_000),
    heapUsedBytes: metric(payload?.heapUsedBytes, 64 * 1024 ** 3), gpuBytes: metric(payload?.gpuBytes, 64 * 1024 ** 3),
    decodeQueue: metric(payload?.decodeQueue, 1_000_000), bufferedBytes: metric(payload?.bufferedBytes, 64 * 1024 ** 3),
  };
}

function sendJsonResult(state, request, payload, { error = false, revision } = {}) {
  error ||= isNodeUOError(payload);
  const context = currentNodeUORequestContext();
  const source = payload && typeof payload === 'object' ? payload : { error: payload };
  const errorPayload = error ? {
    ...createNodeUOError(source.code ?? NodeUOErrorCode.Internal,
      source.error ?? source.message ?? 'request failed', {
        retryable: source.retryable, retryAfterMs: source.retryAfterMs,
        details: source.details, recovery: source.recovery,
        traceId: request.traceId ?? context?.traceId,
        correlationId: request.correlationId ?? context?.correlationId,
      }),
    ...source,
  } : null;
  const sent = sendNodeUOFeature(state, {
    feature: request.feature,
    kind: error ? NodeUOJsonKind.Error : NodeUOJsonKind.Result,
    replyTo: request.id,
    revision,
    priority: error ? NodeUOPriority.High : NodeUOPriority.Normal,
    payload: error ? errorPayload : (payload ?? {}),
    traceId: request.traceId ?? context?.traceId,
    correlationId: request.correlationId ?? context?.correlationId,
    causationId: request.id ?? context?.causationId,
    transactionId: request.transactionId ?? context?.transactionId,
  });
  finishNodeUORequestContext(error ? 'error' : 'handled', error ? errorPayload.error : null);
  return sent;
}

function negotiatedManifest(state) {
  return buildNodeUOManifest([...state.nodeUOFeatures].map(([id, version]) => ({
    id, minimum: version, maximum: version,
  })));
}

function componentRepairSnapshot(state, payload = {}) {
  const requested = [...new Set((Array.isArray(payload.serials) ? payload.serials : [])
    .map((serial) => Number(serial) >>> 0).filter(Boolean))].slice(0, 64);
  const serials = requested.length ? requested : [state.mobile?.serial >>> 0].filter(Boolean);
  const subscription = normalizeSubscription({
    target: 'world.components', components: payload.components, fields: payload.fields,
    maxEntities: Math.min(64, serials.length || 1), rateHz: 30,
  });
  const entities = [];
  for (const serial of serials) {
    const mobile = state.ctx.world?.mobiles?.get?.(serial);
    const item = state.ctx.world?.items?.get?.(serial);
    if (!mobile && !item) continue;
    const visible = serial === (state.mobile?.serial >>> 0)
      || (mobile ? state._visibleMobiles?.has?.(serial) : state._visibleItems?.has?.(serial));
    if (!visible) continue;
    const entity = mobile ?? item;
    const mask = mobile
      ? NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Vitals | NodeUOWorldField.Status
      : NodeUOWorldField.Position | NodeUOWorldField.Appearance | NodeUOWorldField.Parent;
    entities.push(componentEntityRow(entityDeltaRow(entity, mask, mobile ? 'mobile' : 'item'),
      state.ctx.world?.interest?.revision?.(serial) ?? 0, subscription));
  }
  return { ok: true, baseline: state._nodeUOWorld?.baseline ?? 0, entities };
}

function rememberIdempotent(state, key, value) {
  if (!key) return;
  state._nodeUOIdempotency ??= new Map();
  state._nodeUOIdempotency.delete(key);
  state._nodeUOIdempotency.set(key, value);
  while (state._nodeUOIdempotency.size > 512) state._nodeUOIdempotency.delete(state._nodeUOIdempotency.keys().next().value);
}

function resolveFeaturePayload(state, message, vendors, rpcContext = null) {
  if (message.feature === 'vendor.search') return vendorSearch(state, message.payload, vendors);
  if (message.feature === 'properties.structured') {
    const serials = Array.isArray(message.payload?.serials)
      ? message.payload.serials.slice(0, 64) : [message.payload?.serial];
    const results = serials.map((serial) => structuredProperties(state, serial));
    return serials.length === 1 ? results[0] : { ok: true, results };
  }
  if (message.feature === 'quest.journal') return cleanQuestSnapshot(state);
  if (message.feature === 'assets.streaming' || message.feature === 'assets.content-addressed'
      || message.feature === 'assets.chunks') return assetManifest();
  if (message.feature === 'social.state') return partySnapshot(state);
  if (message.feature === 'mods.channels') {
    const namespace = String(message.payload?.namespace ?? '').slice(0, 64);
    return invokeModChannel(namespace, state, { payload: message.payload?.data ?? {}, requestId: message.id,
      signal: rpcContext?.signal, progress: rpcContext?.progress });
  }
  if (message.feature.startsWith('mod.') || message.feature.startsWith('nodeuo.')) {
    return invokeModChannel(message.feature, state, { payload: message.payload, requestId: message.id,
      signal: rpcContext?.signal, progress: rpcContext?.progress });
  }
  if (typeof state.ctx.handleNodeUOFeatureRequest === 'function') {
    return state.ctx.handleNodeUOFeatureRequest(state, message, rpcContext);
  }
  return undefined;
}

/** Native inbound v2 dispatcher. Every request remains server-authoritative;
 * JSON is a transport/schema choice, never permission to mutate world data. */
export function handleNodeUOJsonMessage(state, message, { vendors } = {}) {
  if (!state?.nodeUOJsonTransport || !state.nodeUOProtocol || !rateAllowed(state)) return false;
  if (!state.supportsNodeUO?.(message.feature)) return false;

  if (message.deadlineAt != null && Date.now() > message.deadlineAt) {
    return sendJsonResult(state, message, createNodeUOError(NodeUOErrorCode.Timeout,
      'request deadline elapsed before dispatch', { recovery: 'retry' }), { error: true });
  }

  if (message.preconditions && state.supportsNodeUO?.('protocol.preconditions')) {
    const currentRevision = state._nodeUOFeatureRevisions?.get?.(message.feature) ?? 0;
    const current = {
      revision: currentRevision,
      inWorld: state.stage === 'inWorld',
      alive: state.mobile ? state.mobile.dead !== true : false,
      mobileSerial: state.mobile?.serial >>> 0,
      map: state.mobile?.map ?? null,
    };
    const checked = checkNodeUOPreconditions(message.preconditions, current);
    if (!checked.ok) return sendJsonResult(state, message,
      createNodeUOError(NodeUOErrorCode.PreconditionsFailed, 'request preconditions failed', {
        details: checked.failed, recovery: 'refresh-state',
      }), { error: true, revision: currentRevision });
  }

  const selectedVersion = state.nodeUOFeatures?.get?.(message.feature);
  if (selectedVersion && Number(message.featureVersion) > selectedVersion) {
    if (message.kind === NodeUOJsonKind.Request) return sendJsonResult(state, message, {
      ok: false, code: 'unsupported', error: `feature version ${message.featureVersion} exceeds negotiated v${selectedVersion}`,
    }, { error: true });
    return false;
  }

  if (message.kind === NodeUOJsonKind.Request || message.kind === NodeUOJsonKind.Subscribe
      || message.kind === NodeUOJsonKind.Unsubscribe) {
    const validation = validateFeaturePayload(message.feature, message.payload);
    if (!validation.ok) return sendJsonResult(state, message, {
      ok: false, code: 'invalid-argument', error: 'payload does not match the negotiated feature schema',
      details: validation.errors,
    }, { error: true });
  }

  if (message.kind === NodeUOJsonKind.Ack) {
    if (message.feature === 'world.delta' || message.feature === 'world.components'
        || message.feature === 'world.progressive-snapshot') {
      const sync = state._nodeUOWorld;
      const baseline = Number(message.payload?.baseline) >>> 0;
      if (sync && baseline === sync.baseline) {
        sync.acknowledged = Math.max(sync.acknowledged, Number(message.ack) || 0);
        sync.ready = sync.acknowledged >= sync.finalSequence;
      }
    } else {
      state._nodeUOChannelAcks ??= new Map();
      state._nodeUOChannelAcks.set(message.feature, Number(message.ack) || 0);
    }
    const acknowledged = Number(message.ack) || 0;
    for (const [key, pending] of state._nodeUOPendingAcks ?? []) {
      if (pending.feature === message.feature && pending.seq <= acknowledged) state._nodeUOPendingAcks.delete(key);
    }
    finishNodeUORequestContext('handled');
    return true;
  }

  if (message.feature === 'protocol.manifest' && message.kind === NodeUOJsonKind.Request) {
    return sendJsonResult(state, message, negotiatedManifest(state));
  }
  if (message.feature === 'protocol.schema-registry' && message.kind === NodeUOJsonKind.Request) {
    const requested = String(message.payload?.feature ?? '').trim();
    const ids = requested ? [requested] : [...state.nodeUOFeatures.keys()];
    const manifest = negotiatedManifest(state);
    const fingerprints = new Map(manifest.features.map((entry) => [entry.id, entry.schema]));
    const schemas = ids.filter((id) => state.nodeUOFeatures.has(id)).slice(0, 256)
      .map((id) => ({ feature: id, fingerprint: fingerprints.get(id), document: schemaDocumentForFeature(id) }));
    return sendJsonResult(state, message, { ok: true, dialect: NODEUO_JSON_SCHEMA_DIALECT,
      version: NODEUO_SCHEMA_VERSION, schemas });
  }
  if (message.feature === 'world.progressive-snapshot' && message.kind === NodeUOJsonKind.Request) {
    const radius = Math.max(4, Math.min(64, Number(message.payload?.radius) | 0 || 32));
    const result = sendNodeUOProgressiveSnapshot(state, { radii: [8, 18, radius] });
    return sendJsonResult(state, message, result || { ok: false, error: 'progressive snapshot unavailable' },
      { error: !result });
  }
  if (message.feature === 'world.sector-stream' && message.kind === NodeUOJsonKind.Request) {
    const radius = Math.max(8, Math.min(64, Number(message.payload?.radius) | 0 || 24));
    const sectorKeys = state.ctx.world.sectors.sectorKeysNear(
      state.mobile.map, state.mobile.x, state.mobile.y, radius,
    );
    const result = state.ctx.world.interest.changesSince(message.payload?.cursor, { sectorKeys, limit: 2048 });
    const entities = [];
    for (const change of result.changes) {
      const entity = state.ctx.world.mobiles.get(change.serial) ?? state.ctx.world.items.get(change.serial);
      if (!entity) {
        if ((change.mask & EntityDirty.Removed) && state._nodeUOWorldKnown?.has(change.serial)) {
          const removed = { serial: change.serial, type: change.kind, removed: true };
          removed.stateHash = `fnv1a64:${stableJsonFingerprint(removed)}`;
          entities.push(removed);
          state._nodeUOWorldKnown.delete(change.serial);
        }
        continue;
      }
      if (!visibleTo(state, change.serial, change.kind)) continue;
      const mask = wireMaskForChange(change.mask, entity);
      if (mask) entities.push(componentEntityRow(entityDeltaRow(entity, mask, change.kind),
        change.revision, worldSubscription(state), state.mobile));
    }
    return sendJsonResult(state, message, { ok: true, cursor: result.cursor,
      resetRequired: result.resetRequired, sectors: sectorKeys.length, entities });
  }
  if (message.feature === 'protocol.subscriptions'
      && (message.kind === NodeUOJsonKind.Request || message.kind === NodeUOJsonKind.Subscribe
        || message.kind === NodeUOJsonKind.Unsubscribe)) {
    const target = String(message.payload?.target ?? '').trim().toLowerCase();
    if (!target || !state.nodeUOFeatures.has(target)) {
      return sendJsonResult(state, message, { error: 'subscription target is not negotiated' }, { error: true });
    }
    state._nodeUOSubscriptions ??= new Map();
    const remove = message.kind === NodeUOJsonKind.Unsubscribe || message.payload?.operation === 'remove';
    if (remove) {
      state._nodeUOSubscriptions.delete(target);
      state.nodeUOBandwidth?.configure?.(state.ctx.nodeUOSettings?.value?.network ?? {});
    }
    else {
      let subscription;
      try { subscription = normalizeSubscription(message.payload); }
      catch (error) { return sendJsonResult(state, message, { error: error.message }, { error: true }); }
      state._nodeUOSubscriptions.set(target, subscription);
      if (subscription.maxBytesPerSecond) {
        const configured = state.ctx.nodeUOSettings?.value?.network ?? {};
        state.nodeUOBandwidth?.configure?.({ ...configured,
          bytesPerSecond: Math.min(configured.bytesPerSecond ?? 512 * 1024,
            subscription.maxBytesPerSecond) });
      }
    }
    const active = [...state._nodeUOSubscriptions.values()];
    sendJsonResult(state, message, { ok: true, target, removed: remove, active });
    if (target === 'world.components' || target === 'world.delta') sendNodeUOWorldSnapshot(state);
    return true;
  }
  if (message.feature === 'protocol.state-repair' && message.kind === NodeUOJsonKind.Request) {
    return sendJsonResult(state, message, componentRepairSnapshot(state, message.payload));
  }

  if ((message.feature === 'world.delta' || message.feature === 'world.components')
      && message.kind === NodeUOJsonKind.Request
      && message.payload?.operation === 'resync') {
    if (state._nodeUOWorld) state._nodeUOWorld.resyncs++;
    sendNodeUOWorldSnapshot(state);
    finishNodeUORequestContext('handled');
    return true;
  }
  if (message.feature === 'diagnostics.live') {
    state.nodeUOClientDiagnostics = sanitizeDiagnostics(message.payload);
    finishNodeUORequestContext('handled');
    return true;
  }
  if (message.feature === 'clock.sync' && message.kind === NodeUOJsonKind.Request) {
    const receivedAt = Date.now();
    return sendJsonResult(state, message, {
      clientSentAt: Number(message.payload?.clientSentAt) || 0,
      serverReceivedAt: receivedAt,
      serverSentAt: Date.now(),
      serverTick: state.ctx.world?.tick ?? null,
    });
  }
  if (message.feature === 'flow.qos' && message.kind === NodeUOJsonKind.Request) {
    state._nodeUOClientFlow = sanitizeDiagnostics(message.payload);
    const pendingBytes = Number(state.ws?.bufferedAmount) || 0;
    const softPendingBytes = state.backpressureLimits?.soft ?? 1024 * 1024;
    const budget = state.nodeUOBandwidth?.snapshot?.() ?? null;
    return sendJsonResult(state, message, {
      pendingBytes,
      pressure: pendingBytes > softPendingBytes ? 'high' : budget?.pressure ?? 'normal',
      recommendedHz: pendingBytes > softPendingBytes || budget?.pressure === 'critical'
        ? 10 : budget?.pressure === 'high' || (state.roundTripMs ?? 0) > 250 ? 20 : 30,
      unacknowledged: state._nodeUOPendingAcks?.size ?? 0,
      bandwidth: budget,
    });
  }
  if (message.feature === 'session.resume' && message.kind === NodeUOJsonKind.Resume) {
    const token = String(message.payload?.token ?? '');
    const result = consumeResume(state, token, message.payload);
    sendJsonResult(state, message, result);
    if (result.ok) issueResume(state);
    return true;
  }
  if (message.feature === 'protocol.rpc') {
    return dispatchNodeUORpc(state, message, {
      send: (request, payload, error) => sendJsonResult(state, request, payload, { error }),
      resolve: (request, context) => {
        const revisions = state._nodeUOFeatureRevisions ??= new Map();
        const currentRevision = revisions.get(request.targetFeature) ?? 0;
        if (message.expectedRevision != null && message.expectedRevision !== currentRevision) {
          return { ok: false, code: 'conflict', error: 'revision conflict',
            details: { currentRevision } };
        }
        const target = {
          ...message,
          kind: NodeUOJsonKind.Request,
          feature: request.targetFeature,
          payload: { ...request.params, operation: request.method },
        };
        const result = resolveFeaturePayload(state, target, vendors, context);
        if (result === undefined) {
          return { ok: false, code: 'unsupported', error: `unsupported RPC target: ${request.targetFeature}` };
        }
        return Promise.resolve(result).then((resolved) => {
          if (message.idempotencyKey && resolved?.ok !== false) {
            revisions.set(request.targetFeature, currentRevision + 1);
          }
          return resolved;
        });
      },
    });
  }
  if (message.kind !== NodeUOJsonKind.Request && message.kind !== NodeUOJsonKind.Event
      && message.kind !== NodeUOJsonKind.Subscribe && message.kind !== NodeUOJsonKind.Unsubscribe) return false;

  const dedupeKey = message.idempotencyKey ? `${state.accountName}:${message.feature}:${message.idempotencyKey}` : '';
  const cached = dedupeKey && state._nodeUOIdempotency?.get(dedupeKey);
  if (cached) {
    if (message.kind === NodeUOJsonKind.Request) {
      sendJsonResult(state, message, cached.payload, { revision: cached.revision });
    } else finishNodeUORequestContext('deduplicated');
    return true;
  }
  const inFlight = dedupeKey && state._nodeUOInFlight?.get(dedupeKey);
  if (inFlight) {
    if (message.kind === NodeUOJsonKind.Request) inFlight.then((result) => {
      sendJsonResult(state, message, result.payload, { revision: result.revision });
    }, (error) => sendJsonResult(state, message, { error: error?.message ?? error }, { error: true }));
    else finishNodeUORequestContext('coalesced');
    return true;
  }
  const revisions = state._nodeUOFeatureRevisions ??= new Map();
  const currentRevision = revisions.get(message.feature) ?? 0;
  if (message.expectedRevision != null && message.expectedRevision !== currentRevision) {
    sendJsonResult(state, message, { error: 'revision conflict', currentRevision }, { error: true, revision: currentRevision });
    return true;
  }

  const payload = resolveFeaturePayload(state, message, vendors);
  if (payload === undefined) return false;

  const task = Promise.resolve(payload).then((resolved) => {
    const mutating = !!message.idempotencyKey && resolved?.ok !== false;
    const revision = mutating ? currentRevision + 1 : currentRevision;
    if (mutating) revisions.set(message.feature, revision);
    rememberIdempotent(state, dedupeKey, { payload: resolved ?? {}, revision });
    return { payload: resolved ?? {}, revision };
  });
  if (dedupeKey) {
    state._nodeUOInFlight ??= new Map();
    state._nodeUOInFlight.set(dedupeKey, task);
  }
  task.then((result) => {
    if (message.kind === NodeUOJsonKind.Request) {
      sendJsonResult(state, message, result.payload, { revision: result.revision });
    } else finishNodeUORequestContext('handled');
  }).catch((error) => {
    if (message.kind === NodeUOJsonKind.Request) {
      sendJsonResult(state, message, { error: error?.message ?? error }, { error: true, revision: currentRevision });
    } else {
      finishNodeUORequestContext('error', error);
      console.warn(`[nodeuo-json] ${message.feature} event failed: ${error?.message ?? error}`);
    }
  }).finally(() => {
    if (dedupeKey && state._nodeUOInFlight?.get(dedupeKey) === task) state._nodeUOInFlight.delete(dedupeKey);
  });
  return true;
}

export function broadcastNodeUOChannel(connections, options) {
  let sent = 0;
  for (const state of connections ?? []) if (sendNodeUOChannel(state, options)) sent++;
  return sent;
}

export function notifyNodeUOAssetChanged(connections, changed) {
  const payload = { ...assetManifest(), changed: [].concat(changed ?? []).slice(0, 256) };
  let sent = 0;
  for (const state of connections ?? []) {
    const feature = state.nodeUOJsonTransport && state.supportsNodeUO?.('assets.content-addressed')
      ? 'assets.content-addressed' : undefined;
    sent += !!sendNodeUOChannel(state, {
      channel: NodeUOChannel.Assets, namespace: 'nodeuo.assets', feature,
      kind: NodeUOChannelMessage.Delta, flags: NodeUOChannelFlag.AckRequired, payload,
    });
  }
  return sent;
}

export function broadcastNodeUOSettings(connections, settings) {
  const value = settings?.snapshot?.() ?? settings ?? {};
  let sent = 0;
  for (const state of connections ?? []) {
    state.nodeUOBandwidth?.configure?.(value.network);
    sent += !!sendNodeUOChannel(state, { channel: NodeUOChannel.Interface, namespace: 'nodeuo.ui',
      kind: NodeUOChannelMessage.Snapshot, flags: NodeUOChannelFlag.Replace,
      payload: { schema: 1, theme: value.theme ?? { variables: {} },
        features: Object.fromEntries(state.nodeUOFeatures ?? []) } });
    const locale = String(state.language ?? state.mobile?.language ?? 'en').slice(0, 12).toLowerCase();
    sent += !!sendNodeUOChannel(state, { channel: NodeUOChannel.Interface, namespace: 'nodeuo.localization',
      kind: NodeUOChannelMessage.Snapshot, flags: NodeUOChannelFlag.Replace,
      payload: { locale, fallback: 'en', strings: value.localization?.[locale] ?? {} } });
    const url = String(value.webTransportUrl ?? '').trim();
    sent += !!sendNodeUOChannel(state, { channel: NodeUOChannel.Control, namespace: 'nodeuo.transport',
      kind: NodeUOChannelMessage.Snapshot, flags: NodeUOChannelFlag.Replace,
      payload: { url, mode: 'webtransport-h3', fallback: 'websocket', optional: !!url } });
  }
  return sent;
}

export function trySendNodeUOCombatDamage(state, { target, source = null, amount, damageType } = {}) {
  if (!target) return false;
  return !!sendNodeUOChannel(state, {
    channel: NodeUOChannel.Combat, namespace: 'nodeuo.combat',
    kind: NodeUOChannelMessage.Event, flags: NodeUOChannelFlag.LossTolerant,
    payload: {
      event: 'damage', target: target.serial >>> 0, source: source?.serial >>> 0 || 0,
      amount: Math.max(0, amount | 0), hp: Math.max(0, target.hp | 0),
      hpMax: Math.max(1, target.hpMax | 0), damageType: String(damageType ?? 'physical').slice(0, 32),
      at: Date.now(),
    },
  });
}

function containerRow(item) {
  return {
    serial: item?.serial >>> 0, itemId: item?.itemId | 0, amount: Math.max(1, item?.amount | 0),
    hue: item?.hue | 0, gridX: item?.gridX | 0, gridY: item?.gridY | 0,
    gridLocation: item?.gridLocation | 0, layer: item?.layer | 0,
  };
}

export function trySendNodeUOContainer(state, {
  container, snapshot = false, items = [], upserted = [], removed = [],
} = {}) {
  const parent = Number(container) >>> 0;
  if (!parent) return false;
  return !!sendNodeUOChannel(state, {
    channel: NodeUOChannel.Interface, namespace: 'nodeuo.container',
    kind: snapshot ? NodeUOChannelMessage.Snapshot : NodeUOChannelMessage.Delta,
    flags: NodeUOChannelFlag.AckRequired,
    payload: snapshot
      ? { container: parent, items: items.slice(0, 2048).map(containerRow) }
      : { container: parent, upserted: upserted.slice(0, 512).map(containerRow),
        removed: removed.slice(0, 512).map((serial) => Number(serial) >>> 0).filter(Boolean) },
  });
}

function classicSemanticAction(mob, semantic) {
  const human = (mob?.body | 0) >= 0x190 && (mob?.body | 0) <= 0x3ff;
  const table = human
    ? { walk: 0, run: 2, idle: 4, attack: 9, cast: 16, getHit: 20, die1: 21, die2: 22 }
    : { walk: 0, run: 0, idle: 1, attack: 4, cast: 4, getHit: 13, die1: 2, die2: 3 };
  return table[semantic] ?? table.idle;
}

/** Semantic animation for NodeUO clients with a canonical 0x6E fallback for
 * every classic viewer in range. */
export function broadcastNodeUOSemanticAnimation(world, mob, action, options = {}) {
  const semantic = String(action ?? '').trim();
  if (!mob || !semantic) return 0;
  const classicAction = Number.isFinite(options.classicAction)
    ? options.classicAction | 0 : classicSemanticAction(mob, semantic);
  const fallback = playerAnimation({ serial: mob.serial, action: classicAction,
    frameCount: options.frameCount, repeatCount: options.repeatCount,
    reverse: options.reverse, repeat: options.repeat, delay: options.delay });
  const recipients = [...nearbyClients(world, mob, mob)];
  if (mob.client) recipients.push(mob);
  let sent = 0;
  for (const viewer of recipients) {
    const enhanced = sendNodeUOChannel(viewer.client, {
      channel: NodeUOChannel.Combat, namespace: 'nodeuo.animation',
      kind: NodeUOChannelMessage.Event, flags: NodeUOChannelFlag.LossTolerant,
      payload: { serial: mob.serial, action: semantic, frameCount: options.frameCount,
        repeatCount: options.repeatCount ?? 1, delayMs: options.delayMs ?? options.delay,
        reverse: !!options.reverse },
    });
    if (!enhanced) viewer.client?.send?.(fallback);
    sent++;
  }
  return sent;
}

function roleFor(state) {
  return String(state?.account?.accessLevel ?? 'player').trim().toLowerCase();
}

function modAllowed(entry, state) {
  return !entry.roles.length || entry.roles.includes(roleFor(state));
}

function invokeModChannel(namespace, state, context) {
  const entry = modChannels.get(String(namespace));
  if (!entry) return { ok: false, error: 'unknown mod namespace' };
  if (!modAllowed(entry, state)) return { ok: false, error: 'mod permission denied' };
  return entry.handler({ state, ...context });
}

export function nodeUOModPermissionManifest(state) {
  return [...modChannels.entries()].filter(([, entry]) => modAllowed(entry, state))
    .map(([namespace, entry]) => ({ namespace, version: entry.version,
      permissions: [...entry.permissions], roles: [...entry.roles], description: entry.description }));
}

export function registerNodeUOMod(namespace, handler, options = {}) {
  const key = String(namespace ?? '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(key) || !key.includes('.') || typeof handler !== 'function') {
    throw new TypeError('mod channel requires a namespaced id and handler');
  }
  const safeNames = (source, max) => [...new Set((Array.isArray(source) ? source : [])
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => /^[a-z][a-z0-9._-]{0,63}$/u.test(value)))].slice(0, max);
  modChannels.set(key, Object.freeze({ handler,
    version: Math.max(1, Math.min(0xffff, Number(options.version) | 0 || 1)),
    permissions: Object.freeze(safeNames(options.permissions, 32)),
    roles: Object.freeze(safeNames(options.roles, 16)),
    description: String(options.description ?? '').slice(0, 256),
  }));
  return () => modChannels.delete(key);
}

registerNodeUOMod('nodeuo.core', ({ state, payload }) => ({
  ok: true, operation: String(payload?.operation ?? 'ping').slice(0, 32),
  serverTime: Date.now(), playerSerial: state.mobile?.serial >>> 0,
  protocol: state.nodeUOProtocol, features: Object.fromEntries(state.nodeUOFeatures ?? []),
}));

export function nodeUOModernDiagnostics(state) {
  return {
    world: state?._nodeUOWorld ? { ...state._nodeUOWorld } : null,
    rate: state?._nodeUOModernRate ? { ...state._nodeUOModernRate } : null,
    channelAcks: Object.fromEntries(state?._nodeUOChannelAcks ?? []),
    client: state?.nodeUOClientDiagnostics ?? null,
    bandwidth: state?.nodeUOBandwidth?.snapshot?.() ?? null,
    rpc: [...(state?._nodeUORpcTasks?.values?.() ?? [])].map((entry) => ({
      targetFeature: entry.request?.targetFeature,
      method: entry.request?.method,
      elapsedMs: Math.max(0, Date.now() - (entry.startedAt ?? Date.now())),
    })),
  };
}
