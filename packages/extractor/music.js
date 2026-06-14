// Copy Music/Digital/*.mp3 + Config.txt → public/assets/music/.
// Mirrors the music section of ClassicUO.Assets/SoundsLoader.cs.
//
// Output:
//   music/<filename>.mp3    raw mp3 files
//   music.json              { id: { file, loop, name } }

import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function extractMusic(srcDir, outDir) {
  const musicDir = join(srcDir, 'Music', 'Digital');
  if (!existsSync(musicDir)) {
    return { count: 0, copied: 0 };
  }
  const cfgPath = join(musicDir, 'Config.txt');
  /** @type {Record<number, {file:string, loop:boolean, name:string}>} */
  const entries = {};
  if (existsSync(cfgPath)) {
    const txt = readFileSync(cfgPath, 'utf-8');
    for (let line of txt.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      // Format: `<id> <name>[,loop]`
      const m = /^(\d+)\s+(\S+)/.exec(line);
      if (!m) continue;
      const id = +m[1];
      const rest = line.slice(m[0].length).trim();
      const parts = m[2].split(',');
      const name = parts[0];
      const loop = parts.includes('loop') || /,loop$/i.test(rest) || rest.toLowerCase().includes('loop');
      // Filename match (case-insensitive — UO data is inconsistent on Windows).
      const file = `${name}.mp3`;
      entries[id] = { file, loop, name };
    }
  }

  // Copy every mp3 we resolved (real lookup is case-insensitive against
  // the actual filesystem listing).
  const outMusicDir = join(outDir, 'music');
  mkdirSync(outMusicDir, { recursive: true });
  const dirListing = readdirSync(musicDir);
  const lookup = new Map(dirListing.map((f) => [f.toLowerCase(), f]));

  let copied = 0;
  for (const [id, e] of Object.entries(entries)) {
    const realName = lookup.get(e.file.toLowerCase());
    if (!realName) {
      delete entries[id];
      continue;
    }
    const src = join(musicDir, realName);
    const dst = join(outMusicDir, realName);
    try {
      copyFileSync(src, dst);
      entries[id].file = realName;
      copied++;
    } catch (err) {
      console.warn(`[music] copy ${realName} failed: ${err.message}`);
    }
  }
  writeFileSync(join(outDir, 'music.json'), JSON.stringify({
    count: Object.keys(entries).length, entries,
  }));
  return { count: Object.keys(entries).length, copied };
}
