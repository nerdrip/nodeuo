// Farmable plants — wheat, turnip, pumpkin, onion, lettuce, flax,
// cotton, carrot, cabbage. Mirrors ServUO `Items/Resources/Crops/`.
//
// Plant lifecycle:
//   - item starts with `farm = { kind, plantedAt, ripeAtMs }`
//   - onTick recomputes growth stage; itemId swaps between sprout / mature
//   - onUse with mature stage harvests (consume + drop produce) and
//     resets the timer
//
// Variants share most logic; per-kind config lives in PLANTS_CFG.

import { broadcastItemUpdate } from '../_shared/broadcast.js';

const PLANTS_CFG = {
  wheat:    { sprout: 0x18B5, mature: 0x18B6, produce: 0x1EBD, name: 'wheat',    grow: 240_000 },
  turnip:   { sprout: 0x18B7, mature: 0x18B8, produce: 0x0C7B, name: 'turnip',   grow: 240_000 },
  pumpkin:  { sprout: 0x0C5F, mature: 0x0C6A, produce: 0x0C6A, name: 'pumpkin',  grow: 360_000 },
  onion:    { sprout: 0x0C5D, mature: 0x0C5E, produce: 0x0C6D, name: 'onion',    grow: 240_000 },
  lettuce:  { sprout: 0x0C61, mature: 0x0C62, produce: 0x0C70, name: 'lettuce',  grow: 240_000 },
  flax:     { sprout: 0x1A99, mature: 0x1A9A, produce: 0x1779, name: 'flax',     grow: 240_000 },
  cotton:   { sprout: 0x0C50, mature: 0x0C51, produce: 0x0DF8, name: 'cotton',   grow: 240_000 },
  carrot:   { sprout: 0x0C77, mature: 0x0C78, produce: 0x0C78, name: 'carrot',   grow: 240_000 },
  cabbage:  { sprout: 0x0C7B, mature: 0x0C7C, produce: 0x0C7B, name: 'cabbage',  grow: 240_000 },
};

export function buildFarmablePlant(api) {
  return {
    name: 'farmable-plant',
    hasTick: true,
    onCreate(world, item) {
      const cfg = PLANTS_CFG[item.farm?.kind] ?? PLANTS_CFG.wheat;
      item.farm = item.farm ?? { kind: 'wheat' };
      item.farm.plantedAt = Date.now();
      item.farm.mature = false;
      item.itemId = cfg.sprout;
    },
    onTick(world, item) {
      if (item.farm?.mature) return;
      const cfg = PLANTS_CFG[item.farm?.kind] ?? PLANTS_CFG.wheat;
      const planted = item.farm?.plantedAt ?? Date.now();
      if (Date.now() - planted >= cfg.grow) {
        item.farm.mature = true;
        item.itemId = cfg.mature;
        broadcastItemUpdate(api, world, item);
      }
    },
    onUse(world, item, user) {
      if (Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y)) > 2) {
        user.client?.sendSystemMessage?.('You are too far to harvest.');
        return true;
      }
      const cfg = PLANTS_CFG[item.farm?.kind] ?? PLANTS_CFG.wheat;
      if (!item.farm?.mature) {
        user.client?.sendSystemMessage?.('It is not yet ripe.');
        return true;
      }
      // Drop produce in the harvester's backpack.
      api.game?.mobile?.giveItem?.(user, {
        itemId: cfg.produce,
        name: cfg.name,
        movable: true,
      }, { randomGrid: true });
      // Reset growth.
      item.farm.mature = false;
      item.farm.plantedAt = Date.now();
      item.itemId = cfg.sprout;
      broadcastItemUpdate(api, world, item);
      user.client?.sendSystemMessage?.(`You harvest ${cfg.name}.`);
      return true;
    },
  };
}

export const FARMABLE_PLANT_KINDS = Object.keys(PLANTS_CFG);
