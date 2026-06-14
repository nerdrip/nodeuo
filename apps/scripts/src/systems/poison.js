// Poison level loader — pushes scripts/data/config/poison-levels.json into the
// engine. Engine keeps the apply/cure/tick logic (status-effects timing);
// this script supplies the per-level damage + interval table.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { setPoisonTable } from '../_poison.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/config/poison-levels.json');

export default async function register(api) {
  if (!api.poison?.setPoisonTable && !api.systems?.poison?.setPoisonTable) {
    api.log?.('poison: setPoisonTable missing, skipping');
    return () => {};
  }
  let table = [];
  try { table = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`poison: ${e.message}`); return () => {}; }
  setPoisonTable(api, table);
  api.log?.(`poison: loaded ${table.length} levels`);
  return () => { /* engine retains its baked-in default table */ };
}
