import crypto from 'node:crypto';
import {
  NodeUOHouseToolsMessage,
  NodeUONpcDialogMessage,
  NodeUOSpecializationMessage,
  NodeUOSpellComposerMessage,
  NodeUODelivery,
  NodeUOJsonKind,
} from '@uo/nodeuo-protocol';
import * as specializations from '../../systems/specializations.js';
import * as diagnostics from '../../systems/operational-diagnostics.js';
import { cleanupEditorTransactions, handleEditorTransaction } from './nodeuo-editor-transactions.js';
import { cleanupEditorCollaboration, handleEditorCollaboration } from './nodeuo-editor-collaboration.js';
import { cleanupNodeUORpc } from './nodeuo-rpc.js';
import { sendNodeUOFeature } from './nodeuo-modern.js';
import { cleanupNodeUOWave3State, handleNodeUOWave3Feature } from './nodeuo-wave3.js';
import { cleanupNodeUOWave4State, handleNodeUOWave4Feature } from './nodeuo-wave4.js';
import { cleanupNodeUOWave5State, handleNodeUOWave5Feature } from './nodeuo-wave5.js';
import { cleanupNodeUOWave6State, handleNodeUOWave6Feature } from './nodeuo-wave6.js';
import { cleanupNodeUOWave7State, handleNodeUOWave7Feature } from './nodeuo-wave7.js';

const partyMarkers = new Map();
const partyPings = new Map();
const housePresence = new Map();
const worldAnnotations = new Map();
const worldEvents = [];
let nextWorldEventCursor = 0;
const MAX_WORLD_EVENTS = 1024;
const HOUSE_OPERATION_BY_KIND = new Map([
  [NodeUOHouseToolsMessage.Undo, 'undo'],
  [NodeUOHouseToolsMessage.Redo, 'redo'],
  [NodeUOHouseToolsMessage.Validate, 'validate'],
  [NodeUOHouseToolsMessage.Copy, 'copy'],
  [NodeUOHouseToolsMessage.Paste, 'paste'],
  [NodeUOHouseToolsMessage.SaveTemplate, 'save-template'],
  [NodeUOHouseToolsMessage.ApplyTemplate, 'apply-template'],
]);

function isStaff(state) {
  return ['gm', 'admin', 'administrator', 'seer']
    .includes(String(state?.account?.accessLevel ?? '').toLowerCase());
}

function signedToken(claims, secret) {
  if (!secret) throw new Error('a shared signing secret is required');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function houseTool(state, operation, payload = {}) {
  if (!state.mobile) return { ok: false, message: 'Player is unavailable.' };
  const registry = state.ctx.houses ?? state.ctx.systems?.houses;
  const house = registry?.activeHouseFor?.(state.mobile, state._activeHouseId)
    ?? registry?.housesOf?.(state.mobile.serial)?.[0] ?? null;
  const finish = (result) => ({
    ...result,
    history: house ? registry.customHistory?.(house) : null,
    templates: house ? Object.values(house.customTemplates ?? {}).map((template) => ({
      name: template.name,
      savedAt: template.savedAt,
      tileCount: template.tiles?.length ?? 0,
    })) : [],
  });
  if (!house) return finish({ ok: false, message: 'You do not own a house to customize.' });
  if (!house.editing) registry.beginEditing?.(house, state.mobile);
  if (operation === 'undo') {
    const ok = registry.undoCustom?.(house) ?? false;
    return finish({ ok, message: ok ? 'Undid the last house edit.' : 'Nothing to undo.' });
  }
  if (operation === 'redo') {
    const ok = registry.redoCustom?.(house) ?? false;
    return finish({ ok, message: ok ? 'Redid the house edit.' : 'Nothing to redo.' });
  }
  if (operation === 'validate') {
    const validation = registry.validateCustom?.(house);
    return finish({
      ok: !!validation?.ok,
      message: validation?.ok ? 'House design is valid.' : 'House design has errors.',
      validation,
    });
  }
  if (operation === 'copy') {
    const count = registry.copyCustomArea?.(
      house,
      payload.x1,
      payload.y1,
      payload.x2,
      payload.y2,
      payload.zMin,
      payload.zMax,
    ) ?? 0;
    return finish({ ok: count > 0, message: count ? `Copied ${count} tile(s).` : 'No tiles in that area.' });
  }
  if (operation === 'paste') {
    const count = registry.pasteCustomArea?.(
      house,
      payload.x,
      payload.y,
      payload.zOffset,
      { replace: !!payload.replace },
    ) ?? 0;
    return finish({ ok: count > 0, message: count ? `Pasted ${count} tile(s).` : 'Clipboard is empty.' });
  }
  if (operation === 'save-template') {
    const result = registry.saveCustomTemplate?.(house, payload.name, payload.rect);
    return finish({
      ok: !!result?.ok,
      message: result?.ok ? `Saved template ${result.name}.` : result?.error ?? 'Could not save template.',
    });
  }
  if (operation === 'apply-template') {
    const count = registry.applyCustomTemplate?.(
      house,
      payload.name,
      payload.x,
      payload.y,
      payload.zOffset,
      { replace: !!payload.replace },
    ) ?? 0;
    return finish({
      ok: count > 0,
      message: count ? `Applied ${count} template tile(s).` : 'Template not found or empty.',
    });
  }
  return finish({ ok: false, message: 'Unknown house-tool operation.' });
}

function partyMemberSerials(state) {
  const party = state.ctx.partyRegistry?.partyOf?.(state.mobile?.serial);
  const source = party?.members instanceof Set ? [...party.members]
    : Array.isArray(party?.members) ? party.members : [state.mobile?.serial];
  return {
    party,
    members: source.map((serial) => Number(serial) >>> 0).filter(Boolean),
  };
}

function publishMarkers(state, partyId, markers, members) {
  for (const [key, marker] of markers) {
    if (typeof key === 'number' && !members.includes(key)) markers.delete(key);
    else if (marker.kind === 'location' && Date.now() - marker.updatedAt > 24 * 60 * 60_000) {
      markers.delete(key);
    }
  }
  const payload = { partyId, revision: Date.now(), markers: [...markers.values()] };
  for (const serial of members) {
    const peer = state.ctx.world?.mobiles?.get?.(serial)?.client;
    if (peer) sendNodeUOFeature(peer, {
      feature: 'party.markers',
      kind: NodeUOJsonKind.Snapshot,
      payload,
      delivery: NodeUODelivery.Latest,
      replace: `party-markers:${partyId}`,
    });
  }
  return payload;
}

function cleanPartyPings(pings, now = Date.now()) {
  for (const [id, ping] of pings) if (ping.expiresAt <= now) pings.delete(id);
  while (pings.size > 64) pings.delete(pings.keys().next().value);
}

function publishPartyPings(state, partyId, pings, members) {
  cleanPartyPings(pings);
  const payload = { partyId, revision: Date.now(), serverTime: Date.now(), pings: [...pings.values()] };
  for (const serial of members) {
    const peer = state.ctx.world?.mobiles?.get?.(serial)?.client;
    if (peer) sendNodeUOFeature(peer, {
      feature: 'social.pings', kind: NodeUOJsonKind.Snapshot, payload,
      delivery: NodeUODelivery.Latest, replace: `party-pings:${partyId}`,
    });
  }
  return payload;
}

function annotationScope(state, requested = 'personal') {
  const scope = ['personal', 'party', 'guild'].includes(requested) ? requested : 'personal';
  if (scope === 'party') {
    const { party, members } = partyMemberSerials(state);
    if (!party) return { error: 'party scope requires a party' };
    return { scope, id: String(party.id ?? party.leader ?? members[0]), members, party };
  }
  if (scope === 'guild') {
    const guildId = state.mobile?.guildId ?? state.mobile?.guild?.id;
    if (!guildId) return { error: 'guild scope requires a guild' };
    return { scope, id: String(guildId) };
  }
  return { scope, id: String(state.mobile?.serial >>> 0), members: [state.mobile?.serial >>> 0] };
}

function annotationAudience(state, resolved) {
  if (resolved.scope === 'personal') return [state];
  if (resolved.scope === 'party') return resolved.members.map((serial) =>
    state.ctx.world?.mobiles?.get?.(serial)?.client).filter(Boolean);
  return [...new Set([state, ...(state.ctx.connections ?? [])])].filter((peer) =>
    String(peer.mobile?.guildId ?? peer.mobile?.guild?.id ?? '') === resolved.id);
}

function cleanAnnotations(records, now = Date.now()) {
  for (const [id, record] of records) {
    if (record.expiresAt && record.expiresAt <= now) records.delete(id);
  }
  while (records.size > 256) records.delete(records.keys().next().value);
}

function publishAnnotations(state, resolved, records) {
  cleanAnnotations(records);
  const payload = {
    scope: resolved.scope, scopeId: resolved.id, revision: Date.now(),
    annotations: [...records.values()],
  };
  for (const peer of annotationAudience(state, resolved)) sendNodeUOFeature(peer, {
    feature: 'world.annotations', kind: NodeUOJsonKind.Snapshot, payload,
    delivery: NodeUODelivery.Latest, replace: `world-annotations:${resolved.scope}:${resolved.id}`,
  });
  return payload;
}

function handleWorldAnnotations(state, operation, payload) {
  const resolved = annotationScope(state, String(payload.scope ?? 'personal').toLowerCase());
  if (resolved.error) return { ok: false, error: resolved.error };
  const scopeKey = `${resolved.scope}:${resolved.id}`;
  const records = worldAnnotations.get(scopeKey) ?? new Map();
  worldAnnotations.set(scopeKey, records);
  while (worldAnnotations.size > 10_000) worldAnnotations.delete(worldAnnotations.keys().next().value);
  cleanAnnotations(records);
  if (!operation || operation === 'list') return { ok: true, ...publishAnnotations(state, resolved, records) };
  const source = payload.annotation ?? payload;
  const id = String(source.id ?? crypto.randomUUID()).trim().slice(0, 96);
  if (!id) return { ok: false, error: 'annotation id is required' };
  const existing = records.get(id);
  const actor = state.mobile?.serial >>> 0;
  const canModerate = isStaff(state) || resolved.party?.leader === actor;
  if (operation === 'remove') {
    if (existing && existing.createdBy !== actor && !canModerate) {
      return { ok: false, error: 'only the creator, group leader, or staff can remove this annotation' };
    }
    records.delete(id);
    return { ok: true, removed: id, ...publishAnnotations(state, resolved, records) };
  }
  if (!['upsert', 'publish', 'update'].includes(operation)) {
    return { ok: false, error: 'unknown annotation operation' };
  }
  if (existing && existing.createdBy !== actor && !canModerate) {
    return { ok: false, error: 'only the creator, group leader, or staff can update this annotation' };
  }
  const x = Number(source.x ?? existing?.x);
  const y = Number(source.y ?? existing?.y);
  const map = Number(source.map ?? source.facet ?? existing?.map ?? state.mobile?.map);
  if (![x, y, map].every(Number.isFinite)) return { ok: false, error: 'valid annotation location required' };
  const now = Date.now();
  const ttlMs = Math.max(0, Math.min(30 * 24 * 60 * 60_000, Number(source.ttlMs) | 0));
  records.set(id, {
    id, scope: resolved.scope,
    kind: String(source.kind ?? existing?.kind ?? 'note').slice(0, 32),
    label: String(source.label ?? existing?.label ?? '').slice(0, 160),
    description: String(source.description ?? existing?.description ?? '').slice(0, 1000),
    x: Math.max(0, Math.min(0xffff, x | 0)), y: Math.max(0, Math.min(0xffff, y | 0)),
    z: Math.max(-128, Math.min(127, Number(source.z ?? existing?.z ?? state.mobile?.z) | 0)),
    map: Math.max(0, Math.min(255, map | 0)),
    color: Number(source.color ?? existing?.color) & 0xffffff,
    createdBy: existing?.createdBy ?? actor, createdAt: existing?.createdAt ?? now,
    updatedBy: actor, updatedAt: now, expiresAt: ttlMs ? now + ttlMs : null,
  });
  cleanAnnotations(records);
  return { ok: true, id, ...publishAnnotations(state, resolved, records) };
}

function sanitizeWorldEvent(source = {}, actor = null) {
  const location = source.location && typeof source.location === 'object' ? {
    x: Math.max(0, Math.min(0xffff, Number(source.location.x) | 0)),
    y: Math.max(0, Math.min(0xffff, Number(source.location.y) | 0)),
    z: Math.max(-128, Math.min(127, Number(source.location.z) | 0)),
    map: Math.max(0, Math.min(255, Number(source.location.map) | 0)),
  } : null;
  return {
    id: String(source.id ?? crypto.randomUUID()).slice(0, 96),
    type: String(source.type ?? 'announcement').trim().toLowerCase().slice(0, 48),
    severity: ['info', 'success', 'warning', 'danger'].includes(source.severity)
      ? source.severity : 'info',
    title: String(source.title ?? 'World event').slice(0, 160),
    text: String(source.text ?? '').slice(0, 2000),
    location,
    startsAt: Math.max(0, Number(source.startsAt) || Date.now()),
    endsAt: Math.max(0, Number(source.endsAt) || 0) || null,
    actor: actor ? { serial: actor.serial >>> 0, name: String(actor.name ?? '').slice(0, 80) } : null,
  };
}

export function publishNodeUOWorldEvent(connections, source, actor = null) {
  const event = { cursor: (++nextWorldEventCursor) >>> 0 || ++nextWorldEventCursor,
    ...sanitizeWorldEvent(source, actor) };
  worldEvents.push(event);
  if (worldEvents.length > MAX_WORLD_EVENTS) worldEvents.splice(0, worldEvents.length - MAX_WORLD_EVENTS);
  let sent = 0;
  for (const peer of connections ?? []) sent += !!sendNodeUOFeature(peer, {
    feature: 'world.events', kind: NodeUOJsonKind.Event,
    payload: { cursor: event.cursor, events: [event] },
  });
  return { ok: true, event, sent };
}

function editableHouse(state, hintedSerial = null, allowCoowner = false) {
  const registry = state.ctx.houses ?? state.ctx.systems?.houses;
  if (hintedSerial != null) {
    const hinted = registry?.houseByMultiSerial?.(hintedSerial);
    const role = hinted && registry?.roleOf?.(hinted, state.mobile?.serial);
    const allowed = role === 'owner' || (allowCoowner && role === 'coowner');
    return { registry, house: allowed ? hinted : null };
  }
  const house = registry?.activeHouseFor?.(state.mobile, state._activeHouseId)
    ?? registry?.housesOf?.(state.mobile?.serial)?.[0] ?? null;
  return { registry, house };
}

function publishPresence(house, presence) {
  for (const [key, record] of presence) if (record.state?._closed) presence.delete(key);
  const payload = {
    houseSerial: Number(house.multiSerial ?? house.serial ?? house.id) >>> 0,
    participants: [...presence.values()].map(({ state: peer, cursor }) => ({
      serial: peer.mobile?.serial >>> 0,
      name: String(peer.mobile?.name ?? '').slice(0, 80),
      cursor,
    })),
  };
  for (const record of presence.values()) sendNodeUOFeature(record.state, {
    feature: 'housing.collaboration',
    kind: NodeUOJsonKind.Snapshot,
    payload,
    delivery: NodeUODelivery.Latest,
    replace: `house-presence:${payload.houseSerial}`,
  });
  return payload;
}

async function boundedResponseText(response, maxBytes) {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > maxBytes) throw new Error('AI provider response too large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('AI provider response too large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('AI provider response too large');
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length).toString('utf8');
}

async function generateNpcLine(state, payload, { signal: cancellationSignal, progress } = {}) {
  const settings = state.ctx.nodeUOSettings?.snapshot?.() ?? {};
  if (!settings.ai?.enabled || !settings.ai.endpoint) {
    return { ok: false, error: 'generative NPC dialogue is disabled' };
  }
  const session = state._nodeUONpcDialog;
  const npc = session && state.ctx.world?.mobiles?.get?.(session.npcSerial);
  if (!session || !npc || npc.dead || npc.map !== state.mobile?.map
      || Math.max(Math.abs(npc.x - state.mobile.x), Math.abs(npc.y - state.mobile.y)) > 12) {
    return { ok: false, error: 'active nearby NPC conversation required' };
  }
  const now = Date.now();
  const rate = state._nodeUOAiRate ??= { since: now, count: 0 };
  if (now - rate.since > 60_000) {
    rate.since = now;
    rate.count = 0;
  }
  if (++rate.count > 12) return { ok: false, error: 'dialogue rate limit reached' };
  const prompt = String(payload.prompt ?? '').trim().slice(0, 1000);
  if (!prompt) return { ok: false, error: 'prompt is required' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.ai.timeoutMs ?? 5000);
  const signal = cancellationSignal
    ? AbortSignal.any([controller.signal, cancellationSignal]) : controller.signal;
  try {
    progress?.({ phase: 'provider', completed: 0, total: 1 });
    const response = await fetch(settings.ai.endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(settings.ai.apiKey ? { authorization: `Bearer ${settings.ai.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.ai.model || undefined,
        task: 'npc-dialogue',
        npc: { name: npc.name, title: npc.title, kind: npc.kind, role: npc.role },
        player: { name: state.mobile?.name },
        history: (session.history ?? []).slice(-8),
        prompt,
        constraints: { maxCharacters: 2000, serverActions: 'none' },
      }),
    });
    if (!response.ok) return { ok: false, error: `AI provider HTTP ${response.status}` };
    const value = JSON.parse(await boundedResponseText(response, 128 * 1024));
    const line = String(value.text ?? value.output ?? '').trim().slice(0, 2000);
    if (!line) return { ok: false, error: 'AI provider returned no dialogue' };
    const result = {
      ok: true,
      npcSerial: npc.serial >>> 0,
      speaker: String(npc.name ?? 'NPC').slice(0, 80),
      text: line,
      expression: String(value.expression ?? 'neutral').slice(0, 48),
      generated: true,
    };
    session.history.push({ speaker: result.speaker, text: result.text, generated: true });
    if (session.history.length > 16) session.history.splice(0, session.history.length - 16);
    progress?.({ phase: 'provider', completed: 1, total: 1 });
    return result;
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? 'AI provider timed out' : String(error?.message ?? error).slice(0, 256),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Authoritative operations for negotiated JSON features. */
export function handleNodeUOFeatureRequest(state, message, options = {}) {
  const { npcDialogs, signal, progress } = options ?? {};
  const envelope = message?.payload ?? {};
  const payload = envelope?.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  const requestId = Number(envelope.requestId ?? payload.requestId) >>> 0;
  let operation = String(envelope.operation ?? payload.operation ?? '').trim().toLowerCase();
  const wave7 = handleNodeUOWave7Feature(state, { ...message, payload });
  if (wave7 !== undefined) return wave7;
  const wave6 = handleNodeUOWave6Feature(state, { ...message, payload });
  if (wave6 !== undefined) return wave6;
  const wave5 = handleNodeUOWave5Feature(state, { ...message, payload });
  if (wave5 !== undefined) return wave5;
  const wave4 = handleNodeUOWave4Feature(state, { ...message, payload }, { npcDialogs });
  if (wave4 !== undefined) return wave4;
  const wave3 = handleNodeUOWave3Feature(state, { ...message, payload });
  if (wave3 !== undefined) return wave3;

  if (message.feature === 'spell.composer') {
    const eventKind = Number(envelope.eventKind);
    if (!operation) operation = eventKind === NodeUOSpellComposerMessage.Publish ? 'publish'
      : eventKind === NodeUOSpellComposerMessage.Scribe ? 'scribe' : 'save';
    if (operation === 'publish') return state.ctx?.spellComposer?.publishDraft?.(state, requestId, payload);
    if (operation === 'scribe') return state.ctx?.spellComposer?.scribeDraft?.(state, requestId, payload);
    return state.ctx?.spellComposer?.acceptDraft?.(state, requestId, payload);
  }
  if (message.feature === 'character.specializations') {
    const resetRequested = operation === 'reset'
      || Number(envelope.eventKind) === NodeUOSpecializationMessage.Reset;
    const result = resetRequested
      ? { ok: true, message: `Refunded ${specializations.reset(state.mobile)} point(s).` }
      : specializations.allocate(state.mobile, payload?.nodeId);
    const response = resetRequested ? result : {
      ok: result.ok,
      message: result.ok ? `Learned ${result.node.label}.` : result.error,
    };
    specializations.sendResult(state, requestId, response);
    return { ...response, ...specializations.snapshot(state.mobile) };
  }
  if (message.feature === 'housing.collaboration') {
    const { house } = editableHouse(state, payload.houseSerial, true);
    if (!house) return { ok: false, error: 'an owned or co-owned house is required' };
    const houseSerial = Number(house.multiSerial ?? house.serial ?? house.id) >>> 0;
    const presence = housePresence.get(houseSerial) ?? new Map();
    housePresence.set(houseSerial, presence);
    const peerKey = String(state.id);
    if (operation === 'leave') presence.delete(peerKey);
    else presence.set(peerKey, {
      state,
      cursor: operation === 'cursor' ? {
        x: Number(payload.x) | 0,
        y: Number(payload.y) | 0,
        z: Number(payload.z) | 0,
        tool: String(payload.tool ?? '').slice(0, 32),
      } : presence.get(peerKey)?.cursor ?? null,
      updatedAt: Date.now(),
    });
    const result = publishPresence(house, presence);
    if (presence.size === 0) housePresence.delete(houseSerial);
    return result;
  }
  if (message.feature === 'housing.tools') {
    if (!operation) operation = HOUSE_OPERATION_BY_KIND.get(Number(envelope.eventKind)) ?? '';
    return houseTool(state, operation, payload);
  }
  if (message.feature === 'npc.dialog') {
    const close = operation === 'close'
      || Number(envelope.eventKind) === NodeUONpcDialogMessage.Close;
    npcDialogs?.().handleReply(
      state,
      close ? NodeUONpcDialogMessage.Close : NodeUONpcDialogMessage.Select,
      requestId,
      payload,
    );
    return { ok: true };
  }
  if (message.feature === 'ai.inspector') {
    if (!isStaff(state)) return { ok: false, error: 'staff access required' };
    const serial = Number(payload.serial) >>> 0;
    const mob = state.ctx.world?.mobiles?.get?.(serial);
    if (!mob || mob.isPlayer) return { ok: false, error: 'NPC not found' };
    const inspection = state.ctx.ai?.inspect?.(serial) ?? {
      serial: mob.serial, name: mob.name, behavior: mob.ai ?? mob.behavior ?? null,
      position: { x: mob.x, y: mob.y, z: mob.z, map: mob.map },
      target: mob.target?.serial ?? mob.combatant ?? null,
      state: mob.aiState ?? mob._aiState ?? null,
    };
    const path = payload.includePath === false ? null
      : state.ctx.ai?.previewPath?.(serial, Number(payload.targetSerial) >>> 0, {
        maxNodes: Math.max(128, Math.min(4096, Number(payload.maxNodes) | 0 || 2048)),
      }) ?? null;
    return { ok: true, npc: { kind: mob.kind ?? null, ...inspection, path } };
  }
  if (message.feature === 'party.markers') {
    const { party, members } = partyMemberSerials(state);
    const partyId = String(party?.id ?? `solo:${state.mobile?.serial >>> 0}`);
    const markers = partyMarkers.get(partyId) ?? new Map();
    partyMarkers.set(partyId, markers);
    while (partyMarkers.size > 10_000) partyMarkers.delete(partyMarkers.keys().next().value);
    if (Array.isArray(payload.markers)) {
      for (const key of markers.keys()) if (String(key).startsWith('location:')) markers.delete(key);
      for (const [index, source] of payload.markers.slice(0, 64).entries()) {
        const x = Number(source?.x);
        const y = Number(source?.y);
        const map = Number(source?.map ?? source?.facet);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(map)) continue;
        const id = String(source.id ?? source.name ?? index).slice(0, 64);
        markers.set(`location:${id}`, {
          id,
          name: String(source.name ?? 'Party marker').slice(0, 80),
          x: Math.max(0, Math.min(65535, x | 0)),
          y: Math.max(0, Math.min(65535, y | 0)),
          map: Math.max(0, Math.min(255, map | 0)),
          color: Number(source.color) & 0xffffff,
          kind: 'location',
          updatedBy: state.mobile?.serial >>> 0,
          updatedAt: Date.now(),
        });
      }
      return { ok: true, ...publishMarkers(state, partyId, markers, members) };
    }
    const serial = Number(payload.serial) >>> 0;
    if (!members.includes(serial)) return { ok: false, error: 'marker target must be a party member' };
    const marker = String(payload.marker ?? '').trim().slice(0, 32);
    if (marker) markers.set(serial, {
      serial,
      marker,
      label: String(payload.label ?? '').slice(0, 64),
      updatedBy: state.mobile?.serial >>> 0,
      updatedAt: Date.now(),
    });
    else markers.delete(serial);
    return { ok: true, ...publishMarkers(state, partyId, markers, members) };
  }
  if (message.feature === 'social.pings') {
    const { party, members } = partyMemberSerials(state);
    const partyId = String(party?.id ?? `solo:${state.mobile?.serial >>> 0}`);
    const pings = partyPings.get(partyId) ?? new Map();
    partyPings.set(partyId, pings);
    while (partyPings.size > 10_000) partyPings.delete(partyPings.keys().next().value);
    cleanPartyPings(pings);
    if (operation === 'list' || !operation) return { ok: true, ...publishPartyPings(state, partyId, pings, members) };
    if (operation === 'remove') {
      const existing = pings.get(String(payload.id ?? ''));
      if (existing?.createdBy !== (state.mobile?.serial >>> 0) && party?.leader !== state.mobile?.serial) {
        return { ok: false, error: 'only the creator or party leader can remove this ping' };
      }
      pings.delete(String(payload.id ?? ''));
      return { ok: true, ...publishPartyPings(state, partyId, pings, members) };
    }
    if (operation !== 'publish') return { ok: false, error: 'unknown ping operation' };
    const source = payload.ping ?? payload;
    const x = Number(source.x ?? state.mobile?.x);
    const y = Number(source.y ?? state.mobile?.y);
    const map = Number(source.map ?? state.mobile?.map);
    if (![x, y, map].every(Number.isFinite)) return { ok: false, error: 'valid ping location required' };
    const id = crypto.randomUUID();
    const pingNow = Date.now();
    const ttlMs = Math.max(1000, Math.min(60_000, Number(source.ttlMs) | 0 || 15_000));
    pings.set(id, {
      id, kind: String(source.kind ?? 'attention').slice(0, 32),
      label: String(source.label ?? '').slice(0, 120),
      x: Math.max(0, Math.min(0xffff, x | 0)), y: Math.max(0, Math.min(0xffff, y | 0)),
      z: Math.max(-128, Math.min(127, Number(source.z ?? state.mobile?.z) | 0)),
      map: Math.max(0, Math.min(255, map | 0)), color: Number(source.color) & 0xffffff,
      createdBy: state.mobile?.serial >>> 0, createdAt: pingNow, expiresAt: pingNow + ttlMs,
    });
    return { ok: true, id, ...publishPartyPings(state, partyId, pings, members) };
  }
  if (message.feature === 'world.events') {
    if (operation === 'publish') {
      if (!isStaff(state)) return { ok: false, error: 'staff access required' };
      return publishNodeUOWorldEvent(state.ctx.connections, payload.event ?? payload, state.mobile);
    }
    const cursor = Math.max(0, Number(payload.cursor) >>> 0);
    const limit = Math.max(1, Math.min(256, Number(payload.limit) | 0 || 64));
    return { ok: true, cursor: nextWorldEventCursor,
      events: worldEvents.filter((event) => event.cursor > cursor).slice(-limit) };
  }
  if (message.feature === 'world.annotations') return handleWorldAnnotations(state, operation, payload);
  if (message.feature === 'editor.collaboration') return handleEditorCollaboration(state, operation, payload);
  if (message.feature === 'editor.transactions') return handleEditorTransaction(state, operation, payload);
  if (message.feature === 'spectator.replay') {
    if (!isStaff(state)) return { ok: false, error: 'staff access required' };
    const limit = Math.max(1, Math.min(2000, Number(payload.limit) | 0 || 256));
    return { ok: true, packets: diagnostics.replaySnapshot(limit),
      simulation: diagnostics.simulationReplaySnapshot(limit), payloadsRedacted: true };
  }
  if (message.feature === 'instance.handoff') {
    const settings = state.ctx.nodeUOSettings?.snapshot?.() ?? {};
    const route = settings.instances?.find?.((entry) => entry.enabled !== false && entry.secret
      && (!payload.id || entry.id === String(payload.id)));
    if (!route) return { ok: false, error: 'instance route unavailable' };
    const issuedAt = Date.now();
    const expiresAt = issuedAt + 30_000;
    const claims = {
      type: 'nodeuo-instance',
      route: route.id,
      account: state.accountName,
      mobileSerial: state.mobile?.serial >>> 0,
      issuedAt,
      expiresAt,
      nonce: crypto.randomBytes(12).toString('base64url'),
    };
    return {
      ok: true,
      id: route.id,
      label: route.label,
      url: route.url,
      maps: route.maps,
      token: signedToken(claims, route.secret),
      expiresAt,
    };
  }
  if (message.feature === 'voice.authorization') {
    if (state.mobile?._nodeUOConsent?.categories?.voice !== true) {
      return { ok: false, consentRequired: 'voice', error: 'voice consent is required' };
    }
    const settings = state.ctx.nodeUOSettings?.snapshot?.() ?? {};
    if (!settings.voice?.enabled || !settings.voice.endpoint || !settings.voice.secret) {
      return { ok: false, error: 'voice service unavailable' };
    }
    const { party } = partyMemberSerials(state);
    const scope = party ? `party:${party.id}` : `self:${state.mobile?.serial >>> 0}`;
    const issuedAt = Date.now();
    const expiresAt = issuedAt + settings.voice.tokenTtlMs;
    const claims = {
      type: 'nodeuo-voice',
      scope,
      account: state.accountName,
      mobileSerial: state.mobile?.serial >>> 0,
      issuedAt,
      expiresAt,
      nonce: crypto.randomBytes(12).toString('base64url'),
    };
    return {
      ok: true,
      endpoint: settings.voice.endpoint,
      scope,
      token: signedToken(claims, settings.voice.secret),
      expiresAt,
    };
  }
  if (message.feature === 'cinematic.timeline') {
    const settings = state.ctx.nodeUOSettings?.snapshot?.() ?? {};
    const id = String(payload.id ?? '').slice(0, 64);
    const cues = settings.cinematics?.[id];
    return Array.isArray(cues)
      ? { ok: true, id, serverStartsAt: Date.now() + 250, cues }
      : { ok: false, error: 'cinematic not found' };
  }
  if (message.feature === 'npc.generative') return generateNpcLine(state, payload, { signal, progress });
  return { ok: false, error: `unsupported feature operation: ${message.feature}` };
}

export function cleanupNodeUOFeatureState(state) {
  for (const [houseSerial, presence] of housePresence) {
    presence.delete(String(state?.id));
    if (presence.size === 0) housePresence.delete(houseSerial);
  }
  cleanupEditorCollaboration(state);
  cleanupEditorTransactions(state);
  cleanupNodeUORpc(state);
  cleanupNodeUOWave3State(state);
  cleanupNodeUOWave4State(state);
  cleanupNodeUOWave5State(state);
  cleanupNodeUOWave6State(state);
  cleanupNodeUOWave7State(state);
}
