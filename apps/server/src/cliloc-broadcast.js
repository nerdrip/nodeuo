// Cliloc broadcast helper — build a single 0xC1 / 0xCC packet and
// fan-out to a scope of clients (world, region, party, range). Without
// this every caller re-builds the packet per recipient (~120 bytes
// allocated + 4 PacketWriter calls), and a server-wide announcement
// to 100 players would burn 12 KB of GC pressure for no reason.
//
// Mirror ServUO `Server/Network/PacketBatcher` + `Effects.SendPacket`
// patterns: prepare once, dispatch many.

import { messageLocalized, messageLocalizedAffix } from '@uo/protocol';

/**
 * Send a localized cliloc message to a configurable scope.
 *
 * @param {object} world
 * @param {object} opts            messageLocalized() body
 * @param {object} scope
 * @param {'all'|'range'|'party'|'guild'|'region'|'map'} [scope.kind='all']
 * @param {number} [scope.x]       used by 'range' / 'region'
 * @param {number} [scope.y]
 * @param {number} [scope.map]
 * @param {number} [scope.range]   default 18 tiles
 * @param {number} [scope.partyId]
 * @param {number} [scope.guildId]
 */
export function broadcastLocalized(world, opts, scope = { kind: 'all' }) {
  const pkt = messageLocalized(opts);
  fanOut(world, pkt, scope);
}

/** Same for the affix variant (0xCC). */
export function broadcastLocalizedAffix(world, opts, scope = { kind: 'all' }) {
  const pkt = messageLocalizedAffix(opts);
  fanOut(world, pkt, scope);
}

function fanOut(world, pkt, scope) {
  if (!world?.mobiles) return 0;
  const range = scope.range ?? 18;
  let count = 0;
  // Sector-aware fast path for 'range' scope — walks only mob buckets
  // overlapping the 18-tile window instead of the full mobiles map.
  // On a populated shard NPC chat fires hundreds of broadcasts/min;
  // each previously cost a full 11.7k mob walk. Now ~handful per call.
  if (scope.kind === 'range' && world.sectors?.mobileSerialsNear
      && Number.isFinite(scope.x) && Number.isFinite(scope.y)) {
    for (const s of world.sectors.mobileSerialsNear(scope.map | 0, scope.x | 0, scope.y | 0, range)) {
      const m = world.mobiles.get(s);
      if (!m?.client) continue;
      if (m.map !== scope.map) continue;
      if (Math.abs(m.x - scope.x) > range || Math.abs(m.y - scope.y) > range) continue;
      try { m.client.send(pkt); count++; }
      catch { /* socket transient */ }
    }
    return count;
  }
  const recipients = typeof world.onlineMobiles === 'function'
    ? world.onlineMobiles()
    : world.mobiles.values();
  for (const m of recipients) {
    if (!m.client) continue;
    if (!matchesScope(m, scope, range)) continue;
    try { m.client.send(pkt); count++; }
    catch { /* socket transient — drop the recipient */ }
  }
  return count;
}

function matchesScope(mob, scope, range) {
  switch (scope.kind) {
    case 'all':    return true;
    case 'map':    return scope.map == null || mob.map === scope.map;
    case 'range':  {
      if (mob.map !== scope.map) return false;
      return Math.abs(mob.x - scope.x) <= range && Math.abs(mob.y - scope.y) <= range;
    }
    case 'party':  return mob.partyId && mob.partyId === scope.partyId;
    case 'guild':  return mob.guildId && mob.guildId === scope.guildId;
    case 'region': {
      // 'region' resolves via a per-mob region tag (set by the region
      // tracker tick). Caller passes scope.region = name.
      return mob._lastRegion === scope.region;
    }
    default:       return true;
  }
}

/**
 * Helper for caller-friendly system message broadcast.
 *
 *   broadcastSystemCliloc(world, 1010003);            // announce to all
 *   broadcastSystemCliloc(world, 1010003, '\tBritain'); // with arg
 *   broadcastSystemCliloc(world, 1010003, '', { kind:'range', x, y, map });
 */
export function broadcastSystemCliloc(world, clilocNumber, args = '', scope = { kind: 'all' }) {
  return broadcastLocalized(world, { clilocNumber, args, hue: 0x35 }, scope);
}
