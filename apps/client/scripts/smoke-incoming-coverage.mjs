import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { bus } = await import('../src/core/event-bus.js');
const { SERVER_OPCODES, VAR, frameServerStream } = await import('../src/net/incoming-table.js');
const { registerHandlers } = await import('../src/net/handlers.js');
const { world } = await import('../src/world/world.js');

class FakeNet {
  constructor() { this.handlers = new Map(); }
  on(op, fn) { this.handlers.set(op & 0xff, fn); }
  send() {}
}

function packetFor(op, info) {
  if (info.size === VAR) return new Uint8Array([op & 0xff, 0x00, 0x03]);
  const size = info.size | 0;
  const pkt = new Uint8Array(size);
  pkt[0] = op & 0xff;
  for (let i = 1; i < pkt.length; i++) pkt[i] = (op + i) & 0xff;
  return pkt;
}

function concatPackets(packets) {
  let len = 0;
  for (const pkt of packets) len += pkt.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const pkt of packets) {
    out.set(pkt, off);
    off += pkt.length;
  }
  return out;
}

function once(topic) {
  let value = null;
  const off = bus.on(topic, (payload) => { value = payload; });
  return {
    get value() { return value; },
    off,
  };
}

bus.clear();
const net = new FakeNet();
registerHandlers(net);

const opcodeEntries = Object.entries(SERVER_OPCODES)
  .map(([key, info]) => [Number(key), info])
  .sort((a, b) => a[0] - b[0]);

const missingHandlers = opcodeEntries
  .filter(([op]) => typeof net.handlers.get(op) !== 'function')
  .map(([op, info]) => `0x${op.toString(16).padStart(2, '0')} ${info.name}`);
assert.deepEqual(missingHandlers, [], `every declared server opcode should have a handler or explicit no-op stub; missing ${missingHandlers.join(', ')}`);

const framed = frameServerStream(concatPackets(opcodeEntries.map(([op, info]) => packetFor(op, info))));
assert.deepEqual(framed.warnings, [], 'minimal fuzz stream for known server opcodes should not resync');
assert.equal(framed.packets.length, opcodeEntries.length, 'minimal fuzz stream should frame every known opcode once');
assert.equal(framed.consumed, opcodeEntries.reduce((n, [op, info]) => n + packetFor(op, info).length, 0));

const ping = packetFor(0x73, SERVER_OPCODES[0x73]);
const resync = frameServerStream(concatPackets([new Uint8Array([0xff, 0xee]), ping]));
assert.equal(resync.packets.length, 1, 'unknown bytes before a known opcode should resync to next known packet');
assert.equal(resync.packets[0][0], 0x73);
assert.ok(resync.warnings.length >= 1, 'unknown bytes should produce a diagnostic warning');

for (const op of [0x15, 0x1F, 0x2B, 0x32, 0x61, 0x6B, 0x81, 0xBE, 0xD9, 0xF1, 0xC3, 0xC6, 0xC9, 0xCA, 0xD0, 0xDB]) {
  const rare = once('net:rare-opcode');
  net.handlers.get(op)(packetFor(op, SERVER_OPCODES[op]));
  rare.off();
  assert.equal(rare.value?.opcode, op, `0x${op.toString(16)} should emit net:rare-opcode`);
  assert.equal(rare.value?.length, packetFor(op, SERVER_OPCODES[op]).length);
}

world.reset?.();
const season = once('atmosphere:season');
net.handlers.get(0x7B)(new Uint8Array([0x7B, 0x02]));
season.off();
assert.deepEqual(season.value, { season: 2, playSound: false, legacy: true }, '0x7B NewSeason should surface as an atmosphere season event');
assert.equal(world.season, 2);

bus.clear();
console.log('[smoke:incoming-coverage] ok');
