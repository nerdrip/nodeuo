// Interior Decorator — house furnishings adjustment tool.
//
// ServUO `Items/Special/InteriorDecorator.cs`. The decorator is a 1-stone
// item that, on double-click, opens a 3-mode picker (Turn / Up / Down).
// Selecting a mode + targeting any movable item INSIDE the user's house
// performs the corresponding edit:
//
//   Turn  — rotate the item to the next graphic in its rotation pair
//           (a small table flips between east/west variants, etc.).
//   Up    — raise z by 1 (capped at ceiling height of the floor below).
//   Down  — lower z by 1 (floor at 0).
//
// Constraints (all matched against ServUO `OnDoubleClick`):
//   • The item must be ON THE HOUSE FLOOR — no rotation of bag contents,
//     equipment, or items outside any house.
//   • The user must be the house owner / co-owner / friend (ACL_FRIEND+).
//   • The item must be movable (locked-down items are NOT rotatable —
//     the player has to release them first via the sign menu).
//
// Mode persists on the decorator item itself (`_decoMode`) so each
// successive target uses the last-picked operation until the user
// changes it.

import { getAclLevel, ACL_FRIEND } from '../../behaviors/house-acl.js';
import { moveItem } from '../../../_movement.js';
import { allItems, nearbyClients } from '../../../_spatial.js';
import { itemBySerial } from '../../../_entities.js';
// Curated rotation table. Each entry maps an itemId to its "next" id
// in the rotation cycle — a 2-step (east ↔ west) or 4-step cycle. Only
// hand-picked common furniture is wired; unknown ids leave the item
// alone and message the user. Sourced from ServUO `RotateInfo.cs`.
const ROTATIONS = new Map([
  // Tables (small, 2-step E/W).
  [0x0B41, 0x0B42], [0x0B42, 0x0B41],
  [0x0B43, 0x0B44], [0x0B44, 0x0B43],
  [0x0B45, 0x0B46], [0x0B46, 0x0B45],
  // Tables (large dining, 2-step).
  [0x0B90, 0x0B7D], [0x0B7D, 0x0B90],
  // Chairs (4-step N/E/S/W).
  [0x0B2C, 0x0B2D], [0x0B2D, 0x0B2E], [0x0B2E, 0x0B2F], [0x0B2F, 0x0B2C],
  // Stool simple flip.
  [0x0B5A, 0x0B5B], [0x0B5B, 0x0B5A],
  // Bench.
  [0x0B2A, 0x0B2B], [0x0B2B, 0x0B2A],
  // Stove + oven.
  [0x0931, 0x0930], [0x0930, 0x0931],
  // Loom + spinning wheel.
  [0x1015, 0x1016], [0x1016, 0x1015],
  [0x1019, 0x101A], [0x101A, 0x1019],
  // Bookcase.
  [0x0A97, 0x0A98], [0x0A98, 0x0A97],
  [0x0A99, 0x0A9A], [0x0A9A, 0x0A99],
  // Chest (small/large).
  [0x09A8, 0x09A9], [0x09A9, 0x09A8],
  [0x0E3F, 0x0E40], [0x0E40, 0x0E3F],
  // Anvil.
  [0x0FAF, 0x0FB0], [0x0FB0, 0x0FAF],
]);

const MAX_Z = 30;            // ServUO ceiling-of-floor cap
const MIN_Z = -30;           // Below floor (for trim-style placement)

export default function buildInteriorDecorator(api) {
  return {
    name: 'interior-decorator',

    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Cycle modes — turn → up → down → turn …
      const order = ['turn', 'up', 'down'];
      const next = (idx) => order[(idx + 1) % order.length];
      const cur = item._decoMode ?? 'turn';
      // Switch mode on every double-click; target prompt follows.
      const newMode = next(order.indexOf(cur));
      item._decoMode = newMode;
      state.sendSystemMessage?.(`Interior decorator: ${newMode.toUpperCase()} — target the furnishing.`);

      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) return;
        const target = itemBySerial({ world }, picked.serial >>> 0);
        if (!target) { state.sendSystemMessage?.('That is not a movable furnishing.'); return; }

        // Must be on a house floor (parent is null — i.e. ground-placed).
        if (target.parent != null && target.parent !== 0) {
          state.sendSystemMessage?.('That item is inside a container, not on the floor.');
          return;
        }
        if (target.movable === false) {
          state.sendSystemMessage?.('That item is locked down — release it first.');
          return;
        }

        // ACL check — find the multi the target sits in.
        const multi = _findOwningMulti(world, target);
        if (!multi) {
          state.sendSystemMessage?.('The decorator only works inside houses.');
          return;
        }
        const tier = getAclLevel(multi, user.serial);
        if (tier < ACL_FRIEND) {
          state.sendSystemMessage?.('You are not friendly with this house.');
          return;
        }

        if (newMode === 'turn') _doTurn(api, world, target, state);
        else if (newMode === 'up')   _doMove(api, world, target, +1, state);
        else if (newMode === 'down') _doMove(api, world, target, -1, state);
      });
      return true;
    },
  };
}

/** Walk the multi index and return the first house whose footprint
 *  covers (target.x, target.y) on target.map. Returns null when the
 *  target is on the open world (not in any multi). */
function _findOwningMulti(world, target) {
  for (const it of allItems({ world })) {
    if (it._multi == null) continue;
    if (it.map !== target.map) continue;
    const minX = it.x + (it._multi.minX | 0);
    const maxX = it.x + (it._multi.maxX | 0);
    const minY = it.y + (it._multi.minY | 0);
    const maxY = it.y + (it._multi.maxY | 0);
    if (target.x >= minX && target.x <= maxX
     && target.y >= minY && target.y <= maxY) return it;
  }
  return null;
}

function _doTurn(api, world, target, state) {
  const next = ROTATIONS.get(target.itemId);
  if (next == null) {
    state.sendSystemMessage?.('That item cannot be turned.');
    return;
  }
  target.itemId = next;
  _broadcast(api, world, target);
  state.sendSystemMessage?.('You turn the furnishing.');
}

function _doMove(api, world, target, dz, state) {
  const newZ = (target.z | 0) + dz;
  if (newZ > MAX_Z || newZ < MIN_Z) {
    state.sendSystemMessage?.(dz > 0 ? 'You cannot raise it any higher.'
                                     : 'You cannot lower it any further.');
    return;
  }
  moveItem(api, target, { z: newZ });
  _broadcast(api, world, target);
  state.sendSystemMessage?.(dz > 0 ? 'You raise the furnishing.' : 'You lower the furnishing.');
}

/** Re-broadcast the item to nearby clients so the visual position
 *  refresh propagates. Mirrors the worldItemSA send pattern used by
 *  every other mutating item script. */
function _broadcast(api, world, item) {
  const wi = api.protocol?.worldItemSA?.({
    serial: item.serial, itemId: item.itemId, hue: item.hue,
    amount: item.amount ?? 1, x: item.x, y: item.y, z: item.z,
  });
  if (!wi) return;
  for (const m of nearbyClients(world, item)) m.client.send(wi);
}
