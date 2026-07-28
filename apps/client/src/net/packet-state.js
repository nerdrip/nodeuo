import { world } from '../world/world.js';

/** Big-endian u32 read at byte offset `o`. Used by the 0xBF subop fan-out
 *  where `payload` is the bytes AFTER the `op + len + subop` header. */
export function u32(payload, o) {
  if (!payload || payload.length < o + 4) return 0;
  return ((payload[o] << 24) | (payload[o + 1] << 16) | (payload[o + 2] << 8) | payload[o + 3]) >>> 0;
}

export function u16(payload, o) {
  if (!payload || payload.length < o + 2) return 0;
  return ((payload[o] << 8) | payload[o + 1]) & 0xffff;
}

export function captureNameFromSingleClick(m) {
  if (!m || m.name !== 'You see' || !m.text) return;
  const mob = world.mobiles.get(m.serial >>> 0);
  if (mob) mob.name = String(m.text).trim();
}

export function applyWorldItemInfo(it, info) {
  const graphic = info.graphic | 0;
  it.type = info.type | 0;
  it.graphic = graphic;
  it.itemId = graphic;
  it.amount = info.amount | 0;
  it.x = info.x | 0;
  it.y = info.y | 0;
  it.z = info.z | 0;
  // WorldItem packets do not carry a facet id. ClassicUO assigns them to
  // World.MapIndex (the currently active map); leaving this undefined made
  // our spatial index fall back to map 1. Trammel therefore worked by
  // accident while Felucca/Malas/Tokuno/Ter Mur items were indexed on the
  // wrong facet and either vanished or resurfaced as stale render ghosts.
  it.map = world.mapId | 0;
  it.hue = info.hue | 0;
  it.flags = info.flags | 0;
  if (typeof info.direction === 'number') it.direction = info.direction | 0;
  if (typeof info.facing === 'number') it.facing = info.facing | 0;
}

