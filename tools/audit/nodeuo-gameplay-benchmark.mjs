import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { NodeUODelivery, NodeUOJsonKind, serializeNodeUOFrame } from '../../packages/nodeuo-protocol/src/index.js';
import { ConnectionBandwidthBudget } from '../../apps/server/src/net/connection-bandwidth.js';
import { HotEntityStore } from '../../apps/server/src/world/hot-entity-store.js';
import { EntityDirty, InterestManager } from '../../apps/server/src/world/interest-management.js';
import { SectorIndex } from '../../apps/server/src/world/sectors.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const full = process.argv.includes('--full');
const scale = full ? 4 : 1;

function measure(name, iterations, run, minimumOpsPerSecond) {
  for (let index = 0; index < Math.min(2000, iterations); index++) run(index);
  const samples = [];
  for (let pass = 0; pass < 5; pass++) {
    const started = performance.now();
    for (let index = 0; index < iterations; index++) run(index);
    const elapsedMs = Math.max(0.001, performance.now() - started);
    samples.push(iterations * 1000 / elapsedMs);
  }
  samples.sort((left, right) => left - right);
  const opsPerSecond = Math.round(samples[2]);
  return { name, iterations, opsPerSecond, minimumOpsPerSecond,
    passed: opsPerSecond >= minimumOpsPerSecond };
}

const entities = Array.from({ length: 12_000 * scale }, (_, index) => ({
  serial: index + 1, x: 1200 + (index % 240), y: 900 + (Math.floor(index / 240) % 160),
  z: 0, map: 1, direction: index & 7, body: 0x190, hue: index & 0x3fff,
  hp: 80, hpMax: 100, mana: 30, manaMax: 50, stam: 40, stamMax: 50,
}));
const sectors = new SectorIndex();
const hot = new HotEntityStore(entities.length);
for (const entity of entities) { sectors.addMobile(entity); hot.upsert(entity); }

let sink = 0;
const results = [];
results.push(measure('dense-aoi-query', 25_000 * scale, (index) => {
  let count = 0;
  for (const serial of sectors.mobileSerialsNear(1, 1300 + (index & 31), 980, 18)) count += serial !== 0;
  sink ^= count;
}, 12_000));
results.push(measure('hot-position-update', 300_000 * scale, (index) => {
  const entity = entities[index % entities.length];
  entity.x = 1200 + ((entity.x + 1) % 240);
  sink ^= hot.updatePosition(entity);
}, 500_000));

const interest = new InterestManager({ maxDirty: entities.length });
results.push(measure('dirty-state-coalescing', 300_000 * scale, (index) => {
  sink ^= interest.mark((index % entities.length) + 1, EntityDirty.Position);
  if ((index & 1023) === 1023) sink ^= interest.consume(1024).length;
}, 250_000));

const messages = Array.from({ length: 32 }, (_, index) => ({
  kind: NodeUOJsonKind.Delta, feature: 'world.components', seq: index + 1,
  delivery: NodeUODelivery.Latest,
  payload: { baseline: 44, entities: [{ serial: index + 1, revision: index + 1,
    components: { position: { x: 100 + index, y: 200, z: 0, map: 1 } } }] },
}));
results.push(measure('json-batch-serialization', 20_000 * scale, () => {
  sink ^= serializeNodeUOFrame(messages).length;
}, 4_000));

const budget = new ConnectionBandwidthBudget({ bytesPerSecond: 512 * 1024 });
results.push(measure('qos-admission', 500_000 * scale, (index) => {
  sink ^= budget.admit(96 + (index & 255), {
    trafficClass: (index & 7) === 0 ? 'interactive' : 'state', delivery: NodeUODelivery.Latest,
  }, index / 10) === 'allow';
}, 1_000_000));

const report = {
  generatedAt: new Date().toISOString(), node: process.version, full, scale,
  entityCount: entities.length, results, passed: results.every((result) => result.passed),
  integrity: { indexed: sectors._mobAt.size, hot: hot.length, sink },
};
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'nodeuo-gameplay-performance.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const result of results) {
  console.log(`[gameplay-perf] ${result.name} ${result.opsPerSecond.toLocaleString('en-US')} ops/s ${result.passed ? 'OK' : 'FAILED'}`);
}
if (!report.passed) process.exitCode = 1;
