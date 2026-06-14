// Extract soundLegacyMUL.uop → 1 packed sound.bin + sounds.json index.
//
// Each entry has a 40-byte name prefix followed by raw WAV data
// (RIFF header included). Mirrors ClassicUO.Assets/SoundsLoader.cs
// TryGetSound.
//
// Output:
//   sounds.bin   — concatenated WAV bodies (no name prefix), back-to-back
//   sounds.json  — { count, entries: { id: { offset, size, name } } }
//
// Client streams a single sound via HTTP Range from sounds.bin.

import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openUopIndexed, readEntryContent } from './uop.js';

const SOUND_COUNT = 0x10000;

export async function extractSounds(src, outDir) {
  const uopPath = join(src, 'soundLegacyMUL.uop');
  const { fd, byIndex } = await openUopIndexed(
    uopPath, 'build/soundlegacymul/%08d.dat', SOUND_COUNT,
  );
  try {
    const chunks = [];
    let offset = 0;
    /** @type {Record<number, {offset:number,size:number,name:string}>} */
    const entries = {};
    for (let id = 0; id < SOUND_COUNT; id++) {
      const e = byIndex[id];
      if (!e || e.decompressedSize <= 40) continue;
      const content = await readEntryContent(fd, e);
      const name = content.subarray(0, 40).toString('utf8').replace(/\0+$/, '').trim();
      const wav = content.subarray(40);
      entries[id] = { offset, size: wav.length, name };
      chunks.push(wav);
      offset += wav.length;
    }
    const bin = Buffer.concat(chunks);
    await writeFile(join(outDir, 'sounds.bin'), bin);
    writeFileSync(join(outDir, 'sounds.json'), JSON.stringify({
      count: Object.keys(entries).length, totalBytes: bin.length, entries,
    }));
    return { count: Object.keys(entries).length, totalBytes: bin.length };
  } finally {
    await fd.close();
  }
}
