import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { containerContentUpdate } from '@uo/protocol';
import { NodeUODelivery, NodeUOJsonKind, stableJsonFingerprint } from '@uo/nodeuo-protocol';
import { EntityDirty } from '../../world/interest-management.js';
import { childrenOf } from '../../world/items.js';
import { simulationReplay } from '../../systems/simulation-replay.js';
import {
  assetManifest,
  nodeUOModPermissionManifest,
  sendNodeUOFeature,
  vendorSearch,
} from './nodeuo-modern.js';

const partyPlans = new Map();
const combatTelegraphs = [];
const voicePresence = new Map();
const containerRevisions = new WeakMap();
const signingKeys = new Map();
const manifestHistory = new Map();
let nextTelegraphCursor = 0;

function isStaff(state) {
  return ['gm', 'admin', 'administrator', 'seer']
    .includes(String(state?.account?.accessLevel ?? '').toLowerCase());
}

function cleanText(value, max = 256) { return String(value ?? '').trim().slice(0, max); }

function partyFor(state) {
  const party = state.ctx.partyRegistry?.partyOf?.(state.mobile?.serial);
  const serials = party?.members instanceof Set ? [...party.members]
    : Array.isArray(party?.members) ? party.members : [state.mobile?.serial].filter(Boolean);
  return { party, id: party?.id ?? `solo:${state.mobile?.serial >>> 0}`, serials };
}

function broadcastParty(state, feature, payload) {
  const { serials } = partyFor(state);
  let sent = 0;
  for (const serial of serials) {
    const peer = state.ctx.world.mobiles.get(serial >>> 0)?.client;
    if (!peer?.supportsNodeUO?.(feature)) continue;
    sent += !!sendNodeUOFeature(peer, { feature, kind: NodeUOJsonKind.Delta,
      delivery: NodeUODelivery.Latest, replace: `${feature}:${payload.partyId ?? ''}`, payload });
  }
  return sent;
}

function inventoryRevisionMap(world) {
  let revisions = containerRevisions.get(world);
  if (!revisions) { revisions = new Map(); containerRevisions.set(world, revisions); }
  return revisions;
}

function ownedContainer(state, serialLike) {
  const serial = Number(serialLike) >>> 0;
  let item = state.ctx.world.items.get(serial);
  if (!item) return null;
  const seen = new Set();
  for (let depth = 0; item && depth < 16; depth++) {
    if (seen.has(item.serial)) return null;
    seen.add(item.serial);
    if ((item.parent >>> 0) === (state.mobile?.serial >>> 0)) return state.ctx.world.items.get(serial);
    item = state.ctx.world.items.get(item.parent >>> 0);
  }
  return null;
}

function inventorySnapshot(state, container) {
  const revision = inventoryRevisionMap(state.ctx.world).get(container.serial) ?? 0;
  return { ok: true, containerSerial: container.serial >>> 0, revision,
    items: [...childrenOf(state.ctx.world, container.serial)].slice(0, 512).map((item) => ({
      serial: item.serial >>> 0, itemId: item.itemId | 0, hue: item.hue | 0,
      amount: Math.max(1, item.amount | 0), x: item.gridX | 0, y: item.gridY | 0,
      name: cleanText(item.name, 128),
    })) };
}

function inventoryTransaction(state, payload) {
  const container = ownedContainer(state, payload.containerSerial);
  if (!container) return { ok: false, error: 'owned container not found' };
  if (payload.operation === 'snapshot') return inventorySnapshot(state, container);
  const revisions = inventoryRevisionMap(state.ctx.world);
  const revision = revisions.get(container.serial) ?? 0;
  if (payload.expectedRevision != null && Number(payload.expectedRevision) !== revision) {
    return { ok: false, error: 'container revision conflict', currentRevision: revision };
  }
  let mutations = Array.isArray(payload.mutations) ? payload.mutations.slice(0, 256) : [];
  if (payload.operation === 'auto-sort') {
    mutations = [...childrenOf(state.ctx.world, container.serial)]
      .sort((a, b) => (a.itemId | 0) - (b.itemId | 0) || (a.serial >>> 0) - (b.serial >>> 0))
      .slice(0, 256).map((item, index) => ({ serial: item.serial,
        x: 20 + (index % 8) * 20, y: 20 + Math.floor(index / 8) * 20 }));
  }
  if (payload.operation !== 'commit' && payload.operation !== 'auto-sort') {
    return { ok: false, error: 'unsupported inventory transaction operation' };
  }
  if (!mutations.length) return { ok: false, error: 'transaction has no mutations' };
  const validated = [];
  const seen = new Set();
  for (const mutation of mutations) {
    const serial = Number(mutation?.serial) >>> 0;
    const item = state.ctx.world.items.get(serial);
    const x = Number(mutation?.x) | 0;
    const y = Number(mutation?.y) | 0;
    if (!item || item.parent !== container.serial || seen.has(serial)
        || x < 0 || x > 0xffff || y < 0 || y > 0xffff) {
      return { ok: false, error: 'invalid or stale inventory mutation', serial };
    }
    seen.add(serial);
    validated.push({ item, x, y, oldX: item.gridX, oldY: item.gridY });
  }
  try {
    for (const row of validated) {
      row.item.gridX = row.x;
      row.item.gridY = row.y;
      state.ctx.world.interest?.mark?.(row.item.serial, EntityDirty.Parent, 'item');
    }
  } catch (error) {
    for (const row of validated) { row.item.gridX = row.oldX; row.item.gridY = row.oldY; }
    return { ok: false, error: `inventory transaction rolled back: ${error.message}` };
  }
  const nextRevision = revision + 1;
  revisions.set(container.serial, nextRevision);
  for (const row of validated) state.send?.(containerContentUpdate(row.item, container.serial));
  return { ...inventorySnapshot(state, container), transactionId: cleanText(payload.transactionId, 96),
    committed: validated.length, revision: nextRevision };
}

function questGraph(state, payload) {
  const source = state.mobile?.activeQuests ?? [];
  const active = Array.isArray(source) ? source
    : Object.entries(source).map(([id, value]) => ({ id, ...(value && typeof value === 'object' ? value : {}) }));
  const requested = cleanText(payload.questId, 128);
  const rows = (requested ? active.filter((entry) => String(entry.id) === requested) : active).slice(0, 128);
  const quests = rows.map((entry) => {
    const definition = state.ctx.quests?.getQuest?.(entry.id);
    const objectives = (definition?.objectives ?? entry.objectives ?? []).slice(0, 128);
    return {
      id: cleanText(entry.id, 128), name: cleanText(definition?.name ?? entry.name ?? entry.id, 256),
      description: cleanText(definition?.description ?? entry.description, 2048),
      nodes: objectives.map((objective, index) => ({ id: `objective:${index}`,
        kind: cleanText(objective.kind ?? objective.type, 64),
        target: cleanText(objective.target ?? objective.resource ?? objective.region ?? objective.npc, 256),
        description: cleanText(objective.description, 512), required: Math.max(1, Number(objective.count) | 0 || 1),
        progress: Math.max(0, Number(entry.progress?.[index]) | 0),
        dependsOn: index ? [`objective:${index - 1}`] : [] })),
      reward: definition?.reward ?? entry.reward ?? null,
    };
  });
  return { ok: true, revision: state.ctx.world.interest?.revision?.(state.mobile?.serial) ?? 0, quests };
}

export function recordNpcInteraction(player, npc, event = 'talk') {
  if (!player || !npc?.serial) return null;
  const relationships = player.nodeUONpcRelationships ??= {};
  const key = String(npc.serial >>> 0);
  const previous = relationships[key] ?? { affinity: 0, talks: 0, choices: 0 };
  const row = {
    npcSerial: npc.serial >>> 0, npcName: cleanText(npc.name, 128),
    affinity: Math.max(-100, Math.min(100, Number(previous.affinity) || 0)),
    talks: Math.max(0, Number(previous.talks) | 0) + (event === 'open' ? 1 : 0),
    choices: Math.max(0, Number(previous.choices) | 0) + (event === 'choice' ? 1 : 0),
    lastEvent: cleanText(event, 32), lastAt: Date.now(),
  };
  relationships[key] = row;
  player._world?.markEntityProperties?.(player, 'mobile');
  return row;
}

function npcRelationships(state, payload) {
  const relationships = state.mobile?.nodeUONpcRelationships ?? {};
  const serial = Number(payload.npcSerial) >>> 0;
  const values = serial ? [relationships[String(serial)]].filter(Boolean) : Object.values(relationships);
  return { ok: true, relationships: values.sort((a, b) => b.lastAt - a.lastAt).slice(0, 256) };
}

function partyTactics(state, payload) {
  const { party, id, serials } = partyFor(state);
  const current = partyPlans.get(id) ?? { revision: 0, plan: null };
  if (payload.operation === 'get') return { ok: true, partyId: id, ...current };
  if (party && !serials.includes(state.mobile?.serial)) return { ok: false, error: 'party membership required' };
  if (payload.expectedRevision != null && Number(payload.expectedRevision) !== current.revision) {
    return { ok: false, error: 'party plan revision conflict', currentRevision: current.revision };
  }
  if (!['update', 'clear'].includes(payload.operation)) return { ok: false, error: 'unsupported party tactic operation' };
  const plan = payload.operation === 'clear' ? null : {
    name: cleanText(payload.plan?.name, 96), leader: state.mobile.serial >>> 0,
    roles: (Array.isArray(payload.plan?.roles) ? payload.plan.roles : []).slice(0, 32).map((row) => ({
      serial: Number(row?.serial) >>> 0, role: cleanText(row?.role, 48),
    })).filter((row) => serials.includes(row.serial)),
    route: (Array.isArray(payload.plan?.route) ? payload.plan.route : []).slice(0, 128).map((point) => ({
      x: Number(point?.x) | 0, y: Number(point?.y) | 0, map: Number(point?.map) | 0,
    })),
    targets: (Array.isArray(payload.plan?.targets) ? payload.plan.targets : []).slice(0, 32)
      .map((serial) => Number(serial) >>> 0).filter(Boolean),
  };
  const next = { revision: current.revision + 1, plan, updatedAt: Date.now(),
    updatedBy: state.mobile.serial >>> 0 };
  partyPlans.delete(id); partyPlans.set(id, next);
  while (partyPlans.size > 4096) partyPlans.delete(partyPlans.keys().next().value);
  const response = { ok: true, partyId: id, ...next };
  response.broadcast = broadcastParty(state, 'party.tactics', response);
  return response;
}

export function publishCombatTelegraph(ctx, {
  source, target = null, shape = 'target', radius = 1, startsAt = Date.now(), durationMs = 500,
  label = 'Incoming attack', danger = 'normal',
} = {}) {
  if (!source?.serial) return null;
  const row = Object.freeze({ cursor: ++nextTelegraphCursor,
    id: `telegraph.${nextTelegraphCursor}`, sourceSerial: source.serial >>> 0,
    targetSerial: target?.serial >>> 0 || 0, shape: cleanText(shape, 24),
    x: Number(target?.x ?? source.x) | 0, y: Number(target?.y ?? source.y) | 0,
    z: Number(target?.z ?? source.z) | 0, map: Number(target?.map ?? source.map) | 0,
    radius: Math.max(0, Math.min(32, Number(radius) | 0)), startsAt: Number(startsAt) || Date.now(),
    expiresAt: (Number(startsAt) || Date.now()) + Math.max(50, Math.min(30_000, Number(durationMs) | 0)),
    label: cleanText(label, 128), danger: cleanText(danger, 24),
  });
  combatTelegraphs.push(row);
  if (combatTelegraphs.length > 2048) combatTelegraphs.splice(0, combatTelegraphs.length - 2048);
  for (const serial of ctx.world.sectors?.onlineMobileSerialsNear?.(row.map, row.x, row.y, 24) ?? []) {
    const peer = ctx.world.mobiles.get(serial)?.client;
    if (peer?.supportsNodeUO?.('combat.telegraphs')) sendNodeUOFeature(peer, {
      feature: 'combat.telegraphs', kind: NodeUOJsonKind.Event,
      delivery: NodeUODelivery.Latest, ttlMs: Math.max(50, row.expiresAt - Date.now()),
      replace: row.id, payload: { cursor: row.cursor, telegraphs: [row] },
    });
  }
  return row;
}

function listCombatTelegraphs(state, payload) {
  const cursor = Math.max(0, Number(payload.cursor) || 0);
  const now = Date.now(); const actor = state.mobile;
  return { ok: true, cursor: nextTelegraphCursor,
    telegraphs: combatTelegraphs.filter((row) => row.cursor > cursor && row.expiresAt > now
      && actor?.map === row.map && Math.max(Math.abs(actor.x - row.x), Math.abs(actor.y - row.y)) <= 32)
      .slice(-256) };
}

function accessibility(state, payload) {
  if (payload.operation === 'get' || !payload.preferences) {
    return { ok: true, preferences: state.mobile?.nodeUOAccessibility ?? {} };
  }
  const source = payload.preferences;
  const preferences = {
    scale: Math.max(0.75, Math.min(3, Number(source.scale) || 1)),
    contrast: ['normal', 'high'].includes(source.contrast) ? source.contrast : 'normal',
    colorVision: ['normal', 'protanopia', 'deuteranopia', 'tritanopia']
      .includes(source.colorVision) ? source.colorVision : 'normal',
    reduceMotion: source.reduceMotion === true,
    screenReader: source.screenReader === true,
    keyboardNavigation: source.keyboardNavigation !== false,
  };
  state.mobile.nodeUOAccessibility = preferences;
  state.ctx.world.markEntityProperties?.(state.mobile, 'mobile');
  return { ok: true, preferences };
}

function selectNetworkPath(state, payload) {
  const metrics = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const webTransportUrl = state.ctx.nodeUOSettings?.value?.webTransportUrl
    ?? state.ctx.config?.nodeUOWebTransportUrl ?? '';
  const candidates = new Set((Array.isArray(payload.candidates) ? payload.candidates : [])
    .map((entry) => cleanText(typeof entry === 'string' ? entry : entry?.id, 32)));
  const wtHealthy = !!webTransportUrl && candidates.has('webtransport')
    && Number(metrics.webtransportRttMs) > 0
    && (Number(metrics.websocketRttMs) <= 0 || Number(metrics.webtransportRttMs) <= Number(metrics.websocketRttMs) * 1.25);
  return { ok: true, selected: wtHealthy ? 'webtransport' : 'websocket',
    endpoint: wtHealthy ? webTransportUrl : null, fallback: 'websocket',
    channels: wtHealthy ? ['latest', 'loss-tolerant'] : ['reliable', 'latest', 'loss-tolerant'],
    reliableUO: 'websocket', reevaluateAfterMs: 30_000 };
}

function patchSigningKey(saveDir) {
  const directory = path.resolve(saveDir);
  let cached = signingKeys.get(directory);
  if (cached) return cached;
  const file = path.join(directory, 'nodeuo-assets-ed25519.pem');
  let privateKey;
  try { privateKey = crypto.createPrivateKey(fs.readFileSync(file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey);
  cached = { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  signingKeys.set(directory, cached);
  return cached;
}

export function signNodeUOContent(saveDir, document) {
  const body = JSON.stringify(document ?? null);
  const key = patchSigningKey(saveDir);
  return { algorithm: 'Ed25519', publicKey: key.publicKey,
    signature: crypto.sign(null, Buffer.from(body), key.privateKey).toString('base64url') };
}

function assetPatchset(state, payload) {
  const current = assetManifest();
  manifestHistory.delete(current.revision); manifestHistory.set(current.revision, current);
  while (manifestHistory.size > 32) manifestHistory.delete(manifestHistory.keys().next().value);
  const previous = manifestHistory.get(cleanText(payload.fromRevision, 128));
  const before = new Map((previous?.files ?? []).map((file) => [file.name, file.sha256]));
  const after = new Map(current.files.map((file) => [file.name, file.sha256]));
  const changed = current.files.filter((file) => before.get(file.name) !== file.sha256);
  const removed = [...before.keys()].filter((name) => !after.has(name));
  const body = { schema: 1, fromRevision: previous?.revision ?? null, revision: current.revision,
    createdAt: Date.now(), files: changed, removed, complete: !previous };
  return { ok: true, patchset: body,
    ...signNodeUOContent(state.ctx.saveDir ?? state.ctx.persistence?.saveDir ?? '.', body) };
}

function configTransactions(state, payload) {
  if (!isStaff(state)) return { ok: false, error: 'staff access required' };
  const store = state.ctx.nodeUOSettings;
  if (!store) return { ok: false, error: 'settings store unavailable' };
  const transactions = state._nodeUOConfigTransactions ??= new Map();
  const now = Date.now();
  for (const [id, row] of transactions) if (row.expiresAt <= now) transactions.delete(id);
  const id = cleanText(payload.transactionId, 96) || crypto.randomUUID();
  if (payload.operation === 'begin') {
    const base = store.snapshot();
    const row = { id, baseRevision: base.revision, value: base, expiresAt: now + 5 * 60_000 };
    while (transactions.size >= 4) transactions.delete(transactions.keys().next().value);
    transactions.set(id, row);
    return { ok: true, transactionId: id, baseRevision: row.baseRevision, expiresAt: row.expiresAt };
  }
  const row = transactions.get(id);
  if (!row) return { ok: false, error: 'configuration transaction not found or expired' };
  if (payload.operation === 'rollback') { transactions.delete(id); return { ok: true, rolledBack: true }; }
  if (payload.operation === 'stage') {
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
    row.value = { ...row.value, ...patch,
      theme: { ...row.value.theme, ...(patch.theme ?? {}) },
      network: { ...row.value.network, ...(patch.network ?? {}) },
      ai: { ...row.value.ai, ...(patch.ai ?? {}) }, voice: { ...row.value.voice, ...(patch.voice ?? {}) },
      features: { ...row.value.features, ...(patch.features ?? {}) } };
    row.expiresAt = now + 5 * 60_000;
    try { store.preview(row.value); }
    catch (error) { return { ok: false, error: error.message }; }
    return { ok: true, transactionId: id, staged: true, expiresAt: row.expiresAt };
  }
  if (payload.operation === 'validate') {
    try { return { ok: true, transactionId: id, preview: store.preview(row.value) }; }
    catch (error) { return { ok: false, error: error.message }; }
  }
  if (payload.operation !== 'commit') return { ok: false, error: 'unsupported configuration operation' };
  if (store.value.revision !== row.baseRevision) return { ok: false, error: 'settings revision conflict',
    currentRevision: store.value.revision };
  const next = store.update(row.value);
  transactions.delete(id);
  for (const peer of state.ctx.connections ?? []) peer.nodeUOBandwidth?.configure?.(next.network);
  return { ok: true, transactionId: id, revision: next.revision, settings: store.adminSnapshot() };
}

function marketStream(state, payload) {
  const result = vendorSearch(state, { ...payload, offset: 0, limit: 100 }, state.ctx.vendors);
  const aggregates = new Map();
  for (const entry of result.entries ?? []) {
    const key = `${entry.itemId}:${entry.hue}:${entry.name.toLowerCase()}`;
    const row = aggregates.get(key) ?? { itemId: entry.itemId, hue: entry.hue, name: entry.name,
      minimumPrice: entry.price, maximumPrice: entry.price, offers: 0, vendors: new Set() };
    row.minimumPrice = Math.min(row.minimumPrice, entry.price);
    row.maximumPrice = Math.max(row.maximumPrice, entry.price);
    row.offers += Math.max(1, entry.amount || 1); row.vendors.add(entry.vendorSerial); aggregates.set(key, row);
  }
  return { ok: true, cursor: Date.now(), query: cleanText(payload.query, 128),
    entries: [...aggregates.values()].map((row) => ({ ...row, vendors: row.vendors.size }))
      .sort((a, b) => a.minimumPrice - b.minimumPrice).slice(0, 100) };
}

function voiceSpatialState(state, payload) {
  if (state.mobile?._nodeUOConsent?.categories?.voice !== true) {
    return { ok: false, consentRequired: 'voice', error: 'voice consent is required' };
  }
  const { id, serials } = partyFor(state);
  if (payload.operation === 'leave') voicePresence.delete(String(state.id));
  else voicePresence.set(String(state.id), { sessionId: String(state.id), partyId: id,
    serial: state.mobile.serial >>> 0, x: state.mobile.x | 0, y: state.mobile.y | 0,
    z: state.mobile.z | 0, map: state.mobile.map | 0, muted: payload.muted === true, at: Date.now() });
  for (const [key, row] of voicePresence) if (Date.now() - row.at > 30_000) voicePresence.delete(key);
  const response = { ok: true, partyId: id, members: [...voicePresence.values()]
    .filter((row) => row.partyId === id && serials.includes(row.serial)).slice(0, 32) };
  broadcastParty(state, 'voice.spatial-state', response);
  return response;
}

function liveHandoff(state, payload) {
  const routes = state.ctx.nodeUOSettings?.snapshot?.().instances ?? [];
  if (payload.operation === 'commit') {
    const prepared = state._nodeUOLiveHandoff;
    if (!prepared || prepared.id !== cleanText(payload.token, 128) || prepared.expiresAt < Date.now()) {
      return { ok: false, error: 'handoff preparation expired' };
    }
    const route = routes.find((entry) => entry.enabled !== false && entry.secret
      && entry.id === prepared.routeId);
    if (!route) return { ok: false, error: 'prepared instance route is no longer available' };
    const transferToken = prepared.transferToken;
    delete state._nodeUOLiveHandoff;
    return { ok: true, committed: true, reconnectUrl: route.url, token: transferToken,
      expiresAt: prepared.expiresAt };
  }
  const route = routes.find((entry) => entry.enabled !== false && entry.secret
    && (!payload.routeId || entry.id === cleanText(payload.routeId, 64)));
  if (!route) return { ok: false, error: 'instance route unavailable' };
  const expiresAt = Date.now() + 30_000;
  const id = crypto.randomUUID();
  const snapshot = { account: state.accountName, serial: state.mobile.serial >>> 0,
    position: { x: state.mobile.x, y: state.mobile.y, z: state.mobile.z, map: state.mobile.map },
    vitals: { hp: state.mobile.hp, mana: state.mobile.mana, stam: state.mobile.stam },
    sourceRevision: state.ctx.world.interest?.revision?.(state.mobile.serial) ?? 0,
    issuedAt: Date.now(), expiresAt, nonce: crypto.randomBytes(12).toString('base64url') };
  const encoded = Buffer.from(JSON.stringify(snapshot)).toString('base64url');
  const transferToken = `${encoded}.${crypto.createHmac('sha256', route.secret).update(encoded).digest('base64url')}`;
  state._nodeUOLiveHandoff = { id, routeId: route.id, expiresAt, transferToken };
  return { ok: true, prepared: true, id, routeId: route.id, label: route.label, url: route.url,
    stateHash: `fnv1a64:${stableJsonFingerprint(snapshot)}`, token: id, expiresAt };
}

function timeTravel(state, payload) {
  if (!isStaff(state)) return { ok: false, error: 'staff access required' };
  const exported = simulationReplay.exportTrace(Math.max(1, Math.min(2000, Number(payload.limit) | 0 || 256)));
  const cursor = Math.max(0, Number(payload.cursor) || 0);
  const records = (exported.records ?? exported.events ?? []).filter((row) => Number(row.sequence ?? row.cursor) > cursor);
  return { ok: true, ...exported, records, cursor: Number(records.at(-1)?.sequence ?? cursor) };
}

function spectatorStream(state, payload) {
  if (!isStaff(state)) return { ok: false, error: 'staff access required' };
  const target = state.ctx.world.mobiles.get(Number(payload.targetSerial) >>> 0) ?? state.mobile;
  const entities = [];
  for (const serial of state.ctx.world.sectors.mobileSerialsNear(target.map, target.x, target.y, 24)) {
    const mobile = state.ctx.world.mobiles.get(serial);
    if (!mobile) continue;
    entities.push({ serial: mobile.serial >>> 0, name: cleanText(mobile.name, 128), body: mobile.body | 0,
      hue: mobile.hue | 0, x: mobile.x | 0, y: mobile.y | 0, z: mobile.z | 0,
      map: mobile.map | 0, direction: mobile.direction & 7, hp: mobile.hp, hpMax: mobile.hpMax });
    if (entities.length >= 512) break;
  }
  return { ok: true, cursor: state.ctx.world.interest?.changeLog?.sequence ?? 0,
    delayedByMs: Math.max(0, Math.min(10 * 60_000, Number(payload.delayMs) | 0)), entities,
    replay: timeTravel(state, { cursor: payload.cursor, limit: 256 }) };
}

export const NODEUO_PRIVACY_CONTRACT = Object.freeze({ version: 1,
  classifications: Object.freeze({
    public: Object.freeze(['entity appearance', 'world position', 'combat telegraphs']),
    party: Object.freeze(['party tactics', 'voice position', 'party markers']),
    personal: Object.freeze(['inventory', 'quest progress', 'NPC relationships', 'accessibility preferences']),
    staff: Object.freeze(['AI diagnostics', 'time travel', 'full spectator stream']),
    secret: Object.freeze(['passwords', 'API keys', 'signing private keys', 'resume tokens']),
  }),
  rules: Object.freeze(['secret fields never enter protocol payloads, logs or replay',
    'personal fields are sent only to the owning authenticated session',
    'party fields require current server-side membership',
    'staff fields require an authoritative account access level']),
});

export function handleNodeUOWave3Feature(state, message) {
  const payload = message.payload ?? {};
  switch (message.feature) {
    case 'network.path-selection': return selectNetworkPath(state, payload);
    case 'inventory.transactions': return inventoryTransaction(state, payload);
    case 'combat.telegraphs': return listCombatTelegraphs(state, payload);
    case 'quest.graph': return questGraph(state, payload);
    case 'party.tactics': return partyTactics(state, payload);
    case 'npc.relationships': return npcRelationships(state, payload);
    case 'ui.accessibility': return accessibility(state, payload);
    case 'assets.patchsets': return assetPatchset(state, payload);
    case 'mods.permissions': return { ok: true, namespaces: nodeUOModPermissionManifest(state) };
    case 'admin.config-transactions': return configTransactions(state, payload);
    case 'debug.time-travel': return timeTravel(state, payload);
    case 'economy.market-stream': return marketStream(state, payload);
    case 'voice.spatial-state': return voiceSpatialState(state, payload);
    case 'instance.live-handoff': return liveHandoff(state, payload);
    case 'spectator.full-stream': return spectatorStream(state, payload);
    case 'protocol.privacy-contract': return { ok: true, ...NODEUO_PRIVACY_CONTRACT };
    default: return undefined;
  }
}

export function cleanupNodeUOWave3State(state) {
  voicePresence.delete(String(state?.id));
  state?._nodeUOConfigTransactions?.clear?.();
  delete state?._nodeUOLiveHandoff;
}
