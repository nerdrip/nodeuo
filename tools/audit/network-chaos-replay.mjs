import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { frameIncoming } from '../../packages/protocol/src/opcodes.js';

const full = process.argv.includes('--full') || process.env.NODEUO_AUDIT_FULL === '1';
const packetCount = full ? 100_000 : 10_000;

function rng(seed = 0x4e6f6465) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const random = rng();
const fixed = (opcode, size, nonce) => {
  const out = new Uint8Array(size);
  out[0] = opcode;
  for (let i = 1; i < size; i++) out[i] = (nonce * 31 + i * 17) & 0xff;
  return out;
};
const variable = (opcode, payloadSize, nonce) => {
  const out = fixed(opcode, payloadSize + 3, nonce);
  out[1] = out.length >>> 8;
  out[2] = out.length & 0xff;
  return out;
};

const corpus = [];
for (let i = 0; i < packetCount; i++) {
  switch (i % 6) {
    case 0: corpus.push(fixed(0x73, 2, i)); break;                 // ping
    case 1: corpus.push(fixed(0x02, 7, i)); break;                 // movement
    case 2: corpus.push(fixed(0x06, 5, i)); break;                 // use
    case 3: corpus.push(variable(0x03, 1 + (i % 80), i)); break;   // speech
    case 4: corpus.push(variable(0xBF, 2 + (i % 31), i)); break;   // extended
    default: corpus.push(fixed(0x6C, 19, i)); break;               // target
  }
}

const streamLength = corpus.reduce((sum, packet) => sum + packet.length, 0);
const stream = new Uint8Array(streamLength);
let streamOffset = 0;
for (const packet of corpus) { stream.set(packet, streamOffset); streamOffset += packet.length; }

// Feed the stream using deterministic, adversarial boundaries: single-byte
// chunks, packet coalescing and cuts inside variable-length size fields.
let pending = new Uint8Array(0);
let offset = 0;
const decoded = [];
const chunkSizes = [];
while (offset < stream.length) {
  const mode = chunkSizes.length % 11;
  const wanted = mode === 0 ? 1 : mode === 1 ? 2 : 1 + Math.floor(random() * 257);
  const size = Math.min(wanted, stream.length - offset);
  chunkSizes.push(size);
  const merged = new Uint8Array(pending.length + size);
  merged.set(pending);
  merged.set(stream.subarray(offset, offset + size), pending.length);
  offset += size;
  const framed = frameIncoming(merged);
  decoded.push(...framed.packets.map((packet) => Uint8Array.from(packet)));
  pending = merged.slice(framed.consumed);
}
assert.equal(pending.length, 0, 'framer retained bytes after complete stream');
assert.equal(decoded.length, corpus.length, 'packet count changed under fragmentation/coalescing');
for (let i = 0; i < corpus.length; i++) assert.deepEqual(decoded[i], corpus[i], `packet ${i} changed`);

// Reproduce the observed valid-packet + unknown 0x26 tail. A stream owner can
// dispatch the valid prefix from the error and skip the offending byte without
// losing the movement ACK that precedes it.
const validBeforeNoise = fixed(0x02, 7, 0x55);
const noisy = new Uint8Array(validBeforeNoise.length + 1);
noisy.set(validBeforeNoise); noisy[noisy.length - 1] = 0x26;
let recovery;
try { frameIncoming(noisy); }
catch (error) { recovery = error; }
assert.ok(recovery, 'unknown opcode was not rejected');
assert.equal(recovery.offset, 7);
assert.equal(recovery.consumed, 7);
assert.equal(recovery.packets.length, 1);
assert.deepEqual(recovery.packets[0], validBeforeNoise);

mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(resolve('artifacts/network-chaos-replay.json'), JSON.stringify({
  version: 1,
  seed: '0x4e6f6465',
  mode: full ? 'full' : 'quick',
  packets: corpus.length,
  bytes: stream.length,
  chunks: chunkSizes.length,
  minChunk: Math.min(...chunkSizes),
  maxChunk: Math.max(...chunkSizes),
  recoveredUnknownOpcode: '0x26',
}, null, 2));

console.log(`[audit:network-chaos] ok packets=${corpus.length} bytes=${stream.length} chunks=${chunkSizes.length}`);
