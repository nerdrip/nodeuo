// `[castnet` — deploy a fishing net at the player's current water tile.
// ServUO `Items/Skill Items/Magical/SpecialFishingNet.cs`. Nets are
// account-bound consumables (one-shot) that pull a richer reward pool
// than a regular fishing pole — big fish stacks, treasure-map MIB,
// and a small chance to spawn a Sea Serpent / Dread Spider boss.
//
// Net types:
//   regular-net  : 3-6 big fish + 5 % MIB
//   special-net  : 5-10 big fish + 15 % MIB + 2 % serpent encounter
//   white-pearl-net : guaranteed treasure-map + named-rare seed
//
// Caster must:
//   • be on or adjacent to a water tile (tileKind 'water')
//   • own a net (or matching kind) in their pack
//   • not have cast a net in the last 60 s (anti-spam)

import { findInPack } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';

const NET_ITEM_IDS = {
  regular: 0x0DCA,
  special: 0x0DCA,           // same art, hue distinguishes
  pearl:   0x0DCB,
};

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.world || !api.game?.mobile?.giveItem) return () => {};

  const lastCast = new WeakMap();

  function classifyNet(it) {
    if (!it) return null;
    if (it.itemId === NET_ITEM_IDS.regular) {
      return { item: it, kind: it.hue === 0x47E ? 'pearl' : it.hue === 0x0481 ? 'special' : 'regular' };
    }
    if (it.itemId === NET_ITEM_IDS.pearl) return { item: it, kind: 'pearl' };
    return null;
  }

  function findNet(mob) {
    return classifyNet(findInPack(api, mob, (it) => !!classifyNet(it)));
  }

  api.commands.register({
    name: 'castnet',
    help: '[castnet — deploy a fishing net at the water tile in front of you.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const now = Date.now();
      const last = lastCast.get(mob) ?? 0;
      if (now - last < 60_000) {
        ctx.state.sendSystemMessage('You have cast a net too recently.');
        return;
      }
      const net = findNet(mob);
      if (!net) {
        ctx.state.sendSystemMessage('You have no fishing net in your pack.');
        return;
      }
      // Find a water tile in front of (or under) the caster. Cast direction
      // pulls 2 tiles forward; sea boats let the net drop from any side.
      const dirOffsets = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
      const [dx, dy] = dirOffsets[(mob.direction & 0x07) | 0];
      let waterX = mob.x + dx * 2, waterY = mob.y + dy * 2;
      const onWater = api.landProvider?.isWater?.(mob.map, waterX, waterY);
      if (!onWater) {
        // Try the tile directly under the caster — boats sit ON water.
        if (api.landProvider?.isWater?.(mob.map, mob.x, mob.y)) {
          waterX = mob.x; waterY = mob.y;
        } else {
          ctx.state.sendSystemMessage('There is no water there to cast a net.');
          return;
        }
      }
      lastCast.set(mob, now);
      // Consume the net.
      try {
        net.item.amount = Math.max(0, (net.item.amount ?? 1) - 1);
        if (net.item.amount <= 0) destroyItemBySerial(api, net.item.serial);
        else api.broadcast?.itemUpdate?.(api.world, net.item);
      } catch { /* ignore */ }
      // Resolve the catch table — net kind drives the pool richness.
      const kind = net.kind;
      const rng = Math.random;
      const drops = [];
      if (kind === 'pearl') {
        // Guaranteed treasure map (cartography) + 1 named-rare seed item.
        drops.push({ itemId: 0x14EB, hue: 0, name: 'treasure map (white pearl)' });
        drops.push({ itemId: 0x0DC7, hue: 0x47E, name: 'rare deep-sea pearl' });
      } else {
        const fishCount = kind === 'special'
          ? 5 + Math.floor(rng() * 6)
          : 3 + Math.floor(rng() * 4);
        for (let i = 0; i < fishCount; i++) {
          drops.push({ itemId: 0x09CD, hue: 0, name: 'big fish' });
        }
        const mibChance = kind === 'special' ? 0.15 : 0.05;
        if (rng() < mibChance) drops.push({ itemId: 0x099F, hue: 0x047E, name: 'message in a bottle' });
        const serpentChance = kind === 'special' ? 0.02 : 0;
        if (rng() < serpentChance) {
          // Spawn a sea serpent encounter at the cast tile via the
          // spawn factory. The serpent aggroes the caster.
          try {
            const factory = api.ctx?.spawnFactory;
            if (factory) {
              const serp = factory(api.world, 'sea-serpent', { x: waterX, y: waterY, z: -5, map: mob.map });
              if (serp) {
                serp.combatant = mob.serial;
                ctx.state.sendSystemMessage('A sea serpent rises from the depths!');
              }
            }
          } catch { /* spawn factory not wired */ }
        }
      }
      // Spawn drops into the caster's pack.
      let delivered = 0;
      for (const d of drops) {
        try {
          const item = api.game?.mobile?.giveItem?.(mob, {
            itemId: d.itemId,
            hue: d.hue,
            name: d.name,
          }, { randomGrid: true });
          if (item) delivered += 1;
        } catch { /* ignore individual drop failure */ }
      }
      ctx.state.sendSystemMessage(`Your net pulls up ${delivered} item(s).`);
      // Train Fishing skill.
      api.skillGain?.tryGain?.(mob, 19, kind === 'pearl' ? 95 : 60);
    },
  });

  return () => api.commands.unregister('castnet');
}
