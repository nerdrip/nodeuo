// Spell reagent loader — pushes the `reagents` arrays from
// `apps/scripts/src/data/config/spells.json` into the server's reagent
// engine. spells.json stores reagent costs as readable string tags
// ('reagent-garlic', 'reagent-blood-moss') instead of raw itemIds.
// This loader resolves each tag to its canonical itemId via the
// `reagents.json` lookup table before handing the engine an
// itemId[]-shaped table (the engine consumes from the caster's
// backpack by itemId match).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const SPELLS_PATH   = path.resolve(HERE, '../data/config/spells.json');
const REAGENTS_PATH = path.resolve(HERE, '../data/config/reagents.json');

export default async function register(api) {
  const mod = api.systems?.spellReagents;
  if (!mod?.setReagentTable) {
    api.log?.('reagents: setReagentTable missing on engine, skipping');
    return () => {};
  }
  let spells = {}; let tagMap = {};
  try { spells = JSON.parse(fs.readFileSync(SPELLS_PATH,   'utf8')); }
  catch (e) { api.log?.(`reagents: ${e.message}`); return () => {}; }
  try { tagMap = JSON.parse(fs.readFileSync(REAGENTS_PATH, 'utf8')); }
  catch (e) { api.log?.(`reagents: ${e.message}`); }

  // Project `reagents` out of each spell row + resolve string tags →
  // itemIds. Unknown tags are dropped with a one-time log so a
  // mis-spelled reagent doesn't silently make a spell free to cast.
  const out = {};
  let unresolved = 0;
  for (const [id, row] of Object.entries(spells)) {
    if (!Array.isArray(row?.reagents) || row.reagents.length === 0) continue;
    const itemIds = [];
    for (const r of row.reagents) {
      if (typeof r === 'number') { itemIds.push(r); continue; }
      const info = tagMap[r];
      if (info?.itemId != null) itemIds.push(info.itemId);
      else { api.log?.(`reagents: unknown tag '${r}' for spell ${id}`); unresolved++; }
    }
    if (itemIds.length) out[+id] = itemIds;
  }
  mod.setReagentTable(out);
  api.log?.(`reagents: loaded ${Object.keys(out).length} spell reagent entries from spells.json (${unresolved} unresolved tags)`);
  return () => mod.setReagentTable({});
}
