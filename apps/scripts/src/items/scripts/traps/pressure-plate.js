// Pressure plate — fires onWalkOn AND onWalkOff to flip a linked door
// (item.linkSerial). The door must declare `door: { closedId, openId,
// isOpen, ... }` (set up by the door scripts).
//
// BUGFIX #33 (PHASE BQ): the previous onWalkOff retracted the door the
// moment ANY mob stepped off, ignoring other mobs still on the plate.
// Two-player tandem dungeons (one player holding the plate while the
// second slips through the door) immediately slammed shut the moment
// the second player crossed the threshold. Now we only retract when
// the plate's tile has zero remaining occupants.

import { broadcastItemUpdate } from '../_shared/broadcast.js';
import { allMobiles } from '../../../_spatial.js';
import { itemBySerial } from '../../../_entities.js';

export default function buildPressurePlateScript(api) {
  return {
    name: 'pressure-plate',
    onWalkOn(world, item) {
      const linked = item.linkSerial ? itemBySerial({ world }, item.linkSerial >>> 0) : null;
      if (!linked?.door) return;
      if (linked.door.isOpen) return;
      linked.door.isOpen = true;
      linked.itemId = linked.door.openId;
      broadcastItemUpdate(api, world, linked);
    },
    onWalkOff(world, item, mob) {
      const linked = item.linkSerial ? itemBySerial({ world }, item.linkSerial >>> 0) : null;
      if (!linked?.door) return;
      if (!linked.door.isOpen) return;
      // Any other mobile still standing on the plate's tile? The mob
      // that just stepped off has already had its position updated, so
      // it won't match the plate tile — the only mobiles we'll find
      // here are the OTHERS we want to keep the door open for.
      for (const m of allMobiles({ world })) {
        if (m === mob) continue;
        if (m.map !== item.map) continue;
        if (m.x === item.x && m.y === item.y) return;  // still occupied
      }
      linked.door.isOpen = false;
      linked.itemId = linked.door.closedId;
      broadcastItemUpdate(api, world, linked);
    },
  };
}
