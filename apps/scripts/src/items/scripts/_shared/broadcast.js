// Shared helper — broadcast an item state change (graphic, hue, position)
// to every nearby viewer. Used by toggleable items (torches, lanterns,
// pressure-plate-linked doors) so the world stays consistent for
// observers that aren't the player who triggered the change.
//
// 18-tile radius mirrors the script spatial helper.

import { nearbyClients } from '../../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
/** Light radius (CUO units, 0-30) by item kind. Higher = brighter +
 *  larger glow. Mirrors ServUO `BaseLight.Light`. Lanterns are stronger
 *  than torches in retail UO — about a 2-tile difference in usable
 *  glow radius. */
const LIGHT_LEVEL = {
  torch:   9,
  lantern: 11,
  candle:  6,
  candelabra: 11,
};

function clientsNear(api, world, center, range = 18) {
  return nearbyClients(api ?? world, center, null, range);
}

/** Push the per-mobile 0x4E PersonalLight packet to a wearer. `level=0`
 *  means "no personal glow"; the client's overlay subtracts this from
 *  the overall day-night level so a lit torch carves a halo around the
 *  avatar. Call this whenever a wearable light source toggles lit /
 *  unlit OR is equipped / unequipped. Without it, the world stays
 *  dungeon-dark even with a torch in hand (user report 2026-05-18). */
export function pushPersonalLight(api, mob, level) {
  if (!api?.protocol?.personalLightLevel) return;
  if (!mob?.client?.send) return;
  const lvl = Math.max(0, Math.min(30, level | 0));
  try { mob.client.send(api.protocol.personalLightLevel(mob.serial, lvl)); }
  catch { /* socket transient */ }
}

/** Resolve a "wearer + light level" pair from a light-source item.
 *  Returns `{ wearer, level }` ONLY when the item is DIRECTLY equipped
 *  on a mobile (parent = mobile serial AND `item.layer` set) — a lit
 *  torch sitting in a pack does NOT emit personal light. User report
 *  2026-05-19 "odpalona pochodnia w plecaku daje światło, powinna
 *  dopiero po tym jak podejdzie do ręki". ServUO `BaseLight.OnEquip`
 *  is the canonical hook for emitting personal light — when the item
 *  leaves the layer (drop into pack), `OnRemoved` clears it. */
export function resolveWearerLight(world, item) {
  if (!item?.parent) return null;
  if (!item.layer) return null;            // not directly equipped
  const wearer = mobileBySerial({ world }, item.parent);
  if (!wearer) return null;
  // `item._lit` flips from torch/lantern onUse; unlit = level 0.
  const lvl = item._lit ? (LIGHT_LEVEL[item.script] ?? 8) : 0;
  return { wearer, level: lvl };
}

export function broadcastItemUpdate(api, world, item) {
  if (!api?.protocol) return;
  if (item.parent) {
    // Equipped directly on a mobile (layer 1/2, parent = wearer
    // serial) → 0x2E EquipUpdate so paperdoll + character overlay
    // swap to the new itemId.
    const wearer = mobileBySerial({ world }, item.parent);
    if (wearer) {
      if (api.protocol.equipUpdate) {
        const eu = api.protocol.equipUpdate({
          serial: item.serial, itemId: item.itemId,
          layer: item.layer ?? 0, parent: wearer.serial, hue: item.hue ?? 0,
        });
        // Send to the wearer + every nearby observer.
        for (const m of clientsNear(api, world, wearer, 18)) {
          m.client.send(eu);
        }
      }
      return;
    }
    // In a container (parent = backpack/chest item serial, not a
    // mobile). Walk the parent chain to find the owning mobile, then
    // push a 0x25 ContainerContentUpdate so the pack gump re-renders
    // the icon. Without this, double-clicking a torch in your pack
    // toggled `_lit` server-side but the pack icon stayed on the
    // unlit sprite — user report 2026-05-18 "sprite się nie zmienia
    // czy to w plecaku czy paperdolu".
    let cur = itemBySerial({ world }, item.parent);
    let owner = null;
    let hops = 0;
    while (cur && hops++ < 8) {
      if (cur.parent == null) break;
      const maybeMob = mobileBySerial({ world }, cur.parent);
      if (maybeMob) { owner = maybeMob; break; }
      cur = itemBySerial({ world }, cur.parent);
    }
    if (owner?.client && api.protocol.containerContentUpdate) {
      const cu = api.protocol.containerContentUpdate({
        serial: item.serial,
        itemId: item.itemId,
        amount: item.amount ?? 1,
        gridX: item.gridX ?? 0,
        gridY: item.gridY ?? 0,
        gridLocation: item.gridLocation ?? 0,
        hue: item.hue ?? 0,
      }, item.parent);
      try { owner.client.send(cu); } catch { /* socket transient */ }
    }
    return;
  }
  if (!api.protocol.worldItemSA) return;
  const wi = api.protocol.worldItemSA({
    serial: item.serial, itemId: item.itemId, hue: item.hue,
    amount: item.amount ?? 1, x: item.x, y: item.y, z: item.z,
  });
  for (const m of clientsNear(api, world, item, 18)) {
    m.client.send(wi);
  }
}
