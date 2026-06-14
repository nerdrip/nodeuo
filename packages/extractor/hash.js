// FileNameHasher — Bob Jenkins' hashlittle2 implementation, used by UOP
// to identify files by their (lowercased) virtual name. Mirrors
// ClassicUO.IO/UOFileUop FileNameHasher / hashlittle2.

/**
 * @param {string} s
 * @returns {bigint} 64-bit hash, packed as (high << 32) | low.
 */
export function hashFileName(s) {
  const length = s.length;
  let a = 0xDEADBEEF + (length >>> 0);
  let b = a;
  let c = a;

  // Make uint32 add safe.
  const u32 = (n) => n >>> 0;

  let k = 0;
  // Process 12 bytes at a time.
  while (length - k > 12) {
    a = u32(a + s.charCodeAt(k + 0)
                 + (s.charCodeAt(k + 1) << 8)
                 + (s.charCodeAt(k + 2) << 16)
                 + (s.charCodeAt(k + 3) << 24));
    b = u32(b + s.charCodeAt(k + 4)
                 + (s.charCodeAt(k + 5) << 8)
                 + (s.charCodeAt(k + 6) << 16)
                 + (s.charCodeAt(k + 7) << 24));
    c = u32(c + s.charCodeAt(k + 8)
                 + (s.charCodeAt(k + 9) << 8)
                 + (s.charCodeAt(k + 10) << 16)
                 + (s.charCodeAt(k + 11) << 24));

    [a, b, c] = mix(a, b, c);
    k += 12;
  }
  // Tail.
  const rest = length - k;
  if (rest > 0) {
    if (rest >= 12) c = u32(c + (s.charCodeAt(k + 11) << 24));
    if (rest >= 11) c = u32(c + (s.charCodeAt(k + 10) << 16));
    if (rest >= 10) c = u32(c + (s.charCodeAt(k + 9)  << 8));
    if (rest >= 9)  c = u32(c +  s.charCodeAt(k + 8));
    if (rest >= 8)  b = u32(b + (s.charCodeAt(k + 7)  << 24));
    if (rest >= 7)  b = u32(b + (s.charCodeAt(k + 6)  << 16));
    if (rest >= 6)  b = u32(b + (s.charCodeAt(k + 5)  << 8));
    if (rest >= 5)  b = u32(b +  s.charCodeAt(k + 4));
    if (rest >= 4)  a = u32(a + (s.charCodeAt(k + 3)  << 24));
    if (rest >= 3)  a = u32(a + (s.charCodeAt(k + 2)  << 16));
    if (rest >= 2)  a = u32(a + (s.charCodeAt(k + 1)  << 8));
    if (rest >= 1)  a = u32(a +  s.charCodeAt(k + 0));
    [a, b, c] = finalize(a, b, c);
  }

  return (BigInt(b >>> 0) << 32n) | BigInt(c >>> 0);
}

const rot = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;

function mix(a, b, c) {
  a = ((a - c) >>> 0) ^ rot(c, 4); c = (c + b) >>> 0;
  b = ((b - a) >>> 0) ^ rot(a, 6); a = (a + c) >>> 0;
  c = ((c - b) >>> 0) ^ rot(b, 8); b = (b + a) >>> 0;
  a = ((a - c) >>> 0) ^ rot(c, 16); c = (c + b) >>> 0;
  b = ((b - a) >>> 0) ^ rot(a, 19); a = (a + c) >>> 0;
  c = ((c - b) >>> 0) ^ rot(b, 4);  b = (b + a) >>> 0;
  return [a >>> 0, b >>> 0, c >>> 0];
}

function finalize(a, b, c) {
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4))  >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return [a >>> 0, b >>> 0, c >>> 0];
}
