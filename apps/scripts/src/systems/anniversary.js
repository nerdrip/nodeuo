// Anniversary loader — reads scripts/data/world/anniversary-tiers.json and
// pushes the table into the server's anniversary engine via setTiers.
// Engine: apps/server/src/systems/events/anniversary.js.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/anniversary-tiers.json');

export default function register(api) {
  const sys = api.systems?.anniversary;
  if (!sys?.setTiers) {
    api.log?.('anniversary: engine API missing, skipping');
    return () => {};
  }
  let tiers = [];
  try { tiers = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`anniversary: ${e.message}`); return () => {}; }
  sys.setTiers(tiers);
  api.log?.(`anniversary: loaded ${tiers.length} tiers`);
  return () => sys.setTiers([]);
}
