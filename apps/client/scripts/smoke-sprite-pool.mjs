import assert from 'node:assert/strict';
import { Texture } from 'pixi.js';
import {
  LandMeshPool, SpritePool, spriteLeaseValid,
} from '../src/renderer/sprite-pool.js';

const pool = new SpritePool(2, 0);
const first = pool.acquire(Texture.EMPTY);
const generation = first._uoPoolGeneration;
assert.equal(spriteLeaseValid(first, generation), true, 'fresh sprite lease must be valid');
first.pivot.set(9, 7);
first.skew.set(0.2, -0.3);
first.eventMode = 'none';
first.cursor = 'pointer';
first.hitArea = { contains: () => true };
first.alpha = 0.2;
pool.release(first);
pool.release(first);
assert.equal(pool.stats().free, 1, 'double release must not put the same sprite into the pool twice');

assert.notEqual(first._uoPoolGeneration, generation, 'release invalidates pending animation callbacks');
assert.equal(spriteLeaseValid(first, generation), false, 'released sprite invalidates its old lease');

const reused = pool.acquire();
assert.equal(reused, first, 'pool should reuse the released sprite');
assert.equal(reused.texture, Texture.EMPTY, 'acquire without texture must not retain stale atlas art');
assert.deepEqual([reused.pivot.x, reused.pivot.y], [0, 0]);
assert.deepEqual([reused.skew.x, reused.skew.y], [0, 0]);
assert.equal(reused.eventMode, undefined);
assert.equal(reused.cursor, undefined);
assert.equal(reused.hitArea, null);
assert.equal(reused.alpha, 1);
assert.ok(reused._uoPoolGeneration > generation, 'reacquire gets a distinct ownership generation');
assert.equal(
  spriteLeaseValid(reused, generation),
  false,
  'an old animation registry must not own a sprite after pool reuse',
);
assert.equal(
  spriteLeaseValid(reused, reused._uoPoolGeneration),
  true,
  'the reacquired sprite exposes only its new lease',
);

pool.release(reused);
pool.destroyAll();

let spriteNow = 500;
let spriteFrame = 10;
const delayedSprites = new SpritePool(3, 80, () => spriteNow, () => spriteFrame);
const staleSprite = delayedSprites.acquire(Texture.EMPTY);
delayedSprites.release(staleSprite);
const immediateSprite = delayedSprites.acquire(Texture.EMPTY);
assert.notEqual(immediateSprite, staleSprite, 'sprite must not be reused while its previous GPU draw may still be queued');
delayedSprites.release(immediateSprite);
spriteNow += 81;
const wallClockOnlySprite = delayedSprites.acquire(Texture.EMPTY);
assert.notEqual(wallClockOnlySprite, immediateSprite, 'elapsed wall time without rendered frames must not end GPU quarantine');
delayedSprites.release(wallClockOnlySprite);
spriteFrame += 2;
const reusableSprite = delayedSprites.acquire(Texture.EMPTY);
assert.equal(reusableSprite, immediateSprite, 'sprite becomes reusable after the frame quarantine');
delayedSprites.release(reusableSprite);
delayedSprites.destroyAll();

// Land meshes may switch their diagonal/topology when the same pooled object
// is reused for another slope.  All three buffers must follow the new tile.
const meshPool = new LandMeshPool(1, 0);
const firstMesh = meshPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
);
meshPool.release(firstMesh);
const nextIndices = new Uint32Array([0, 1, 3, 0, 3, 2]);
const reusedMesh = meshPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
  nextIndices,
);
assert.equal(reusedMesh, firstMesh, 'land mesh pool should reuse the released mesh');
assert.deepEqual(
  Array.from(reusedMesh.geometry.indexBuffer.data),
  Array.from(nextIndices),
  'reused land mesh must replace its stale index topology',
);
meshPool.release(reusedMesh);
meshPool.destroyAll();

// Production meshes are deliberately not recycled while Pixi may still have
// a render instruction for their old owner queued in the current frame.
let now = 1000;
let meshFrame = 20;
const quarantinedPool = new LandMeshPool(2, 120, () => now, () => meshFrame);
const oldMesh = quarantinedPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
);
quarantinedPool.release(oldMesh);
const freshMesh = quarantinedPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
);
assert.notEqual(freshMesh, oldMesh, 'land mesh must not be reused inside its GPU quarantine window');
quarantinedPool.release(freshMesh);
now += 121;
const wallClockOnlyMesh = quarantinedPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
);
assert.notEqual(wallClockOnlyMesh, freshMesh, 'elapsed wall time without rendered frames must not recycle a land mesh');
quarantinedPool.release(wallClockOnlyMesh);
meshFrame += 2;
const safeMesh = quarantinedPool.acquire(
  Texture.EMPTY,
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Float32Array([0, 0, 1, 0, 0, 1]),
  new Uint32Array([0, 1, 2]),
);
assert.equal(safeMesh, freshMesh, 'land mesh becomes reusable after the quarantine window');
quarantinedPool.release(safeMesh);
quarantinedPool.destroyAll();
console.log('[smoke:sprite-pool] ok');
