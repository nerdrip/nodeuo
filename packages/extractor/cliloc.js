// Extract Cliloc.enu → cliloc.json (numbered string lookup table).
// Mirrors ClassicUO.Assets/ClilocLoader.cs.

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bwtDecompress } from './bwt.js';

export async function extractCliloc(clilocPath, outDir) {
  const buf = readFileSync(clilocPath);
  // Modern clients store Cliloc.enu in BWT form, signalled by buf[3] == 0x8E.
  const decoded = buf[3] === 0x8E ? bwtDecompress(buf) : buf;
  const dv = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
  let off = 0;
  off += 4 + 2; // skip i32 header + i16 checksum
  /** @type {Record<number, string>} */
  const entries = {};
  const dec = new TextDecoder('utf-8');
  while (off < decoded.length) {
    if (decoded.length - off < 7) break;
    const number = dv.getInt32(off, true);  off += 4;
    /* const flag = */                       off += 1;
    const length = dv.getInt16(off, true);  off += 2;
    if (length < 0 || off + length > decoded.length) break;
    const text = dec.decode(decoded.subarray(off, off + length));
    off += length;
    entries[number] = text;
  }
  writeFileSync(join(outDir, 'cliloc.json'), JSON.stringify({
    count: Object.keys(entries).length, entries,
  }));
  return { count: Object.keys(entries).length };
}
