import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createClientRuntimeProfile, FrameTaskScheduler, ResourceTelemetry,
  SessionEpoch, AsyncGenerationOwner, validateTextureRegion,
  clampLayoutRect, migrateLayoutScale, buildClientQualityReport, clientQualityReportMarkdown,
} from '../src/shared/runtime-governor.js';

const low = createClientRuntimeProfile({ navigator: { deviceMemory: 2, hardwareConcurrency: 2 } });
const high = createClientRuntimeProfile({ navigator: { deviceMemory: 16, hardwareConcurrency: 16 } });
assert.equal(low.tier, 'low');
assert.equal(high.tier, 'high');
assert.ok(low.atlasBytes < high.atlasBytes && low.chunkPopulates < high.chunkPopulates);
assert.ok(low.cacheLimits.gump < high.cacheLimits.gump);

let now = 0;
const scheduler = new FrameTaskScheduler({ now: () => (now += 0.2), budgetMs: 1 });
const seen = [];
scheduler.schedule('prefetch', () => seen.push('prefetch'), { priority: 3, owner: 'chunk' });
scheduler.schedule('visible', () => seen.push('old'), { priority: 0, owner: 'chunk' });
scheduler.schedule('visible', () => seen.push('visible'), { priority: 0, owner: 'chunk' });
scheduler.schedule('cancelled', () => seen.push('bad'), { priority: 1, owner: 'old-scene' });
assert.equal(scheduler.cancelOwner('old-scene'), 1);
scheduler.drain(10);
assert.deepEqual(seen, ['visible', 'prefetch']);
assert.equal(scheduler.stats.cancelled, 2, 'dedupe and owner cancellation are both counted');
const initialBudget = scheduler.budgetMs;
for (let i = 0; i < 20; i++) scheduler.observeFrame(40);
assert.ok(scheduler.budgetMs < initialBudget, 'streaming budget adapts down after slow frames');

const telemetry = new ResourceTelemetry();
telemetry.note('gump', 'hit'); telemetry.note('gump', 'miss'); telemetry.note('gump', 'evict');
assert.equal(telemetry.missing('static', 42), true);
assert.equal(telemetry.missing('static', 42), false);
const snapshot = telemetry.snapshot();
assert.deepEqual(snapshot.resources.gump, { hits: 1, misses: 1, evictions: 1, requests: 3 });
assert.equal(snapshot.missing[0].count, 2);

const epoch = new SessionEpoch();
const captured = epoch.capture();
let calls = 0;
const guarded = epoch.guard(captured, () => calls++);
guarded(); epoch.advance(); guarded();
assert.equal(calls, 1, 'callbacks from retired sessions must be ignored');
const owner = new AsyncGenerationOwner();
const ownerGeneration = owner.capture();
let guardedCalls = 0;
owner.guard(ownerGeneration, () => guardedCalls++)(); owner.invalidate(); owner.guard(ownerGeneration, () => guardedCalls++)();
assert.equal(guardedCalls, 1);
assert.equal(validateTextureRegion({ u: 2, v: 3, w: 8, h: 9 }, { width: 16, height: 16 }).ok, true);
assert.equal(validateTextureRegion({ u: 12, v: 3, w: 8, h: 9 }, { width: 16, height: 16 }).ok, false);

assert.deepEqual(clampLayoutRect({ x: 999, y: -10, width: 300, height: 200 }, { width: 800, height: 600 }), {
  x: 768, y: 0, width: 300, height: 200,
});
assert.deepEqual(migrateLayoutScale({ x: 100, y: 100, width: 200, height: 100 }, 1, 2, { width: 800, height: 600 }), {
  x: 50, y: 50, width: 100, height: 50,
});

const report = buildClientQualityReport({ profile: low, assets: { diagnosticsSnapshot: () => ({ ok: true }) }, scheduler });
assert.equal(report.runtime.tier, 'low');
assert.equal(report.assets.ok, true);
assert.match(clientQualityReportMarkdown(report), /Runtime tier: low/);

const tileSource = readFileSync(new URL('../src/renderer/tile-renderer.js', import.meta.url), 'utf8');
assert.match(tileSource, /clientRuntimeProfile\.chunkPopulates/);
assert.match(tileSource, /CHUNK_DIRECTION_VECTORS/);
assert.match(tileSource, /\(tier \| 0\) \* 10_000/);
assert.match(tileSource, /this\._mountBatchSize/);
assert.match(tileSource, /diagnosticsSnapshot\(\)/);
assert.match(tileSource, /this\._streamFrameEma/);
assert.match(tileSource, /_chunkIntersectsViewport/);
assert.match(tileSource, /_refreshChunkShimmerGeometry/);
assert.match(tileSource, /const staticsPromise = assets\.fetchStatics/);
assert.doesNotMatch(
  tileSource,
  /gfx\.poly\(\[topX, topY, rightX, rightY, botX, botY, leftX, leftY\]/,
  'loading placeholder must not regress to one giant z=0 chunk polygon',
);

const assetSource = readFileSync(new URL('../src/assets/asset-manager.js', import.meta.url), 'utf8');
assert.match(assetSource, /trimInactiveResources\(\)/);
assert.match(assetSource, /diagnosticsSnapshot\(\)/);
assert.match(assetSource, /this\.runtimeProfile\?\.atlasBytes/);

const netSource = readFileSync(new URL('../src/net/net-client.js', import.meta.url), 'utf8');
assert.match(netSource, /SessionEpoch/);
assert.match(netSource, /net:session-reset/);
assert.match(netSource, /frame-watchdog/);

console.log('[smoke:runtime-wave2] ok');
