import assert from 'node:assert/strict';
import { effectLifetimeMs } from '../src/renderer/effect-timing.js';

assert.equal(
  effectLifetimeMs({ type: 2, duration: 10 }),
  500,
  'fixed-effect duration uses protocol 50 ms units',
);

const slow = effectLifetimeMs({
  type: 0,
  sx: 0, sy: 0, sz: 0,
  tx: 10, ty: 0, tz: 0,
  speed: 5,
  duration: 50,
});
const sameWithDifferentDuration = effectLifetimeMs({
  type: 0,
  sx: 0, sy: 0, sz: 0,
  tx: 10, ty: 0, tz: 0,
  speed: 5,
  duration: 1,
});
const fast = effectLifetimeMs({
  type: 0,
  sx: 0, sy: 0, sz: 0,
  tx: 10, ty: 0, tz: 0,
  speed: 10,
  duration: 50,
});

assert.ok(slow > 400 && slow < 700, `ten-tile projectile should travel in a plausible interval (${slow} ms)`);
assert.equal(slow, sameWithDifferentDuration, 'moving travel is distance/speed driven, not duration driven');
assert.ok(fast < slow, 'higher protocol speed shortens projectile travel');

console.log('[smoke:effect-timing] ok');
