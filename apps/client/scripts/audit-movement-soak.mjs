import assert from 'node:assert/strict';
import { Walker } from '../src/managers/walker.js';

const full = process.argv.includes('--full') || process.env.NODEUO_AUDIT_FULL === '1';
const steps = Number(process.env.NODEUO_MOVEMENT_STEPS) || (full ? 250_000 : 10_000);
const soakHours = Math.max(0, Number(process.env.NODEUO_SOAK_HOURS) || 0);
const deadline = soakHours > 0 ? Date.now() + soakHours * 60 * 60 * 1000 : 0;
const walker = new Walker();
let now = 1_000;
let rejects = 0;
let wraps = 0;
let previousSequence = 0;

let completedSteps = 0;
for (let i = 0; i < steps || (deadline > 0 && Date.now() < deadline); i++) {
  const run = (i & 1) === 1;
  const mounted = i % 17 === 0;
  const reservation = walker.reserve(run, false, now, mounted);
  assert.ok(reservation, `step ${i} should reserve`);
  assert.ok(reservation.sequence >= 1 && reservation.sequence <= 255, 'sequence must stay in 1..255');
  if (previousSequence === 255 && reservation.sequence === 1) wraps++;
  previousSequence = reservation.sequence;

  if (i > 0 && i % 997 === 0) {
    walker.onRej({ sequence: reservation.sequence, x: 100, y: 100, z: 0, direction: i & 7 });
    rejects++;
    assert.equal(walker.resyncRequested, true, 'reject must latch resync');
    assert.equal(walker.reserve(false, false, now + 10), null, 'movement must pause during resync');
    walker.clearResync();
  } else {
    walker.onAck(reservation.sequence);
  }
  assert.equal(walker._inFlight, 0, `step ${i} should leave no pending packet`);
  now += reservation.delayMs;
  completedSteps++;
  // A wall-clock soak must remain interruptible and let diagnostics/stdio
  // drain instead of monopolising the event loop for 8–12 hours.
  if (deadline > 0 && completedSteps % 10_000 === 0) await new Promise((ok) => setImmediate(ok));
}

assert.ok(wraps > 0, 'long soak should exercise sequence wrap');

// MAX_STEP_COUNT flow control under a delayed-ACK burst.
walker.reset();
now += 1_000;
const burst = [];
for (let i = 0; i < 5; i++) {
  const step = walker.reserve(true, false, now);
  assert.ok(step, `in-flight slot ${i + 1} should reserve`);
  burst.push(step);
  now += step.delayMs;
}
assert.equal(walker.reserve(true, false, now), null, 'sixth unacked step must be flow-controlled');
for (const step of burst) walker.onAck(step.sequence);
assert.equal(walker._inFlight, 0, 'ACK burst should drain all slots');

console.log(`[audit:movement-soak] ok steps=${completedSteps} rejects=${rejects} wraps=${wraps} soakHours=${soakHours}`);
