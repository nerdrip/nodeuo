import assert from 'node:assert/strict';
import { bus } from '../src/core/event-bus.js';
import { net } from '../src/net/net-client.js';
import { party } from '../src/managers/party-manager.js';
import { world } from '../src/world/world.js';

function u32(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

const originalSend = net.send.bind(net);
const sent = [];
net.send = (bytes) => sent.push(bytes);

try {
  world.reset();
  world.player = { serial: 0x01020304 };
  party.members = new Map();
  party.leaderSerial = 0;
  party.pendingInviter = 0;

  const invites = [];
  const chats = [];
  const unsubs = [
    bus.on('party:invite', (info) => invites.push(info)),
    bus.on('party:chat', (info) => chats.push(info)),
  ];

  bus.emit('party:command', {
    payload: new Uint8Array([0x01, 0x02, ...u32(0x01020304), ...u32(0x05060708)]),
  });
  assert.equal(party.leaderSerial, 0x01020304);
  assert.equal(party.size(), 2);

  assert.equal(party.setCanLoot(true), true);
  assert.equal(hex(sent.pop()), 'bf000700060601');
  assert.equal(party.myCanLoot(), true);
  assert.equal(party.setCanLoot(0x05060708, true), false);
  assert.equal(sent.length, 0);

  party.sayParty('hi');
  assert.equal(hex(sent.pop()), 'bf000c000604006800690000');
  party.sayPrivate(0x05060708, 'ok');
  assert.equal(hex(sent.pop()), 'bf001000060305060708006f006b0000');

  party.acceptInvite(0x05060708);
  assert.equal(hex(sent.pop()), 'bf000a00060805060708');
  party.declineInvite(0x05060708);
  assert.equal(hex(sent.pop()), 'bf000a00060905060708');

  bus.emit('party:command', { payload: new Uint8Array([0x07, ...u32(0x05060708)]) });
  assert.deepEqual(invites.pop(), { leader: 0x05060708 });
  assert.equal(party.pendingInviter, 0x05060708);

  bus.emit('party:command', {
    payload: new Uint8Array([0x04, ...u32(0x05060708), 0x00, 0x68, 0x00, 0x69, 0x00, 0x00]),
  });
  assert.deepEqual(chats.pop(), { from: 0x05060708, text: 'hi', private: false });
  bus.emit('party:command', {
    payload: new Uint8Array([0x03, ...u32(0x05060708), 0x00, 0x70, 0x00, 0x6d, 0x00, 0x00]),
  });
  assert.deepEqual(chats.pop(), { from: 0x05060708, text: 'pm', private: true });

  bus.emit('party:command', {
    payload: new Uint8Array([0x02, 0x01, ...u32(0x05060708), ...u32(0x01020304)]),
  });
  assert.equal(party.size(), 1);
  assert.equal(party.isMember(0x05060708), false);
  assert.equal(party.isMember(0x01020304), true);

  for (const unsub of unsubs) unsub();
} finally {
  net.send = originalSend;
}

console.log('[smoke:party-manager] ok');
