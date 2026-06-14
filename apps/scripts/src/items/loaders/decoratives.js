// Decoratives — loads scripts/data/world/decoratives.json and registers each
// as a non-functional decoration item via the item registry.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../data/world/decoratives.json');

export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) {
    api.log?.('decoratives: registerItem missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`decoratives: ${e.message}`); return () => {}; }
  let count = 0;
  for (const d of list) {
    try {
      reg({
        kind: 'decoration', weight: 1, movable: true,
        id: d.id, tagId: d.tagId, name: d.name,
        ...(d.hue ? { hue: d.hue } : {}),
      });
      count++;
    } catch (e) {
      api.log?.(`decoratives: ${d.tagId} — ${e.message}`);
    }
  }
  api.log?.(`decoratives: registered ${count} items`);
  return () => {};
}
