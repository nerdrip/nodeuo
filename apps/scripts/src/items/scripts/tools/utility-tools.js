// Treasure Hunter's Trinket + Rope of Ascension — utility tools.
//
// ServUO `Items/Skill Items/Magical/`:
//   TreasureHuntersTrinket — on use, decodes a treasure map AND
//     bumps its level by +1 (consumes 1 charge). Lets a level-5
//     map become a level-6, etc.
//   RopeOfAscension       — on use, teleports the user to the
//     surface from a dungeon level. Specifically, teleports to the
//     marked surface waypoint (defaults to the user's last
//     outdoor tile). Consumes 1 charge per use.

import { teleportMobile } from '../../../_movement.js';
import { itemBySerial } from '../../../_entities.js';

const TRINKET_MAX_LEVEL = 7;

export function buildTreasureTrinket(api) {
  return {
    name: 'treasure-trinket',
    onCreate(_world, item) {
      item.charges = item.charges ?? 10;
    },
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The trinket has crumbled.');
        return true;
      }
      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      state.sendSystemMessage?.('Target a treasure map to decode + level up.');
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) return;
        const target = itemBySerial({ world }, picked.serial >>> 0);
        if (!target || !target.treasureMap) {
          state.sendSystemMessage?.('That is not a treasure map.');
          return;
        }
        const map = target.treasureMap;
        // Decode (auto-reveal coords on the map UI).
        target.decoded = true;
        // Level bump.
        const lvl = (map.level | 0) || 1;
        if (lvl >= TRINKET_MAX_LEVEL) {
          state.sendSystemMessage?.('The map is already at maximum level.');
          return;
        }
        map.level = Math.min(TRINKET_MAX_LEVEL, lvl + 1);
        item.charges = Math.max(0, (item.charges | 0) - 1);
        state.sendSystemMessage?.(
          `Decoded — map now level ${map.level}. (${item.charges} charges remaining.)`,
        );
      });
      return true;
    },
  };
}

// ──────────────── Rope of Ascension ────────────────

export function buildRopeOfAscension(api) {
  return {
    name: 'rope-of-ascension',
    onCreate(_world, item) {
      item.charges = item.charges ?? 10;
    },
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The rope is frayed beyond use.');
        return true;
      }
      // Find a safe surface tile. We use the saved
      // `user._lastSurfaceTile` (set whenever the user is outdoors with
      // map==1 or 2 and z<5); fallback is Britain bank at (1413,1612,0).
      const surface = user._lastSurfaceTile
        ?? { x: 1413, y: 1612, z: 0, map: 1 };
      teleportMobile(api, user, surface, { state, refresh: true });
      item.charges = Math.max(0, (item.charges | 0) - 1);
      state.sendSystemMessage?.(
        `The rope yanks you upward. (${item.charges} charges remaining.)`,
      );
      return true;
    },
  };
}
