import {
  NodeUOChannel,
  NodeUOChannelFlag,
  NodeUOChannelMessage,
  NodeUOFeature,
  NodeUOEntityType,
  NodeUOWorldDeltaKind,
  NodeUOWorldField,
  featureIdForNamespace,
  NodeUODelivery,
  NodeUOJsonKind,
  stableJsonFingerprint,
} from '@uo/nodeuo-protocol';
import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { walker } from '../managers/walker.js';
import { assets } from '../assets/asset-manager.js';

const cinematicTimers = new Map();

function playCinematic(net, payload) {
  const id = String(payload?.id ?? 'cinematic');
  for (const timer of cinematicTimers.get(id) ?? []) clearTimeout(timer);
  const timers = [];
  const serverNow = Date.now() + (net.nodeUOClock?.offsetMs ?? 0);
  const delay = Math.max(0, Number(payload?.serverStartsAt) - serverNow || 0);
  for (const cue of Array.isArray(payload?.cues) ? payload.cues.slice(0, 256) : []) {
    timers.push(setTimeout(() => {
      const event = { id, ...cue };
      bus.emit('cinematic:cue', event);
      if (cue.type === 'caption' && cue.text) bus.emit('message:journal', {
        name: 'Story', text: cue.text, textType: 1, hue: 0xffdf88,
      });
      else if (cue.type === 'camera-shake') bus.emit('camera:shake', {
        magnitude: Number(cue.value) || 4, durationMs: Number(cue.durationMs) || 500,
      });
      else if (cue.type === 'fade') bus.emit('cinematic:fade', event);
      else if (cue.type === 'music') bus.emit('music:play', { id: cue.asset ?? cue.value });
    }, delay + Math.max(0, Number(cue.atMs) || 0)));
  }
  cinematicTimers.set(id, timers);
  bus.emit('cinematic:start', { id, delayMs: delay, cues: payload?.cues ?? [] });
}

function modernState() {
  world.nodeUOModern ??= {
    sequences: new Map(), baselines: new Map(), channels: new Map(),
    properties: new Map(), containers: new Map(), notices: [],
    repairPending: new Set(),
  };
  return world.nodeUOModern;
}

function applyTheme(payload) {
  if (typeof document === 'undefined' || !payload?.variables || typeof payload.variables !== 'object') return;
  const allowed = new Set(['--uo-gold', '--uo-gold-bright', '--uo-copper', '--uo-ink', '--uo-slate', '--uo-muted', '--uo-text', '--uo-danger']);
  for (const [key, value] of Object.entries(payload.variables)) {
    const text = String(value ?? '').trim();
    if (allowed.has(key) && text.length <= 48 && /^#[0-9a-f]{3,8}$/i.test(text)) {
      document.documentElement.style.setProperty(key, text);
    }
  }
}

function applyContainer(message) {
  const payload = message.payload ?? {};
  const parent = Number(payload.container) >>> 0;
  if (!parent) return;
  if (message.kind === NodeUOChannelMessage.Snapshot && Array.isArray(payload.items)) {
    const committed = world.replaceContainerContents(parent, payload.items);
    if (committed.ok) bus.emit('container:contents', { containerSerial: parent, items: payload.items });
  } else if (message.kind === NodeUOChannelMessage.Delta) {
    for (const serial of payload.removed ?? []) world.removeEntity(Number(serial) >>> 0);
    for (const row of payload.upserted ?? []) {
      const item = world.ensureItem(Number(row?.serial) >>> 0);
      const old = { parent: item.parent, x: item.x, y: item.y, map: item.map };
      Object.assign(item, row, { parent });
      world.linkItemParent(item, old.parent);
      world.reindexItem(item, old.x, old.y, old.map, old.parent);
      bus.emit('item:placed', item);
      bus.emit('container:item-update', item);
    }
  }
  modernState().containers.set(parent, message.sequence);
  bus.emit('container:nodeuo-delta', { ...payload, sequence: message.sequence });
}

function dispatchChannel(message) {
  const state = modernState();
  state.channels.set(message.namespace || String(message.channel), message.payload);
  switch (message.namespace) {
    case 'nodeuo.timeline': {
      const p = message.payload ?? {};
      if (Number.isFinite(p.lightLevel)) {
        world.lightLevel = p.lightLevel | 0;
        bus.emit('atmosphere:light', { level: world.lightLevel, serverTime: p.serverTime });
      }
      if (Number.isFinite(p.season)) {
        world.season = p.season | 0;
        bus.emit('atmosphere:season', { season: world.season, playSound: false });
      }
      if (Number.isFinite(p.weather)) bus.emit('atmosphere:weather', {
        kind: p.weather | 0, intensity: p.intensity | 0, temperature: p.temperature | 0,
      });
      world.timeline = p;
      bus.emit('nodeuo:world-timeline', p);
      break;
    }
    case 'nodeuo.animation': {
      const p = message.payload ?? {};
      if (p.serial && typeof p.action === 'string') bus.emit('anim:custom', {
        serial: p.serial >>> 0, action: p.action, frameCount: p.frameCount,
        repeatCount: p.repeatCount ?? 1, delay: p.delayMs, reverse: !!p.reverse,
      });
      break;
    }
    case 'nodeuo.effects': {
      const p = message.payload ?? {};
      if (p.kind === 'particle') bus.emit('fx:particle', p);
      else if (p.kind === 'hued-short') bus.emit('fx:hued-short', p);
      else bus.emit('fx:graphic', p);
      break;
    }
    case 'nodeuo.combat': {
      const p = message.payload ?? {};
      if (p.event === 'damage' && p.target && p.amount > 0) {
        const target = world.ensureMobile(p.target >>> 0);
        target.hp = Math.max(0, Number(p.hp) | 0);
        target.hpMax = Math.max(1, Number(p.hpMax) | 0);
        const info = { serial: target.serial, source: p.source >>> 0, amount: p.amount | 0,
          current: target.hp, max: target.hpMax, damageType: p.damageType, at: p.at };
        bus.emit('mobile:hp', info);
        bus.emit('combat:damage', info);
        bus.emit('damage:apply', info);
      }
      bus.emit('nodeuo:combat-timeline', p);
      break;
    }
    case 'nodeuo.container': applyContainer(message); break;
    case 'nodeuo.properties': {
      const p = message.payload ?? {};
      for (const result of p.results ?? [p]) {
        if (!result?.serial) continue;
        state.properties.set(result.serial >>> 0, result);
        bus.emit('tooltip:lines', { serial: result.serial >>> 0, revision: result.hash, lines: result.entries ?? [] });
      }
      bus.emit('nodeuo:properties', p);
      break;
    }
    case 'nodeuo.vendor':
      world.vendorSearch = message.payload ?? {};
      bus.emit('nodeuo:vendor-search', world.vendorSearch);
      break;
    case 'nodeuo.quest':
      world.questJournal = message.payload ?? {};
      bus.emit('nodeuo:quest-journal', world.questJournal);
      break;
    case 'nodeuo.assets':
      world.assetManifest = message.payload ?? {};
      bus.emit(message.kind === NodeUOChannelMessage.Delta ? 'assets:hot-reload' : 'assets:manifest', world.assetManifest);
      break;
    case 'nodeuo.party':
      world.partyState = message.payload ?? {};
      bus.emit('party:update', world.partyState);
      break;
    case 'nodeuo.ui':
      world.structuredUi = message.payload ?? {};
      applyTheme(world.structuredUi.theme);
      bus.emit('nodeuo:structured-ui', world.structuredUi);
      break;
    case 'nodeuo.localization':
      world.nodeUOLocalization = message.payload ?? {};
      bus.emit('nodeuo:localization', world.nodeUOLocalization);
      break;
    case 'nodeuo.notice': {
      const notice = message.payload ?? {};
      state.notices.push(notice);
      if (state.notices.length > 32) state.notices.shift();
      bus.emit('nodeuo:notice', notice);
      if (notice.text) bus.emit('message:journal', {
        name: String(notice.title ?? 'Shard'), text: String(notice.text),
        textType: notice.level === 'error' ? 8 : 1, hue: notice.level === 'error' ? 0xff8080 : 0xd8af62,
      });
      break;
    }
    case 'nodeuo.resume': {
      const token = String(message.payload?.token ?? '');
      if (token && token.length <= 256) {
        try { sessionStorage.setItem('nodeuo.resume', token); } catch { /* unavailable */ }
      }
      world.resume = message.payload ?? {};
      bus.emit('nodeuo:resume', world.resume);
      break;
    }
    case 'nodeuo.transport':
      world.transportUpgrade = message.payload ?? {};
      bus.emit('nodeuo:transport-upgrade', world.transportUpgrade);
      break;
    default:
      bus.emit(`nodeuo:channel:${message.namespace || message.channel}`, message);
  }
}

const FEATURE_NAMESPACE = Object.freeze({
  'world.timeline': 'nodeuo.timeline', 'animation.semantic': 'nodeuo.animation',
  'effects.structured': 'nodeuo.effects', 'combat.timeline': 'nodeuo.combat',
  'container.delta': 'nodeuo.container', 'properties.structured': 'nodeuo.properties',
  'vendor.search': 'nodeuo.vendor', 'quest.journal': 'nodeuo.quest',
  'assets.streaming': 'nodeuo.assets', 'assets.content-addressed': 'nodeuo.assets',
  'social.state': 'nodeuo.party', 'ui.structured': 'nodeuo.ui',
  'localization.message-format': 'nodeuo.localization', 'session.resume': 'nodeuo.resume',
  'diagnostics.live': 'nodeuo.diagnostics', 'transport.webtransport': 'nodeuo.transport',
});

const JSON_CHANNEL_KIND = Object.freeze({
  [NodeUOJsonKind.Snapshot]: NodeUOChannelMessage.Snapshot,
  [NodeUOJsonKind.Delta]: NodeUOChannelMessage.Delta,
  [NodeUOJsonKind.Ack]: NodeUOChannelMessage.Ack,
  [NodeUOJsonKind.Request]: NodeUOChannelMessage.Request,
  [NodeUOJsonKind.Result]: NodeUOChannelMessage.Result,
  [NodeUOJsonKind.Event]: NodeUOChannelMessage.Event,
  [NodeUOJsonKind.Subscribe]: NodeUOChannelMessage.Subscribe,
  [NodeUOJsonKind.Unsubscribe]: NodeUOChannelMessage.Unsubscribe,
  [NodeUOJsonKind.Resume]: NodeUOChannelMessage.Resume,
  [NodeUOJsonKind.Notice]: NodeUOChannelMessage.Notice,
});

function applyNodeUOChannel(net, message, { acknowledge = true } = {}) {
  const state = modernState();
  const key = `${message.channel}:${message.namespace}`;
  const last = state.sequences.get(key) ?? 0;
  if (message.kind !== NodeUOChannelMessage.Snapshot && message.sequence && message.sequence <= last) return false;
  if (message.sequence) state.sequences.set(key, message.sequence);
  net._resolveNodeUOResponse?.(message);
  dispatchChannel(message);
  if (acknowledge && (message.flags & NodeUOChannelFlag.AckRequired) && message.sequence) {
    net.sendNodeUOMessage({
      kind: NodeUOJsonKind.Ack, feature: message.feature ?? featureIdForNamespace(message.namespace),
      ack: message.sequence, replyTo: message.requestId ? String(message.requestId) : undefined,
      payload: {},
    });
  }
  return true;
}

function applyWorldEntity(entity) {
  const serial = entity.serial >>> 0;
  if (entity.mask & NodeUOWorldField.Removed) {
    world.removeEntity(serial);
    bus.emit('entity:removed', { serial });
    return;
  }
  if (entity.entityType === NodeUOEntityType.Mobile) {
    const mob = world.ensureMobile(serial);
    const old = { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
    if (entity.mask & NodeUOWorldField.Position) assignDefined(mob, entity,
      { x: 'x', y: 'y', z: 'z', map: 'map', direction: 'direction' });
    if (entity.mask & NodeUOWorldField.Appearance) assignDefined(mob, entity,
      { artId: 'body', hue: 'hue', flags: 'flags', notoriety: 'notoriety' });
    if (entity.mask & NodeUOWorldField.Vitals) assignDefined(mob, entity, {
      hp: 'hp', hpMax: 'hpMax', mana: 'mana', manaMax: 'manaMax',
      stam: 'stam', stamMax: 'stamMax',
    });
    if (entity.mask & NodeUOWorldField.Vitals) {
      if (entity.mana !== undefined) mob.mp = entity.mana;
      if (entity.manaMax !== undefined) mob.mpMax = entity.manaMax;
      if (entity.stam !== undefined) mob.st = entity.stam;
      if (entity.stamMax !== undefined) mob.stMax = entity.stamMax;
    }
    if (entity.mask & NodeUOWorldField.Status) {
      if (entity.componentStatus) assignDefined(mob, entity.componentStatus, {
        dead: 'dead', hidden: 'hidden', poisoned: 'poisoned', frozen: 'frozen',
        invulnerable: 'invulnerable',
      });
      else Object.assign(mob, {
        dead: !!(entity.statusBits & 1), hidden: !!(entity.statusBits & 2),
        poisoned: !!(entity.statusBits & 4), frozen: !!(entity.statusBits & 8),
        invulnerable: !!(entity.statusBits & 16),
      });
    }
    world.reindexMobile(mob, old.x, old.y, old.map);
    if (old.x !== mob.x || old.y !== mob.y || old.z !== mob.z) bus.emit('mobile:moving', mob);
    else bus.emit('mobile:update', mob);
    if (entity.mask & NodeUOWorldField.Vitals) {
      bus.emit('mobile:hp', { serial, current: mob.hp, max: mob.hpMax });
      bus.emit('mobile:mana', { serial, current: mob.mana, max: mob.manaMax });
      bus.emit('mobile:stamina', { serial, current: mob.stam, max: mob.stamMax });
    }
    return;
  }
  if (entity.entityType === NodeUOEntityType.Item) {
    const item = world.ensureItem(serial);
    const old = { x: item.x, y: item.y, map: item.map, parent: item.parent };
    if (entity.mask & NodeUOWorldField.Position) assignDefined(item, entity,
      { x: 'x', y: 'y', z: 'z', map: 'map', direction: 'direction' });
    if (entity.mask & NodeUOWorldField.Appearance) assignDefined(item, entity,
      { artId: 'itemId', hue: 'hue', flags: 'flags', amount: 'amount' });
    if (entity.mask & NodeUOWorldField.Parent) assignDefined(item, entity,
      { parent: 'parent', layer: 'layer' });
    world.linkItemParent(item, old.parent);
    world.reindexItem(item, old.x, old.y, old.map, old.parent);
    bus.emit('item:placed', item);
  }
}

function assignDefined(target, source, mapping) {
  for (const [from, to] of Object.entries(mapping)) {
    if (source[from] !== undefined) target[to] = source[from];
  }
}

function componentEntityToLegacy(entity) {
  const serial = Number(entity?.serial) >>> 0;
  if (entity?.removed) return { serial, entityType: NodeUOEntityType.Item, mask: NodeUOWorldField.Removed,
    revision: Number(entity.revision) >>> 0 };
  const components = entity?.components ?? {};
  let mask = 0;
  const row = { serial, entityType: entity?.type === 'mobile' ? NodeUOEntityType.Mobile : NodeUOEntityType.Item,
    revision: Number(entity?.revision) >>> 0 };
  if (components.position) {
    mask |= NodeUOWorldField.Position;
    Object.assign(row, components.position);
  }
  if (components.appearance) {
    mask |= NodeUOWorldField.Appearance;
    Object.assign(row, components.appearance);
  }
  if (components.vitals) {
    mask |= NodeUOWorldField.Vitals;
    Object.assign(row, components.vitals);
    if (components.vitals.stamina !== undefined) row.stam = components.vitals.stamina;
    if (components.vitals.staminaMax !== undefined) row.stamMax = components.vitals.staminaMax;
  }
  if (components.status) {
    mask |= NodeUOWorldField.Status;
    row.componentStatus = components.status;
    row.statusBits = (components.status.dead ? 1 : 0) | (components.status.hidden ? 2 : 0)
      | (components.status.poisoned ? 4 : 0) | (components.status.frozen ? 8 : 0)
      | (components.status.invulnerable ? 16 : 0);
  }
  if (components.containment) {
    mask |= NodeUOWorldField.Parent;
    row.parent = Number(components.containment.parent) >>> 0;
    row.layer = Number(components.containment.layer) | 0;
  }
  row.mask = mask;
  return row;
}

function validComponentHash(entity) {
  if (!entity?.stateHash) return true;
  const copy = { ...entity };
  delete copy.stateHash;
  return entity.stateHash === `fnv1a64:${stableJsonFingerprint(copy)}`;
}

function requestComponentRepair(net, entity) {
  const state = modernState();
  const serial = Number(entity?.serial) >>> 0;
  if (!serial || state.repairPending.has(serial)
      || !net.supportsNodeUO?.('protocol.state-repair')) return;
  state.repairPending.add(serial);
  void net.sendNodeUORequest({
    capability: 'protocol.state-repair', timeoutMs: 3000, ttlMs: 5000,
    payload: { serials: [serial], components: Object.keys(entity?.components ?? {}) },
  }).catch(() => {}).finally(() => state.repairPending.delete(serial));
}

function applyComponentRepair(payload) {
  const state = modernState();
  state.entityRevisions ??= new Map();
  const accepted = [];
  for (const entity of Array.isArray(payload?.entities) ? payload.entities : []) {
    if (!validComponentHash(entity)) continue;
    const row = componentEntityToLegacy(entity);
    accepted.push(row);
    if (row.revision) state.entityRevisions.set(row.serial, row.revision);
    state.worldEntities ??= new Set();
    if (row.mask & NodeUOWorldField.Removed) state.worldEntities.delete(row.serial);
    else state.worldEntities.add(row.serial);
  }
  world.batchSpatialMutations(() => { for (const entity of accepted) applyWorldEntity(entity); });
  bus.emit('nodeuo:state-repaired', { baseline: payload?.baseline, entities: accepted });
  return true;
}

function applyNodeUOWorldDelta(net, message) {
  const state = modernState();
  if (message.kind === NodeUOWorldDeltaKind.Snapshot) {
    if (state.worldBaseline !== message.baseline) {
      state.worldBaseline = message.baseline;
      state.worldSequence = 0;
      state.worldSnapshotPending = new Set();
      state.worldSnapshotPrevious = new Set(state.worldEntities ?? []);
      state.entityRevisions = new Map();
    }
    if (message.sequence <= state.worldSequence) return false;
    state.worldSequence = message.sequence;
    for (const entity of message.entities) state.worldSnapshotPending.add(entity.serial >>> 0);
  } else if (message.kind === NodeUOWorldDeltaKind.Delta) {
    if (message.baseline !== state.worldBaseline || message.sequence <= (state.worldSequence ?? 0)) {
      net.sendNodeUOMessage({
        kind: NodeUOJsonKind.Request, feature: message.feature ?? 'world.delta',
        payload: { operation: 'resync', baseline: state.worldBaseline ?? 0, acknowledge: state.worldSequence ?? 0 },
      });
      return false;
    }
    state.worldSequence = message.sequence;
  } else return false;
  const accepted = [];
  state.entityRevisions ??= new Map();
  for (const entity of message.entities) {
    const revision = Number(entity.revision) >>> 0;
    const previous = state.entityRevisions?.get?.(entity.serial >>> 0) ?? 0;
    if (revision && previous && revision < previous) continue;
    if (revision) state.entityRevisions.set(entity.serial >>> 0, revision);
    accepted.push(entity);
  }
  world.batchSpatialMutations(() => { for (const entity of accepted) applyWorldEntity(entity); });
  if (message.kind === NodeUOWorldDeltaKind.Snapshot && message.acknowledge
      && message.sequence >= message.acknowledge) {
    for (const serial of state.worldSnapshotPrevious) {
      if (!state.worldSnapshotPending.has(serial)) {
        world.removeEntity(serial);
        bus.emit('entity:removed', { serial });
      }
    }
    state.worldEntities = state.worldSnapshotPending;
    delete state.worldSnapshotPending;
    delete state.worldSnapshotPrevious;
  } else if (message.kind === NodeUOWorldDeltaKind.Delta) {
    state.worldEntities ??= new Set();
    for (const entity of message.entities) {
      if (entity.mask & NodeUOWorldField.Removed) state.worldEntities.delete(entity.serial >>> 0);
      else state.worldEntities.add(entity.serial >>> 0);
    }
  }
  net.sendNodeUOMessage({
    kind: NodeUOJsonKind.Ack, feature: message.feature ?? 'world.delta', ack: state.worldSequence,
    payload: { baseline: state.worldBaseline },
  });
  bus.emit('nodeuo:world-delta', message);
  return true;
}

/** Dispatch a native NodeUO v2 JSON envelope to feature consumers. */
export function handleNodeUOJsonMessage(net, message) {
  const payload = message.payload ?? {};
  if (message.feature === 'mods.channels') {
    const namespace = String(payload.namespace ?? '').slice(0, 64);
    if (!namespace) return false;
    return applyNodeUOChannel(net, {
      feature: message.feature, channel: NodeUOChannel.Mods, namespace,
      kind: JSON_CHANNEL_KIND[message.kind] ?? NodeUOChannelMessage.Event,
      flags: message.requiresAck ? NodeUOChannelFlag.AckRequired : 0,
      sequence: Number(message.seq) || 0, acknowledge: Number(message.ack) || 0,
      requestId: 0, payload: payload.data ?? {},
    });
  }
  if (message.feature === 'world.progressive-snapshot') {
    world.nodeUOProgressiveSnapshot = {
      baseline: Number(payload.baseline) >>> 0, phase: Number(payload.phase) || 0,
      complete: payload.complete === true,
    };
    bus.emit('nodeuo:progressive-snapshot', world.nodeUOProgressiveSnapshot);
    return applyNodeUOWorldDelta(net, {
      feature: 'world.progressive-snapshot', kind: NodeUOWorldDeltaKind.Snapshot,
      baseline: Number(payload.baseline) >>> 0,
      sequence: Number(message.seq) || Number(payload.sequence) || 0,
      acknowledge: Number(payload.finalSequence) || 0,
      entities: (Array.isArray(payload.entities) ? payload.entities : []).flatMap((entity) => {
        if (!validComponentHash(entity)) { requestComponentRepair(net, entity); return []; }
        return [componentEntityToLegacy(entity)];
      }),
    });
  }
  if (message.feature === 'world.sector-stream') {
    if (Array.isArray(payload.entities)) applyComponentRepair(payload);
    world.nodeUOSectorCursor = Math.max(Number(world.nodeUOSectorCursor) || 0, Number(payload.cursor) || 0);
    try { sessionStorage.setItem('nodeuo.world-sector.cursor', String(world.nodeUOSectorCursor)); }
    catch { /* storage can be disabled */ }
    bus.emit('nodeuo:sector-stream', payload);
    return true;
  }
  if (message.feature === 'world.delta' || message.feature === 'world.components') {
    const kind = message.kind === NodeUOJsonKind.Snapshot
      ? NodeUOWorldDeltaKind.Snapshot : NodeUOWorldDeltaKind.Delta;
    return applyNodeUOWorldDelta(net, {
      feature: message.feature,
      kind, baseline: Number(payload.baseline) >>> 0, sequence: Number(message.seq) || Number(payload.sequence) || 0,
      acknowledge: Number(payload.finalSequence) || 0,
      entities: (Array.isArray(payload.entities) ? payload.entities : []).flatMap((entity) => {
        if (message.feature !== 'world.components') return [entity];
        if (!validComponentHash(entity)) { requestComponentRepair(net, entity); return []; }
        return [componentEntityToLegacy(entity)];
      }),
    });
  }
  if (message.feature === 'protocol.state-repair' && Array.isArray(payload.entities)) {
    return applyComponentRepair(payload);
  }
  if (message.feature === 'protocol.manifest') {
    world.nodeUOManifest = payload;
    bus.emit('nodeuo:manifest', payload);
    return true;
  }
  if (message.feature === 'protocol.schema-registry') {
    world.nodeUOSchemaRegistry = payload;
    bus.emit('nodeuo:schema-registry', payload);
    return true;
  }
  if (message.feature === 'protocol.subscriptions') {
    world.nodeUOSubscriptions = payload;
    bus.emit('nodeuo:subscriptions', payload);
    return true;
  }
  if (message.feature === 'movement.hints') {
    const hint = payload.data ?? payload;
    if (world.player) world.player.encumbrance = hint;
    walker.setPaceMultiplier?.(Math.max(1, Number(hint.paceMultiplier) || 1));
    bus.emit('player:encumbrance', hint);
    return true;
  }
  if (message.feature === 'movement.reconciliation') {
    world.movementReconciliation = payload;
    bus.emit('movement:reconciliation', payload);
    return true;
  }
  const featureEvents = {
    'spell.composer': 'nodeuo:spell-composer',
    'character.specializations': 'nodeuo:specializations',
    'combat.cooldowns': 'nodeuo:cooldown',
    'naval.preview': 'nodeuo:naval-preview',
    'housing.tools': 'nodeuo:house-tools',
    'skills.insights': 'nodeuo:skill-insight',
    'trade.audit': 'nodeuo:trade-audit',
    'vendor.insights': 'nodeuo:vendor-insight',
    'npc.dialog': 'nodeuo:npc-dialog',
  };
  const event = featureEvents[message.feature];
  if (event) {
    bus.emit(event, {
      kind: Number(payload.eventKind ?? payload.kind) || 0,
      requestId: Number(payload.requestId) >>> 0 || 0,
      payload: payload.data ?? payload.payload ?? payload,
    });
    return true;
  }
  if (message.feature === 'world.editing') {
    if (payload.operation === 'preview') bus.emit('target:preview', {
      itemId: Number(payload.itemId) | 0, hue: Number(payload.hue) | 0,
    });
    if (payload.operation === 'map-edits' && Array.isArray(payload.edits)) assets.applyOverlayEdits(payload.edits);
    return true;
  }
  if ((message.feature === 'ui.rich-gumps' || message.feature === 'crafting.workbench')
      && payload.operation === 'open-gump') {
    const tag = String(payload.name ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (!tag) return false;
    // Keep the mature gump dispatch local to GameScene while the wire remains
    // a typed JSON command. JournalManager filters this internal event.
    bus.emit('message:journal', {
      name: 'NodeUO', text: `@@OPEN_${tag}_GUMP@@${String(payload.payload ?? '')}`,
      textType: 1, hue: 0,
    });
    return true;
  }
  if (message.feature === 'ui.rich-gumps' && payload.operation === 'open-action') {
    const tag = String(payload.name ?? '').replace(/[^a-z0-9_]/gi, '').toUpperCase();
    if (!tag) return false;
    bus.emit('message:journal', {
      name: 'NodeUO', text: `@@OPEN_${tag}@@${String(payload.payload ?? '')}`,
      textType: 1, hue: 0,
    });
    return true;
  }
  if (message.feature === 'crafting.workbench' && payload.operation === 'progress') {
    bus.emit('chat:unicode', {
      name: 'NodeUO', text: `@@CRAFT_PROGRESS@@${Number(payload.recipeId) | 0}`
        + `|${Number(payload.done) | 0}|${Number(payload.total) | 0}`
        + `|${String(payload.status ?? '')}|${String(payload.message ?? '')}`,
    });
    return true;
  }
  if (message.feature === 'ui.rich-gumps' && (payload.data ?? payload).operation === 'command-catalogue') {
    const source = payload.data ?? payload;
    const catalogue = { accessLevel: String(source.accessLevel ?? 'Player'),
      commands: Array.isArray(source.commands) ? source.commands : [] };
    world.commandCatalogue = catalogue;
    bus.emit('shard:commands', catalogue);
    return true;
  }
  if (message.feature === 'character.virtues') {
    if (world.player) world.player.virtues = payload;
    bus.emit('player:virtues', payload);
    return true;
  }
  if (message.feature === 'world.champion') {
    bus.emit('champion:status', payload);
    return true;
  }
  if (message.feature === 'flow.qos') {
    world.nodeUOFlow = payload;
    bus.emit('nodeuo:flow-qos', payload);
    return true;
  }
  if (message.feature === 'map.prefetch') {
    for (const body of (payload.bodies ?? []).slice(0, 64)) {
      assets.prefetchMobileCycle?.(Number(body) | 0, 0, 0).catch?.(() => {});
      assets.prefetchMobileCycle?.(Number(body) | 0, 0, 4).catch?.(() => {});
    }
    bus.emit('map:prefetch', payload);
    return true;
  }
  if (message.feature === 'party.markers') {
    world.partyMarkers = payload;
    bus.emit('party:markers', payload);
    return true;
  }
  if (message.feature === 'social.pings') {
    const now = Date.now() + (net.nodeUOClock?.offsetMs ?? 0);
    const pings = (Array.isArray(payload.pings) ? payload.pings : [])
      .filter((ping) => !Number.isFinite(Number(ping?.expiresAt)) || Number(ping.expiresAt) > now)
      .slice(0, 64);
    world.partyPings = { ...payload, pings };
    bus.emit('party:pings', world.partyPings);
    return true;
  }
  if (message.feature === 'world.events') {
    const state = modernState();
    state.worldEvents ??= [];
    const known = new Set(state.worldEvents.map((event) => event.id));
    for (const event of Array.isArray(payload.events) ? payload.events : []) {
      if (!event?.id || known.has(event.id)) continue;
      known.add(event.id);
      state.worldEvents.push(event);
      bus.emit('world:event', event);
      if (message.kind === NodeUOJsonKind.Event && event.text) bus.emit('message:journal', {
        name: String(event.title ?? 'World').slice(0, 80), text: String(event.text).slice(0, 2000),
        textType: event.severity === 'danger' ? 8 : 1,
        hue: event.severity === 'danger' ? 0xff6060 : event.severity === 'warning' ? 0xffc060 : 0xd8af62,
      });
    }
    if (state.worldEvents.length > 256) state.worldEvents.splice(0, state.worldEvents.length - 256);
    world.nodeUOWorldEvents = { cursor: payload.cursor ?? state.worldEvents.at(-1)?.cursor ?? 0,
      events: state.worldEvents };
    try { sessionStorage.setItem('nodeuo.world-events.cursor', String(world.nodeUOWorldEvents.cursor)); }
    catch { /* storage may be unavailable */ }
    return true;
  }
  if (message.feature === 'world.annotations') {
    const scopeKey = `${payload.scope ?? 'personal'}:${payload.scopeId ?? ''}`;
    world.worldAnnotationScopes ??= new Map();
    world.worldAnnotationScopes.set(scopeKey, payload);
    world.worldAnnotations = {
      revision: Math.max(0, ...[...world.worldAnnotationScopes.values()]
        .map((entry) => Number(entry.revision) || 0)),
      annotations: [...world.worldAnnotationScopes.values()]
        .flatMap((entry) => Array.isArray(entry.annotations) ? entry.annotations : []).slice(-768),
    };
    bus.emit('world:annotations', world.worldAnnotations);
    return true;
  }
  if (message.feature === 'editor.collaboration') {
    world.nodeUOEditorCollaboration = payload;
    bus.emit('editor:collaboration', payload);
    return true;
  }
  if (message.feature === 'editor.transactions') {
    world.nodeUOEditorTransaction = payload;
    bus.emit('editor:transaction', payload);
    return true;
  }
  if (message.feature === 'housing.collaboration') {
    world.houseCollaboration = payload;
    bus.emit('house:collaboration', payload);
    return true;
  }
  if (message.feature === 'spectator.replay') {
    world.spectatorReplay = payload;
    bus.emit('spectator:replay', payload);
    return true;
  }
  if (message.feature === 'ai.inspector') {
    bus.emit('ai:inspector', payload);
    return true;
  }
  if (message.feature === 'instance.handoff') {
    world.instanceHandoff = payload;
    bus.emit('instance:handoff', payload);
    return true;
  }
  if (message.feature === 'voice.authorization') {
    world.voiceAuthorization = payload;
    bus.emit('voice:authorization', payload);
    return true;
  }
  if (message.feature === 'cinematic.timeline') {
    if (payload?.ok !== false) playCinematic(net, payload);
    return true;
  }
  if (message.feature === 'npc.generative') {
    bus.emit('nodeuo:npc-generated', payload);
    return true;
  }
  if (message.feature === 'protocol.feature-health') {
    world.nodeUOFeatureHealth = payload;
    for (const feature of payload.disabled ?? []) net._nodeUODisabledFeatures?.add?.(String(feature));
    bus.emit('nodeuo:feature-health', payload);
    return true;
  }
  if (message.feature === 'client.performance-hints') {
    world.nodeUOPerformanceHints = payload;
    bus.emit('nodeuo:performance-hints', payload);
    return true;
  }
  if (message.feature === 'assets.client-profile') {
    world.nodeUOAssetProfileAck = payload;
    bus.emit('assets:client-profile', payload);
    return true;
  }
  if (message.feature === 'content.release') {
    const previous = world.nodeUOContentRelease?.active?.fingerprint;
    world.nodeUOContentRelease = payload;
    bus.emit('content:release', payload);
    if (previous && payload.active?.fingerprint && previous !== payload.active.fingerprint) {
      bus.emit('assets:hot-reload', { files: payload.active.files ?? [], revision: payload.active.fingerprint });
    }
    return true;
  }
  if (message.feature === 'content.preflight') {
    world.nodeUOContentPreflight = payload;
    bus.emit('content:preflight', payload);
    return true;
  }
  if (message.feature === 'interaction.catalog') {
    world.nodeUOInteractionCatalog = payload;
    bus.emit('interaction:catalog', payload);
    return true;
  }
  if (message.feature === 'world.region-prefetch') {
    void assets.prefetchMobileBodies?.((payload.bodies ?? []).slice(0, 128));
    // Static textures are independently cached; cap parallel lookups so a
    // malicious/stale response cannot create a decode burst.
    void Promise.all((payload.items ?? []).slice(0, 64)
      .map((id) => assets.staticTexture?.(Number(id) | 0))).catch(() => {});
    world.nodeUORegionPrefetch = payload;
    bus.emit('world:region-prefetch', payload);
    return true;
  }
  if (message.feature === 'diagnostics.trace') {
    world.nodeUODiagnosticTrace = payload;
    bus.emit('diagnostics:trace', payload);
    return true;
  }
  if (message.feature === 'protocol.consent') {
    world.nodeUOConsent = payload;
    bus.emit('nodeuo:consent', payload);
    return true;
  }
  if (message.feature === 'world.sector-digest') {
    world.nodeUOSectorDigests = payload;
    const serials = [...new Set((payload.mismatched ?? []).flatMap((row) => row.serials ?? []))].slice(0, 512);
    if (serials.length && net.supportsNodeUO?.('protocol.state-repair')) {
      void net.sendNodeUORequest({ capability: 'protocol.state-repair',
        payload: { serials }, timeoutMs: 5000, ttlMs: 5000 }).catch(() => {});
    }
    bus.emit('world:sector-digest', payload);
    return true;
  }
  const wave6Events = {
    'protocol.causality': 'nodeuo:causality',
    'protocol.errors': 'nodeuo:error-contract',
    'protocol.preconditions': 'nodeuo:preconditions',
    'protocol.transactions': 'nodeuo:transaction',
    'protocol.command-schema': 'nodeuo:command-schema',
    'content.dependencies': 'content:dependencies',
    'content.preview-session': 'content:preview-session',
    'combat.preflight': 'combat:preflight',
    'inventory.views': 'inventory:view',
    'crafting.plan': 'crafting:plan',
    'world.environment': 'world:environment',
    'world.audio-scene': 'audio:scene',
    'accessibility.spatial-cues': 'accessibility:spatial-cues',
    'quest.guidance': 'quest:guidance',
    'support.evidence': 'support:evidence',
    'moderation.case': 'moderation:case',
    'script.catalog': 'script:catalog',
    'release.compatibility': 'content:release-compatibility',
    'trade.receipts': 'trade:receipts',
  };
  const wave6Event = wave6Events[message.feature];
  if (wave6Event) {
    world.nodeUOWave6 ??= Object.create(null);
    world.nodeUOWave6[message.feature] = payload;
    if (message.feature === 'world.environment') {
      if (Number.isFinite(payload.lightLevel)) world.lightLevel = Number(payload.lightLevel) | 0;
      if (Number.isFinite(payload.season)) world.season = Number(payload.season) | 0;
    }
    bus.emit(wave6Event, payload);
    return true;
  }
  const wave7Events = {
    'protocol.policy': 'nodeuo:policy',
    'protocol.subscription-leases': 'nodeuo:subscription-lease',
    'protocol.resumable-streams': 'nodeuo:resumable-stream',
    'protocol.retry-policy': 'nodeuo:retry-policy',
    'protocol.cost-hints': 'nodeuo:cost-hints',
    'protocol.compatibility-fallbacks': 'nodeuo:fallbacks',
    'protocol.conformance': 'nodeuo:conformance',
    'protocol.privacy-labels': 'nodeuo:privacy-labels',
    'protocol.signed-content': 'content:signed-release',
    'diagnostics.client-frame': 'diagnostics:client-frame',
    'world.layers': 'world:layer',
    'world.live-event-director': 'world:live-events',
    'world.codex': 'world:codex',
    'party.loot-policy': 'party:loot-policy',
    'ui.safe-schema': 'ui:safe-forms',
  };
  const wave7Event = wave7Events[message.feature];
  if (wave7Event) {
    world.nodeUOWave7 ??= Object.create(null);
    world.nodeUOWave7[message.feature] = payload;
    bus.emit(wave7Event, payload);
    return true;
  }
  const wave3Events = {
    'network.path-selection': 'nodeuo:network-path',
    'inventory.transactions': 'inventory:transaction',
    'combat.telegraphs': 'combat:telegraphs',
    'quest.graph': 'quest:graph',
    'party.tactics': 'party:tactics',
    'npc.relationships': 'npc:relationships',
    'ui.accessibility': 'ui:accessibility',
    'assets.patchsets': 'assets:patchset',
    'mods.permissions': 'mods:permissions',
    'admin.config-transactions': 'admin:config-transaction',
    'debug.time-travel': 'debug:time-travel',
    'economy.market-stream': 'economy:market',
    'voice.spatial-state': 'voice:spatial-state',
    'instance.live-handoff': 'instance:live-handoff',
    'spectator.full-stream': 'spectator:full-stream',
    'protocol.privacy-contract': 'nodeuo:privacy-contract',
  };
  const wave3Event = wave3Events[message.feature];
  if (wave3Event) {
    world.nodeUOWave3 ??= {};
    world.nodeUOWave3[message.feature] = payload;
    if (message.feature === 'combat.telegraphs') {
      const now = Date.now() + (net.nodeUOClock?.offsetMs ?? 0);
      world.combatTelegraphs = (payload.telegraphs ?? []).filter((row) => Number(row.expiresAt) > now);
    }
    if (message.feature === 'ui.accessibility' && payload.preferences && typeof document !== 'undefined') {
      const root = document.documentElement;
      root.dataset.nodeuoContrast = String(payload.preferences.contrast ?? 'normal');
      root.dataset.nodeuoColorVision = String(payload.preferences.colorVision ?? 'normal');
      root.dataset.nodeuoReduceMotion = payload.preferences.reduceMotion ? 'true' : 'false';
    }
    bus.emit(wave3Event, payload);
    return true;
  }
  const namespace = FEATURE_NAMESPACE[message.feature] ?? `nodeuo.${message.feature}`;
  return applyNodeUOChannel(net, {
    feature: message.feature,
    channel: message.channel, namespace, kind: JSON_CHANNEL_KIND[message.kind] ?? NodeUOChannelMessage.Event,
    flags: (message.delivery === NodeUODelivery.LossTolerant ? NodeUOChannelFlag.LossTolerant : 0)
      | (message.requiresAck ? NodeUOChannelFlag.AckRequired : 0),
    sequence: Number(message.seq) || 0, acknowledge: Number(message.ack) || 0,
    requestId: 0, payload,
  });
}

export function installNodeUOJsonProtocol(net) {
  net.setNodeUOJsonHandler?.((message) => handleNodeUOJsonMessage(net, message));
  net._nodeUOJsonCapabilitiesUnsub?.();
  net._nodeUOJsonCapabilitiesUnsub = bus.on('nodeuo:capabilities', (capabilities) => {
    if (!net.nodeUOJsonTransport) return;
    world.nodeUO = capabilities;
    attemptNodeUOSessionResume(net);
  });
}

export function resetNodeUOModernState() {
  for (const timers of cinematicTimers.values()) for (const timer of timers) clearTimeout(timer);
  cinematicTimers.clear();
  for (const key of ['nodeUOModern', 'timeline', 'vendorSearch', 'questJournal',
    'assetManifest', 'partyState', 'partyMarkers', 'partyPings', 'nodeUOWorldEvents',
    'nodeUOEditorTransaction', 'nodeUOEditorCollaboration', 'houseCollaboration', 'spectatorReplay',
    'instanceHandoff', 'voiceAuthorization', 'structuredUi', 'nodeUOLocalization',
    'nodeUOFlow', 'nodeUOClock', 'nodeUOManifest', 'nodeUOSubscriptions', 'resume', 'transportUpgrade',
    'movementReconciliation', 'worldAnnotations', 'worldAnnotationScopes', 'nodeUOProgressiveSnapshot',
    'nodeUOSectorCursor', 'nodeUOSchemaRegistry', 'nodeUOWave3', 'combatTelegraphs']) delete world[key];
  for (const key of ['nodeUOFeatureHealth', 'nodeUOPerformanceHints', 'nodeUOContentRelease',
    'nodeUOInteractionCatalog', 'nodeUORegionPrefetch', 'nodeUOConsent', 'nodeUOSectorDigests',
    'nodeUOReleaseCompatibility', 'nodeUOWave6']) delete world[key];
}

function messageFormatOptions(source) {
  const options = new Map();
  let index = 0;
  while (index < source.length) {
    while (/\s/u.test(source[index] ?? '')) index++;
    const keyStart = index;
    while (index < source.length && !/\s|\{/u.test(source[index])) index++;
    const key = source.slice(keyStart, index);
    while (/\s/u.test(source[index] ?? '')) index++;
    if (!key || source[index] !== '{') break;
    let depth = 1, end = ++index;
    while (end < source.length && depth) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}') depth--;
      end++;
    }
    if (depth) break;
    options.set(key, source.slice(index, end - 1));
    index = end;
  }
  return options;
}

function formatMessagePattern(pattern, variables, locale, depth = 0) {
  if (depth > 8) return String(pattern);
  let safeLocale = 'en';
  try { safeLocale = Intl.getCanonicalLocales(String(locale ?? 'en'))[0] ?? 'en'; }
  catch { /* malformed server locale falls back without breaking the UI */ }
  const source = String(pattern);
  let output = '';
  for (let index = 0; index < source.length;) {
    if (source[index] !== '{') { output += source[index++]; continue; }
    let level = 1, end = index + 1;
    while (end < source.length && level) {
      if (source[end] === '{') level++;
      else if (source[end] === '}') level--;
      end++;
    }
    if (level) { output += source.slice(index); break; }
    const expression = source.slice(index + 1, end - 1);
    const first = expression.indexOf(',');
    if (first < 0) output += String(variables[expression.trim()] ?? '');
    else {
      const name = expression.slice(0, first).trim();
      const tail = expression.slice(first + 1).trim();
      const second = tail.indexOf(',');
      const type = (second < 0 ? tail : tail.slice(0, second)).trim();
      const value = variables[name];
      if (type === 'number') output += new Intl.NumberFormat(safeLocale).format(Number(value) || 0);
      else if (type === 'date') {
        const date = new Date(value);
        output += Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(safeLocale).format(date);
      }
      else if (type === 'plural' || type === 'selectordinal' || type === 'select') {
        const options = messageFormatOptions(second < 0 ? '' : tail.slice(second + 1));
        let selector;
        if (type === 'select') selector = String(value);
        else selector = options.has(`=${Number(value)}`) ? `=${Number(value)}`
          : new Intl.PluralRules(safeLocale, { type: type === 'selectordinal' ? 'ordinal' : 'cardinal' })
            .select(Number(value) || 0);
        const chosen = options.get(selector) ?? options.get('other') ?? '';
        output += formatMessagePattern(chosen.replaceAll('#', String(Number(value) || 0)), variables, safeLocale, depth + 1);
      } else output += String(value ?? '');
    }
    index = end;
  }
  return output;
}

export function nodeUOTranslate(key, variables = {}) {
  const localization = world.nodeUOLocalization ?? {};
  const text = localization.strings?.[key] ?? key;
  return formatMessagePattern(text, variables, localization.locale ?? localization.fallback ?? 'en');
}

export function attemptNodeUOSessionResume(net) {
  if (!net.supportsNodeUO?.(NodeUOFeature.SessionResume)) return false;
  let token = '';
  try { token = sessionStorage.getItem('nodeuo.resume') ?? ''; } catch { return false; }
  if (!token) return false;
  const state = modernState();
  let worldEventCursor = 0;
  try { worldEventCursor = Number(sessionStorage.getItem('nodeuo.world-events.cursor')) >>> 0; }
  catch { /* storage may be unavailable */ }
  return net.sendNodeUOEvent({
    channel: NodeUOChannel.Control, namespace: 'nodeuo.resume',
    capability: NodeUOFeature.SessionResume, kind: NodeUOChannelMessage.Resume,
    payload: {
      token,
      baseline: state.worldBaseline >>> 0,
      sequences: Object.fromEntries(state.sequences),
      cursors: { worldEvents: worldEventCursor },
    },
  });
}
