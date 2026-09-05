import { runtimeServiceLevels } from './service-levels.js';
import { runtimeGovernor } from './runtime-governor.js';
import { runtimeProfiler } from './runtime-profiler.js';
import { trafficReplay } from './traffic-replay.js';
import { simulationReplay } from './simulation-replay.js';
import { runtimeAdmission } from './load-shedding.js';
import { sharedPacketTemplates } from '../net/packet-template-cache.js';
import { verifyWorldDatabaseSync } from '../world/sqlite-store.js';

const startedAt = Date.now();
const protocol = {
  connectionsOpened: 0, connectionsClosed: 0, protocolErrors: 0, handlerErrors: 0,
  rxPackets: 0, txPackets: 0, rxBytes: 0, txBytes: 0,
  rx: new Map(), tx: new Map(),
};
const sessions = new Map();
const audit = [];
const AUDIT_MAX = 2000;
const gumps = {
  opened: 0, refreshed: 0, closed: 0, expired: 0,
  responses: 0, rejected: 0, callbackErrors: 0,
  totalLifetimeMs: 0, maxLifetimeMs: 0,
  rejectionReasons: new Map(),
};
const runtime = {
  eventLoopLagMs: 0,
  maxEventLoopLagMs: 0,
  lagSamples: [],
  ticks: new Map(),
  tickSamples: [],
};
let runtimeMonitor = null;
const structuredEvents = [];
const STRUCTURED_MAX = 2000;
const adminRequests = new Map();
const compatibilityNotices = { shown: 0, suppressed: 0, byFeature: new Map() };

function opcodeEntry(map, opcode) {
  const key = opcode & 0xff;
  const value = map.get(key) ?? { opcode: key, packets: 0, bytes: 0, errors: 0, totalHandlerMs: 0, maxHandlerMs: 0 };
  map.set(key, value);
  return value;
}

export function connectionOpened(state) {
  protocol.connectionsOpened++;
  sessions.set(state.id, { id: state.id, openedAt: Date.now(),
    transport: state.nodeUOTransportVersion || (state.transportKind === 'tcp' ? 'uo.tcp' : 'uo.websocket'), stage: state.stage,
    packets: [], rxPackets: 0, txPackets: 0, rxBytes: 0, txBytes: 0 });
}
export function connectionUpdated(state) {
  const entry = sessions.get(state.id);
  if (!entry) return;
  Object.assign(entry, { stage: state.stage, account: state.accountName ?? undefined, mobileSerial: state.mobile?.serial,
    clientVersion: state.clientVersionString ?? undefined,
    nodeUOProfile: state.nodeUOProfile ?? undefined,
    features: state.nodeUOFeatures?.size ? Object.fromEntries(state.nodeUOFeatures) : undefined,
    nodeUOJson: state.nodeUOJsonStats ? { ...state.nodeUOJsonStats,
      pendingAcks: state._nodeUOPendingAcks?.size ?? 0,
      reliableQueue: state._nodeUOJsonReliableQueue?.length ?? 0,
      reliableQueueBytes: state._nodeUOJsonReliableBytes ?? 0,
      rpcInFlight: state._nodeUORpcTasks?.size ?? 0,
      bandwidth: state.nodeUOBandwidth ? {
        pressure: state.nodeUOBandwidth.pressure(),
        availableBytes: Math.trunc(state.nodeUOBandwidth.tokens),
        bytesPerSecond: state.nodeUOBandwidth.bytesPerSecond,
      } : null,
    } : undefined,
    clientPerformance: state.nodeUOClientDiagnostics ?? undefined,
    pendingBytes: Number(state.ws?.bufferedAmount) || 0,
    pingMs: Number.isFinite(state.roundTripMs) ? state.roundTripMs : null });
}
export function connectionClosed(state, reason = '') {
  if (!sessions.delete(state.id)) return;
  protocol.connectionsClosed++;
  recordAudit('network.close', { actor: state.accountName, target: `net#${state.id}`, detail: String(reason).slice(0, 160) });
}
export function packet(direction, opcode, bytes, handlerMs = 0, error = false, state = null) {
  const incoming = direction === 'rx';
  const entry = opcodeEntry(incoming ? protocol.rx : protocol.tx, opcode);
  entry.packets++; entry.bytes += Math.max(0, bytes | 0);
  if (error) entry.errors++;
  if (handlerMs > 0) { entry.totalHandlerMs += handlerMs; entry.maxHandlerMs = Math.max(entry.maxHandlerMs, handlerMs); }
  if (incoming) { protocol.rxPackets++; protocol.rxBytes += Math.max(0, bytes | 0); }
  else { protocol.txPackets++; protocol.txBytes += Math.max(0, bytes | 0); }
  if (incoming && handlerMs > 0) runtimeServiceLevels.observe('packetHandler', handlerMs);
  // A short per-session ring makes packet inspection useful for a selected
  // world entity without turning the global structured log into a firehose.
  // It contains metadata only (never credentials/chat packet payloads).
  if (state?.id != null) {
    connectionUpdated(state);
    const session = sessions.get(state.id);
    if (session) {
      const size = Math.max(0, bytes | 0);
      session[incoming ? 'rxPackets' : 'txPackets']++;
      session[incoming ? 'rxBytes' : 'txBytes'] += size;
      session.lastPacketAt = Date.now();
      session.packets.push({
        at: session.lastPacketAt,
        direction: incoming ? 'rx' : 'tx',
        opcode: `0x${(opcode & 0xff).toString(16).padStart(2, '0')}`,
        bytes: size,
        handlerMs: Number(Math.max(0, Number(handlerMs) || 0).toFixed(3)),
        error: !!error,
      });
      if (session.packets.length > 256) session.packets.splice(0, session.packets.length - 256);
    }
  }
}
export function protocolError() { protocol.protocolErrors++; }
export function handlerError() { protocol.handlerErrors++; }
export function compatibilityNotice(feature, shown = true) {
  const key = String(feature ?? 'unknown').slice(0, 160);
  if (shown) compatibilityNotices.shown++;
  else compatibilityNotices.suppressed++;
  const entry = compatibilityNotices.byFeature.get(key) ?? { shown: 0, suppressed: 0 };
  entry[shown ? 'shown' : 'suppressed']++;
  compatibilityNotices.byFeature.set(key, entry);
  while (compatibilityNotices.byFeature.size > 256) {
    compatibilityNotices.byFeature.delete(compatibilityNotices.byFeature.keys().next().value);
  }
}
export function gumpOpened(refreshed = false) { gumps.opened++; if (refreshed) gumps.refreshed++; }
export function gumpClosed() { gumps.closed++; }
export function gumpExpired(count = 1) { gumps.expired += Math.max(0, count | 0); }
export function gumpResponse(lifetimeMs = 0) {
  gumps.responses++;
  const duration = Math.max(0, Number(lifetimeMs) || 0);
  gumps.totalLifetimeMs += duration;
  gumps.maxLifetimeMs = Math.max(gumps.maxLifetimeMs, duration);
}
export function gumpRejected(reason = 'unknown') {
  gumps.rejected++;
  const key = String(reason);
  gumps.rejectionReasons.set(key, (gumps.rejectionReasons.get(key) ?? 0) + 1);
}
export function gumpCallbackError() { gumps.callbackErrors++; }
export function gumpSnapshot() {
  return {
    ...Object.fromEntries(Object.entries(gumps).filter(([, value]) => typeof value === 'number')),
    averageLifetimeMs: gumps.responses ? Math.round(gumps.totalLifetimeMs / gumps.responses) : 0,
    rejectionReasons: Object.fromEntries(gumps.rejectionReasons),
  };
}
export function protocolSnapshot() {
  const rows = (map) => [...map.values()].map((entry) => ({ ...entry,
    averageBytes: entry.packets ? Math.round(entry.bytes / entry.packets) : 0,
    averageHandlerMs: entry.packets ? Number((entry.totalHandlerMs / entry.packets).toFixed(3)) : 0,
  })).sort((a, b) => b.bytes - a.bytes);
  return { uptimeMs: Date.now() - startedAt,
    ...Object.fromEntries(Object.entries(protocol).filter(([, value]) => typeof value === 'number')),
    rxOpcodes: rows(protocol.rx), txOpcodes: rows(protocol.tx) };
}
export function compatibilitySnapshot() {
  const list = [...sessions.values()], byTransport = {}, byVersion = {};
  for (const session of list) {
    byTransport[session.transport] = (byTransport[session.transport] ?? 0) + 1;
    const version = session.clientVersion ?? 'unknown'; byVersion[version] = (byVersion[version] ?? 0) + 1;
  }
  return { connected: list.length, byTransport, byVersion,
    notices: { shown: compatibilityNotices.shown, suppressed: compatibilityNotices.suppressed,
      byFeature: Object.fromEntries(compatibilityNotices.byFeature) },
    sessions: list };
}
export function recordAudit(kind, { actor, target, detail, ok = true } = {}) {
  const entry = { id: `audit-${Date.now().toString(36)}-${(++recordAudit.sequence).toString(36)}`,
    at: Date.now(), kind: String(kind), actor: actor ? String(actor) : undefined,
    target: target ? String(target) : undefined, detail: detail ? String(detail).slice(0, 500) : undefined, ok: !!ok };
  audit.push(entry);
  if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
  return entry;
}
recordAudit.sequence = 0;
export function auditSnapshot(limit = 200) { return audit.slice(-Math.max(1, Math.min(2000, limit | 0))).reverse(); }

/** Record one named scheduler pass without retaining callback arguments. */
export function recordTick(name, durationMs) {
  const key = String(name ?? 'unknown');
  const ms = Math.max(0, Number(durationMs) || 0);
  const entry = runtime.ticks.get(key) ?? {
    name: key, calls: 0, totalMs: 0, maxMs: 0, slow: 0, lastMs: 0, lastAt: 0,
  };
  entry.calls++;
  entry.totalMs += ms;
  entry.maxMs = Math.max(entry.maxMs, ms);
  entry.lastMs = ms;
  entry.lastAt = Date.now();
  if (ms >= 50) entry.slow++;
  runtime.ticks.set(key, entry);
  runtime.tickSamples.push({ at: Date.now(), name: key, ms });
  if (runtime.tickSamples.length > 20_000) runtime.tickSamples.splice(0, runtime.tickSamples.length - 20_000);
  runtimeServiceLevels.observe('tickDuration', ms);
  runtimeProfiler.record(key, ms);
  return ms;
}

export function measureTick(name, callback) {
  const started = performance.now();
  try { return callback(); }
  finally { recordTick(name, performance.now() - started); }
}

/** Event-loop drift sampler. Idempotent and unref'd, so diagnostics never
 * changes process lifetime. Returns a disposer for controlled shutdown/tests. */
export function startRuntimeMonitor(intervalMs = 1000) {
  if (runtimeMonitor) return () => stopRuntimeMonitor();
  const interval = Math.max(100, Number(intervalMs) || 1000);
  let expected = performance.now() + interval;
  const sample = () => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    expected = now + interval;
    runtime.eventLoopLagMs = lag;
    runtime.maxEventLoopLagMs = Math.max(runtime.maxEventLoopLagMs, lag);
    runtime.lagSamples.push(lag);
    if (runtime.lagSamples.length > 300) runtime.lagSamples.splice(0, runtime.lagSamples.length - 300);
    runtimeServiceLevels.observe('eventLoopLag', lag);
    // Keep the control loop O(metric count); percentile sorting is reserved
    // for explicit diagnostics snapshots requested by an operator.
    const pressure = runtimeServiceLevels.pressure();
    for (const budget of Object.values(runtimeGovernor.budgets)) budget.setPressure(pressure);
    runtimeAdmission.setPressure(pressure);
  };
  runtimeMonitor = runtimeGovernor.scheduler?.every
    ? runtimeGovernor.scheduler.every('runtime-monitor', interval, sample)
    : setInterval(sample, interval);
  runtimeMonitor.unref?.();
  runtimeProfiler.start(runtimeGovernor.scheduler);
  return () => stopRuntimeMonitor();
}

export function stopRuntimeMonitor() {
  if (typeof runtimeMonitor?.cancel === 'function') runtimeMonitor.cancel();
  else if (runtimeMonitor) clearInterval(runtimeMonitor);
  runtimeMonitor = null;
  runtimeProfiler.stop();
}

export function runtimeSnapshot(windowMs = 60_000) {
  const samples = [...runtime.lagSamples].sort((a, b) => a - b);
  const percentile = (p) => samples.length
    ? samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))]
    : 0;
  const cutoff = Date.now() - Math.max(1000, Number(windowMs) || 60_000);
  const recent = runtime.tickSamples.filter((sample) => sample.at >= cutoff);
  const recentByName = new Map();
  for (const sample of recent) {
    const row = recentByName.get(sample.name) ?? { name: sample.name, calls: 0, totalMs: 0, maxMs: 0, samples: [] };
    row.calls++; row.totalMs += sample.ms; row.maxMs = Math.max(row.maxMs, sample.ms); row.samples.push(sample.ms); recentByName.set(sample.name, row);
  }
  const profile = [...recentByName.values()].map((row) => {
    row.samples.sort((a, b) => a - b);
    const p95 = row.samples[Math.min(row.samples.length - 1, Math.floor(row.samples.length * .95))] ?? 0;
    return { name: row.name, calls: row.calls, totalMs: Number(row.totalMs.toFixed(3)), maxMs: Number(row.maxMs.toFixed(3)),
      averageMs: Number((row.totalMs / Math.max(1, row.calls)).toFixed(3)), p95Ms: Number(p95.toFixed(3)) };
  }).sort((a, b) => b.totalMs - a.totalMs);
  return {
    eventLoop: {
      currentLagMs: Number(runtime.eventLoopLagMs.toFixed(3)),
      maxLagMs: Number(runtime.maxEventLoopLagMs.toFixed(3)),
      p95LagMs: Number(percentile(0.95).toFixed(3)),
      samples: samples.length,
    },
    ticks: [...runtime.ticks.values()].map((entry) => ({
      ...entry,
      averageMs: entry.calls ? Number((entry.totalMs / entry.calls).toFixed(3)) : 0,
      totalMs: Number(entry.totalMs.toFixed(3)),
      maxMs: Number(entry.maxMs.toFixed(3)),
      lastMs: Number(entry.lastMs.toFixed(3)),
    })).sort((a, b) => b.totalMs - a.totalMs),
    profile: { windowMs: Math.max(1000, Number(windowMs) || 60_000), samples: recent.length, systems: profile },
    serviceLevels: runtimeServiceLevels.snapshot(),
    scheduler: runtimeGovernor.scheduler.snapshot(),
    queues: {
      visibility: runtimeGovernor.visibility.snapshot(),
      background: runtimeGovernor.background.snapshot(),
    },
    packetTemplates: sharedPacketTemplates.snapshot(),
    profiler: runtimeProfiler.snapshot(),
    admission: runtimeAdmission.snapshot(),
  };
}

export function recordPacketReplay(direction, payload, state) {
  return trafficReplay.record(direction, payload, state);
}

export function replaySnapshot(limit = 256) {
  return trafficReplay.snapshot(true, Math.max(1, Math.min(5000, limit | 0)));
}

export function configureReplay(options = {}) { return trafficReplay.configure(options); }
export function clearReplay() { trafficReplay.clear(); return trafficReplay.snapshot(false); }
export function exportReplay(limit = 20_000) { return trafficReplay.exportTrace(limit); }
export function replayPackets(trace, dispatch, options) { return trafficReplay.replay(trace, dispatch, options); }
export function recordSimulationInput(state, packet) { return simulationReplay.input(state, packet); }
export function recordSimulationDecision(domain, actor, name, data) {
  return simulationReplay.decision(domain, actor, name, data);
}
export function beginSimulationTick(domain, at) { return simulationReplay.beginTick(domain, at); }
export function simulationReplaySnapshot(limit = 256) {
  return simulationReplay.snapshot(true, Math.max(1, Math.min(5000, limit | 0)));
}
export function configureSimulationReplay(options = {}) { return simulationReplay.configure(options); }
export function clearSimulationReplay() { simulationReplay.clear(); return simulationReplay.snapshot(false); }
export function exportSimulationReplay(limit = 50_000) { return simulationReplay.exportTrace(limit); }
export function captureCpuProfile(options) { return runtimeProfiler.captureCpuProfile(options); }
export function cpuProfile(id) { return runtimeProfiler.profile(id); }
export function profilerSnapshot() { return runtimeProfiler.snapshot(); }
export function admissionSnapshot() { return runtimeAdmission.snapshot(); }

export function serviceLevelSnapshot() { return runtimeServiceLevels.snapshot(); }

/** Structured event ring. In JSON logging mode the same object is emitted as
 * one line, making it directly ingestible by Loki/ELK without changing the
 * human-readable default console output. */
export function structuredEvent(event, fields = {}, level = 'info') {
  const entry = { at: new Date().toISOString(), level: String(level), event: String(event), ...fields };
  structuredEvents.push(entry);
  if (structuredEvents.length > STRUCTURED_MAX) structuredEvents.splice(0, structuredEvents.length - STRUCTURED_MAX);
  if (process.env.UO_LOG_FORMAT === 'json') {
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
    console[method](JSON.stringify(entry));
  }
  return entry;
}

export function structuredSnapshot(limit = 200) {
  return structuredEvents.slice(-Math.max(1, Math.min(STRUCTURED_MAX, limit | 0))).reverse();
}

export function recordAdminRequest(route, durationMs, status = 200) {
  const key = String(route ?? 'unknown');
  const entry = adminRequests.get(key) ?? { route: key, calls: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] };
  const ms = Math.max(0, Number(durationMs) || 0);
  entry.calls++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms); if (Number(status) >= 400) entry.errors++;
  entry.samples.push(ms); if (entry.samples.length > 256) entry.samples.shift(); adminRequests.set(key, entry);
  runtimeServiceLevels.observe('adminRequest', ms);
}

export function adminRequestSnapshot() {
  const routes = [...adminRequests.values()].map((entry) => {
    const samples = entry.samples.slice().sort((a, b) => a - b);
    const at = (p) => samples.length ? samples[Math.min(samples.length - 1, Math.floor((samples.length - 1) * p))] : 0;
    return { route: entry.route, calls: entry.calls, errors: entry.errors,
      averageMs: Number((entry.totalMs / Math.max(1, entry.calls)).toFixed(3)),
      p95Ms: Number(at(.95).toFixed(3)), maxMs: Number(entry.maxMs.toFixed(3)) };
  }).sort((a, b) => b.p95Ms - a.p95Ms);
  return { routes, calls: routes.reduce((sum, route) => sum + route.calls, 0), errors: routes.reduce((sum, route) => sum + route.errors, 0) };
}

export function scanWorldIntegrity(world, { spawner = null } = {}) {
  const issues = [];
  const add = (severity, kind, serial, detail) => {
    if (issues.length < 5000) issues.push({ severity, kind, serial: serial ? `0x${(serial >>> 0).toString(16)}` : null, detail });
  };
  for (const item of world?.items?.values?.() ?? []) {
    if (item.parent != null && !world.items.has(item.parent >>> 0) && !world.mobiles.has(item.parent >>> 0)) add('error', 'orphan-item', item.serial, `parent 0x${(item.parent >>> 0).toString(16)} missing`);
    // Contained/equipped items intentionally have no world coordinates; their
    // position is resolved through the parent chain. Validate coordinates only
    // for top-level world items.
    if (item.parent == null && ![item.x, item.y, item.z].every(Number.isFinite)) add('error', 'invalid-position', item.serial, 'non-finite item coordinate');
    if (item.boat) for (const attached of [...(item.boat.planks ?? []), ...(item.boat.cannons ?? [])]) {
      if (!world.items.has(attached >>> 0)) add('warning', 'boat-attachment', item.serial, `attachment 0x${(attached >>> 0).toString(16)} missing`);
    }
  }
  for (const mob of world?.mobiles?.values?.() ?? []) {
    if (![mob.x, mob.y, mob.z].every(Number.isFinite)) add('error', 'invalid-position', mob.serial, 'non-finite mobile coordinate');
    if (mob.targetSerial && !world.mobiles.has(mob.targetSerial >>> 0)) add('warning', 'stale-target', mob.serial, `target 0x${(mob.targetSerial >>> 0).toString(16)} missing`);
  }
  for (const [parent, children] of world?._childrenByParent ?? []) for (const serial of children) {
    const item = world.items.get(serial >>> 0);
    if (!item) add('error', 'child-index', serial, `index parent 0x${(parent >>> 0).toString(16)} references missing item`);
    else if ((item.parent >>> 0) !== (parent >>> 0)) add('error', 'child-index', serial, 'item parent and reverse index disagree');
  }
  for (const group of spawner?.groups?.values?.() ?? []) for (const serial of group.spawnedSerials ?? []) {
    if (!world.mobiles.has(serial >>> 0)) add('warning', 'spawner-tracking', serial, `group ${group.id} tracks missing mobile`);
  }
  const counts = issues.reduce((acc, issue) => { acc[issue.severity] = (acc[issue.severity] ?? 0) + 1; return acc; }, {});
  return { ok: !(counts.error > 0), scanned: { items: world?.items?.size ?? 0, mobiles: world?.mobiles?.size ?? 0,
    spawners: spawner?.groups?.size ?? 0 }, counts, issues };
}

/** Non-blocking equivalent for admin-triggered deep scans. It yields after a
 * bounded number of entities, keeping gameplay packets and AI schedulable. */
export async function scanWorldIntegrityAsync(world, { spawner = null, batchSize = 1000 } = {}) {
  const issues = [];
  const add = (severity, kind, serial, detail) => {
    if (issues.length < 5000) issues.push({ severity, kind,
      serial: serial ? `0x${(serial >>> 0).toString(16)}` : null, detail });
  };
  const batch = Math.max(100, batchSize | 0);
  let visited = 0;
  const yieldMaybe = async () => {
    if (++visited % batch === 0) await new Promise((resolve) => setImmediate(resolve));
  };
  for (const item of world?.items?.values?.() ?? []) {
    if (item.parent != null && !world.items.has(item.parent >>> 0) && !world.mobiles.has(item.parent >>> 0)) add('error', 'orphan-item', item.serial, `parent 0x${(item.parent >>> 0).toString(16)} missing`);
    if (item.parent == null && ![item.x, item.y, item.z].every(Number.isFinite)) add('error', 'invalid-position', item.serial, 'non-finite item coordinate');
    if (item.boat) for (const attached of [...(item.boat.planks ?? []), ...(item.boat.cannons ?? [])]) {
      if (!world.items.has(attached >>> 0)) add('warning', 'boat-attachment', item.serial, `attachment 0x${(attached >>> 0).toString(16)} missing`);
    }
    await yieldMaybe();
  }
  for (const mob of world?.mobiles?.values?.() ?? []) {
    if (![mob.x, mob.y, mob.z].every(Number.isFinite)) add('error', 'invalid-position', mob.serial, 'non-finite mobile coordinate');
    if (mob.targetSerial && !world.mobiles.has(mob.targetSerial >>> 0)) add('warning', 'stale-target', mob.serial, `target 0x${(mob.targetSerial >>> 0).toString(16)} missing`);
    await yieldMaybe();
  }
  for (const [parent, children] of world?._childrenByParent ?? []) for (const serial of children) {
    const item = world.items.get(serial >>> 0);
    if (!item) add('error', 'child-index', serial, `index parent 0x${(parent >>> 0).toString(16)} references missing item`);
    else if ((item.parent >>> 0) !== (parent >>> 0)) add('error', 'child-index', serial, 'item parent and reverse index disagree');
    await yieldMaybe();
  }
  for (const group of spawner?.groups?.values?.() ?? []) for (const serial of group.spawnedSerials ?? []) {
    if (!world.mobiles.has(serial >>> 0)) add('warning', 'spawner-tracking', serial, `group ${group.id} tracks missing mobile`);
    await yieldMaybe();
  }
  const counts = issues.reduce((acc, issue) => { acc[issue.severity] = (acc[issue.severity] ?? 0) + 1; return acc; }, {});
  return { ok: !(counts.error > 0), scanned: { items: world?.items?.size ?? 0, mobiles: world?.mobiles?.size ?? 0,
    spawners: spawner?.groups?.size ?? 0 }, counts, issues };
}

export function verifySaveDirectory(saveDir) {
  try {
    const database = verifyWorldDatabaseSync(saveDir);
    return { ok: database.ok, saveDir, database, files: [database] };
  } catch (error) {
    return { ok: false, saveDir, database: null, files: [], error: error.message };
  }
}
