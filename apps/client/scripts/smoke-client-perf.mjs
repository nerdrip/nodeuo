import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { clientPerfStats, recordClientLongTask } = await import('../src/core/game-controller.js');

const beforeCount = clientPerfStats.longTaskCount;
const beforeHead = clientPerfStats.longTaskHead;

const entry = recordClientLongTask(72.5, 1234, 72.5, 18.25);

assert.equal(clientPerfStats.longTaskCount, beforeCount + 1);
assert.equal(clientPerfStats.longTaskHead, (beforeHead + 1) >>> 0);
assert.equal(clientPerfStats.lastLongTaskMs, 72.5);
assert.ok(clientPerfStats.maxLongTaskMs >= 72.5);
assert.equal(entry.at, 1234);
assert.equal(entry.ms, 72.5);
assert.equal(entry.frameMs, 72.5);
assert.equal(entry.lagMs, 18.25);
assert.equal(clientPerfStats.longTaskHistory[beforeHead % clientPerfStats.longTaskHistory.length], entry);

const mobileRenderer = readFileSync(new URL('../src/renderer/mobile-renderer.js', import.meta.url), 'utf8');
assert.ok(mobileRenderer.includes('let sortDirty = false'), 'MobileRenderer should separate z-order dirtiness from visibility changes');
assert.ok(mobileRenderer.includes('sortDirty = true'), 'MobileRenderer should mark sort dirtiness on add/zIndex changes');
assert.ok(!mobileRenderer.includes('let dirty = false'), 'MobileRenderer should not use a generic dirty flag for sort scheduling');

const tileRenderer = readFileSync(new URL('../src/renderer/tile-renderer.js', import.meta.url), 'utf8');
assert.ok(tileRenderer.includes('MAX_ADD_CHILD_BATCH'), 'TileRenderer should batch chunk sprite mounts');
assert.ok(tileRenderer.includes('_addChunkSprites'), 'TileRenderer should centralize chunk sprite mounting');
assert.ok(tileRenderer.includes('sprites.sort((a, b) => _zIndexOf(a) - _zIndexOf(b))'), 'Chunk sprites should be locally z-sorted before mounting');

console.log('[smoke:client-perf] ok');
