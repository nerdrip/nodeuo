import crypto from 'node:crypto';
import {
  buildNodeUOConformanceFixtures,
  NODEUO_FEATURE_CATALOG,
  NODEUO_FEATURE_DEPENDENCIES,
  NODEUO_FEATURE_LIFECYCLE,
  NodeUOErrorCode,
  createNodeUOError,
  normalizeSubscription,
} from '@uo/nodeuo-protocol';
import { signNodeUOContent } from './nodeuo-wave3.js';

const ACCESS = Object.freeze({ Player: 0, Counselor: 1, Counsellor: 1, Seer: 2,
  GM: 3, GameMaster: 3, Admin: 4, Administrator: 4 });
const RESUME_SECRET = crypto.randomBytes(32);
const LOOT_MODES = new Set(['free-for-all', 'round-robin', 'leader', 'need-before-greed']);

const CLASSIC_FALLBACKS = Object.freeze({
  'world.layers': { mode: 'server-filter', classic: 'The server sends only entities belonging to the player layer.' },
  'world.live-event-director': { mode: 'world-and-message', classic: 'Ordinary mobiles, items, weather and journal messages represent the event.' },
  'world.codex': { mode: 'gump-or-journal', classic: 'Codex information may be shown through a standard gump or journal text.' },
  'party.loot-policy': { mode: 'server-authoritative', classic: 'The policy is enforced server-side; the classic client needs no extension.' },
  'ui.safe-schema': { mode: 'standard-gump', classic: 'The server renders a standard UO gump or uses the existing packet workflow.' },
  'diagnostics.client-frame': { mode: 'omit', classic: 'No browser frame telemetry is expected from classic clients.' },
});

const RETRY_POLICIES = Object.freeze({
  [NodeUOErrorCode.RateLimited]: { retryable: true, strategy: 'server-delay', minimumDelayMs: 250, maximumAttempts: 3 },
  [NodeUOErrorCode.Overloaded]: { retryable: true, strategy: 'exponential-jitter', minimumDelayMs: 500, maximumAttempts: 4 },
  [NodeUOErrorCode.Timeout]: { retryable: true, strategy: 'exponential-jitter', minimumDelayMs: 250, maximumAttempts: 2 },
  [NodeUOErrorCode.Conflict]: { retryable: false, strategy: 'refresh-revision', maximumAttempts: 0 },
  [NodeUOErrorCode.PreconditionsFailed]: { retryable: false, strategy: 'refresh-state', maximumAttempts: 0 },
});

const PRIVACY_LABELS = Object.freeze({
  'diagnostics.client-frame': { category: 'performance', retention: 'session', fields: {
    samples: 'performance-sensitive', renderer: 'device-capability', deviceLost: 'diagnostic' } },
  'support.evidence': { category: 'diagnostics', retention: 'case-policy', fields: {
    traceId: 'pseudonymous', context: 'operator-reviewed' } },
  'moderation.case': { category: 'diagnostics', retention: 'moderation-policy', fields: {
    summary: 'user-provided', eventIds: 'pseudonymous' } },
  'voice.authorization': { category: 'voice', retention: 'token-lifetime', fields: {
    token: 'secret', scope: 'social-membership' } },
});

const SAFE_FORMS = Object.freeze({
  'support.report': { id: 'support.report', title: 'Contact shard support', submitFeature: 'moderation.case',
    fields: [{ id: 'category', type: 'select', required: true, options: ['bug', 'harassment', 'stuck', 'other'] },
      { id: 'summary', type: 'textarea', required: true, maxLength: 2000 }] },
  'accessibility.preferences': { id: 'accessibility.preferences', title: 'Accessibility preferences', submitFeature: 'ui.accessibility',
    fields: [{ id: 'scale', type: 'number', minimum: 0.75, maximum: 3 },
      { id: 'contrast', type: 'select', options: ['normal', 'high'] },
      { id: 'reduceMotion', type: 'checkbox' }, { id: 'screenReader', type: 'checkbox' }] },
  'codex.search': { id: 'codex.search', title: 'Search discoveries', submitFeature: 'world.codex',
    fields: [{ id: 'query', type: 'text', maxLength: 128 }] },
});

function clean(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);
}

function rank(state) {
  const key = clean(state?.account?.accessLevel, 32);
  return ACCESS[key] ?? ACCESS[key[0]?.toUpperCase() + key.slice(1)] ?? 0;
}

function isStaff(state) { return rank(state) >= ACCESS.Seer; }

function error(code, message, options) { return createNodeUOError(code, message, options); }

function cleanupLeases(state, now = Date.now()) {
  const leases = state._nodeUOSubscriptionLeases;
  if (!leases) return;
  for (const [id, row] of leases) {
    if (row.expiresAt > now) continue;
    leases.delete(id);
    if (state._nodeUOSubscriptions?.get?.(row.target)?._leaseId === id) state._nodeUOSubscriptions.delete(row.target);
  }
}

function subscriptionLease(state, payload) {
  cleanupLeases(state);
  const operation = clean(payload.operation || 'list', 32).toLowerCase();
  const leases = state._nodeUOSubscriptionLeases ??= new Map();
  if (operation === 'list') return { ok: true, serverTime: Date.now(), leases: [...leases.values()] };
  const requestedId = clean(payload.leaseId, 128);
  if (operation === 'release') {
    const row = leases.get(requestedId); if (!row) return error(NodeUOErrorCode.NotFound, 'subscription lease not found');
    leases.delete(requestedId);
    if (state._nodeUOSubscriptions?.get?.(row.target)?._leaseId === requestedId) state._nodeUOSubscriptions.delete(row.target);
    return { ok: true, leaseId: requestedId, released: true };
  }
  if (operation === 'renew') {
    const row = leases.get(requestedId); if (!row) return error(NodeUOErrorCode.NotFound, 'subscription lease not found');
    const ttlMs = Math.max(5_000, Math.min(5 * 60_000, Number(payload.ttlMs) | 0 || 60_000));
    row.expiresAt = Date.now() + ttlMs; row.renewals++;
    return { ok: true, lease: { ...row }, serverTime: Date.now() };
  }
  if (operation !== 'acquire') return error(NodeUOErrorCode.InvalidArgument, 'operation must be acquire, renew, release or list');
  if (leases.size >= 32) return error(NodeUOErrorCode.RateLimited, 'subscription lease limit reached', { retryable: true, retryAfterMs: 5_000 });
  let subscription;
  try { subscription = normalizeSubscription(payload); }
  catch (cause) { return error(NodeUOErrorCode.InvalidArgument, cause.message); }
  if (!state.nodeUOFeatures?.has?.(subscription.target)) {
    return error(NodeUOErrorCode.PermissionDenied, 'subscription target is not negotiated');
  }
  const ttlMs = Math.max(5_000, Math.min(5 * 60_000, Number(payload.ttlMs) | 0 || 60_000));
  const leaseId = crypto.randomUUID(); const now = Date.now();
  const row = { leaseId, target: subscription.target, createdAt: now, expiresAt: now + ttlMs, renewals: 0,
    cursor: Math.max(0, Number(payload.cursor) || 0), subscription };
  leases.set(leaseId, row); state._nodeUOSubscriptions ??= new Map();
  state._nodeUOSubscriptions.set(subscription.target, Object.freeze({ ...subscription, _leaseId: leaseId }));
  return { ok: true, lease: { ...row }, serverTime: now };
}

function resumeToken(state, stream, cursor) {
  const body = Buffer.from(JSON.stringify({ session: String(state.id), stream, cursor,
    expiresAt: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', RESUME_SECRET).update(body).digest('base64url')}`;
}

function verifyResumeToken(state, token, stream) {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;
  const expected = crypto.createHmac('sha256', RESUME_SECRET).update(body).digest();
  let supplied; try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.session !== String(state.id) || claims.stream !== stream || claims.expiresAt <= Date.now()) return null;
    return Math.max(0, Number(claims.cursor) | 0);
  } catch { return null; }
}

function resumableStream(state, payload) {
  const stream = clean(payload.stream, 64).toLowerCase();
  const tokenCursor = payload.token ? verifyResumeToken(state, payload.token, stream) : null;
  if (payload.token && tokenCursor == null) return error(NodeUOErrorCode.InvalidArgument, 'resume token is invalid or expired');
  const cursor = tokenCursor ?? Math.max(0, Number(payload.cursor) | 0);
  const limit = Math.max(1, Math.min(500, Number(payload.limit) | 0 || 100));
  let entries = [];
  if (stream === 'incidents') {
    if (!isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'staff access required');
    entries = [...(state.ctx.platformOperations?.incidents?.({ limit: 1000 }).incidents ?? [])].reverse();
  } else if (stream === 'moderation') {
    if (!isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'staff access required');
    entries = [...(state.ctx.platformOperations?.listModerationCases?.({ limit: 500 }).cases ?? [])].reverse();
  } else if (stream === 'codex') entries = state.mobile?.nodeUOCodex ?? [];
  else if (stream === 'live-events') entries = state.ctx.platformOperations?.listLiveEvents?.({ includeCompleted: true }).events ?? [];
  else return error(NodeUOErrorCode.NotFound, 'resumable stream not found');
  const page = entries.slice(cursor, cursor + limit); const nextCursor = cursor + page.length;
  return { ok: true, stream, cursor, nextCursor, complete: nextCursor >= entries.length,
    entries: page, resumeToken: resumeToken(state, stream, nextCursor) };
}

function protocolPolicy(state, payload) {
  const feature = clean(payload.feature, 128).toLowerCase();
  const entries = NODEUO_FEATURE_CATALOG.filter((row) => !feature || row.id === feature).map((row) => ({
    feature: row.id, direction: row.direction, delivery: row.delivery,
    enabled: state.ctx.nodeUOSettings?.value?.features?.[row.id] !== false,
    negotiated: state.nodeUOFeatures?.has?.(row.id) ?? false,
    dependencies: NODEUO_FEATURE_DEPENDENCIES[row.id] ?? [],
    lifecycle: NODEUO_FEATURE_LIFECYCLE[row.id] ?? { status: 'stable', since: '2.0' },
    constraints: { maximumPayloadBytes: 512 * 1024, requestsPerSecond: isStaff(state) ? 60 : 20,
      requiresStaff: /^(?:admin\.|debug\.|editor\.|script\.)/u.test(row.id) },
  }));
  return { ok: true, entries, principal: { accessLevel: state.account?.accessLevel ?? 'Player', staff: isStaff(state) } };
}

function costHints(state, payload) {
  const feature = clean(payload.feature, 128).toLowerCase();
  const measured = state.ctx.protocolCosts?.snapshot?.({ historyLimit: 6 })?.features ?? [];
  const rows = NODEUO_FEATURE_CATALOG.filter((row) => !feature || row.id === feature).map((row) => {
    const metric = measured.find((entry) => entry.feature === row.id);
    return { feature: row.id, delivery: row.delivery,
      requestWeight: row.delivery === 'reliable' ? 2 : 1, measuredAvgMs: metric?.avgMs ?? null,
      measuredMaxMs: metric?.maxMs ?? null, measuredBytes: metric ? metric.bytesIn + metric.bytesOut : null };
  });
  return { ok: true, measured: true, hints: rows };
}

function conformance(payload) {
  const requested = new Set((Array.isArray(payload.probes) ? payload.probes : []).map(String));
  const fixtureSet = buildNodeUOConformanceFixtures();
  const fixtures = fixtureSet.fixtures.filter((row) => !requested.size || requested.has(row.feature)).slice(0, 128);
  return { ok: fixtures.every((row) => row.valid), nonce: clean(payload.nonce, 128),
    schemaVersion: fixtureSet.schemaVersion, fingerprint: fixtureSet.fingerprint, fixtures };
}

function signedContent(state, payload) {
  const snapshot = state.ctx.contentReleases?.snapshot?.(); const requested = clean(payload.releaseId, 128);
  const release = !requested || snapshot?.active?.id === requested ? snapshot?.active
    : snapshot?.staged?.[requested] ?? snapshot?.history?.find?.((row) => row.id === requested);
  if (!release) return error(NodeUOErrorCode.NotFound, 'content release not found');
  const document = { releaseId: release.id, fingerprint: release.fingerprint,
    revision: release.revision ?? snapshot.revision, files: release.files, issuedAt: Date.now() };
  return { ok: true, document, ...signNodeUOContent(state.ctx.saveDir ?? '.', document) };
}

function clientFrames(state, payload) {
  if (state.mobile?._nodeUOConsent?.categories?.performance !== true) {
    return error(NodeUOErrorCode.PermissionDenied, 'performance consent is required', { recovery: 'request-consent' });
  }
  const samples = (Array.isArray(payload.samples) ? payload.samples : []).slice(-120).map((sample) => ({
    at: Math.max(0, Number(sample?.at) || Date.now()), frameMs: Math.max(0, Math.min(2_000, Number(sample?.frameMs) || 0)),
    updateMs: Math.max(0, Math.min(2_000, Number(sample?.updateMs) || 0)),
    drawMs: Math.max(0, Math.min(2_000, Number(sample?.drawMs) || 0)),
    scripts: (Array.isArray(sample?.scripts) ? sample.scripts : []).slice(0, 16).map((row) => ({
      source: clean(row?.source, 160), duration: Math.max(0, Math.min(2_000, Number(row?.duration) || 0)),
    })),
  }));
  state._nodeUOFrameDiagnostics = { receivedAt: Date.now(), renderer: clean(payload.renderer, 32),
    deviceLost: payload.deviceLost === true, samples };
  return { ok: true, accepted: samples.length, retained: 'session', rawInput: false };
}

function worldLayers(state, payload) {
  const operation = clean(payload.operation || 'get', 32).toLowerCase();
  let target = state.mobile; const targetSerial = Number(payload.targetSerial) >>> 0;
  if (targetSerial && targetSerial !== (state.mobile?.serial >>> 0)) {
    if (!isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'staff access required');
    target = state.ctx.world?.mobiles?.get?.(targetSerial);
  }
  if (!target) return error(NodeUOErrorCode.NotFound, 'mobile not found');
  if (operation === 'get') return { ok: true, targetSerial: target.serial >>> 0, layer: target.nodeUOWorldLayer || 'base' };
  if (operation !== 'set' || !isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'staff access required to change world layers');
  const layer = clean(payload.layer || 'base', 96).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/u.test(layer)) return error(NodeUOErrorCode.InvalidArgument, 'invalid world layer');
  target.nodeUOWorldLayer = layer;
  if (target.client) state.ctx.handlers?.refreshSurroundings?.(target.client);
  return { ok: true, targetSerial: target.serial >>> 0, layer, serverFiltered: true };
}

function liveEventDirector(state, payload) {
  const operation = clean(payload.operation || 'list', 32).toLowerCase(); const platform = state.ctx.platformOperations;
  if (!platform) return error(NodeUOErrorCode.Unavailable, 'live event service unavailable');
  if (operation === 'list') return platform.listLiveEvents({ includeCompleted: payload.includeCompleted === true });
  if (!isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'staff access required');
  if (operation === 'upsert') return platform.upsertLiveEvent(payload.event ?? payload, state.accountName);
  if (operation === 'transition') return platform.transitionLiveEvent(payload.eventId, payload, state.accountName);
  return error(NodeUOErrorCode.InvalidArgument, 'unknown live event operation');
}

function codex(state, payload) {
  if (!state.mobile) return error(NodeUOErrorCode.Unavailable, 'player unavailable');
  const operation = clean(payload.operation || 'list', 32).toLowerCase();
  state.mobile.nodeUOCodex ??= [];
  if (operation === 'discover') {
    if (!isStaff(state)) return error(NodeUOErrorCode.PermissionDenied, 'codex discoveries are server-authored');
    const source = payload.entry ?? {}; const id = clean(source.id || payload.entryId, 128).toLowerCase();
    if (!id || !/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(id)) return error(NodeUOErrorCode.InvalidArgument, 'valid codex entry id is required');
    const existing = state.mobile.nodeUOCodex.find((row) => row.id === id);
    const entry = { id, kind: clean(source.kind || 'lore', 64), title: clean(source.title || id, 160),
      text: clean(source.text, 4_096), links: (Array.isArray(source.links) ? source.links : []).slice(0, 32).map((value) => clean(value, 128)),
      discoveredAt: existing?.discoveredAt ?? Date.now() };
    if (existing) Object.assign(existing, entry); else state.mobile.nodeUOCodex.push(entry);
    state.mobile.nodeUOCodex = state.mobile.nodeUOCodex.slice(-2_000);
    return { ok: true, entry };
  }
  const query = clean(payload.query, 128).toLowerCase();
  const entries = state.mobile.nodeUOCodex.filter((row) => !query
    || `${row.id} ${row.kind} ${row.title} ${row.text}`.toLowerCase().includes(query)).slice(0, 500);
  return { ok: true, entries, total: state.mobile.nodeUOCodex.length };
}

function lootPolicy(state, payload) {
  const party = state.ctx.partyRegistry?.partyOf?.(state.mobile?.serial);
  if (!party) return error(NodeUOErrorCode.NotFound, 'party not found');
  party._nodeUOLootPolicy ??= { revision: 1, mode: 'free-for-all', threshold: 0, updatedAt: Date.now(), updatedBy: party.leader };
  const operation = clean(payload.operation || 'get', 32).toLowerCase();
  if (operation === 'get') return { ok: true, policy: { ...party._nodeUOLootPolicy } };
  if (operation !== 'set' || party.leader !== (state.mobile?.serial >>> 0)) {
    return error(NodeUOErrorCode.PermissionDenied, 'only the party leader can update loot policy');
  }
  if (payload.expectedRevision != null && Number(payload.expectedRevision) !== party._nodeUOLootPolicy.revision) {
    return error(NodeUOErrorCode.Conflict, 'loot policy revision conflict', { details: { current: party._nodeUOLootPolicy } });
  }
  const mode = clean(payload.policy?.mode, 32);
  if (!LOOT_MODES.has(mode)) return error(NodeUOErrorCode.InvalidArgument, 'invalid loot policy mode');
  party._nodeUOLootPolicy = { revision: party._nodeUOLootPolicy.revision + 1, mode,
    threshold: Math.max(0, Math.min(1_000_000_000, Number(payload.policy?.threshold) | 0)),
    updatedAt: Date.now(), updatedBy: state.mobile.serial >>> 0 };
  return { ok: true, policy: { ...party._nodeUOLootPolicy } };
}

function safeUi(state, payload) {
  const operation = clean(payload.operation || 'list', 32).toLowerCase(); const formId = clean(payload.formId, 96).toLowerCase();
  if (operation === 'list') return { ok: true, forms: Object.values(SAFE_FORMS) };
  const form = SAFE_FORMS[formId]; if (!form) return error(NodeUOErrorCode.NotFound, 'safe form not found');
  if (operation === 'get') return { ok: true, form };
  if (operation !== 'submit') return error(NodeUOErrorCode.InvalidArgument, 'operation must be list, get or submit');
  const values = payload.values ?? {};
  if (formId === 'support.report') {
    if (state.mobile?._nodeUOConsent?.categories?.diagnostics !== true) return error(NodeUOErrorCode.PermissionDenied, 'diagnostics consent is required');
    const now = Date.now(); const previous = Number(state._nodeUOModerationCreateAt) || 0;
    if (!isStaff(state) && now - previous < 30_000) return error(NodeUOErrorCode.RateLimited,
      'wait before creating another support report', { retryable: true, retryAfterMs: 30_000 - (now - previous) });
    state._nodeUOModerationCreateAt = now;
    return state.ctx.platformOperations?.createModerationCase?.({ reporter: state.accountName,
      mobileSerial: state.mobile?.serial, category: values.category, summary: values.summary })
      ?? error(NodeUOErrorCode.Unavailable, 'moderation service unavailable');
  }
  if (formId === 'accessibility.preferences') {
    state.mobile.nodeUOAccessibility = { ...state.mobile.nodeUOAccessibility,
      scale: Math.max(.75, Math.min(3, Number(values.scale) || 1)),
      contrast: values.contrast === 'high' ? 'high' : 'normal', reduceMotion: values.reduceMotion === true,
      screenReader: values.screenReader === true };
    return { ok: true, values: state.mobile.nodeUOAccessibility };
  }
  if (formId === 'codex.search') return codex(state, { operation: 'list', query: values.query });
  return error(NodeUOErrorCode.Unsupported, 'form submit is not implemented');
}

export function handleNodeUOWave7Feature(state, message) {
  const payload = message.payload ?? {};
  switch (message.feature) {
    case 'protocol.policy': return protocolPolicy(state, payload);
    case 'protocol.subscription-leases': return subscriptionLease(state, payload);
    case 'protocol.resumable-streams': return resumableStream(state, payload);
    case 'protocol.retry-policy': return { ok: true, policies: payload.code ? { [payload.code]: RETRY_POLICIES[payload.code] } : RETRY_POLICIES };
    case 'protocol.cost-hints': return costHints(state, payload);
    case 'protocol.compatibility-fallbacks': {
      const all = Object.fromEntries(NODEUO_FEATURE_CATALOG.map((row) => [row.id,
        CLASSIC_FALLBACKS[row.id] ?? { mode: 'omit-extension',
          classic: 'The enhanced feature is omitted; the standard UO packet flow remains authoritative.' }]));
      return { ok: true, fallbacks: payload.feature ? { [payload.feature]: all[payload.feature] } : all };
    }
    case 'protocol.conformance': return conformance(payload);
    case 'protocol.privacy-labels': return { ok: true, labels: payload.feature
      ? { [payload.feature]: PRIVACY_LABELS[payload.feature] } : PRIVACY_LABELS };
    case 'protocol.signed-content': return signedContent(state, payload);
    case 'diagnostics.client-frame': return clientFrames(state, payload);
    case 'world.layers': return worldLayers(state, payload);
    case 'world.live-event-director': return liveEventDirector(state, payload);
    case 'world.codex': return codex(state, payload);
    case 'party.loot-policy': return lootPolicy(state, payload);
    case 'ui.safe-schema': return safeUi(state, payload);
    default: return undefined;
  }
}

export function cleanupNodeUOWave7State(state) {
  state?._nodeUOSubscriptionLeases?.clear?.();
  delete state?._nodeUOSubscriptionLeases;
  delete state?._nodeUOFrameDiagnostics;
}
