import assert from 'node:assert/strict';
import { Texture } from 'pixi.js';
import { SpritePool } from '../src/renderer/sprite-pool.js';

const pool = new SpritePool(2);
const first = pool.acquire(Texture.EMPTY);
const generation = first._uoPoolGeneration;
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

pool.release(reused);
pool.destroyAll();
console.log('[smoke:sprite-pool] ok');
