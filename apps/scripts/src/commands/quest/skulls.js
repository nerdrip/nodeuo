import { destroyItemBySerial } from '../../_items.js';
import { packItems } from '../../_inventory.js';
import { allMobiles } from '../../_spatial.js';
import { createMobile } from '../../_mobiles.js';
// `[skulls` — Champion Skull inventory + Harrower summon.
//
//   [skulls         — show carried skulls (count by colour + missing)
//   [skulls summon  — consume 5 different-colour skulls to summon the Harrower
//
// ServUO `Items/Champions/ChampionSkull.cs`: 5 distinct skull colours
// drop one each from the 5 elemental champion altars (Abyss, Vermin,
// Forestlord, Cold Blood, Glade). Bringing all 5 to the Harrower
// Summoning Altar in Felucca calls the Harrower — the ultimate champion
// that drops 12 Greater Scrolls + a +25 Stat Scroll.

const SKULL_ITEM_ID = 0x1AE0;
const HARROWER_ALTAR = { x: 5556, y: 823, z: 65, map: 0 };   // Felucca Lost Lands

const SKULL_COLORS = {
  pestilence: 0x0021,
  greed:      0x0489,
  power:      0x0445,
  pain:       0x0496,
  venom:      0x004F,
};
const COLOR_BY_HUE = new Map(
  Object.entries(SKULL_COLORS).map(([k, h]) => [h, k]),
);

function carriedSkulls(api, mob) {
  const owned = new Map();          // colour → item[]
  for (const it of packItems(api, mob)) {
    if (it.itemId !== SKULL_ITEM_ID) continue;
    const colour = COLOR_BY_HUE.get(it.hue & 0xffff);
    if (!colour) continue;
    if (!owned.has(colour)) owned.set(colour, []);
    owned.get(colour).push(it);
  }
  return owned;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'skulls',
    help: '[skulls / [skulls summon — Champion Skull inventory + Harrower summon.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      const owned = carriedSkulls(api, mob);
      const have = [...owned.keys()].sort();
      const missing = Object.keys(SKULL_COLORS).filter((c) => !owned.has(c));

      if (sub === 'summon') {
        // Must stand at the Harrower Altar (within 4 tiles).
        const dx = Math.abs(mob.x - HARROWER_ALTAR.x);
        const dy = Math.abs(mob.y - HARROWER_ALTAR.y);
        if (mob.map !== HARROWER_ALTAR.map || Math.max(dx, dy) > 4) {
          ctx.state.sendSystemMessage?.(
            'You must stand at the Harrower Summoning Altar (Felucca Lost Lands, 5556,823).',
          );
          return;
        }
        if (missing.length > 0) {
          ctx.state.sendSystemMessage?.(
            `You are missing skulls: ${missing.join(', ')}.`,
          );
          return;
        }
        // Consume one of each colour.
        for (const colour of Object.keys(SKULL_COLORS)) {
          const arr = owned.get(colour);
          if (!arr?.length) continue;
          try { destroyItemBySerial(api, arr[0].serial); }
          catch { /* ignore */ }
        }
        // Spawn the Harrower at the altar tile.
        const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
        let boss = null;
        try {
          if (factory) {
            boss = factory(api.world, 'harrower', {
              x: HARROWER_ALTAR.x, y: HARROWER_ALTAR.y, z: HARROWER_ALTAR.z,
              map: HARROWER_ALTAR.map,
            });
          }
        } catch { /* fall through */ }
        if (!boss) {
          boss = createMobile(api, api.world, {
            name: 'The Harrower', body: 0x002B,
            x: HARROWER_ALTAR.x, y: HARROWER_ALTAR.y, z: HARROWER_ALTAR.z,
            map: HARROWER_ALTAR.map,
            hp: 30000, hpMax: 30000, str: 600, dex: 200, int: 600,
            notoriety: 5, fame: 30000, karma: -30000,
            kind: 'harrower',
          });
        }
        if (boss) {
          boss._harrower = true;
          // Shard announce.
          const pkt = api.protocol?.unicodeMessage?.({
            text: `${mob.name ?? 'A hero'} has summoned The Harrower!`,
            hue: 0x21, font: 3, name: 'System',
          });
          if (pkt) for (const m of allMobiles(api)) {
            if (m.client) m.client.send(pkt);
          }
          ctx.state.sendSystemMessage?.('The Harrower materializes!');
        } else {
          ctx.state.sendSystemMessage?.('The summons fizzles.');
        }
        return;
      }

      // Default: inventory.
      ctx.state.sendSystemMessage?.(`Champion Skulls (${have.length}/5):`);
      for (const c of Object.keys(SKULL_COLORS)) {
        const arr = owned.get(c);
        ctx.state.sendSystemMessage?.(
          `  ${c.padEnd(12)} — ${arr?.length ?? 0}`,
        );
      }
      if (missing.length === 0) {
        ctx.state.sendSystemMessage?.(
          '★ All 5 skulls — travel to the Harrower Altar in Felucca Lost Lands and [skulls summon.',
        );
      } else {
        ctx.state.sendSystemMessage?.(`Still need: ${missing.join(', ')}.`);
      }
    },
  });

  return () => api.commands.unregister('skulls');
}
