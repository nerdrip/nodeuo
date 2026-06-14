// Eodon Time of Legends artifact templates — loads scripts/data/world/eodon-artifacts.json
// and registers each as an item template via api.templates.registerTemplate.
// Quests in scripts/quests/eodon.js resolve reward tags through these.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../data/world/eodon-artifacts.json');

export default function register(api) {
  if (!api.templates?.registerTemplate) {
    api.log?.('eodon-artifacts: templates API missing, skipping');
    return () => {};
  }
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch (e) {
    api.log?.(`eodon-artifacts: failed to load data — ${e.message}`);
    return () => {};
  }
  const registered = [];
  for (const a of list) {
    try {
      api.templates.registerTemplate({
        name: a.tag,
        itemId: a.itemId,
        hue: a.hue ?? 0,
        label: a.label,
        movable: true,
        _eodonArtifact: true,
      });
      registered.push(a.tag);
    } catch (e) {
      api.log?.(`eodon-artifacts: ${a.tag} — ${e.message}`);
    }
  }
  api.log?.(`eodon-artifacts: registered ${registered.length} templates`);
  return () => {
    for (const tag of registered) {
      try { api.templates.unregisterTemplate?.(tag); }
      catch { /* hot-reload tolerant */ }
    }
  };
}
