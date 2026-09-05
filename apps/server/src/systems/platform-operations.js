import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CASE_STATUSES = new Set(['open', 'investigating', 'resolved', 'dismissed']);
const APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'consumed', 'expired']);
const PREVIEW_TTL_MIN = 30_000;
const PREVIEW_TTL_MAX = 30 * 60_000;
const MAX_CASES = 10_000;
const MAX_INCIDENTS = 5_000;
const MAX_APPROVALS = 2_000;
const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const ENGINE_EVENT_PRODUCERS = Object.freeze([
  ['live-event:updated', '<engine:platform-operations>'],
  ['live-event:transition', '<engine:platform-operations>'],
]);

function clean(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedJson(value, maxBytes = 256 * 1024) {
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
  return JSON.parse(encoded);
}

function walkJavaScript(root, limit = 10_000) {
  const files = [];
  const pending = [root];
  while (pending.length && files.length < limit) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.script-studio-')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile() && /\.(?:js|mjs)$/iu.test(entry.name)) files.push(absolute);
      if (files.length >= limit) break;
    }
  }
  return files;
}

function eventReferences(source, expression) {
  const found = [];
  for (const match of source.matchAll(expression)) found.push(match[1]);
  return found;
}

/**
 * Durable, low-frequency operational state shared by the game protocol and
 * admin panel. It deliberately contains no gameplay hot-path work. Preview
 * mutations are kept in isolated memory and can only be applied by an
 * explicit, separately reviewed publishing path.
 */
export class PlatformOperations {
  constructor({ saveDir, scriptsDir, emitEvent = null }) {
    this.file = path.join(path.resolve(saveDir), 'platform-operations.json');
    this.scriptsDir = path.resolve(scriptsDir);
    this.state = {
      schema: 1, revision: 1,
      policy: { approvalsRequired: false, requiredApprovers: 1 },
      moderationCases: [], approvals: [], incidents: [], maintenance: [], liveEvents: [],
    };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...loaded, policy: { ...this.state.policy, ...(loaded.policy ?? {}) } };
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[platform-operations] ${error.message}`);
    }
    for (const key of ['moderationCases', 'approvals', 'incidents', 'maintenance', 'liveEvents']) {
      if (!Array.isArray(this.state[key])) this.state[key] = [];
    }
    this.state.policy.approvalsRequired = this.state.policy.approvalsRequired === true;
    this.state.policy.requiredApprovers = Math.max(1, Math.min(3,
      Number(this.state.policy.requiredApprovers) | 0 || 1));
    for (const row of this.state.moderationCases) if (!Array.isArray(row.timeline)) row.timeline = [];
    for (const row of this.state.approvals) if (!Array.isArray(row.approvals)) row.approvals = [];
    for (const row of this.state.liveEvents) if (!Array.isArray(row.phases)) row.phases = [];
    this.previews = new Map();
    this._contractCache = null;
    this.emitEvent = typeof emitEvent === 'function' ? emitEvent : null;
  }

  _persist() {
    this.state.revision++;
    atomicJson(this.file, this.state);
  }

  _incident(kind, summary, actor = '', details = {}) {
    const row = { id: crypto.randomUUID(), at: Date.now(), kind: clean(kind, 64),
      summary: clean(summary, 512), actor: clean(actor, 128), details: boundedJson(details, 32 * 1024) };
    this.state.incidents.push(row);
    if (this.state.incidents.length > MAX_INCIDENTS) this.state.incidents.splice(0, this.state.incidents.length - MAX_INCIDENTS);
    return row;
  }

  snapshot() {
    this.cleanupPreviews();
    return clone({ schema: this.state.schema, revision: this.state.revision, policy: this.state.policy,
      counts: { moderation: this.state.moderationCases.length, approvals: this.state.approvals.length,
        incidents: this.state.incidents.length, previews: this.previews.size,
        liveEvents: this.state.liveEvents.length },
      previews: [...this.previews.values()].map((row) => this._publicPreview(row)) });
  }

  updatePolicy(input = {}) {
    this.state.policy = {
      approvalsRequired: input.approvalsRequired === true,
      requiredApprovers: Math.max(1, Math.min(3, Number(input.requiredApprovers) | 0 || 1)),
    };
    this._incident('policy.updated', 'Platform safety policy updated', input.actor, this.state.policy);
    this._persist();
    return { ok: true, revision: this.state.revision, policy: clone(this.state.policy) };
  }

  createModerationCase(input = {}) {
    const summary = clean(input.summary, 2_000);
    if (!summary) return { ok: false, error: 'summary is required' };
    const now = Date.now();
    const row = { id: crypto.randomUUID(), revision: 1, createdAt: now, updatedAt: now,
      status: 'open', reporter: clean(input.reporter, 128), owner: '',
      mobileSerial: Number(input.mobileSerial) >>> 0, category: clean(input.category || 'other', 64), summary,
      eventIds: [...new Set((Array.isArray(input.eventIds) ? input.eventIds : [])
        .map((value) => clean(value, 128)).filter(Boolean))].slice(0, 64),
      timeline: [{ at: now, actor: clean(input.reporter, 128), action: 'created', note: '' }] };
    this.state.moderationCases.push(row);
    if (this.state.moderationCases.length > MAX_CASES) this.state.moderationCases.splice(0, this.state.moderationCases.length - MAX_CASES);
    this._incident('moderation.created', `Moderation case ${row.id} created`, row.reporter,
      { caseId: row.id, category: row.category });
    this._persist();
    return { ok: true, case: clone(row), revision: this.state.revision };
  }

  listModerationCases({ status = '', category = '', query = '', limit = 100, offset = 0 } = {}) {
    const needle = clean(query, 128).toLowerCase();
    const selected = this.state.moderationCases.filter((row) => (!status || row.status === status)
      && (!category || row.category === category)
      && (!needle || `${row.id} ${row.reporter} ${row.owner} ${row.summary}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const start = Math.max(0, Number(offset) | 0); const count = Math.max(1, Math.min(500, Number(limit) | 0 || 100));
    return { ok: true, total: selected.length, offset: start, cases: clone(selected.slice(start, start + count)) };
  }

  updateModerationCase(id, patch = {}, actor = '') {
    const row = this.state.moderationCases.find((entry) => entry.id === String(id));
    if (!row) return { ok: false, error: 'moderation case not found' };
    if (patch.expectedRevision != null && Number(patch.expectedRevision) !== row.revision) {
      return { ok: false, conflict: true, revision: row.revision, case: clone(row) };
    }
    const status = clean(patch.status, 32);
    if (status && !CASE_STATUSES.has(status)) return { ok: false, error: 'invalid moderation status' };
    if (status) row.status = status;
    if (Object.hasOwn(patch, 'owner')) row.owner = clean(patch.owner, 128);
    row.updatedAt = Date.now(); row.revision++;
    row.timeline.push({ at: row.updatedAt, actor: clean(actor, 128), action: status || 'updated', note: clean(patch.note, 2_000) });
    row.timeline = row.timeline.slice(-500);
    this._incident('moderation.updated', `Moderation case ${row.id} updated`, actor,
      { caseId: row.id, status: row.status, owner: row.owner });
    this._persist();
    return { ok: true, case: clone(row), revision: this.state.revision };
  }

  requestApproval(input = {}, actor = '') {
    const kind = clean(input.kind, 64); const resource = clean(input.resource, 256);
    if (!kind || !resource || !SAFE_ID.test(kind)) return { ok: false, error: 'valid kind and resource are required' };
    const now = Date.now(); const required = Math.max(1, Math.min(3,
      Number(input.requiredApprovers) | 0 || this.state.policy.requiredApprovers));
    const row = { id: crypto.randomUUID(), revision: 1, kind, resource,
      summary: clean(input.summary, 1_000), requestedBy: clean(actor, 128), requestedAt: now,
      expiresAt: now + Math.max(60_000, Math.min(7 * 86_400_000, Number(input.ttlMs) | 0 || 24 * 60 * 60_000)),
      status: 'pending', requiredApprovers: required, approvals: [], rejection: null,
      payloadFingerprint: clean(input.payloadFingerprint, 128) || fingerprint(input.payload ?? {}) };
    this.state.approvals.push(row);
    if (this.state.approvals.length > MAX_APPROVALS) this.state.approvals.splice(0, this.state.approvals.length - MAX_APPROVALS);
    this._incident('approval.requested', `${kind} approval requested for ${resource}`, actor, { approvalId: row.id });
    this._persist();
    return { ok: true, approval: clone(row), revision: this.state.revision };
  }

  decideApproval(id, decision, actor, note = '') {
    const row = this.state.approvals.find((entry) => entry.id === String(id));
    if (!row) return { ok: false, error: 'approval request not found' };
    this._refreshApproval(row);
    if (row.status !== 'pending') return { ok: false, error: `approval is ${row.status}`, approval: clone(row) };
    const who = clean(actor, 128);
    if (!who || who.toLowerCase() === row.requestedBy.toLowerCase()) {
      return { ok: false, error: 'the requester cannot approve their own change' };
    }
    if (decision === 'reject') {
      row.status = 'rejected'; row.rejection = { actor: who, at: Date.now(), note: clean(note, 1_000) };
    } else if (decision === 'approve') {
      if (!row.approvals.some((entry) => entry.actor.toLowerCase() === who.toLowerCase())) {
        row.approvals.push({ actor: who, at: Date.now(), note: clean(note, 1_000) });
      }
      if (row.approvals.length >= row.requiredApprovers) row.status = 'approved';
    } else return { ok: false, error: 'decision must be approve or reject' };
    row.revision++;
    this._incident(`approval.${row.status}`, `${row.kind} approval ${row.status}`, who, { approvalId: row.id });
    this._persist();
    return { ok: true, approval: clone(row), revision: this.state.revision };
  }

  _refreshApproval(row) {
    if (row.status === 'pending' && row.expiresAt <= Date.now()) row.status = 'expired';
    if (!APPROVAL_STATUSES.has(row.status)) row.status = 'pending';
    return row;
  }

  listApprovals({ status = '', limit = 100 } = {}) {
    let dirty = false;
    for (const row of this.state.approvals) { const before = row.status; this._refreshApproval(row); dirty ||= before !== row.status; }
    if (dirty) this._persist();
    const rows = this.state.approvals.filter((row) => !status || row.status === status)
      .sort((a, b) => b.requestedAt - a.requestedAt).slice(0, Math.max(1, Math.min(500, Number(limit) | 0 || 100)));
    return { ok: true, approvals: clone(rows), policy: clone(this.state.policy) };
  }

  authorizeApproval(id, { kind, resource, actor, fingerprint: expectedFingerprint } = {}) {
    if (!this.state.policy.approvalsRequired) return { ok: true, advisory: true };
    const requestedId = clean(id, 128);
    const candidates = this.state.approvals.filter((entry) => {
      this._refreshApproval(entry);
      return entry.status === 'approved' && entry.kind === kind && entry.resource === resource
        && (!expectedFingerprint || entry.payloadFingerprint === expectedFingerprint);
    });
    const row = requestedId
      ? candidates.find((entry) => entry.id === requestedId)
      : candidates.sort((a, b) => b.requestedAt - a.requestedAt)[0];
    if (!row) return { ok: false, error: 'approved change request is required' };
    row.status = 'consumed'; row.consumedAt = Date.now(); row.consumedBy = clean(actor, 128); row.revision++;
    this._incident('approval.consumed', `${kind} approval consumed for ${resource}`, actor, { approvalId: row.id });
    this._persist();
    return { ok: true, approval: clone(row) };
  }

  startPreview({ actor = '', resources = [], ttlMs, baseline = {} } = {}) {
    this.cleanupPreviews();
    const selected = [...new Set((Array.isArray(resources) ? resources : [])
      .map((value) => clean(value, 300)).filter(Boolean))].slice(0, 256);
    const now = Date.now(); const id = crypto.randomUUID();
    const row = { id, actor: clean(actor, 128), resources: selected, createdAt: now,
      expiresAt: now + Math.max(PREVIEW_TTL_MIN, Math.min(PREVIEW_TTL_MAX, Number(ttlMs) | 0 || 5 * 60_000)),
      baseline: boundedJson(baseline, 128 * 1024), mutations: [], simulations: [], revision: 1 };
    row.baseFingerprint = fingerprint({ resources: row.resources, baseline: row.baseline });
    this.previews.set(id, row);
    return { ok: true, session: this._publicPreview(row) };
  }

  _publicPreview(row) {
    return clone({ sessionId: row.id, actor: row.actor, resources: row.resources,
      createdAt: row.createdAt, expiresAt: row.expiresAt, baseFingerprint: row.baseFingerprint,
      revision: row.revision, isolated: true, externalEffects: false,
      mutations: row.mutations, simulations: row.simulations });
  }

  preview(id) {
    this.cleanupPreviews();
    const row = this.previews.get(String(id));
    return row ? { ok: true, session: this._publicPreview(row) } : { ok: false, error: 'preview session not found' };
  }

  mutatePreview(id, mutations = [], actor = '') {
    this.cleanupPreviews();
    const row = this.previews.get(String(id));
    if (!row) return { ok: false, error: 'preview session not found' };
    if (clean(actor, 128).toLowerCase() !== row.actor.toLowerCase()) return { ok: false, error: 'preview session owner mismatch' };
    const incoming = (Array.isArray(mutations) ? mutations : []).slice(0, 256).map((entry) => ({
      resource: clean(entry?.resource, 300), operation: ['set', 'merge', 'remove'].includes(entry?.operation) ? entry.operation : 'merge',
      value: boundedJson(entry?.value, 64 * 1024), at: Date.now(),
    })).filter((entry) => entry.resource);
    if (!incoming.length) return { ok: false, error: 'at least one valid mutation is required' };
    if (row.mutations.length + incoming.length > 2_000) return { ok: false, error: 'preview mutation limit exceeded' };
    row.mutations.push(...incoming); row.revision++; row.expiresAt = Math.min(Date.now() + 5 * 60_000, row.createdAt + PREVIEW_TTL_MAX);
    return { ok: true, session: this._publicPreview(row), diffFingerprint: fingerprint(row.mutations) };
  }

  simulatePreview(id, eventName, payload = {}, actor = '') {
    this.cleanupPreviews();
    const row = this.previews.get(String(id)); const event = clean(eventName, 128);
    if (!row) return { ok: false, error: 'preview session not found' };
    if (clean(actor, 128).toLowerCase() !== row.actor.toLowerCase()) return { ok: false, error: 'preview session owner mismatch' };
    if (!event || !SAFE_ID.test(event)) return { ok: false, error: 'valid event name is required' };
    const contracts = this.eventContracts({ query: event, refresh: false }).contracts;
    const result = { at: Date.now(), event, payload: boundedJson(payload, 64 * 1024),
      matchedConsumers: contracts.filter((entry) => entry.id === event).flatMap((entry) => entry.consumers).slice(0, 128),
      externalEffects: false, deterministic: true };
    row.simulations.push(result); row.simulations = row.simulations.slice(-100); row.revision++;
    this._incident('preview.simulated', `${event} simulated in preview ${row.id}`, actor,
      { previewId: row.id, consumers: result.matchedConsumers.length });
    this._persist();
    return { ok: true, result: clone(result), session: this._publicPreview(row) };
  }

  endPreview(id, actor = '') {
    const row = this.previews.get(String(id));
    if (!row) return { ok: false, error: 'preview session not found' };
    if (actor && clean(actor, 128).toLowerCase() !== row.actor.toLowerCase()) return { ok: false, error: 'preview session owner mismatch' };
    this.previews.delete(row.id);
    return { ok: true, sessionId: row.id, ended: true, diffFingerprint: fingerprint(row.mutations) };
  }

  cleanupPreviews(now = Date.now()) {
    let removed = 0;
    for (const [id, row] of this.previews) if (row.expiresAt <= now) { this.previews.delete(id); removed++; }
    return removed;
  }

  eventContracts({ query = '', refresh = false } = {}) {
    const now = Date.now();
    if (refresh || !this._contractCache || now - this._contractCache.at > 10_000) {
      const events = new Map(); const files = walkJavaScript(this.scriptsDir);
      for (const absolute of files) {
        let source = ''; try { source = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
        const rel = path.relative(this.scriptsDir, absolute).replace(/\\/gu, '/');
        const producers = eventReferences(source, /(?:\.emit|emitEvent)\s*\(\s*['"]([^'"]+)['"]/gu);
        const consumers = eventReferences(source, /(?:lifecycle\.event|\.on)\s*\(\s*['"]([^'"]+)['"]/gu);
        for (const id of producers) {
          const row = events.get(id) ?? { id, producers: [], consumers: [] };
          if (!row.producers.includes(rel)) row.producers.push(rel); events.set(id, row);
        }
        for (const id of consumers) {
          const row = events.get(id) ?? { id, producers: [], consumers: [] };
          if (!row.consumers.includes(rel)) row.consumers.push(rel); events.set(id, row);
        }
      }
      for (const [id, producer] of ENGINE_EVENT_PRODUCERS) {
        const row = events.get(id) ?? { id, producers: [], consumers: [] };
        if (!row.producers.includes(producer)) row.producers.push(producer);
        events.set(id, row);
      }
      const contracts = [...events.values()].sort((a, b) => a.id.localeCompare(b.id)).map((row) => ({ ...row,
        status: !row.producers.length ? 'no-producer' : !row.consumers.length ? 'no-consumer' : 'connected' }));
      this._contractCache = { at: now, scannedFiles: files.length, contracts };
    }
    const needle = clean(query, 128).toLowerCase();
    const contracts = this._contractCache.contracts.filter((row) => !needle || row.id.toLowerCase().includes(needle)
      || [...row.producers, ...row.consumers].some((file) => file.toLowerCase().includes(needle)));
    return { ok: true, generatedAt: this._contractCache.at, scannedFiles: this._contractCache.scannedFiles,
      summary: { total: contracts.length, connected: contracts.filter((row) => row.status === 'connected').length,
        noProducer: contracts.filter((row) => row.status === 'no-producer').length,
        noConsumer: contracts.filter((row) => row.status === 'no-consumer').length }, contracts: clone(contracts.slice(0, 5_000)) };
  }

  listLiveEvents({ status = '', includeCompleted = false } = {}) {
    const now = Date.now();
    const events = this.state.liveEvents.filter((row) => (!status || row.status === status)
      && (includeCompleted || row.status !== 'completed')
      && (!row.endsAt || row.endsAt >= now || row.status === 'draft'))
      .sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
    return { ok: true, revision: this.state.revision, events: clone(events) };
  }

  upsertLiveEvent(input = {}, actor = '') {
    const id = clean(input.id, 96).toLowerCase();
    if (!id || !SAFE_ID.test(id)) return { ok: false, error: 'valid event id is required' };
    const phases = (Array.isArray(input.phases) ? input.phases : []).slice(0, 64).map((phase, index) => ({
      id: clean(phase?.id || `phase-${index + 1}`, 64), label: clean(phase?.label, 128),
      objectives: (Array.isArray(phase?.objectives) ? phase.objectives : []).slice(0, 64).map((value) => clean(value, 256)),
      environment: boundedJson(phase?.environment ?? {}, 32 * 1024),
    })).filter((phase, index, all) => phase.id && SAFE_ID.test(phase.id)
      && all.findIndex((candidate) => candidate.id === phase.id) === index);
    if (!phases.length) return { ok: false, error: 'at least one valid event phase is required' };
    let row = this.state.liveEvents.find((entry) => entry.id === id); const isNew = !row;
    const now = Date.now();
    if (!row) {
      row = { id, revision: 0, createdAt: now };
    } else if (input.expectedRevision != null && Number(input.expectedRevision) !== row.revision) {
      return { ok: false, conflict: true, revision: row.revision, event: clone(row) };
    }
    const currentPhase = clean(input.currentPhase || phases[0]?.id || row.currentPhase, 64);
    if (!phases.some((phase) => phase.id === currentPhase)) return { ok: false, error: 'current event phase is not defined' };
    const startsAt = Math.max(0, Number(input.startsAt) || row.startsAt || now);
    const endsAt = Math.max(0, Number(input.endsAt) || row.endsAt || 0);
    if (endsAt && endsAt < startsAt) return { ok: false, error: 'event end must not precede its start' };
    Object.assign(row, { revision: row.revision + 1, updatedAt: now, updatedBy: clean(actor, 128),
      title: clean(input.title || id, 160), description: clean(input.description, 2_000),
      status: ['draft', 'active', 'paused', 'completed'].includes(input.status) ? input.status : (row.status ?? 'draft'),
      currentPhase, startsAt, endsAt, phases });
    if (isNew) this.state.liveEvents.push(row);
    this._incident('live-event.updated', `Live event ${id} updated`, actor,
      { eventId: id, status: row.status, phase: row.currentPhase });
    this._persist();
    try { this.emitEvent?.('live-event:updated', clone(row)); }
    catch (error) { this._incident('live-event.callback-error', clean(error.message, 512), actor, { eventId: id }); this._persist(); }
    return { ok: true, event: clone(row), revision: this.state.revision };
  }

  transitionLiveEvent(id, input = {}, actor = '') {
    const row = this.state.liveEvents.find((entry) => entry.id === String(id));
    if (!row) return { ok: false, error: 'live event not found' };
    if (input.expectedRevision != null && Number(input.expectedRevision) !== row.revision) {
      return { ok: false, conflict: true, revision: row.revision, event: clone(row) };
    }
    const status = clean(input.status, 32); const phase = clean(input.phase, 64);
    if (status && !['draft', 'active', 'paused', 'completed'].includes(status)) return { ok: false, error: 'invalid event status' };
    if (phase && !row.phases.some((entry) => entry.id === phase)) return { ok: false, error: 'event phase not found' };
    if (status) row.status = status;
    if (phase) row.currentPhase = phase;
    row.updatedAt = Date.now(); row.updatedBy = clean(actor, 128); row.revision++;
    this._incident('live-event.transitioned', `Live event ${row.id} transitioned`, actor,
      { eventId: row.id, status: row.status, phase: row.currentPhase });
    this._persist();
    try { this.emitEvent?.('live-event:transition', clone(row)); }
    catch (error) { this._incident('live-event.callback-error', clean(error.message, 512), actor, { eventId: row.id }); this._persist(); }
    return { ok: true, event: clone(row), revision: this.state.revision };
  }

  incidents({ kind = '', limit = 200 } = {}) {
    return { ok: true, incidents: clone(this.state.incidents.filter((row) => !kind || row.kind === kind)
      .slice(-Math.max(1, Math.min(1_000, Number(limit) | 0 || 200))).reverse()) };
  }

  close() {
    this.previews.clear();
  }
}
