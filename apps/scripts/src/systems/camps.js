// Camps loader — reads scripts/data/world/camps.json and pushes the camp
// definitions into the server engine via setDefs.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/camps.json');

export default function register(api) {
  const sys = api.systems?.camps;
  if (!sys?.setDefs) {
    api.log?.('camps: engine API missing, skipping');
    return () => {};
  }
  let json = {};
  try { json = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`camps: ${e.message}`); return () => {}; }
  sys.setDefs(json);
  api.log?.(`camps: loaded ${Object.keys(json).length} camp kinds`);
  return () => sys.setDefs({});
}
