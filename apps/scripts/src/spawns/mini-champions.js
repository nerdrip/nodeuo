import { allMobiles } from '../_spatial.js';
import { canCreateItem, createItem } from '../_items.js';
// Mini-champion spawn registrations + `[minichamp` admin command.
//
// Six canonical mini-champion locations seeded in classic UO dungeons
// (Wrong, Despise, Covetous-3, Deceit, Ice, Hythloth). Each instance
// runs the `MiniChampionSpawn` lifecycle from
// `apps/server/src/systems/bosses/mini-champion.js` — single tier with
// a "mini boss" rather than a full multi-tier altar.

// Coordinates intentionally inline — six small entries, not worth a
// separate JSON file like champions.json (which has 13 entries).
const SPAWNS = [
  { name: 'wrong-undead',     type: 'undead',     map: 1, cx: 2026, cy: 110,  cz: -28, radius: 6 },
  { name: 'despise-vermin',   type: 'vermin',     map: 1, cx: 5520, cy: 671,  cz: 5,   radius: 6 },
  { name: 'covetous-arachnid',type: 'arachnid',   map: 1, cx: 5559, cy: 1799, cz: 0,   radius: 6 },
  { name: 'deceit-coldblood', type: 'coldblood',  map: 1, cx: 5193, cy: 605,  cz: 5,   radius: 6 },
  { name: 'ice-abyss',        type: 'abyss',      map: 1, cx: 5790, cy: 96,   cz: 16,  radius: 6 },
  { name: 'hythloth-forest',  type: 'forest',     map: 1, cx: 5639, cy: 1399, cz: 0,   radius: 6 },
];

export default function register(api) {
  if (!api.commands) return () => {};
  const mini = api.systems?.miniChampion;
  if (!mini) {
    api.log?.('minichamp: mini champion system unavailable');
    return () => {};
  }
  const spawnFactory = (world, kind, pos) => api.ctx?.spawnFactory?.(world, kind, pos) ?? null;
  const despawn = (world, serial) => {
    const remove = api.protocol?.removeEntity?.(serial);
    if (!remove) return;
    for (const m of allMobiles({ world })) {
      if (m.client) m.client.send(remove);
    }
  };
  const dropLoot = (world, mob, lootKind) => {
    if (!mob || !canCreateItem(api, world)) return;
    try {
      // Minor artifact — single item dropped on the boss tile. The
      // canonical artifact data lives in `data/world/artifacts.json` and
      // is picked from the lesser-tier pool just like champion altars.
      createItem(api, world, {
        itemId: 0x1F1C, hue: 0x47E,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: `Minor artifact (${lootKind})`, movable: true,
      });
    } catch (e) { api.log?.(`[minichamp] drop failed: ${e.message}`); }
  };

  for (const cfg of SPAWNS) {
    if (!mini.MINI_CHAMP_TYPES[cfg.type]) continue;
    try {
      const s = new mini.MiniChampionSpawn(api.world, cfg, { spawnFactory, despawn, dropLoot });
      mini.registerMiniChamp(s);
    } catch (e) {
      api.log?.(`[minichamp] register ${cfg.name} failed: ${e.message}`);
    }
  }

  const tick = () => {
    for (const s of mini.listMiniChamps()) {
      try { s.tick(); } catch (e) { console.error('[minichamp] tick:', e); }
    }
  };
  const timer = api.lifecycle?.setInterval?.(tick, 5000) ?? setInterval(tick, 5000);
  timer.unref?.();

  const spec = {
    name: 'minichamp',
    help: '[minichamp <list|start|stop|status> [name]',
    access: 'Admin',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const name = String(ctx.args[1] ?? '').toLowerCase();
      if (sub === 'list' || !sub) {
        const names = mini.listMiniChamps().map((s) => s.cfg.name).join(', ');
        ctx.state.sendSystemMessage(`Mini-champion spawns: ${names || '(none)'}`);
        return;
      }
      const s = mini.getMiniChamp(name);
      if (!s) {
        ctx.state.sendSystemMessage(`No mini-champion spawn '${name}'.`);
        return;
      }
      switch (sub) {
        case 'start':  s.start(); ctx.state.sendSystemMessage(`${name} started.`); break;
        case 'stop':   s.stop();  ctx.state.sendSystemMessage(`${name} stopped.`); break;
        case 'status': {
          const st = s.status();
          ctx.state.sendSystemMessage(
            `${st.name} [${st.type}]: active=${st.active} kills=${st.kills}/${st.killsToAdvance} ` +
            `alive=${st.spawnedAlive} boss=${st.bossSerial ? '0x' + st.bossSerial.toString(16) : '-'}`,
          );
          break;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [minichamp <list|start|stop|status> [name]');
      }
    },
  };
  if (!api.lifecycle?.command?.(spec)) api.commands.register(spec);

  return () => {
    if (!api.lifecycle) clearInterval(timer);
    for (const s of mini.listMiniChamps()) s.stop();
    if (!api.lifecycle) api.commands.unregister('minichamp');
  };
}
