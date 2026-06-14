// Quest reward item template loader — pushes scripts/data/world/quest-reward-items.json
// into the world template registry so quest chains (chain-loader.js) can
// resolve reward tags to real items with proper itemId + hue + label.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../../data/world/quest-reward-items.json');

export default function register(api) {
  if (!api.templates?.registerTemplate) {
    api.log?.('quest-rewards: templates API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`quest-rewards: ${e.message}`); return () => {}; }
  const registered = [];
  for (const a of list) {
    try {
      api.templates.registerTemplate({
        name: a.tag,
        itemId: a.itemId,
        hue: a.hue ?? 0,
        label: a.label,
        movable: true,
        _questReward: true,
      });
      registered.push(a.tag);
    } catch (e) {
      api.log?.(`quest-rewards: ${a.tag} — ${e.message}`);
    }
  }
  api.log?.(`quest-rewards: registered ${registered.length} reward templates`);
  return () => {
    for (const tag of registered) {
      try { api.templates.unregisterTemplate?.(tag); }
      catch { /* hot-reload tolerant */ }
    }
  };
}
