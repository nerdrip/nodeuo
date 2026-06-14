// TerMur content loader — reads scripts/data/world/termur-content.json and
// registers each encounter pack via the server's termurContent engine.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/termur-content.json');

export default function register(api) {
  const sys = api.systems?.termurContent;
  if (!sys?.registerPack) {
    api.log?.('termur-content: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`termur-content: ${e.message}`); return () => {}; }
  const ids = [];
  for (const p of list) {
    try { sys.registerPack(p); ids.push(p.id); }
    catch (e) { api.log?.(`termur-content: ${p.id} — ${e.message}`); }
  }
  api.log?.(`termur-content: registered ${ids.length} packs`);
  return () => { for (const id of ids) sys.unregisterPack?.(id); };
}
