// Shared "hidden mobile" helpers.
//
// A hidden mob carries the UO `Hidden` flag bit (0x80) plus a parallel
// `mob.hidden = true` field for fast checks from scripts. Hidden mobs are
// removed from the world view of every other client; their owning client
// still sees them. Any "reveal" event (offensive action, taking damage,
// casting from the shadows, being detected) calls reveal().

import { nearbyClients } from './_spatial.js';
import { equipmentForMobile } from './_equipment.js';

const FLAG_HIDDEN = 0x80;

/** True if `target` is currently hidden FROM `observer` (party-mates always see). */
export function isHiddenFromObserver(observer, target) {
  if (!target?.hidden) return false;
  if (observer === target) return false;
  if (observer?.party && target?.party && observer.party === target.party) return false;
  return true;
}

/**
 * Mark a mob hidden and remove it from every nearby observer's view.
 * The owning client still sees the character as a translucent overlay.
 */
export function hide(api, mob) {
  mob.hidden = true;
  mob.flags = (mob.flags | 0) | FLAG_HIDDEN;
  for (const m of nearbyClients(api, mob, mob, 18)) {
    m.client.send(api.protocol.removeEntity(mob.serial));
  }
  // Owner sees a flag refresh so the paperdoll/highlight reflects the state.
  if (mob.client) {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, hue: mob.hue, flags: mob.flags,
      x: mob.x, y: mob.y, z: mob.z, direction: mob.direction,
    }));
  }
}

/**
 * Drop the hidden state and re-introduce the mob to every nearby observer.
 * No-op when the mob isn't hidden.
 */
export function reveal(api, mob) {
  if (!mob || !mob.hidden) return;
  mob.hidden = false;
  mob.flags = (mob.flags | 0) & ~FLAG_HIDDEN;
  for (const m of nearbyClients(api, mob, mob, 18)) {
    m.client.send(api.protocol.mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue, flags: mob.flags,
      notoriety: mob.notoriety,
      equipment: equipmentForMobile(api, mob),
    }));
  }
  if (mob.client) {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, hue: mob.hue, flags: mob.flags,
      x: mob.x, y: mob.y, z: mob.z, direction: mob.direction,
    }));
  }
}
