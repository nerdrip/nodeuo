import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { bus } = await import('../src/core/event-bus.js');
const { registerHandlers } = await import('../src/net/handlers.js');
const { world } = await import('../src/world/world.js');

class FakeNet {
  constructor() { this.handlers = new Map(); }
  on(op, fn) { this.handlers.set(op & 0xff, fn); }
  send() {}
}

function be32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function bf(subop, payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = 0xBF;
  out[1] = (out.length >>> 8) & 0xff;
  out[2] = out.length & 0xff;
  out[3] = (subop >>> 8) & 0xff;
  out[4] = subop & 0xff;
  out.set(payload, 5);
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

world.reset();
const net = new FakeNet();
registerHandlers(net);
const ext = net.handlers.get(0xBF);
assert.equal(typeof ext, 'function', '0xBF handler should register');

const serial = 0x40001234;
const mob = world.ensureMobile(serial);
world.player = mob;

ext(bf(0x0019, new Uint8Array([0, ...be32(serial), 1])));
assert.equal(mob.dead, true, 'extended stats v0 should set mobile dead state');

const statLocks = once('mobile:stat-locks');
ext(bf(0x0019, new Uint8Array([5, ...be32(serial), 0, 0b10_01_00])));
statLocks.off();
assert.deepEqual(
  {
    serial: statLocks.value.serial,
    strLock: statLocks.value.strLock,
    dexLock: statLocks.value.dexLock,
    intLock: statLocks.value.intLock,
  },
  { serial, strLock: 2, dexLock: 1, intLock: 0 },
  'extended stats v5 fallback should decode player stat locks',
);

const customAnim = once('anim:custom');
ext(bf(0x0019, new Uint8Array([5, ...be32(serial), 0, 0xFF, 1, 0, 9, 0, 3])));
customAnim.off();
assert.deepEqual(
  {
    serial: customAnim.value.serial,
    action: customAnim.value.action,
    staticFrame: customAnim.value.staticFrame,
  },
  { serial, action: 9, staticFrame: 3 },
  'extended stats v5 should emit static animation frame',
);

console.log('[smoke:extended-stats] ok');
