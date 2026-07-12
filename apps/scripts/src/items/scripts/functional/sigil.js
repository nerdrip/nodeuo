// Faction Sigil item-script. Server parity #4 — sigil-system core
// (pickup/drop/corruption) was wired but nothing hooked the in-world
// sigil item to the system, so factions could never capture cities.
//
// Each registered sigil maps to a physical item placed at `(x, y, map)`
// via `[placesigil <town>` admin command. Picking it up calls
// `sigils.pickup(town, mob.serial)` and lowers the carrier's notoriety
// to 4 (criminal flag — ServUO standard). Dropping it (or death) calls
// `sigils.drop(town, mob.serial)`.

import {
  dropSigil,
  getSigil,
  listSigils,
  pickupSigil,
  registerSigil,
} from '../../../_sigils.js';

export default function buildSigilScript(api) {
  return {
    name: 'sigil',
    /** Pickup hook — fires when a player lifts the sigil item. Returning
     *  `false` would reject the pickup; we allow it but stamp the
     *  faction-tracking state. */
    onLift(_world, item, mob) {
      const town = item._sigilTown;
      if (!town || !mob) return true;
      const r = pickupSigil(api, town, mob.serial >>> 0);
      if (!r.ok) {
        mob.client?.sendSystemMessage?.(`You cannot lift this sigil right now (${r.reason}).`);
        return false;
      }
      mob.notoriety = 4;     // criminal — PvP everywhere
      mob.client?.sendSystemMessage?.(
        `You carry the Sigil of ${town}. Hold it for 10 minutes to corrupt the town.`,
      );
      return true;
    },
    /** Drop hook — fires on any drop (ground, container, paperdoll, …).
     *  Clears the carrier in the sigil system so the timer resets. */
    onDrop(_world, item, _to, droppedBy) {
      const town = item._sigilTown;
      if (!town || !droppedBy) return true;
      dropSigil(api, town, droppedBy.serial >>> 0);
      droppedBy.client?.sendSystemMessage?.(`You release the Sigil of ${town}.`);
      return true;
    },
  };
}

// Convenience export — main.js / `[createworld` decorate pass can call
// this to pre-register the 5 standard sigil coordinates at boot.
export function registerStandardSigils(api) {
  if (listSigils(api).length > 0) return;
  // Coordinates approximate town squares (Felucca facet, map=0).
  const coords = [
    ['britain',  1496, 1626, 0],
    ['magincia', 3713, 2113, 0],
    ['minoc',    2479,  439, 0],
    ['trinsic',  1846, 2745, 0],
    ['yew',       633,  858, 0],
  ];
  for (const [t, x, y, m] of coords) {
    if (!getSigil(api, t)) registerSigil(api, t, x, y, m);
  }
}
