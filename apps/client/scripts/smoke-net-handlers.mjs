import assert from 'node:assert/strict';
import { openBookLegacy, openBookNew } from '@uo/protocol';

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

for (const op of [0x93, 0xD4, 0xD7]) {
  assert.equal(typeof net.handlers.get(op), 'function', `0x${op.toString(16)} handler should register`);
}
for (const op of [0x21, 0x22, 0x38, 0x56, 0x90, 0x97, 0xC3, 0xC6, 0xC9, 0xCA, 0xD0, 0xDB, 0xF5]) {
  assert.equal(typeof net.handlers.get(op), 'function', `0x${op.toString(16)} audit-gap handler should register`);
}

const legacyBook = once('book:open');
net.handlers.get(0x93)(openBookLegacy({
  serial: 0x40001234,
  writable: true,
  pages: 3,
  title: 'Legacy Book',
  author: 'Scribe',
}));
legacyBook.off();
assert.deepEqual(
  {
    serial: legacyBook.value.serial,
    writable: legacyBook.value.writable,
    pageCount: legacyBook.value.pageCount,
    title: legacyBook.value.title,
    author: legacyBook.value.author,
    legacy: legacyBook.value.legacy,
  },
  {
    serial: 0x40001234,
    writable: 1,
    pageCount: 3,
    title: 'Legacy Book',
    author: 'Scribe',
    legacy: true,
  },
  '0x93 should decode and emit legacy book headers',
);

const modernBook = once('book:open');
net.handlers.get(0xD4)(openBookNew({
  serial: 0x40005678,
  writable: false,
  pages: 2,
  title: 'Modern Book',
  author: 'Archivist',
}));
modernBook.off();
assert.deepEqual(
  {
    serial: modernBook.value.serial,
    writable: modernBook.value.writable,
    pageCount: modernBook.value.pageCount,
    title: modernBook.value.title,
    author: modernBook.value.author,
    legacy: modernBook.value.legacy,
  },
  {
    serial: 0x40005678,
    writable: 0,
    pageCount: 2,
    title: 'Modern Book',
    author: 'Archivist',
    legacy: undefined,
  },
  '0xD4 should keep the modern book path wired',
);

const aos = once('aos:cmd');
const d7 = new Uint8Array([0xD7, 0x00, 0x07, 0x00, 0x00, 0x12, 0x34]);
net.handlers.get(0xD7)(d7);
aos.off();
assert.deepEqual(
  {
    subop: aos.value.subop,
    length: aos.value.length,
    raw: Array.from(aos.value.raw),
  },
  {
    subop: 0x1234,
    length: 7,
    raw: Array.from(d7),
  },
  '0xD7 should emit a generic diagnostic event instead of dropping the packet',
);

const mapPin = once('mapgump:pin');
net.handlers.get(0x56)(new Uint8Array([0x56, 0x40, 0x00, 0x12, 0x34, 0x01, 0x02, 0x00, 0x10, 0x00, 0x20]));
mapPin.off();
assert.deepEqual(
  mapPin.value,
  { serial: 0x40001234, cmd: 1, pinNum: 2, x: 16, y: 32 },
  '0x56 MapData should surface pin mutations for MapGump',
);

const displayMap = once('mapgump:display');
net.handlers.get(0x90)(new Uint8Array([
  0x90, 0x40, 0x00, 0x12, 0x34, 0x13, 0x9D,
  0x00, 0x01, 0x00, 0x02, 0x01, 0x2C, 0x01, 0x90,
  0x01, 0x40, 0x00, 0xC8,
]));
displayMap.off();
assert.equal(displayMap.value.serial, 0x40001234);
assert.equal(displayMap.value.gump, 0x139D);
assert.equal(displayMap.value.width, 320);
assert.equal(displayMap.value.height, 200);

const rare = once('net:rare-opcode');
net.handlers.get(0xC3)(new Uint8Array([0xC3, 0x00, 0x03]));
rare.off();
assert.equal(rare.value.opcode, 0xC3);
assert.equal(rare.value.length, 3);

const pathfind = once('pathfind:server-request');
net.handlers.get(0x38)(new Uint8Array([0x38, 0x12, 0x34, 0xab, 0xcd, 0xff, 0xfe]));
pathfind.off();
assert.deepEqual(pathfind.value, { x: 0x1234, y: 0xabcd, z: -2 }, '0x38 should request client-side pathfind');

const ack = once('movement:ack');
net.handlers.get(0x22)(new Uint8Array([0x22, 0x7a, 0x06]));
ack.off();
assert.deepEqual(ack.value, { sequence: 0x7a, notoriety: 0x06 }, '0x22 should decode movement ack');

const rej = once('movement:rej');
net.handlers.get(0x21)(new Uint8Array([0x21, 0x7b, 0x12, 0x34, 0x56, 0x78, 0x05, 0xfb]));
rej.off();
assert.deepEqual(
  rej.value,
  { sequence: 0x7b, x: 0x1234, y: 0x5678, direction: 5, z: -5 },
  '0x21 should decode movement reject and authoritative snap position',
);

world.reset?.();
world.player = { serial: 0x40000001, x: 10, y: 10, z: 0, map: 1, direction: 0, isPlayer: true };
const forced = once('movement:forced');
net.handlers.get(0x97)(new Uint8Array([0x97, 0x82]));
forced.off();
assert.deepEqual(forced.value, { direction: 2, running: true }, '0x97 should emit forced east-run movement');
assert.equal(world.player.x, 11, '0x97 east should move player x by +1');
assert.equal(world.player.y, 10, '0x97 east should not move player y');
assert.equal(world.player.direction, 2, '0x97 should update player facing');

world.player.flags = 0x40;
const defender = world.ensureMobile(0x00000002);
defender.x = 9;
defender.y = 10;
const swing = once('combat:swing');
net.handlers.get(0x2F)(new Uint8Array([
  0x2F, 0x00,
  0x40, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x02,
]));
swing.off();
assert.deepEqual(swing.value, { attacker: 0x40000001, defender: 2 });
assert.equal(world.player.direction, 6, 'war-mode swing should face the acknowledged defender');

const legacyCombatDamage = once('combat:damage');
const legacyVisualDamage = once('damage:apply');
net.handlers.get(0x0B)(new Uint8Array([
  0x0B, 0x00, 0x00, 0x00, 0x02, 0x00, 0x19,
]));
legacyCombatDamage.off();
legacyVisualDamage.off();
assert.deepEqual(legacyCombatDamage.value, { serial: 2, amount: 25 });
assert.deepEqual(legacyVisualDamage.value, { serial: 2, amount: 25 });

bus.clear();
console.log('[smoke:net-handlers] ok');
