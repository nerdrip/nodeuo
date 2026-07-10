import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUopAnimEntry } from '../anim-uop.js';
import { compareAnimationPackingOrder } from '../anim.js';

function animationEntry({ dataStart = 64, frames = 5 } = {}) {
  const metadataBytes = frames * 16;
  const pixelPos = dataStart + metadataBytes + 8;
  const buffer = Buffer.alloc(pixelPos + 512 + 8 + 4);
  buffer.writeUInt32LE(frames, 32);
  buffer.writeUInt32LE(dataStart, 36);
  // Poison the old hard-coded metadata position. A decoder that ignores
  // dataStart will read nonsensical frame ids from these bytes.
  buffer.fill(0xFF, 40, dataStart);

  for (let i = 0; i < frames; i++) {
    const metaPos = dataStart + i * 16;
    buffer.writeUInt16LE(22, metaPos);
    buffer.writeUInt16LE(i + 1, metaPos + 2);
    buffer.writeUInt32LE(pixelPos - metaPos, metaPos + 12);
  }

  // Palette can remain transparent; dimensions and the terminator are
  // sufficient to prove that the correct frame block was reached.
  let pos = pixelPos + 512;
  buffer.writeInt16LE(1, pos); pos += 2;
  buffer.writeInt16LE(2, pos); pos += 2;
  buffer.writeInt16LE(32, pos); pos += 2;
  buffer.writeInt16LE(48, pos); pos += 2;
  buffer.writeUInt32LE(0x7FFF7FFF, pos);
  return buffer;
}

test('honours the UOP dataStart offset when reading frame metadata', () => {
  const frames = decodeUopAnimEntry(animationEntry(), 0);
  assert.equal(frames.length, 1);
  assert.deepEqual(
    { w: frames[0].w, h: frames[0].h, cx: frames[0].cx, cy: frames[0].cy },
    { w: 32, h: 48, cx: 1, cy: 2 },
  );
});

test('uses the ten-frame minimum for equipment UOP data', () => {
  const normal = decodeUopAnimEntry(animationEntry(), 0);
  const equipment = decodeUopAnimEntry(animationEntry(), 0, { equipment: true });
  assert.equal(normal.length, 1);
  assert.equal(equipment.length, 10);
  assert.equal(
    decodeUopAnimEntry(animationEntry(), 1, { equipment: true }),
    null,
    'a padded equipment direction with no real pixels is absent',
  );
});

test('packs all frames of one body contiguously before the next body', () => {
  const sprites = [
    { body: 400, action: 4, dir: 0, frame: 0, h: 40 },
    { body: 9, action: 1, dir: 0, frame: 0, h: 20 },
    { body: 400, action: 0, dir: 0, frame: 0, h: 70 },
    { body: 9, action: 0, dir: 0, frame: 0, h: 50 },
  ].sort(compareAnimationPackingOrder);

  assert.deepEqual(sprites.map((sprite) => [sprite.body, sprite.h]), [
    [9, 50], [9, 20], [400, 70], [400, 40],
  ]);
});
