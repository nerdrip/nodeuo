// Peerless arena loader — registers the canonical 3 ML peerless arenas
// (Travesty / Lady Melisande / Shimmering Effusion) from
// scripts/data/world/peerless-arenas.json into the engine's peerless registry.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/peerless-arenas.json');

export default async function register(api) {
  const peerless = api.systems?.peerless;
  if (!peerless?.registerArena) {
    api.log?.('peerless-arenas: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`peerless-arenas: ${e.message}`); return () => {}; }
  let count = 0;
  const owned = [];
  for (const arena of list) {
    try { owned.push(peerless.registerArena(arena)); count++; }
    catch (e) { api.log?.(`peerless-arenas: ${arena.name} — ${e.message}`); }
  }
  const unhook = api.corpse?.addKillHook?.((_world, victim, killer) => {
    const arenaName = victim?._peerlessArenaName;
    if (!arenaName) return;
    const arena = peerless.getArena?.(arenaName);
    peerless.markFinished?.(arenaName);
    if (arena?.bossKind) api.systems?.instancedPeerless?.release?.(arena.bossKind);
    api.systems?.peerlessBosses?.invokeBossDeath?.(victim, killer, {
      dropOnGround: (boss, payload) => {
        try {
          _world.createItem?.({
            itemId: 0x14F0,
            name: payload.artifact ?? 'artifact',
            x: boss.x, y: boss.y, z: boss.z, map: boss.map,
            artifactDrop: payload,
          });
        } catch { /* optional reward path */ }
      },
    });
  });
  api.log?.(`peerless-arenas: registered ${count} arenas`);
  return () => {
    unhook?.();
    for (const arena of owned) peerless.unregisterArena?.(arena.name, arena);
  };
}
