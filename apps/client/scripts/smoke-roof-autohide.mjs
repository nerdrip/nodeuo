import assert from 'node:assert/strict';
import { DoorTileIndex } from '../src/renderer/door-tile-index.js';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.fetch = async () => ({ ok: false });

const doorIndex = new DoorTileIndex({
  resolveDoorPiece: (id) => id === 100 ? { pieceIdx: 0 } : null,
  chunkSize: 8,
});
const closedDoor = { serial: 1, itemId: 100, x: 16, y: 24, parent: 0 };
const openDoor = { serial: 2, itemId: 101, x: 15, y: 24, parent: 0 };
const doorChunk = doorIndex.register(closedDoor);
assert.equal(doorIndex.register(openDoor), doorChunk, 'open graphic maps back to its hinge chunk');
assert.equal(doorIndex.tilesForChunkKey(doorChunk).has(doorIndex.tileKey(16, 24)), true);
doorIndex.unregister(closedDoor.serial);
assert.equal(doorIndex.tilesForChunkKey(doorChunk).size, 1, 'shared hinge remains suppressed');
doorIndex.unregister(openDoor.serial);
assert.equal(doorIndex.tilesForChunkKey(doorChunk).size, 0, 'last door releases suppression');

const {
  TileRenderer,
  assignTallStructureBounds,
  shouldHideTallEntry,
  tallStaticBounds,
  tallStructureBoundsForPlayer,
} = await import('../src/renderer/tile-renderer.js');

function sprite() {
  return { visible: true, alpha: 1 };
}

function roof(x, y, z = 20) {
  return {
    sprite: sprite(),
    x,
    y,
    z,
    height: 5,
    isRoof: true,
    isWall: false,
    isTransparent: false,
    bounds: tallStaticBounds(x, y),
  };
}

function ceilingSurface(x, y, z = 20) {
  return {
    sprite: sprite(),
    x,
    y,
    z,
    height: 0,
    isRoof: false,
    isWall: false,
    isSurface: true,
    isCeilingSurface: true,
    isTransparent: false,
    bounds: tallStaticBounds(x, y),
  };
}

const connected = [roof(10, 10), roof(11, 10), roof(14, 10)];
assignTallStructureBounds(connected);

assert.deepEqual(connected[0].bounds, { x0: 10, y0: 10, x1: 11, y1: 10 });
assert.deepEqual(connected[1].bounds, { x0: 10, y0: 10, x1: 11, y1: 10 });
assert.deepEqual(connected[2].bounds, { x0: 14, y0: 10, x1: 14, y1: 10 });

const diagonalRoof = [roof(20, 20), roof(21, 21)];
assignTallStructureBounds(diagonalRoof);
assert.deepEqual(diagonalRoof[0].bounds, { x0: 20, y0: 20, x1: 21, y1: 21 });
assert.deepEqual(diagonalRoof[1].bounds, { x0: 20, y0: 20, x1: 21, y1: 21 });

assert.equal(shouldHideTallEntry(connected[0], 10, 10, true, 5, 20), true);
assert.equal(shouldHideTallEntry(connected[1], 10, 10, true, 5, 20), true);
assert.equal(shouldHideTallEntry(connected[2], 10, 10, true, 5, 20), false);

const dynamicMultiRoof = roof(30, 30);
dynamicMultiRoof.bounds = { x0: 28, y0: 28, x1: 34, y1: 34 };
assert.equal(shouldHideTallEntry(dynamicMultiRoof, 31, 31, true, 5, 20), true);
assert.equal(shouldHideTallEntry(dynamicMultiRoof, 35, 31, true, 5, 20), false);

const chunkA = [roof(40, 40), roof(41, 40)];
const chunkB = [roof(42, 40), roof(43, 40)];
assignTallStructureBounds(chunkA);
assignTallStructureBounds(chunkB);
const wholeRoofBounds = tallStructureBoundsForPlayer([...chunkA, ...chunkB], 40, 40, 0);
assert.deepEqual(wholeRoofBounds, { x0: 40, y0: 40, x1: 43, y1: 40 });
assert.equal(shouldHideTallEntry(chunkB[1], 40, 40, true, 5, 20, wholeRoofBounds), true);

const roofRing = [];
for (let x = 50; x <= 54; x++) {
  roofRing.push(roof(x, 50), roof(x, 54));
}
for (let y = 51; y <= 53; y++) {
  roofRing.push(roof(50, y), roof(54, y));
}
const wholeBuildingBounds = tallStructureBoundsForPlayer(roofRing, 52, 52, 0);
assert.deepEqual(wholeBuildingBounds, { x0: 50, y0: 50, x1: 54, y1: 54 });
assert.equal(shouldHideTallEntry(roofRing[0], 52, 52, true, 5, Infinity, wholeBuildingBounds), true);

const britainBankLikeCeiling = [];
for (let x = 60; x <= 64; x++) {
  for (let y = 60; y <= 64; y++) {
    britainBankLikeCeiling.push(ceilingSurface(x, y));
  }
}
const bankCeilingBounds = tallStructureBoundsForPlayer(britainBankLikeCeiling, 62, 62, 0);
assert.deepEqual(bankCeilingBounds, { x0: 60, y0: 60, x1: 64, y1: 64 });
assert.equal(shouldHideTallEntry(britainBankLikeCeiling[0], 62, 62, true, 5, Infinity, bankCeilingBounds), true);

const renderer = Object.create(TileRenderer.prototype);
renderer.visuals = new Map();
renderer._dynamicTalls = new Map();
renderer.visuals.set((1 << 16) | 1, {
  ready: true,
  _tallStatics: connected,
});
renderer.visuals.set((7 << 16) | 7, {
  ready: true,
  _tallStatics: britainBankLikeCeiling,
});
renderer._dynamicTalls.set(1, [dynamicMultiRoof]);

assert.equal(renderer._computeMaxDrawZ(10, 10, 0), 20);
assert.equal(renderer._computeMaxDrawZ(14, 10, 0), 20);
assert.equal(renderer._computeMaxDrawZ(12, 10, 0), Infinity);
assert.equal(renderer._computeMaxDrawZ(31, 31, 0), 20);
assert.equal(renderer._computeMaxDrawZ(62, 62, 0), 20);
assert.equal(renderer._computeMaxDrawZ(62, 62, 20), Infinity);

console.log('[smoke:roof-autohide] ok');
