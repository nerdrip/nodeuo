// Peerless arena loader — registers the canonical 3 ML peerless arenas
// (Travesty / Lady Melisande / Shimmering Effusion) from
// scripts/data/world/peerless-arenas.json into the engine's peerless registry.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/peerless-arenas.json');

export default async function register(api) {
  const peerless = api.systems?.peerless;
  if (!peerless?.registerArena) {
    api.log?.('peerless-arenas: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`peerless-arenas: ${e.message}`); return () => {}; }
  let count = 0;
  for (const arena of list) {
    try { peerless.registerArena(arena); count++; }
    catch (e) { api.log?.(`peerless-arenas: ${arena.name} — ${e.message}`); }
  }
  api.log?.(`peerless-arenas: registered ${count} arenas`);
  return () => { /* peerless system doesn't expose unregister */ };
}
