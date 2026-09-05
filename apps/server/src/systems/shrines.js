// PHASE BV — Shrine of Resurrection.
//
// ServUO reference: Scripts/Items/Misc/AnkhPendantNorth.cs +
// Scripts/Mobiles/AI/AIs/AnkhAI.cs. We model the shrine as a static
// world item with `script: 'shrine'`. When a ghost player walks onto
// the shrine tile, the lifecycle dispatcher fires `onWalkOn` and the
// shrine resurrects them on the spot. The resurrect path is also
// available via double-clicking the shrine (`onUse`) for accessibility.
//
// Two helper functions live here:
//   `placeShrine(world, opts)` — drops a shrine item on the map
//   `resurrectAtShrine(world, mob)` — does the resurrect + sets HP/stam
//
// This module deliberately doesn't import the protocol layer; the
// lifecycle script wires the broadcast.

const SHRINE_ITEM_ID = 0x0EE3;   // ankh pillar art id

/**
 * @typedef {Object} ShrineOpts
 * @property {string} name         "Spirituality", "Honor", ...
 * @property {number} x
 * @property {number} y
 * @property {number} [z]
 * @property {number} [map]
 * @property {number} [hue]
 * @property {boolean} [fullRestore]   true = full HP/mana/stam (Healer NPC),
 *                                     false = half HP only (default Ankh)
 */

/**
 * Spawn a shrine item bound to the lifecycle dispatcher. Calling code
 * (a startup script) wires `createItem` from outside so this module
 * stays decoupled.
 *
 * @param {{ items: { createItem: (w:any, opts:any) => any } }} api
 * @param {*} world
 * @param {ShrineOpts} opts
 */
export function placeShrine(api, world, opts) {
  const item = api.items.createItem(world, {
    itemId: SHRINE_ITEM_ID,
    x: opts.x, y: opts.y, z: opts.z ?? 0, map: opts.map ?? 1,
    name: `Shrine of ${opts.name}`,
    hue: opts.hue ?? 0,
    movable: false,
  });
  item.script = 'shrine';
  item.shrine = {
    name: opts.name,
    fullRestore: opts.fullRestore === true,
  };
  return item;
}

/**
 * Resurrect `mob` if they are a ghost AND adjacent to (or standing on)
 * the shrine. Returns true if the resurrection happened.
 *
 * Half-restore vs full-restore mirrors ServUO behaviour: standard ankh
 * shrines bring the player back at half HP and zero mana / full stam;
 * Healer NPC's `[res` is full HP. The shrine item carries the
 * `fullRestore` flag so a custom GM-placed shrine can be configured.
 *
 * @param {*} world
 * @param {*} corpseModule  apps/server/src/corpse.js exports
 * @param {*} mob
 * @param {{ shrine: { fullRestore?:boolean } }} shrineItem
 */
export function resurrectAtShrine(world, corpseModule, mob, shrineItem) {
  if (!mob?.ghost) return false;
  if (!shrineItem) return false;
  const dx = Math.abs((mob.x | 0) - (shrineItem.x | 0));
  const dy = Math.abs((mob.y | 0) - (shrineItem.y | 0));
  if (mob.map !== shrineItem.map) return false;
  if (Math.max(dx, dy) > 2) return false;
  corpseModule.resurrectMobile(world, mob);
  // Bonus restore for full-restore shrines (e.g. priest NPC).
  const fullRestore = shrineItem.shrine?.fullRestore === true;
  if (fullRestore) {
    mob.hp   = mob.hpMax   ?? mob.hp;
    mob.mana = mob.manaMax ?? mob.mana ?? 0;
    mob.stam = mob.stamMax ?? mob.stam ?? 0;
  } else {
    // Default ankh — half HP, zero mana, full stam.
    mob.hp   = Math.max(1, Math.floor((mob.hpMax ?? 50) / 2));
    mob.mana = 0;
    mob.stam = mob.stamMax ?? mob.stam ?? 0;
  }
  return true;
}

export const SHRINE_GRAPHIC = SHRINE_ITEM_ID;
