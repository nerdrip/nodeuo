// Store inventory loader — reads scripts/data/config/store-catalogue.json
// and pushes it into the server engine via setCatalogue.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/config/store-catalogue.json');

export default function register(api) {
  const sys = api.systems?.storeInventory;
  if (!sys?.setCatalogue) {
    api.log?.('store-inventory: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`store-inventory: ${e.message}`); return () => {}; }
  sys.setCatalogue(list);
  api.log?.(`store-inventory: loaded ${list.length} SKUs`);
  return () => sys.setCatalogue([]);
}
