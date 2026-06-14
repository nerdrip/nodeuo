// Mannequin — posable in-house statue. ServUO `Items/Houses/Mannequin.cs`.
//
// A Mannequin is a stationary humanoid sprite (any body — human male/
// female, elf m/f, gargoyle m/f) that lives inside a house. Owners can
// dress it with equipment slots (head/chest/legs/arms/hands/feet/cloak/
// shield/weapon/sash) by dropping the worn item onto the mannequin —
// it shows the equipment graphic on the doll, mirroring how
// equipment-renderer treats a normal mob.
//
// Owners can also re-pose the mannequin via `[pose <id>` while
// targeting it. Pose IDs roughly match `BaseBody` animation indices:
//   0 = standing
//   1 = warmode
//   2 = sit
//   3 = lying
//
// We layer on top of the standard mobile script slot. The mannequin is
// stored as a Mobile (not an Item) so it benefits from the existing
// equipment-on-mob rendering pipeline; we just freeze its AI + combat
// off and gate ownership via the house ACL.

import { getAclLevel, ACL_FRIEND } from '../../behaviors/house-acl.js';
import { destroyItemBySerial } from '../../../_items.js';
import { allItems, allMobiles } from '../../../_spatial.js';
import { createMobile } from '../../../_mobiles.js';

const MANNEQUIN_BODIES = {
  'human-m':    0x0190,
  'human-f':    0x0191,
  'elf-m':      0x025D,
  'elf-f':      0x025E,
  'gargoyle-m': 0x029A,
  'gargoyle-f': 0x029B,
};

/** Spawn a frozen humanoid mob acting as a mannequin. Caller usually
 *  invokes this from the mannequin-deed onUse hook. */
export function spawnMannequin(api, owner, x, y, z, map, kind = 'human-m') {
  const body = MANNEQUIN_BODIES[kind] ?? MANNEQUIN_BODIES['human-m'];
  const mob = createMobile(api, api.world, {
    name: 'a mannequin', body, hue: 0,
    x, y, z, map,
    hp: 1, hpMax: 1, mana: 0, manaMax: 0, stam: 0, stamMax: 0,
    notoriety: 1,                      // Innocent
    kind: 'mannequin',
  });
  if (!mob) return null;
  mob._mannequin = true;
  mob._mannequinOwner = owner.serial >>> 0;
  mob._mannequinPose = 0;
  mob.flags = (mob.flags | 0) | 0x10;   // "frozen" so it doesn't move/animate
  return mob;
}

/** Re-pose helper, gated by house ACL. */
export function setMannequinPose(api, user, mannequin, poseId) {
  if (!mannequin?._mannequin) return { ok: false, reason: 'not-a-mannequin' };
  const multi = _findOwningMulti(api.world, mannequin);
  const tier = multi ? getAclLevel(multi, user.serial) : ACL_FRIEND;
  if (tier < ACL_FRIEND && mannequin._mannequinOwner !== user.serial) {
    return { ok: false, reason: 'not-friend' };
  }
  mannequin._mannequinPose = poseId | 0;
  // Broadcast a stationary animation packet so clients see the pose
  // change immediately.
  try {
    const pkt = api.protocol?.playerAnimation?.({
      serial: mannequin.serial, action: poseId | 0, frameCount: 1, repeatCount: 1,
    });
    if (pkt) for (const m of allMobiles(api)) {
      if (!m.client || m.map !== mannequin.map) continue;
      if (Math.abs(m.x - mannequin.x) > 18 || Math.abs(m.y - mannequin.y) > 18) continue;
      m.client.send(pkt);
    }
  } catch { /* protocol optional */ }
  return { ok: true };
}

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

// Item script for the Mannequin Deed (0x14F0 with `kind: mannequin-deed`).
// On use → prompts for race/sex via subargs OR target a tile to drop
// the mannequin at. For simplicity we drop at the user's feet.
export default function buildMannequinDeed(api) {
  return {
    name: 'mannequin-deed',
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      // Choose body from the deed's `kindHint` if it's a specific deed,
      // otherwise default to human male.
      const kind = item._mannequinKind ?? 'human-m';
      const mob = spawnMannequin(api, user, user.x, user.y, user.z, user.map ?? 1, kind);
      if (!mob) {
        state.sendSystemMessage?.('The mannequin fails to manifest.');
        return true;
      }
      // Consume the deed.
      try { destroyItemBySerial(api, item.serial); } catch { /* ignore */ }
      state.sendSystemMessage?.('A mannequin appears.');
      return true;
    },
  };
}
