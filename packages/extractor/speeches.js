// Extract speech.mul → speeches.json.
// Mirrors ClassicUO.Assets/SpeechesLoader.cs.
//
// File layout (big-endian record stream):
//   u16 id     — keyword id (referenced by client when an NPC reacts)
//   u16 length — bytes of UTF-8 keyword text
//   <length>   — keyword text (Latin-1 / UTF-8 hybrid)
//   * repeated until EOF
//
// Multiple records share an `id` — they're alternate spellings /
// translations of the same keyword. Client groups by id for matching.
//
// Output (speeches.json):
//   { count, entries: [ { id, keyword } ] }

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function extractSpeeches(srcDir, outDir) {
  const path = join(srcDir, 'speech.mul');
  if (!existsSync(path)) return { count: 0, skipped: true };
  const buf = readFileSync(path);

  const entries = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const id = buf.readUInt16BE(off);
    const len = buf.readUInt16BE(off + 2);
    off += 4;
    if (off + len > buf.length) break;
    // Decode as UTF-8 — CUO uses ASCII but UO speech.mul ships some
    // localised data with Latin-1 fallback. Try UTF-8 first; on
    // replacement chars, fall back to Latin-1.
    let keyword = buf.toString('utf-8', off, off + len);
    if (/�/.test(keyword)) keyword = buf.toString('latin1', off, off + len);
    off += len;
    entries.push({ id, keyword });
  }

  writeFileSync(join(outDir, 'speeches.json'), JSON.stringify({
    count: entries.length,
    entries,
  }));
  return { count: entries.length };
}
