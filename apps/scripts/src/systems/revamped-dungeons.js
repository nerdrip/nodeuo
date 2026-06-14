// Revamped Dungeons loader — reads scripts/data/world/revamped-dungeons.json
// and registers each dungeon via the server's revampedDungeons engine.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/revamped-dungeons.json');

export default function register(api) {
  const sys = api.systems?.revampedDungeons;
  if (!sys?.registerDungeon) {
    api.log?.('revamped-dungeons: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`revamped-dungeons: ${e.message}`); return () => {}; }
  const ids = [];
  for (const d of list) {
    try { sys.registerDungeon(d); ids.push(d.id); }
    catch (e) { api.log?.(`revamped-dungeons: ${d.id} — ${e.message}`); }
  }
  api.log?.(`revamped-dungeons: registered ${ids.length} dungeons`);
  return () => { for (const id of ids) sys.unregisterDungeon?.(id); };
}
