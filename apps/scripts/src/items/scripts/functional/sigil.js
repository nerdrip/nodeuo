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
  pickupSigil,
  registerSigil,
  resetSigils,
} from '../../../_sigils.js';
import { allItems } from '../../../_spatial.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';

const STANDARD_SIGILS = [
  ['britain',  1495, 1629, 1],
  ['magincia', 3713, 2113, 1],
  ['minoc',    2479,  439, 1],
  ['trinsic',  1846, 2745, 1],
  ['yew',       633,  858, 1],
];

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

// Create/restore the five standard physical sigils and bind their runtime
// ownership state. Called by `[createworld` and populated-world restart.
export function registerStandardSigils(api, opts = {}) {
  const facets = opts.facets ? new Set(opts.facets) : null;
  if (!canCreateItem(api, api.world)) return { added: 0, failed: 1 };
  let added = 0; let skipped = 0;
  for (const [town, x, y, map] of STANDARD_SIGILS) {
    if (facets && !facets.has(map)) continue;
    if (!getSigil(api, town)) registerSigil(api, town, x, y, map);
    let item = [...allItems(api)].find((candidate) =>
      (candidate._sigilTown === town || candidate.name === `Sigil of ${town}`) &&
      candidate.map === map && candidate.x === x && candidate.y === y);
    if (!item) {
      item = createItem(api, api.world, {
        itemId: 0x1869, hue: 0x44, x, y, z: 0, map,
        name: `Sigil of ${town}`, movable: true, script: 'sigil',
      });
      added++;
    } else skipped++;
    item._sigilTown = town;
    item._worldContentSeed = 'faction-sigils';
  }
  return { added, skipped };
}

export function deleteStandardSigils(api, opts = {}) {
  const facets = opts.facets ? new Set(opts.facets) : null;
  if (facets && !STANDARD_SIGILS.some((entry) => facets.has(entry[3]))) return { removed: 0 };
  const towns = new Set(STANDARD_SIGILS.map(([town]) => town));
  const serials = [];
  for (const item of allItems(api)) {
    const town = item._sigilTown ?? String(item.name ?? '').replace(/^Sigil of /, '');
    const canonical = STANDARD_SIGILS.some(([id, x, y, map]) =>
      id === town && item.map === map && item.x === x && item.y === y);
    if ((item._worldContentSeed === 'faction-sigils' || canonical) && towns.has(town) &&
        (!facets || facets.has(item.map))) serials.push(item.serial >>> 0);
  }
  let removed = 0;
  for (const serial of serials) {
    try { if (itemBySerial(api, serial)) { destroyItemBySerial(api, serial); removed++; } }
    catch (error) { api.log?.(`[sigils] remove failed: ${error.message}`); }
  }
  // All canonical sigils currently share the Felucca facet. A matching
  // partial removal therefore clears the complete logical singleton set.
  if (!facets || STANDARD_SIGILS.some((entry) => facets.has(entry[3]))) resetSigils(api);
  return { removed };
}
