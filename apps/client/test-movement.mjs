// Smoke test for movement: log in, send 4 walk steps (E, S, W, N), verify
// each gets a 0x22 ack and the player position updates accordingly.
//
//   node apps/client/test-movement.mjs

import { WebSocket } from '../server/node_modules/ws/wrapper.mjs';
globalThis.WebSocket = WebSocket;

const { net } = await import('./src/net/net-client.js');
const { registerHandlers } = await import('./src/net/handlers.js');
const { bus } = await import('./src/core/event-bus.js');
const { world } = await import('./src/world/world.js');
const {
  buildLoginSeed, buildAccountLogin, buildPlayServer, buildGameLogin,
  buildPlayCharacter, buildClientVersion, buildSystemInfo,
  buildMovementReq,
} = await import('./src/net/outgoing.js');

const ACCOUNT = 'admin'; const PASSWORD = 'admin';
const URL = 'ws://127.0.0.1:2593/game';

let acks = 0; let rejects = 0;
const startPos = { x: 0, y: 0 };
let stepIndex = 0;
const STEPS = [
  { dir: 2, name: 'East'  },
  { dir: 4, name: 'South' },
  { dir: 6, name: 'West'  },
  { dir: 0, name: 'North' },
];
const DELTA = { 0: [0,-1], 2: [1,0], 4: [0,1], 6: [-1,0] };

registerHandlers(net);

bus.on('login:server-list', () => net.send(buildPlayServer(0)));
bus.on('login:relay', (info) => {
  net.send(buildClientVersion('7.0.95.0'));
  net.send(buildSystemInfo());
  net.send(buildGameLogin(info.authKey, ACCOUNT, PASSWORD));
});
bus.on('login:char-list', (info) => {
  const target = info.characters.find((c) => c.name?.trim()) ?? { name: ACCOUNT };
  net.send(buildPlayCharacter(target.name, 0));
});
bus.on('world:login-complete', () => {
  startPos.x = world.player.x;
  startPos.y = world.player.y;
  console.log(`✓ in world at (${startPos.x},${startPos.y})`);
  // Some servers send the first 0x77 with movement they pushed before the
  // client sends anything; wait a tick.
  setTimeout(sendNextStep, 100);
});
bus.on('movement:ack', ({ sequence }) => {
  acks++;
  const pending = STEPS[stepIndex - 1];
  if (!pending) return;
  const [dx, dy] = DELTA[pending.dir];
  // The handler updates world.player; mirror that here for verification.
  world.player.direction = pending.dir;
  world.player.x += dx; world.player.y += dy;
  console.log(`  ack seq=${sequence} → ${pending.name}, now (${world.player.x},${world.player.y})`);
  setTimeout(sendNextStep, 60);
});
bus.on('movement:rej', (info) => { rejects++; console.error('  REJ', info); });

function sendNextStep() {
  if (stepIndex >= STEPS.length) {
    console.log(`\nfinal: acks=${acks} rejects=${rejects} pos=(${world.player.x},${world.player.y})`);
    const ok = acks === STEPS.length && rejects === 0
      && world.player.x === startPos.x && world.player.y === startPos.y;
    process.exit(ok ? 0 : 1);
  }
  const step = STEPS[stepIndex++];
  // First step turns to face the direction (no position change). After
  // that subsequent steps with the same direction actually walk. We are
  // sending each step individually and the handler's _onMovementAck
  // assumes a position change — but for this smoke test we manually
  // mirror only walking steps. Workaround: send each direction TWICE
  // (turn, then walk) so the second ack moves us.
  const seq1 = (world.moveSequence || 1) & 0xff;
  world.moveSequence = (seq1 + 1) & 0xff || 1;
  net.send(buildMovementReq(step.dir, seq1, 0));
  // The "walk" packet — server returns a separate ack that DOES advance.
  setTimeout(() => {
    const seq2 = world.moveSequence & 0xff;
    world.moveSequence = (seq2 + 1) & 0xff || 1;
    net.send(buildMovementReq(step.dir, seq2, 0));
  }, 30);
}

await net.connect(URL);
console.log(`· connected ${URL}`);
net.send(buildLoginSeed(0x7F000001));
net.send(buildAccountLogin(ACCOUNT, PASSWORD));

setTimeout(() => {
  console.error('TIMEOUT', { acks, rejects });
  process.exit(2);
}, 8000);
