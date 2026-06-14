// MD5 — pure-JS, minimal-allocation port. Required by the Twofish-MD5
// game-encryption variant used by modern UO clients (≥2.0.4). Browsers
// expose `crypto.subtle.digest('MD5')` only on insecure contexts on
// some platforms; this synchronous fallback keeps the cipher self-
// contained and Node-compatible.
//
// API: `md5Bytes(Uint8Array) → Uint8Array(16)`.
//
// Reference: RFC 1321. Output matches `openssl dgst -md5`.

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

function _rotl(n, x) { return ((n << x) | (n >>> (32 - x))) >>> 0; }

export function md5Bytes(bytes) {
  // Pad to a multiple of 64 bytes with the canonical 0x80 + zeros + len.
  const origLen = bytes.length;
  const bitLen = origLen * 8;
  const padded = new Uint8Array(((origLen + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[origLen] = 0x80;
  // 64-bit little-endian bit length at end.
  padded[padded.length - 8] = bitLen & 0xff;
  padded[padded.length - 7] = (bitLen >>> 8) & 0xff;
  padded[padded.length - 6] = (bitLen >>> 16) & 0xff;
  padded[padded.length - 5] = (bitLen >>> 24) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] = (padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24)) >>> 0;
    }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16)       { f = (b & c) | (~b & d); g = i; }
      else if (i < 32)  { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48)  { f = b ^ c ^ d;          g = (3 * i + 5) & 15; }
      else              { f = c ^ (b | ~d);       g = (7 * i) & 15; }
      f = (f + a + K[i] + M[g]) >>> 0;
      a = d; d = c; c = b;
      b = (b + _rotl(f, S[i])) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4]     =  words[i]        & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8)  & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}
