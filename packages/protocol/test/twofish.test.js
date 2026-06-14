import { describe, expect, it } from 'vitest';
import { TwofishMd5Encryption } from '../src/twofish.js';

const VERSION = { a: 7, b: 0, c: 95, d: 0 };

function samplePayload(length = 73) {
  const out = new Uint8Array(length);
  for (let i = 0; i < out.length; i++) out[i] = (i * 37 + 11) & 0xff;
  return out;
}

describe('TwofishMd5Encryption', () => {
  it('keeps the CFB ciphertext block across fragmented transforms', () => {
    const plain = samplePayload();
    const whole = new TwofishMd5Encryption(0x12345678, VERSION).encrypt(plain);

    const splitCipher = new TwofishMd5Encryption(0x12345678, VERSION);
    const split = new Uint8Array(plain.length);
    let off = 0;
    for (const size of [3, 11, 1, 19, 7, 32]) {
      const end = Math.min(plain.length, off + size);
      split.set(splitCipher.encrypt(plain.subarray(off, end)), off);
      off = end;
    }
    if (off < plain.length) {
      split.set(splitCipher.encrypt(plain.subarray(off)), off);
    }

    expect([...split]).toEqual([...whole]);
  });
});
