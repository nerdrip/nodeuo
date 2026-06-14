// Additional trap variants ported from ServUO `Items/Functional/`:
//
//   GasTrap         — onWalkOn applies poison status (cure or wait it out)
//   FireColumnTrap  — onWalkOn deals fire damage + brief stun (DEX-saved)
//   SawTrap         — onWalkOn deals heavy bleed (physical) + brief slow
//
// Each ships as a separate registered script so items.json can attach
// them by name and trap-builders can mix-and-match.

import { broadcastItemUpdate } from '../_shared/broadcast.js';
import { itemBySerial } from '../../../_entities.js';

function ownerOk(item, mob) {
  return mob && (mob.serial >>> 0) !== ((item.owner ?? 0) >>> 0);
}

/** Animate a trap toggle — bumps the itemId for one tick so the
 *  client sees the animation; restored by setTimeout. */
function pulseGraphic(api, world, item, altId, holdMs = 600) {
  const orig = item.itemId;
  item.itemId = altId;
  broadcastItemUpdate(api, world, item);
  setTimeout(() => {
    if (!itemBySerial({ world }, item)) return;
    item.itemId = orig;
    broadcastItemUpdate(api, world, item);
  }, holdMs).unref?.();
}

export function buildGasTrap(api) {
  return {
    name: 'gas-trap',
    onWalkOn(world, item, mob) {
      if (!ownerOk(item, mob)) return;
      // Plume of poison gas. ServUO `Mobile.ApplyPoison` with Poison.Lesser.
      api.statusEffects?.apply?.(world, mob, 'poison', { ticks: 8, intensity: 1 });
      mob.client?.sendSystemMessage?.('A vile cloud of gas envelops you.');
      // Visual: graphic 0x113A is the puff cloud — bump to it briefly.
      pulseGraphic(api, world, item, 0x113A, 800);
    },
  };
}

export function buildFireColumnTrap(api) {
  return {
    name: 'fire-column-trap',
    onWalkOn(world, item, mob) {
      if (!ownerOk(item, mob)) return;
      const dmg = 12 + Math.floor(Math.random() * 12);
      api.combat?.damage?.(world, mob, dmg, 'fire');
      mob.client?.sendSystemMessage?.('A column of flame erupts at your feet!');
      // Brief paralyze on a failed dex save (dex >= 60 = save).
      const save = (mob.dex ?? 50) >= 60 + Math.floor(Math.random() * 20);
      if (!save) {
        api.statusEffects?.apply?.(world, mob, 'paralyze', { ticks: 2 });
      }
      pulseGraphic(api, world, item, 0x36BD, 700);   // fire column gfx
    },
  };
}

export function buildSawTrap(api) {
  return {
    name: 'saw-trap',
    onWalkOn(world, item, mob) {
      if (!ownerOk(item, mob)) return;
      const dmg = 14 + Math.floor(Math.random() * 14);
      api.combat?.damage?.(world, mob, dmg, 'physical');
      mob.client?.sendSystemMessage?.('A whirling blade slashes you!');
      api.statusEffects?.apply?.(world, mob, 'bleed', { ticks: 6 });
      pulseGraphic(api, world, item, 0x10F5, 600);   // spinning saw gfx
    },
  };
}

export function buildDartTrap(api) {
  return {
    name: 'dart-trap',
    onWalkOn(world, item, mob) {
      if (!ownerOk(item, mob)) return;
      const dmg = 6 + Math.floor(Math.random() * 6);
      api.combat?.damage?.(world, mob, dmg, 'physical');
      mob.client?.sendSystemMessage?.('Hidden darts pierce your hide.');
      pulseGraphic(api, world, item, 0x1BFE, 500);   // dart gfx
    },
  };
}
