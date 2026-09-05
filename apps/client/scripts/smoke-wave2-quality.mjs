import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { World } from '../src/world/world.js';
import { frameServerStream } from '../src/net/incoming-table.js';
import {
  AsyncWorkPool, FrameTaskScheduler, clampLayoutRect, createClientRuntimeProfile,
  migrateLayoutScale,
} from '../src/shared/runtime-governor.js';

// 91 + 94: reconnect reset and equipment/container commits are atomic.
const world = new World();
const mob = world.ensureMobile(0x100);
world.replaceEquipment(mob, [
  { serial: 0x40000001, layer: 5, itemId: 0x1517, hue: 1 },
  { serial: 0x40000002, layer: 21, itemId: 0x0e75, hue: 0 },
]);
assert.deepEqual([...mob.equipment.keys()], [5, 21]);
assert.equal(world.validateGraph().ok, true);
const duplicateSnapshot = world.replaceEquipment(mob, [
  { serial: 0x40000001, layer: 5, itemId: 0x1517, hue: 1 },
  { serial: 0x40000004, layer: 29, itemId: 0x09ab, hue: 0 },
  { serial: 0x40000005, layer: 29, itemId: 0x09ab, hue: 50 },
  { serial: 0x40000002, layer: 21, itemId: 0x0e75, hue: 0 },
]);
assert.equal(duplicateSnapshot.ok, true);
assert.equal(duplicateSnapshot.ignored, 1);
assert.deepEqual([...mob.equipment.keys()], [5, 29, 21]);
world.replaceEquipment(mob, [{ serial: 0x40000002, layer: 21, itemId: 0x0e75, hue: 0 }]);
assert.equal(world.items.has(0x40000001), false, 'stale worn art must leave the graph');
world.replaceContainerContents(0x40000002, [
  { serial: 0x40000003, itemId: 0x0eed, amount: 50, hue: 0, gridX: 10, gridY: 20 },
]);
assert.equal(world.validateGraph().ok, true);
const oldMaps = { mobiles: world.mobiles, items: world.items };
world.reset();
assert.notEqual(world.mobiles, oldMaps.mobiles);
assert.notEqual(world.items, oldMaps.items);
assert.equal(world.mobiles.size + world.items.size, 0);

// 92: random and malformed streams never escape the framer or consume beyond input.
let seed = 0x4e6f6465;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
for (let pass = 0; pass < 2_000; pass++) {
  const bytes = new Uint8Array(random() % 512);
  for (let i = 0; i < bytes.length; i++) bytes[i] = random() & 0xff;
  const framed = frameServerStream(bytes);
  assert.ok(framed.consumed >= 0 && framed.consumed <= bytes.length);
  assert.ok(framed.packets.every((packet) => packet.byteLength > 0 && packet.byteLength <= bytes.length));
}

// 95 + 97: DPI migration stays visible and scheduler obeys frame budgets.
for (const from of [0.75, 1, 1.25, 1.5, 2]) for (const to of [0.75, 1, 1.5, 2]) {
  const rect = migrateLayoutScale({ x: 900, y: -40, width: 420, height: 260 }, from, to, { width: 1024, height: 768 });
  assert.deepEqual(rect, clampLayoutRect(rect, { width: 1024, height: 768 }));
}
let clock = 0;
const scheduler = new FrameTaskScheduler({ budgetMs: 2, now: () => (clock += 0.2) });
for (let i = 0; i < 500; i++) scheduler.schedule(`chunk:${i}`, () => {}, { priority: i < 20 ? 0 : 3 });
const drained = scheduler.drain();
assert.ok(drained > 0 && drained < 500);
assert.ok(scheduler.stats.lastMs <= 2.5);

// Bounded decoding is a behavioural memory/concurrency gate used by facet swaps.
const pool = new AsyncWorkPool(3); let active = 0; let peak = 0;
await Promise.all(Array.from({ length: 40 }, (_, i) => pool.run(`page:${i}`, async () => {
  active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return i;
})));
assert.ok(peak <= 3); assert.equal(pool.stats.queued, 0);
assert.ok(createClientRuntimeProfile({ navigator: { deviceMemory: 2, hardwareConcurrency: 2 } }).atlasBytes
  < createClientRuntimeProfile({ navigator: { deviceMemory: 16, hardwareConcurrency: 16 } }).atlasBytes);

// 93, 96, 98, 99 integration gates: exact implementation anchors.
const asset = readFileSync(new URL('../src/assets/asset-manager.js', import.meta.url), 'utf8');
assert.match(asset, /placeholderTexture\(kind/); assert.match(asset, /_missingAssetCounts/); assert.match(asset, /trimInactiveResources/);
const context = readFileSync(new URL('../src/ui/controls/context-menu.js', import.meta.url), 'utf8');
assert.match(context, /rect\.right > window\.innerWidth/); assert.match(context, /rect\.bottom > window\.innerHeight/);
const tile = readFileSync(new URL('../src/renderer/tile-renderer.js', import.meta.url), 'utf8');
assert.match(tile, /chunkHardLimit/); assert.match(tile, /cancelOwner\(this\)/); assert.match(tile, /landMeshPool\.stats/);
const diagnostics = readFileSync(new URL('../src/managers/diagnostics-manager.js', import.meta.url), 'utf8');
assert.match(diagnostics, /unhandledrejection/); assert.match(diagnostics, /qualityGate/);

console.log('[smoke:wave2-quality] ok fuzz=2000 concurrency=3 graph=consistent');
