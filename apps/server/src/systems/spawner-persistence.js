// Spawner persistence — saves the (id → spawned-serials) map across
// restarts so a freshly-loaded shard reattaches to the mobs/items the
// previous process spawned, instead of double-spawning on top of them.
//
// Mirrors ServUO `SpawnerPersistence.bin` flow at MVP: serialize as
// JSON inside `saves/spawners.json`. The actual spawner module
// (`apps/server/src/spawner.js`) calls `loadSpawners` at boot and
// `saveSpawners` periodically (or on graceful shutdown).
//
// File schema:
//   {
//     "version": 1,
//     "entries": [
//       { "spawnerId": "ratman-bramble-pass",
//         "serials": [12345, 12346, ...] }
//     ]
//   }

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATH = 'saves/spawners.json';

export function saveSpawners(spawnerMap, filePath = DEFAULT_PATH) {
  const entries = [];
  for (const [id, info] of spawnerMap) {
    if (!info?.serials) continue;
    entries.push({ spawnerId: id, serials: [...info.serials].map((s) => s >>> 0) });
  }
  const payload = { version: 1, savedAt: Date.now(), entries };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('[spawner-persistence] save failed:', e.message);
  }
}

export function loadSpawners(filePath = DEFAULT_PATH) {
  try {
    if (!fs.existsSync(filePath)) return new Map();
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (data?.version !== 1) {
      console.warn('[spawner-persistence] unknown version', data?.version);
      return new Map();
    }
    const out = new Map();
    for (const e of data.entries ?? []) {
      out.set(e.spawnerId, { serials: new Set(e.serials.map((s) => s >>> 0)) });
    }
    return out;
  } catch (e) {
    console.error('[spawner-persistence] load failed:', e.message);
    return new Map();
  }
}

/**
 * Helper called on shard graceful-shutdown. Walks `world.mobiles` and
 * `world.items`, drops serials whose entities no longer exist (cleanup)
 * before saving.
 */
export function pruneAndSave(spawnerMap, world, filePath = DEFAULT_PATH) {
  for (const info of spawnerMap.values()) {
    if (!info?.serials) continue;
    for (const s of [...info.serials]) {
      if (!world.mobiles.has(s) && !world.items.has(s)) info.serials.delete(s);
    }
  }
  saveSpawners(spawnerMap, filePath);
}
