import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const startedAt = Date.now();
const protocol = {
  connectionsOpened: 0, connectionsClosed: 0, protocolErrors: 0, handlerErrors: 0,
  rxPackets: 0, txPackets: 0, rxBytes: 0, txBytes: 0,
  rx: new Map(), tx: new Map(),
};
const sessions = new Map();
const audit = [];
const AUDIT_MAX = 2000;

function opcodeEntry(map, opcode) {
  const key = opcode & 0xff;
  const value = map.get(key) ?? { opcode: key, packets: 0, bytes: 0, errors: 0, totalHandlerMs: 0, maxHandlerMs: 0 };
  map.set(key, value);
  return value;
}

export function connectionOpened(state) {
  protocol.connectionsOpened++;
  sessions.set(state.id, { id: state.id, openedAt: Date.now(), transport: state.nodeUOTransport ? 'nodeuo.v1' : 'standard', stage: state.stage });
}
export function connectionUpdated(state) {
  const entry = sessions.get(state.id);
  if (!entry) return;
  Object.assign(entry, { stage: state.stage, account: state.accountName ?? undefined, mobileSerial: state.mobile?.serial,
    clientVersion: state.clientVersionString ?? undefined, capabilities: state.nodeUOCapabilities >>> 0,
    pendingBytes: Number(state.ws?.bufferedAmount) || 0 });
}
export function connectionClosed(state, reason = '') {
  if (!sessions.delete(state.id)) return;
  protocol.connectionsClosed++;
  recordAudit('network.close', { actor: state.accountName, target: `net#${state.id}`, detail: String(reason).slice(0, 160) });
}
export function packet(direction, opcode, bytes, handlerMs = 0, error = false) {
  const incoming = direction === 'rx';
  const entry = opcodeEntry(incoming ? protocol.rx : protocol.tx, opcode);
  entry.packets++; entry.bytes += Math.max(0, bytes | 0);
  if (error) entry.errors++;
  if (handlerMs > 0) { entry.totalHandlerMs += handlerMs; entry.maxHandlerMs = Math.max(entry.maxHandlerMs, handlerMs); }
  if (incoming) { protocol.rxPackets++; protocol.rxBytes += Math.max(0, bytes | 0); }
  else { protocol.txPackets++; protocol.txBytes += Math.max(0, bytes | 0); }
}
export function protocolError() { protocol.protocolErrors++; }
export function handlerError() { protocol.handlerErrors++; }
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
  return { connected: list.length, byTransport, byVersion, sessions: list };
}
export function recordAudit(kind, { actor, target, detail, ok = true } = {}) {
  audit.push({ at: Date.now(), kind: String(kind), actor: actor ? String(actor) : undefined,
    target: target ? String(target) : undefined, detail: detail ? String(detail).slice(0, 500) : undefined, ok: !!ok });
  if (audit.length > AUDIT_MAX) audit.splice(0, audit.length - AUDIT_MAX);
}
export function auditSnapshot(limit = 200) { return audit.slice(-Math.max(1, Math.min(2000, limit | 0))).reverse(); }

export function scanWorldIntegrity(world, { spawner = null } = {}) {
  const issues = [];
  const add = (severity, kind, serial, detail) => {
    if (issues.length < 5000) issues.push({ severity, kind, serial: serial ? `0x${(serial >>> 0).toString(16)}` : null, detail });
  };
  for (const item of world?.items?.values?.() ?? []) {
    if (item.parent != null && !world.items.has(item.parent >>> 0) && !world.mobiles.has(item.parent >>> 0)) add('error', 'orphan-item', item.serial, `parent 0x${(item.parent >>> 0).toString(16)} missing`);
    if (![item.x, item.y, item.z].every(Number.isFinite)) add('error', 'invalid-position', item.serial, 'non-finite item coordinate');
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

export function verifySaveDirectory(saveDir) {
  const candidates = ['world.json.gz', 'world.json', 'houses.json.gz', 'houses.json'];
  const files = [];
  for (const name of candidates) {
    const file = path.join(saveDir, name);
    if (!fs.existsSync(file)) continue;
    try {
      const bytes = fs.readFileSync(file);
      const text = name.endsWith('.gz') ? zlib.gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
      const parsed = JSON.parse(text);
      files.push({ name, ok: true, bytes: bytes.length, version: parsed.version,
        records: parsed.mobiles?.length ?? parsed.items?.length ?? parsed.houses?.length ?? null });
    } catch (error) { files.push({ name, ok: false, error: error.message }); }
  }
  return { ok: files.length > 0 && files.every((file) => file.ok), saveDir, files };
}
