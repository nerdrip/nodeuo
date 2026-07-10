import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeAnimationSequenceEntry,
  resolveUopAction,
} from '../animation-sequence.js';

function sequenceEntry(body, records, replacementCount = records.length) {
  const buffer = Buffer.alloc(56 + records.length * 72);
  buffer.writeUInt32LE(body, 0);
  buffer.writeInt32LE(replacementCount, 52);
  records.forEach((record, index) => {
    const pos = 56 + index * 72;
    buffer.writeInt32LE(record.oldGroup, pos);
    buffer.writeUInt32LE(record.frameCount, pos + 4);
    buffer.writeInt32LE(record.newGroup, pos + 8);
  });
  return buffer;
}

test('decodes zero-frame group replacements and preserves other actions', () => {
  const decoded = decodeAnimationSequenceEntry(sequenceEntry(717, [
    { oldGroup: 0, frameCount: 0, newGroup: 22 },
    { oldGroup: 1, frameCount: 5, newGroup: 24 },
  ]));

  assert.equal(decoded.body, 717);
  assert.equal(decoded.actions[0], 22);
  assert.equal(decoded.actions[1], 1, 'non-zero frameCount is not a replacement');
  assert.equal(decoded.actions[79], 79);
  assert.equal(resolveUopAction(new Map([[717, decoded.actions]]), 717, 0), 22);
  assert.equal(resolveUopAction(new Map(), 717, 0), 0);
});

test('48/68 sentinel counts retain the identity map', () => {
  for (const sentinel of [48, 68]) {
    const decoded = decodeAnimationSequenceEntry(sequenceEntry(826, [], sentinel));
    assert.equal(decoded.actions[0], 0);
    assert.equal(decoded.actions[79], 79);
  }
});

test('rejects truncated replacement tables', () => {
  const buffer = sequenceEntry(717, [], 1);
  assert.equal(decodeAnimationSequenceEntry(buffer), null);
});
