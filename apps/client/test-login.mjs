// Smoke test for the login flow — runs the new client's net layer in Node
// and walks through 0xEF → 0x80 → 0xA0 → 0x91 → 0x5D → 0x1B end-to-end
// against the live shard. Asserts each handshake step lands.
//
//   pnpm --filter @uo/client exec node test-login.mjs

import { WebSocket } from '../server/node_modules/ws/wrapper.mjs';
// Polyfill the browser global the NetClient expects.
globalThis.WebSocket = WebSocket;

const { net } = await import('./src/net/net-client.js');
const { registerHandlers } = await import('./src/net/handlers.js');
const { bus } = await import('./src/core/event-bus.js');
const {
  buildLoginSeed, buildAccountLogin, buildPlayServer, buildGameLogin,
  buildPlayCharacter, buildClientVersion, buildSystemInfo,
} = await import('./src/net/outgoing.js');

const ACCOUNT = 'admin';
const PASSWORD = 'admin';
const URL = 'ws://127.0.0.1:2593/game';

const milestones = [];
function mark(tag, payload) {
  milestones.push({ tag, payload });
  console.log(`✔ ${tag}`, payload ? JSON.stringify(payload).slice(0, 200) : '');
}

// net.serverHuffman defaults to true, matching the server's UO_HUFFMAN=1 default.
registerHandlers(net);

bus.on('login:server-list', (info) => {
  mark('A8 server-list', { count: info.servers.length, first: info.servers[0]?.name });
  net.send(buildPlayServer(0));
});
bus.on('login:relay', (info) => {
  mark('8C relay', info);
  net.send(buildClientVersion('7.0.95.0'));
  net.send(buildSystemInfo());
  net.send(buildGameLogin(info.authKey, ACCOUNT, PASSWORD));
});
bus.on('login:char-list', (info) => {
  mark('A9 char-list', { chars: info.characters.map((c) => c.name), cities: info.cities.length });
  // Pick first non-empty char or default to account name (server pre-registers a slot).
  const target = info.characters.find((c) => c.name?.trim()) ?? { name: ACCOUNT };
  console.log(`  > about to send 0x5D for "${target.name}"`);
  console.log(`  > ws readyState=${net.ws?.readyState}`);
  const pkt = buildPlayCharacter(target.name, 0);
  console.log(`  > built ${pkt.length} bytes, opcode 0x${pkt[0].toString(16)}`);
  net.send(pkt);
  console.log(`  > sent`);
});
bus.on('world:login-confirm', (info) => {
  mark('1B login-confirm', info);
});
bus.on('world:login-complete', () => {
  mark('55 login-complete');
  setTimeout(() => {
    console.log(`\nfinal: ${milestones.length} milestones reached`);
    process.exit(0);
  }, 250);
});
bus.on('login:rejected', (info) => {
  console.error('✖ login rejected', info);
  process.exit(1);
});
bus.on('net:close', (info) => {
  console.log('· net closed', info);
  if (milestones.length === 0) process.exit(2);
});
bus.on('net:unhandled', ({ opcode, pkt }) => {
  console.log(`  · unhandled 0x${opcode.toString(16)} (${pkt.length}B)`);
});

await net.connect(URL);
console.log(`· connected to ${URL}`);
net.send(buildLoginSeed(0x7F000001));
net.send(buildAccountLogin(ACCOUNT, PASSWORD));

setTimeout(() => {
  console.error('✖ timeout — flow did not complete in 5s');
  console.error('milestones:', milestones.map((m) => m.tag));
  process.exit(3);
}, 5000);
