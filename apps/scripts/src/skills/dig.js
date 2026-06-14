// `[dig` — treasure-map digging activity. The player must:
//   1. Hold a treasure map in their pack (item with `treasureMap` payload)
//   2. Be within a small radius of the buried coordinate
// Then we spawn a locked chest at their feet with level-scaled loot.
// Lockpicking the chest releases the gold/items inside.
//
// ServUO has a multi-step flow (use map → "decode" with Cartography →
// then dig); we collapse decode + dig into a single command for MVP.

import { nearbyClients } from '../_spatial.js';
import { findInPack } from '../_inventory.js';
import { createItem, destroyItemBySerial } from '../_items.js';

const DIG_RANGE = 6;          // tiles from the buried spot
const SKILL_CARTOGRAPHY = 13;
const COOLDOWN_MS = 6_000;
const cooldown = new WeakMap();

function pickMap(api, mob) {
  return findInPack(api, mob, (it) => !!it.treasureMap);
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  api.commands.register({
    name: 'dig',
    help: '[dig — dig at your feet (requires a treasure map in your pack).',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Catch your breath before another dig.');
        return;
      }
      const map = pickMap(api, mob);
      if (!map) {
        ctx.state.sendSystemMessage('You need a treasure map.');
        return;
      }
      const tx = map.treasureMap.x;
      const ty = map.treasureMap.y;
      const dist = Math.max(Math.abs(mob.x - tx), Math.abs(mob.y - ty));
      if (dist > DIG_RANGE) {
        ctx.state.sendSystemMessage(
          `Wrong place. The map shows somewhere else (~${dist} tiles away).`,
        );
        cooldown.set(mob, now);
        return;
      }
      cooldown.set(mob, now);

      // Consume the map.
      destroyItemBySerial(api, map.serial);
      if (mob.client && api.protocol?.removeEntity) {
        mob.client.send(api.protocol.removeEntity(map.serial));
      }

      // Spawn a locked chest at the dig spot (mob's feet, not the map's).
      const level = map.treasureMap.level | 0 || 1;
      const chest = createItem(api, api.world, {
        itemId: 0x09AB, hue: 0x0032,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: `treasure chest (level ${level})`,
        gumpId: 0x003C,
        movable: false,
      });
      chest.locked = true;
      chest.lockDifficulty = Math.min(95, level * 20);
      chest.treasureLevel = level;

      // Pre-fill the chest with level-scaled loot. The gold pile is the
      // headline item; ingredients/scrolls round out the haul. Lockpicking
      // is required first — items aren't visible until the chest opens.
      const goldAmt = 200 * level + Math.floor(Math.random() * 200 * level);
      createItem(api, api.world, {
        itemId: 0x0EED, name: 'gold',
        x: 0, y: 0, z: 0, map: mob.map,
        amount: goldAmt, parent: chest.serial,
      });
      // Random reagent stacks scaled by level.
      const reagentItemIds = [3962, 3963, 3972, 3977, 3978, 3982, 3983]; // black pearl..nox..grave dust
      const numReg = 1 + level;
      for (let i = 0; i < numReg; i++) {
        createItem(api, api.world, {
          itemId: reagentItemIds[(Math.random() * reagentItemIds.length) | 0],
          x: 0, y: 0, z: 0, map: mob.map,
          amount: 5 + Math.floor(Math.random() * 10) + level * 2,
          parent: chest.serial, name: 'reagent',
        });
      }
      // Scrolls.
      for (let i = 0; i < level; i++) {
        createItem(api, api.world, {
          itemId: 0x1F2D, x: 0, y: 0, z: 0, map: mob.map,
          parent: chest.serial, name: 'magic scroll',
        });
      }
      // Broadcast the chest spawn — BUGFIX #65 (FAZA CW): visibility-gate.
      if (api.protocol?.worldItemSA) {
        const wi = api.protocol.worldItemSA({
          serial: chest.serial, itemId: chest.itemId, hue: chest.hue,
          amount: 1, x: chest.x, y: chest.y, z: chest.z,
        });
        for (const m of nearbyClients(api.world, chest)) m.client.send(wi);
      }
      ctx.state.sendSystemMessage(
        `You unearth a level-${level} chest! [lockpick to open it.`,
      );
      api.skillGain?.tryGain?.(mob, SKILL_CARTOGRAPHY, 50 + level * 10);
    },
  });

  return () => api.commands.unregister('dig');
}
