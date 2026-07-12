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
  constructor() {
    this.handlers = new Map();
    this.sent = [];
  }

  on(op, fn) { this.handlers.set(op & 0xff, fn); }
  send(pkt) { this.sent.push(pkt); }
}

function fixed(op, size, fill = 0) {
  const out = new Uint8Array(size);
  out[0] = op & 0xff;
  for (let i = 1; i < out.length; i++) {
    out[i] = typeof fill === 'function' ? fill(i) & 0xff : fill & 0xff;
  }
  return out;
}

function variable(op, body = []) {
  const out = new Uint8Array(3 + body.length);
  out[0] = op & 0xff;
  out[1] = (out.length >>> 8) & 0xff;
  out[2] = out.length & 0xff;
  out.set(body, 3);
  return out;
}

function asciiBytes(text, nul = false) {
  const bytes = Array.from(text, (ch) => ch.charCodeAt(0) & 0xff);
  if (nul) bytes.push(0);
  return bytes;
}

function concat(packets) {
  const total = packets.reduce((n, pkt) => n + pkt.length, 0);
  const out = new Uint8Array(total);
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

function assertPacketShape(pkt) {
  const info = SERVER_OPCODES[pkt[0]];
  assert.ok(info, `sample opcode 0x${pkt[0].toString(16)} should be declared`);
  if (info.size === VAR) {
    assert.equal((pkt[1] << 8) | pkt[2], pkt.length, `0x${pkt[0].toString(16)} sample length should match header`);
  } else {
    assert.equal(pkt.length, info.size, `0x${pkt[0].toString(16)} sample should use declared fixed size`);
  }
}

const samples = [
  { name: 'servuo-client-version-request', pkt: variable(0xBD) },
  { name: 'servuo-enabled-features-modern', pkt: new Uint8Array([0xB9, 0x00, 0x00, 0x01, 0x00]) },
  { name: 'servuo-view-range', pkt: new Uint8Array([0xC8, 0x18]) },
  { name: 'servuo-weather-cold-rain', pkt: new Uint8Array([0x65, 0x00, 0x28, 0xFB]) },
  { name: 'legacy-new-season', pkt: new Uint8Array([0x7B, 0x02]) },
  { name: 'servuo-drop-approved-status', pkt: new Uint8Array([0x29, 0x00]) },
  { name: 'servuo-close-vendor', pkt: variable(0x3B, [0x40, 0x00, 0x12, 0x34]) },
  { name: 'servuo-open-url', pkt: variable(0xA5, asciiBytes('https://shard.example/status', true)) },
  { name: 'servuo-tip-window', pkt: variable(0xA6, [0x00, 0x00, 0x00, 0x10, 0x01, 0x00, 0x03, ...asciiBytes('Tip')]) },
  { name: 'servuo-quest-arrow-modern', pkt: new Uint8Array([0xBA, 0x01, 0x12, 0x34, 0x23, 0x45, 0x40, 0x00, 0x00, 0x01]) },
  { name: 'servuo-help-queue', pkt: new Uint8Array([0xCB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05]) },
  { name: 'razor-krrios-envelope', pkt: variable(0xF0, [0x03, 0x40, 0x00, 0x00, 0x01]) },
  { name: 'kr-encryption-response', pkt: variable(0xE3, [0x12, 0x34, 0x56, 0x78, 0, 1, 2, 3, 4, 5, 6, 7, 8]) },
  { name: 'assist-version-probe', pkt: variable(0xBE) },
  { name: 'freeshard-list-reply', pkt: fixed(0xF1, 9, (i) => i) },
  { name: 'spy-on-client-admin-probe', pkt: fixed(0xD9, 268, (i) => i) },
  { name: 'old-health-update', pkt: fixed(0x1F, 8, (i) => i) },
  { name: 'legacy-delete-object', pkt: fixed(0x61, 9, (i) => i) },
  { name: 'login-delay', pkt: new Uint8Array([0xFD, 0x0A]) },
];

for (const sample of samples) assertPacketShape(sample.pkt);

const framed = frameServerStream(concat(samples.map((sample) => sample.pkt)));
assert.deepEqual(framed.warnings, [], 'representative ServUO/legacy sample stream should not resync');
assert.equal(framed.packets.length, samples.length, 'representative sample stream should frame every packet');
assert.equal(framed.consumed, samples.reduce((n, sample) => n + sample.pkt.length, 0));

bus.clear();
world.reset?.();
const net = new FakeNet();
registerHandlers(net);

const versionReq = samples.find((s) => s.name === 'servuo-client-version-request').pkt;
net.handlers.get(0xBD)(versionReq);
assert.equal(net.sent.length, 1, '0xBD ServUO client-version request should send a version reply');
assert.equal(net.sent[0][0], 0xBD, '0xBD reply should be ClientVersion');

const viewRange = once('view:range');
net.handlers.get(0xC8)(samples.find((s) => s.name === 'servuo-view-range').pkt);
viewRange.off();
assert.deepEqual(viewRange.value, { range: 0x18 });
assert.equal(world.viewRange, 0x18);

const weather = once('atmosphere:weather');
net.handlers.get(0x65)(samples.find((s) => s.name === 'servuo-weather-cold-rain').pkt);
weather.off();
assert.deepEqual(weather.value, { kind: 0, particles: 0x28, temperature: -5 });

const season = once('atmosphere:season');
net.handlers.get(0x7B)(samples.find((s) => s.name === 'legacy-new-season').pkt);
season.off();
assert.deepEqual(season.value, { season: 2, playSound: false, legacy: true });

const drag = once('drag:approved');
net.handlers.get(0x29)(samples.find((s) => s.name === 'servuo-drop-approved-status').pkt);
drag.off();
assert.deepEqual(drag.value, undefined);

const closeVendor = once('shop:close');
net.handlers.get(0x3B)(samples.find((s) => s.name === 'servuo-close-vendor').pkt);
closeVendor.off();
assert.deepEqual(closeVendor.value, { serial: 0x40001234 });

const url = once('chat:system');
net.handlers.get(0xA5)(samples.find((s) => s.name === 'servuo-open-url').pkt);
url.off();
assert.equal(url.value.text, '[server URL] https://shard.example/status');

const tip = once('chat:system');
net.handlers.get(0xA6)(samples.find((s) => s.name === 'servuo-tip-window').pkt);
tip.off();
assert.equal(tip.value.text, '[tip] Tip');

const quest = once('quest:arrow');
net.handlers.get(0xBA)(samples.find((s) => s.name === 'servuo-quest-arrow-modern').pkt);
quest.off();
assert.deepEqual(quest.value, { active: true, x: 0x1234, y: 0x2345, serial: 0x40000001 });

const krrios = once('net:krrios');
net.handlers.get(0xF0)(samples.find((s) => s.name === 'razor-krrios-envelope').pkt);
krrios.off();
assert.equal(krrios.value.type, 0x03);
assert.deepEqual(Array.from(krrios.value.body), [0x40, 0x00, 0x00, 0x01]);

const kr = once('net:kr-encryption-response');
net.handlers.get(0xE3)(samples.find((s) => s.name === 'kr-encryption-response').pkt);
kr.off();
assert.deepEqual(kr.value, { authId: 0x12345678, length: 16 });

for (const [op, name] of [
  [0xBE, 'assist-version-probe'],
  [0xF1, 'freeshard-list-reply'],
  [0xD9, 'spy-on-client-admin-probe'],
  [0x1F, 'old-health-update'],
  [0x61, 'legacy-delete-object'],
]) {
  const rare = once('net:rare-opcode');
  net.handlers.get(op)(samples.find((s) => s.name === name).pkt);
  rare.off();
  assert.equal(rare.value.opcode, op, `0x${op.toString(16)} should emit diagnostic rare-opcode`);
}

const delay = once('login:delay');
net.handlers.get(0xFD)(samples.find((s) => s.name === 'login-delay').pkt);
delay.off();
assert.deepEqual(delay.value, { seconds: 10 });

bus.clear();
console.log('[smoke:servuo-samples] ok');
