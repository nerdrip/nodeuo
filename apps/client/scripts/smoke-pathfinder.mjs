globalThis.window ??= globalThis;
globalThis.Worker ??= undefined;
globalThis.localStorage ??= {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

const { assets } = await import('../src/assets/asset-manager.js');
const { world } = await import('../src/world/world.js');
const { pathfind, pathfindAsync, pathfindStats } = await import('../src/world/pathfinder.js');
const { readFileSync } = await import('node:fs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const original = {
  landAt: assets.landAt,
  staticsAt: assets.staticsAt,
  suppInfo: assets.suppInfo,
  tiledata: assets.tiledata,
};

try {
  world.reset();
  world.mapId = 1;
  assets.tiledata = { statics: [] };
  assets.suppInfo = () => null;
  assets.landAt = () => ({ id: 0, z: 0 });
  assets.staticsAt = () => [];

  let dirs = pathfind({ x: 0, y: 0, z: 0, map: 1 }, 3, 0);
  assert(Array.isArray(dirs), 'flat path should resolve');
  assert(dirs.join(',') === '2,2,2', `flat east path should be 2,2,2, got ${dirs.join(',')}`);
  assert(pathfindStats.lastResult === 'found', 'pathfind stats should record found result');
  assert(pathfindStats.lastCacheMisses > 0, 'pathfind should populate Z cache stats');

  const blockerId = 0x0999;
  assets.tiledata.statics[blockerId] = { flags: 0x00000040, height: 20 };
  const blocker = world.ensureItem(0x40000001);
  Object.assign(blocker, {
    itemId: blockerId,
    x: 1,
    y: 0,
    z: 0,
    map: 1,
    parent: 0,
  });
  world.markSpatialDirty();

  dirs = pathfind({ x: 0, y: 0, z: 0, map: 1 }, 2, 0);
  assert(Array.isArray(dirs), 'path around dynamic blocker should resolve');
  assert(dirs[0] !== 2, 'path should not step directly east into dynamic blocker');
  assert(pathfindStats.lastBlockCacheMisses > 0, 'pathfind should populate blocker cache stats');

  dirs = await pathfindAsync({ x: 0, y: 0, z: 0, map: 1 }, 2, 0);
  assert(Array.isArray(dirs), 'async pathfinder fallback should resolve');

  const pathfinderSource = readFileSync(new URL('../src/world/pathfinder.js', import.meta.url), 'utf8');
  const workerSource = readFileSync(new URL('../src/world/pathfinder-worker.js', import.meta.url), 'utf8');
  for (const needle of [
    'new Worker(new URL',
    'experimental.workerPathfinding',
    'pathfindAsync',
    '_buildWorkerSnapshot',
    'worker.postMessage',
  ]) {
    assert(pathfinderSource.includes(needle), `pathfinder should keep worker-ready path: ${needle}`);
  }
  for (const needle of [
    'self.onmessage',
    'blockedBuffer',
    'zBuffer',
    'heapPush',
    'heapPop',
  ]) {
    assert(workerSource.includes(needle), `pathfinder worker should keep A* solver path: ${needle}`);
  }
} finally {
  assets.landAt = original.landAt;
  assets.staticsAt = original.staticsAt;
  assets.suppInfo = original.suppInfo;
  assets.tiledata = original.tiledata;
  world.reset();
}

console.log('[smoke:pathfinder] ok');
