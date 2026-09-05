import { stableJsonFingerprint } from '@uo/nodeuo-protocol';
import { sectorKeyForPosition } from '../../world/sectors.js';

const CONSENT_CATEGORIES = new Set(['performance', 'diagnostics', 'voice', 'personalization']);

function inRange(state, entity, radius = 12) {
  const actor = state?.mobile;
  return !!(actor && entity && actor.map === entity.map
    && Math.max(Math.abs(actor.x - entity.x), Math.abs(actor.y - entity.y)) <= radius);
}

function consentState(mobile) {
  mobile._nodeUOConsent ??= { revision: 1, categories: {
    performance: false, diagnostics: false, voice: false, personalization: false,
  } };
  return mobile._nodeUOConsent;
}

function protocolConsent(state, payload) {
  if (!state.mobile) return { ok: false, error: 'player unavailable' };
  const consent = consentState(state.mobile);
  const operation = String(payload.operation ?? 'get').toLowerCase();
  if (operation === 'get' || operation === 'list') return { ok: true, ...structuredClone(consent) };
  if (operation !== 'update') return { ok: false, error: 'unsupported consent operation' };
  const category = String(payload.category ?? '').toLowerCase();
  if (!CONSENT_CATEGORIES.has(category)) return { ok: false, error: 'unknown consent category' };
  if (payload.revision != null && Number(payload.revision) !== consent.revision) {
    return { ok: false, conflict: true, ...structuredClone(consent) };
  }
  consent.categories[category] = payload.granted === true;
  consent.revision++;
  return { ok: true, ...structuredClone(consent) };
}

function featureHealth(state, payload) {
  const operation = String(payload.operation ?? 'report').toLowerCase();
  if (operation === 'query') {
    const snapshot = state.ctx.featureRollouts?.snapshot?.() ?? {};
    const requested = String(payload.feature ?? '');
    return { ok: true, disabled: [...(state._nodeUODisabledFeatures ?? [])],
      rollout: requested ? snapshot.active?.[requested] ?? null : snapshot.active ?? {},
      killSwitches: requested ? { [requested]: snapshot.killSwitches?.[requested] ?? null }
        : snapshot.killSwitches ?? {} };
  }
  const accepted = [];
  const disableAfterResponse = [];
  for (const source of (Array.isArray(payload.reports) ? payload.reports : []).slice(0, 64)) {
    const feature = String(source?.feature ?? '').toLowerCase();
    if (!state.nodeUOFeatures?.has?.(feature) || feature === 'protocol.feature-health') continue;
    const status = ['healthy', 'degraded', 'failed', 'incompatible'].includes(source?.status)
      ? source.status : 'degraded';
    state.ctx.featureRollouts?.observe?.(feature, status === 'healthy');
    accepted.push({ feature, status });
    if (status === 'failed' || status === 'incompatible') disableAfterResponse.push(feature);
  }
  if (disableAfterResponse.length) queueMicrotask(() => {
    state._nodeUODisabledFeatures ??= new Set();
    for (const feature of disableAfterResponse) state._nodeUODisabledFeatures.add(feature);
  });
  return { ok: true, accepted, disabled: disableAfterResponse };
}

function performanceHints(state, payload) {
  if (!state.mobile) return { ok: false, error: 'player unavailable' };
  if (consentState(state.mobile).categories.performance !== true) {
    return { ok: false, consentRequired: 'performance', error: 'performance consent is required' };
  }
  const hints = {
    fps: Math.max(1, Math.min(1000, Number(payload.fps) || 60)),
    frameP95Ms: Math.max(0, Math.min(10_000, Number(payload.frameP95Ms) || 16.7)),
    memoryMB: Math.max(0, Math.min(1_000_000, Number(payload.memoryMB) || 0)),
    desiredRateHz: Math.max(5, Math.min(60, Number(payload.desiredRateHz) | 0 || 30)),
    desiredRadius: Math.max(8, Math.min(64, Number(payload.desiredRadius) | 0 || 24)),
    receivedAt: Date.now(),
  };
  // The applied profile is cached once and reused by the replication hot path.
  state._nodeUOPerformanceHints = hints;
  state._nodeUOAdaptiveSubscription = Object.freeze({
    target: 'world.components', components: [], fields: [], levelOfDetail: hints.frameP95Ms > 40 ? 'minimal'
      : hints.frameP95Ms > 24 ? 'reduced' : 'full',
    rateHz: hints.desiredRateHz,
    maxEntities: hints.frameP95Ms > 40 ? 512 : hints.frameP95Ms > 24 ? 1024 : 2048,
  });
  return { ok: true, applied: state._nodeUOAdaptiveSubscription };
}

function interactionCatalog(state, payload, npcDialogs) {
  const serial = Number(payload.targetSerial) >>> 0;
  const mobile = state.ctx.world.mobiles.get(serial);
  const item = state.ctx.world.items.get(serial);
  const target = mobile ?? item;
  if (!target || !inRange(state, target, 12)
    || (mobile && mobile !== state.mobile && !state._visibleMobiles?.has?.(serial))
    || (item && !state._visibleItems?.has?.(serial))) {
    return { ok: false, error: 'visible target is unavailable or out of range' };
  }
  const actions = [];
  const controller = npcDialogs?.();
  const version = state.nodeUOFeatures?.get?.('interaction.catalog') ?? 1;
  if (mobile && !mobile.isPlayer && controller?.isScripted?.(state, mobile)) {
    actions.push({ id: 'dialog', label: 'Talk, quests and services', kind: 'dialog',
      group: 'primary', enabled: true, presentation: version >= 2 ? 'visual-novel' : undefined });
  }
  if (mobile) actions.push({ id: 'paperdoll', label: 'Open paperdoll', kind: 'character',
    group: 'primary', enabled: true, shortcut: version >= 2 ? 'P' : undefined });
  actions.push({ id: 'inspect', label: 'Inspect', kind: 'information',
    group: 'secondary', enabled: true });
  const revision = Number.parseInt(stableJsonFingerprint(actions).slice(-8), 16) >>> 0;
  const operation = String(payload.operation ?? 'list').toLowerCase();
  if (operation !== 'invoke') return { ok: true, targetSerial: serial, revision, actions,
    expiresAt: Date.now() + 10_000,
    groups: version >= 2 ? [
      { id: 'primary', label: 'Actions', order: 0 },
      { id: 'secondary', label: 'Information', order: 1 },
    ] : undefined };
  if (payload.expectedRevision != null && Number(payload.expectedRevision) !== revision) {
    return { ok: false, conflict: true, revision, actions };
  }
  const action = actions.find((row) => row.id === String(payload.actionId));
  if (!action) return { ok: false, error: 'interaction action is unavailable', revision, actions };
  if (action.id === 'dialog') return { ok: !!controller.open?.(state, mobile), targetSerial: serial, action: action.id };
  if (action.id === 'paperdoll') return { ok: !!controller.sendPaperdoll?.(state, mobile), targetSerial: serial, action: action.id };
  return { ok: true, targetSerial: serial, action: action.id,
    entity: mobile ? { type: 'mobile', name: String(mobile.name ?? '').slice(0, 128), body: mobile.body | 0,
      hue: mobile.hue | 0, notoriety: mobile.notoriety | 0 }
      : { type: 'item', name: String(item.name ?? '').slice(0, 128), itemId: item.itemId | 0,
        hue: item.hue | 0, amount: item.amount | 0 } };
}

function regionPrefetch(state, payload) {
  const actor = state.mobile;
  if (!actor) return { ok: false, error: 'player unavailable' };
  const x = Math.max(0, Math.min(0xffff, payload.x == null ? actor.x : Number(payload.x) | 0));
  const y = Math.max(0, Math.min(0xffff, payload.y == null ? actor.y : Number(payload.y) | 0));
  const map = Math.max(0, Math.min(255, payload.map == null ? actor.map : Number(payload.map) | 0));
  if (map !== actor.map || Math.max(Math.abs(x - actor.x), Math.abs(y - actor.y)) > 64) {
    return { ok: false, error: 'prefetch target must be near the player' };
  }
  const radius = Math.max(8, Math.min(48, Number(payload.radius) | 0 || 24));
  const bodies = new Set();
  const items = new Set();
  const sectors = new Set();
  for (const serial of state.ctx.world.sectors.mobileSerialsNear(map, x, y, radius)) {
    const entity = state.ctx.world.mobiles.get(serial);
    if (entity && (!entity.hidden || state._visibleMobiles?.has?.(serial))) {
      bodies.add(entity.body | 0); sectors.add(sectorKeyForPosition(entity.map, entity.x, entity.y));
    }
    if (bodies.size >= 128) break;
  }
  for (const serial of state.ctx.world.sectors.itemSerialsNear(map, x, y, radius)) {
    const entity = state.ctx.world.items.get(serial);
    if (entity && !entity.parent && (!entity.hidden || state._visibleItems?.has?.(serial))) {
      items.add(entity.itemId | 0); sectors.add(sectorKeyForPosition(entity.map, entity.x, entity.y));
    }
    if (items.size >= 256) break;
  }
  const version = state.nodeUOFeatures?.get?.('world.region-prefetch') ?? 1;
  return { ok: true, region: { x, y, map, radius }, bodies: [...bodies], items: [...items],
    release: state.ctx.contentReleases?.snapshot?.().active ?? null,
    ...(version >= 2 ? { sectors: [...sectors].slice(0, 128), priority: 'background',
      expiresAt: Date.now() + 15_000,
      budget: { bodies: 128, items: 256, decodeConcurrency: 2 },
      reason: String(payload.reason ?? 'near-player').slice(0, 48) } : {}) };
}

function sectorDigests(state, payload) {
  const actor = state.mobile;
  if (!actor) return { ok: false, error: 'player unavailable' };
  const radius = Math.max(8, Math.min(48, Number(payload.radius) | 0 || 24));
  const groups = new Map();
  const append = (entity, type) => {
    if (!entity || entity.map !== actor.map
      || Math.max(Math.abs(entity.x - actor.x), Math.abs(entity.y - actor.y)) > radius) return;
    const sector = sectorKeyForPosition(entity.map, entity.x, entity.y);
    let group = groups.get(sector);
    if (!group) groups.set(sector, group = []);
    group.push({ serial: entity.serial >>> 0, type,
      revision: state.ctx.world.interest?.revision?.(entity.serial) ?? 0,
      x: entity.x | 0, y: entity.y | 0, z: entity.z | 0,
      art: type === 'mobile' ? entity.body | 0 : entity.itemId | 0,
      hue: entity.hue | 0 });
  };
  append(actor, 'mobile');
  for (const serial of state._visibleMobiles ?? []) append(state.ctx.world.mobiles.get(serial), 'mobile');
  for (const serial of state._visibleItems ?? []) append(state.ctx.world.items.get(serial), 'item');
  const digests = [...groups].map(([sector, entities]) => {
    entities.sort((a, b) => a.serial - b.serial);
    return { sector, digest: `fnv1a64:${stableJsonFingerprint(entities)}`,
      count: entities.length, revision: Math.max(0, ...entities.map((row) => row.revision)),
      serials: entities.slice(0, 256).map((row) => row.serial) };
  }).sort((a, b) => a.sector - b.sector).slice(0, 128);
  const client = new Map((Array.isArray(payload.digests) ? payload.digests : [])
    .slice(0, 128).map((row) => [Number(row?.sector), String(row?.digest ?? '')]));
  const mismatched = digests.filter((row) => client.has(row.sector) && client.get(row.sector) !== row.digest);
  return { ok: true, cursor: state.ctx.world.interest?.changeLog?.sequence ?? 0,
    digests, mismatched: mismatched.map((row) => ({ sector: row.sector, serials: row.serials })) };
}

export function handleNodeUOWave4Feature(state, message, { npcDialogs } = {}) {
  const payload = message.payload ?? {};
  switch (message.feature) {
    case 'protocol.feature-health': return featureHealth(state, payload);
    case 'client.performance-hints': return performanceHints(state, payload);
    case 'content.release': {
      const release = state.ctx.contentReleases?.snapshot?.() ?? null;
      return { ok: !!release, revision: release?.revision ?? 0, active: release?.active ?? null };
    }
    case 'interaction.catalog': return interactionCatalog(state, payload, npcDialogs);
    case 'world.region-prefetch': return regionPrefetch(state, payload);
    case 'protocol.consent': return protocolConsent(state, payload);
    case 'world.sector-digest': return sectorDigests(state, payload);
    default: return undefined;
  }
}

export function cleanupNodeUOWave4State(state) {
  delete state?._nodeUOPerformanceHints;
  delete state?._nodeUOAdaptiveSubscription;
  state?._nodeUODisabledFeatures?.clear?.();
}
