// Extended in-world books — loads scripts/data/world/books-extended.json
// and registers each via the item registry (api.items.registerItem).
// Used as static lore/quest books spawned by quest scripts or admin.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_FILES = [
  path.resolve(HERE, '../../data/world/books.servuo.generated.json'),
  path.resolve(HERE, '../../data/world/books-extended.json'),
];

export default function register(api) {
  // api.catalog.items.registerItem — the item registry index re-exports it.
  const reg = api.catalog?.items?.registerItem;
  if (!reg) {
    api.log?.('books-extended: registerItem missing, skipping');
    return () => {};
  }
  const list = [];
  for (const file of DATA_FILES) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) list.push(...parsed);
    } catch (e) {
      api.log?.(`books-extended: ${path.basename(file)}: ${e.message}`);
    }
  }
  let count = 0;
  for (const b of list) {
    try {
      reg({
        kind: 'book', weight: 2, movable: true,
        script: 'readable-book',
        id: b.id, tagId: b.tagId,
        title: b.title, author: b.author ?? 'Unknown',
        name: b.name ?? b.title,
        pages: b.pages ?? [],
        servuoClass: b.servuoClass,
        servuoPath: b.servuoPath,
      });
      count++;
    } catch (e) {
      api.log?.(`books-extended: ${b.tagId} — ${e.message}`);
    }
  }
  api.log?.(`books-extended: registered ${count} books`);
  return () => { /* item registry has no per-tag unregister; OK for live data */ };
}
