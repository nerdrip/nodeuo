import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const { assets } = await import('../src/assets/asset-manager.js');

const savedPages = assets._atlasPages;
const savedUses = assets._atlasPageUseCounts;
const savedLoads = assets._atlasPageLoads;
const savedUnloads = assets._atlasPageUnloads;
const savedLandAtlas = assets.landAtlas;
const savedStaticAtlas = assets.staticAtlas;
const savedGumpAtlas = assets.gumpAtlas;
const savedTexmapAtlas = assets.texmapAtlas;
const savedMissingLand = assets._missingLandTextures;
const savedMissingStatic = assets._missingStaticTextures;
const savedMissingGump = assets._missingGumpTextures;
const savedMissingTexmap = assets._missingTexmapTextures;
const savedMissingCounts = assets._missingAssetCounts;
const savedLoadAtlasPage = assets._loadAtlasPage;
const savedPreloadStats = assets.assetPreloadStats;

try {
  assets._atlasPages = new Map();
  assets._atlasPageUseCounts = new Map();
  assets._atlasPageLoads = new Map();
  assets._atlasPageUnloads = new Map();

  let destroyed = 0;
  for (let i = 0; i < 48; i++) {
    const key = `static:${i}`;
    assets._atlasPages.set(key, {
      destroy: () => { destroyed++; },
    });
    if (i < 8) assets._atlasPageUseCounts.set(key, 1);
  }

  assets._capAtlasPages(24);

  assert.ok(assets._atlasPages.size <= 24, 'atlas page LRU should trim to target');
  assert.equal(destroyed, 32, 'unused atlas pages should be destroyed');
  for (let i = 0; i < 8; i++) {
    assert.ok(assets._atlasPages.has(`static:${i}`), 'used atlas page should stay resident');
  }

  assets.landAtlas = { tiles: {} };
  assets.staticAtlas = { tiles: {} };
  assets.gumpAtlas = { tiles: {} };
  assets.texmapAtlas = { tiles: {} };
  assets._missingLandTextures = new Set();
  assets._missingStaticTextures = new Set();
  assets._missingGumpTextures = new Set();
  assets._missingTexmapTextures = new Set();
  assets._missingAssetCounts = new Map();

  assert.equal(await assets.landTexture(0x1234), null);
  assert.equal(await assets.staticTexture(0x2345), null);
  assert.equal(await assets.gumpTexture(0x3456), null);
  assert.equal(await assets.texmapTexture(0x4567), null);
  assert.equal(await assets.landTexture(0x1234), null, 'known-missing land lookup should stay quiet');

  const missing = assets.missingAssetStats;
  assert.equal(missing.total, 4, 'missing asset aggregation should count unique ids by kind');
  assert.equal(missing.byKind.land, 1);
  assert.equal(missing.byKind.static, 1);
  assert.equal(missing.byKind.gump, 1);
  assert.equal(missing.byKind.texmap, 1);
  assert.deepEqual(
    missing.top.map((entry) => `${entry.kind}:${entry.id.toString(16)}`).sort(),
    ['gump:3456', 'land:1234', 'static:2345', 'texmap:4567'],
  );

  const preloadJobs = Array.from({ length: 5 }, (_, page) => ({ kind: 'land', page }));
  const loaded = [];
  let settled = 0;
  assets._loadAtlasPage = async (kind, page) => {
    loaded.push(`${kind}:${page}`);
    return null;
  };
  await assets._runAtlasPreloadQueue(preloadJobs, 4, () => { settled++; });
  assert.deepEqual(loaded, ['land:0', 'land:1', 'land:2', 'land:3', 'land:4']);
  assert.equal(settled, preloadJobs.length);
  assert.equal(assets.assetPreloadStats.jobs, preloadJobs.length);
  assert.equal(assets.assetPreloadStats.completed, preloadJobs.length);
  assert.ok(assets.assetPreloadStats.batches >= 3, 'preload should be split across idle batches');
  assert.ok(assets.assetPreloadStats.maxBatchSize <= 2, 'preload should respect per-idle page budget');

  const assetSource = readFileSync(new URL('../src/assets/asset-manager.js', import.meta.url), 'utf8');
  const workerSource = readFileSync(new URL('../src/assets/worker-json.js', import.meta.url), 'utf8');
  for (const needle of [
    'const HEAVY_MANIFESTS = new Set',
    "'tiledata.json'",
    "'animdata.json'",
    "'multi.json'",
    "'cliloc.json'",
    "await import('./worker-json.js')",
    'fetchJsonInWorker(url)',
    "`${BASE}/${stem}.ktx2`",
    "`${BASE}/${stem}.png`",
    "fetch(url, { method: 'HEAD' })",
  ]) {
    assert.ok(assetSource.includes(needle), `asset manager should keep heavy manifest worker path: ${needle}`);
  }
  assert.ok(workerSource.includes('new Worker(new URL'), 'worker-json should spawn a module worker');
  assert.ok(workerSource.includes('return r.json()'), 'worker-json should keep main-thread fallback for tests/browsers');
} finally {
  assets._atlasPages = savedPages;
  assets._atlasPageUseCounts = savedUses;
  assets._atlasPageLoads = savedLoads;
  assets._atlasPageUnloads = savedUnloads;
  assets.landAtlas = savedLandAtlas;
  assets.staticAtlas = savedStaticAtlas;
  assets.gumpAtlas = savedGumpAtlas;
  assets.texmapAtlas = savedTexmapAtlas;
  assets._missingLandTextures = savedMissingLand;
  assets._missingStaticTextures = savedMissingStatic;
  assets._missingGumpTextures = savedMissingGump;
  assets._missingTexmapTextures = savedMissingTexmap;
  assets._missingAssetCounts = savedMissingCounts;
  assets._loadAtlasPage = savedLoadAtlasPage;
  assets.assetPreloadStats = savedPreloadStats;
}

console.log('[smoke:asset-cache] ok');
