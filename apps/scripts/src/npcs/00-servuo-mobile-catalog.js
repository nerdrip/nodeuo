// Generated ServUO mobile definitions are registered as a low-priority
// compatibility layer.  Hand-authored NodeUO monsters/NPCs load first from
// data.js and always win; this file only fills genuinely absent kinds.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '..', 'data', 'config', 'mobile-types.json');

function readDefinitions() {
  try {
    const rows = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn(`[servuo-mobile-catalog] load failed: ${error.message}`);
    return [];
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const addedMonsters = [];
  const addedNpcs = [];
  for (const row of readDefinitions()) {
    if (!row?.kind || row.role === 'player') continue;
    if (row.role === 'npc') {
      if (!api.npcs?.get?.(row.kind)) {
        api.npcs?.register?.({ ...row, behavior: row.behavior ?? 'wander' });
        addedNpcs.push(row.kind);
      }
      continue;
    }
    // MonsterRegistry resolves both kind and servuoClass aliases.  Skip an
    // existing authored record even when its kebab spelling differs.
    if (api.monsters?.get?.(row.kind) || api.monsters?.get?.(row.servuoClass)) continue;
    api.monsters?.register?.({
      ...row,
      behavior: row.behavior ?? (row.ai === 'mage' ? 'mage' : 'aggressive'),
      gold: row.gold ?? [Math.max(0, Math.floor(row.hp / 5)), Math.max(0, Math.floor(row.hp / 2))],
    });
    addedMonsters.push(row.kind);
  }
  api.log?.(`servuo-mobile-catalog: filled ${addedMonsters.length} monsters and ${addedNpcs.length} NPCs`);
  return () => {
    for (const kind of addedMonsters) api.monsters?.unregister?.(kind);
    for (const kind of addedNpcs) api.npcs?.unregister?.(kind);
  };
}
