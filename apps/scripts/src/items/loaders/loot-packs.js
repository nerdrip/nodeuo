// Loot pack loader — reads scripts/data/config/loot-packs.json and registers
// each tier (Filthy/Poor/Meager/Average/Rich/FilthyRich/UltraRich/SuperBoss)
// with the server's LootRegistry. Mob templates reference packs by name
// via `mob.lootTable = 'pack.average'`.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../data/config/loot-packs.json');

export default function register(api) {
  const reg = api.loot;
  if (!reg?.register) {
    api.log?.('loot-packs: api.loot.register missing, skipping');
    return () => {};
  }
  let packs = {};
  try { packs = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`loot-packs: ${e.message}`); return () => {}; }
  let count = 0;
  for (const pack of Object.values(packs)) {
    try { reg.register(pack); count++; }
    catch (e) { api.log?.(`loot-packs: ${pack.name} — ${e.message}`); }
  }
  api.log?.(`loot-packs: registered ${count} packs`);
  return () => {
    for (const pack of Object.values(packs)) {
      try { reg.unregister?.(pack.name); }
      catch { /* ignore */ }
    }
  };
}
