import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { World } from '../../apps/server/src/world/world.js';
import { scanWorldIntegrity } from '../../apps/server/src/systems/operational-diagnostics.js';

const full = process.argv.includes('--full') || process.env.NODEUO_AUDIT_FULL === '1';
const mobileCount = full ? 2_000 : 200;
const itemCount = full ? 20_000 : 2_000;
const ticks = full ? 20_000 : 2_000;
const soakHours = Math.max(0, Number(process.env.NODEUO_SOAK_HOURS) || 0);
const deadline = soakHours > 0 ? Date.now() + soakHours * 60 * 60 * 1000 : 0;
const world = new World();
const heapBefore = process.memoryUsage().heapUsed;

for (let i = 0; i < mobileCount; i++) {
  world.createMobile({ name: `load-${i}`, x: 1000 + (i % 100), y: 1000 + Math.floor(i / 100), map: i % 2 });
}
const mobiles = [...world.mobiles.values()];
for (let i = 0; i < itemCount; i++) {
  world.createItem({ itemId: 0x0eed, amount: 1 + (i % 20), x: 900 + (i % 200), y: 900 + (i % 150), z: 0, map: i % 2 });
}

const started = performance.now();
let completedTicks = 0;
for (let tick = 0; tick < ticks || (deadline > 0 && Date.now() < deadline); tick++) {
  const mob = mobiles[tick % mobiles.length];
  mob.x = 1000 + ((mob.x - 999 + 1) % 160);
  mob.y = 1000 + ((mob.y - 999 + ((tick & 7) === 0 ? 1 : 0)) % 160);
  world.sectors.moveMobile(mob);
  if ((tick & 63) === 0) {
    const nearby = [...world.sectors.mobileSerialsNear(mob.map, mob.x, mob.y, 18)];
    assert.ok(nearby.length <= mobileCount, 'sector query returned impossible cardinality');
  }
  completedTicks++;
  if (deadline > 0 && completedTicks % 10_000 === 0) await new Promise((ok) => setImmediate(ok));
}
const elapsed = performance.now() - started;
const integrity = scanWorldIntegrity(world);
assert.equal(integrity.ok, true, JSON.stringify(integrity.issues.slice(0, 5)));
assert.equal(world.mobiles.size, mobileCount);
assert.equal(world.items.size, itemCount);

const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
const maxHeapGrowth = full ? 512 * 1024 * 1024 : 128 * 1024 * 1024;
assert.ok(heapGrowth < maxHeapGrowth, `heap grew ${(heapGrowth / 1024 / 1024).toFixed(1)} MiB`);
const movesPerSecond = Math.round(completedTicks / Math.max(0.001, elapsed / 1000));
assert.ok(movesPerSecond > 500, `sector movement throughput too low: ${movesPerSecond}/s`);

console.log(`[audit:server-load] ok mobiles=${mobileCount} items=${itemCount} ticks=${completedTicks} movesPerSecond=${movesPerSecond} heapMiB=${(heapGrowth / 1024 / 1024).toFixed(1)} soakHours=${soakHours}`);
