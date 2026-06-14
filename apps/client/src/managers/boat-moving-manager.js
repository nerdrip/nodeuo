// BoatMovingManager — interpolates boat (multi) movement across server
// ticks. Mirrors ClassicUO `Game/Managers/BoatMovingManager.cs`.
//
// Server emits 0xF6 BoatMoving with the boat's current { speed, direction,
// facing, x, y, z }. Without a manager every 0xF6 snaps the boat one tile
// at a time — choppy when speed=fast (200ms cadence). The manager turns
// each broadcast into a smooth lerp over the expected step duration:
//
//   speed 0 = stop, 1 = slow (400ms), 2 = normal (300ms), 3 = fast (200ms)
//
// We also remember which world items sit on the boat deck so they ride
// along visually instead of being left behind by the iso-sort.

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { net } from '../net/net-client.js';
import { assets } from '../assets/asset-manager.js';
import { PacketWriter } from '@uo/protocol';

const STEP_MS = [0, 400, 300, 200];

// Audit #37 client P1 #1 — boat-facing multi swap. CUO `Multi.cs`
// references 4 distinct multi-IDs per boat orientation. Compass:
// 0=N, 2=E, 4=S, 6=W (UO direction encoding). The 4-tuple is stored
// at boat creation; on facing change we look it up by base multi id.
// Boats ServUO ships:
//   Small Boat:   0x3E96/0x3E98/0x3E9A/0x3E9C (N/E/S/W)
//   Medium:       0x3E89/0x3E8A/0x3E8B/0x3E8C
//   Large Boat:   0x3E92/0x3E94/0x3EA1/0x3EA3
//   Orcish Boat:  0x3E84/0x3E85/0x3E86/0x3E87
// Was: boat rotated facing but multiId didn't swap → planks/tiller
// drew with old orientation after every turn.
const BOAT_FACING_MULTI = new Map([
  // Each entry maps "any one of the 4 IDs" → the 4-tuple [N, E, S, W].
  [0x3E96, [0x3E96, 0x3E98, 0x3E9A, 0x3E9C]],
  [0x3E98, [0x3E96, 0x3E98, 0x3E9A, 0x3E9C]],
  [0x3E9A, [0x3E96, 0x3E98, 0x3E9A, 0x3E9C]],
  [0x3E9C, [0x3E96, 0x3E98, 0x3E9A, 0x3E9C]],
  [0x3E89, [0x3E89, 0x3E8A, 0x3E8B, 0x3E8C]],
  [0x3E8A, [0x3E89, 0x3E8A, 0x3E8B, 0x3E8C]],
  [0x3E8B, [0x3E89, 0x3E8A, 0x3E8B, 0x3E8C]],
  [0x3E8C, [0x3E89, 0x3E8A, 0x3E8B, 0x3E8C]],
  [0x3E92, [0x3E92, 0x3E94, 0x3EA1, 0x3EA3]],
  [0x3E94, [0x3E92, 0x3E94, 0x3EA1, 0x3EA3]],
  [0x3EA1, [0x3E92, 0x3E94, 0x3EA1, 0x3EA3]],
  [0x3EA3, [0x3E92, 0x3E94, 0x3EA1, 0x3EA3]],
  [0x3E84, [0x3E84, 0x3E85, 0x3E86, 0x3E87]],
  [0x3E85, [0x3E84, 0x3E85, 0x3E86, 0x3E87]],
  [0x3E86, [0x3E84, 0x3E85, 0x3E86, 0x3E87]],
  [0x3E87, [0x3E84, 0x3E85, 0x3E86, 0x3E87]],
  // Audit rev.4 P3 — Gargish + Elven boats (Stygian Abyss / Mondain's
  // Legacy). ServUO's `BaseBoat` subclasses ship these as separate
  // multi ids; the 4-tuple cycle matches the boat orientation enum.
  [0x40C9, [0x40C9, 0x40CA, 0x40CB, 0x40CC]],     // Gargish small
  [0x40CA, [0x40C9, 0x40CA, 0x40CB, 0x40CC]],
  [0x40CB, [0x40C9, 0x40CA, 0x40CB, 0x40CC]],
  [0x40CC, [0x40C9, 0x40CA, 0x40CB, 0x40CC]],
  [0x40D1, [0x40D1, 0x40D2, 0x40D3, 0x40D4]],     // Gargish medium
  [0x40D2, [0x40D1, 0x40D2, 0x40D3, 0x40D4]],
  [0x40D3, [0x40D1, 0x40D2, 0x40D3, 0x40D4]],
  [0x40D4, [0x40D1, 0x40D2, 0x40D3, 0x40D4]],
  [0x40D9, [0x40D9, 0x40DA, 0x40DB, 0x40DC]],     // Elven small
  [0x40DA, [0x40D9, 0x40DA, 0x40DB, 0x40DC]],
  [0x40DB, [0x40D9, 0x40DA, 0x40DB, 0x40DC]],
  [0x40DC, [0x40D9, 0x40DA, 0x40DB, 0x40DC]],
  [0x40E1, [0x40E1, 0x40E2, 0x40E3, 0x40E4]],     // Elven medium
  [0x40E2, [0x40E1, 0x40E2, 0x40E3, 0x40E4]],
  [0x40E3, [0x40E1, 0x40E2, 0x40E3, 0x40E4]],
  [0x40E4, [0x40E1, 0x40E2, 0x40E3, 0x40E4]],
]);

function multiForFacing(currentId, facing) {
  const tuple = BOAT_FACING_MULTI.get(currentId | 0);
  if (!tuple) return currentId;
  // facing encoded as 0/2/4/6 in UO direction byte; map to N/E/S/W index.
  const idx = ((facing | 0) >>> 1) & 3;
  return tuple[idx];
}

/** Per-multiId AABB cache. Computed lazily from `multi.json` tile
 *  coordinates relative to the boat's origin — used to detect what
 *  sits on the deck so passengers ride along the lerp. */
const _footprintCache = new Map();
function multiFootprint(multiId) {
  if (multiId == null) return null;
  if (_footprintCache.has(multiId)) return _footprintCache.get(multiId);
  const tiles = assets.multiTiles?.(multiId);
  if (!tiles?.length) { _footprintCache.set(multiId, null); return null; }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (t.x < minX) minX = t.x;
    if (t.x > maxX) maxX = t.x;
    if (t.y < minY) minY = t.y;
    if (t.y > maxY) maxY = t.y;
  }
  const box = { minX, maxX, minY, maxY };
  _footprintCache.set(multiId, box);
  return box;
}

/** 0xBF subop 0x33 — MultiBoatMoveRequest (CUO Send_MultiBoatMoveRequest). */
function buildBoatMoveRequest(serial, direction, speed) {
  const w = new PacketWriter(11);
  w.writeU8(0xBF); w.writeU16(11);
  w.writeU16(0x0033);
  w.writeU32(serial >>> 0);
  w.writeU8(direction & 0x0F);
  w.writeU8(speed & 0x03);
  return w.bytes();
}

class BoatMovingManager {
  constructor() {
    /** @type {Map<number, { startedAt:number, durationMs:number,
     *    fromX:number, fromY:number, toX:number, toY:number,
     *    facing:number }>} */
    this._lerps = new Map();
    /** Track the player's current "driving" boat serial. */
    this.drivenBoat = 0;
    this._installed = false;
    this._riderSeenScratch = new Set();
    this._adoptSeenScratch = new Set();
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('boat:moving', (info) => this._onMoving(info));
    bus.on('frame:tick',  (now) => this._tick(now));
  }

  /** Emit a steering command. Called from GameScene RMB-hold-on-tiller. */
  steer(direction, speed = 2) {
    if (!this.drivenBoat) return;
    try { net.send(buildBoatMoveRequest(this.drivenBoat, direction, speed)); }
    catch { /* socket transient */ }
  }

  setDrivenBoat(serial) { this.drivenBoat = serial >>> 0; }
  clearDrivenBoat()     { this.drivenBoat = 0; }

  _onMoving(info) {
    const { speed, direction: _direction, facing, x, y, z } = info;
    const serial = info.serial >>> 0;
    const it = world.items.get(serial);
    if (!it) return;
    const fromX = Number.isFinite(info.fromX) ? info.fromX : it.x;
    const fromY = Number.isFinite(info.fromY) ? info.fromY : it.y;
    const dur = STEP_MS[speed & 3] | 0;
    if (dur <= 0 || (fromX === x && fromY === y)) {
      it.x = x; it.y = y; it.z = z; it.facing = facing;
      // Audit #37 client P1 #1 — swap multi graphic for the new facing.
      const newMulti = multiForFacing(it.multiId, facing);
      if (newMulti !== it.multiId) it.multiId = newMulti;
      this._lerps.delete(serial);
      return;
    }
    if (it.x !== x || it.y !== y || it.z !== z) {
      const oldX = it.x, oldY = it.y, oldMap = it.map ?? 1, oldParent = it.parent | 0;
      it.x = x; it.y = y; it.z = z;
      world.reindexItem?.(it, oldX, oldY, oldMap, oldParent);
    }
    // CUO `Game/Managers/BoatMovingManager.cs` collects every item +
    // mobile sitting on the boat footprint into `_itemsOnBoat` so they
    // ride the same lerp. Without this passengers + cargo slid off the
    // deck visually until the next 0x77 self-update snapped them back.
    const riders = [];
    const seenRiders = this._riderSeenScratch;
    seenRiders.clear();
    const addRider = (ent, isMobile, logicalMoved = false) => {
      if (!ent) return;
      const riderSerial = ent.serial >>> 0;
      if (seenRiders.has(riderSerial)) return;
      seenRiders.add(riderSerial);
      riders.push({ ent, isMobile, logicalMoved });
    };
    for (const p of info.passengers ?? []) {
      const mob = world.mobiles.get(p.serial >>> 0);
      if (mob) { addRider(mob, true, !!p.logicalMoved); continue; }
      const item = world.items.get(p.serial >>> 0);
      if (item && item !== it) addRider(item, false, !!p.logicalMoved);
    }
    const fp = multiFootprint(it.multiId);
    if (fp) {
      const lx = fromX + fp.minX, rx = fromX + fp.maxX;
      const ty = fromY + fp.minY, by = fromY + fp.maxY;
      const cx = ((lx + rx) / 2) | 0;
      const cy = ((ty + by) / 2) | 0;
      const radius = Math.max(rx - lx, by - ty) + 1;
      const mapId = it.map ?? world.mapId ?? 1;
      const visitMobile = (m) => {
        if (m.map !== it.map) return;
        if (m.x < lx || m.x > rx || m.y < ty || m.y > by) return;
        addRider(m, true);
      };
      const visitItem = (w) => {
        if (w === it) return;
        if (w.map !== it.map) return;
        if (w.x < lx || w.x > rx || w.y < ty || w.y > by) return;
        addRider(w, false);
      };
      if (typeof world.forEachMobileNear === 'function') {
        world.forEachMobileNear(cx, cy, mapId, radius, true, visitMobile);
      } else {
        const mobs = world.mobilesNear
          ? world.mobilesNear(cx, cy, mapId, radius, true)
          : world.mobiles.values();
        for (const m of mobs) visitMobile(m);
      }
      if (typeof world.forEachItemNear === 'function') {
        world.forEachItemNear(cx, cy, mapId, radius, visitItem);
      } else {
        const items = world.itemsNear
          ? world.itemsNear(cx, cy, mapId, radius)
          : world.items.values();
        for (const w of items) visitItem(w);
      }
    }
    this._lerps.set(serial, {
      startedAt: performance.now(),
      durationMs: dur,
      fromX, fromY,
      toX: x, toY: y,
      facing,
      riders,
    });
    seenRiders.clear();
  }

  _tick(now) {
    if (this._lerps.size === 0) return;
    for (const [serial, l] of this._lerps) {
      const it = world.items.get(serial);
      if (!it) { this._lerps.delete(serial); continue; }
      const t = Math.min(1, (now - l.startedAt) / l.durationMs);
      // Visual offset only — keep the logical x/y as the destination so
      // the iso-sort stays correct. We piggyback on Item.offsetX/Y; if
      // the renderer doesn't read those it's a no-op.
      const dx = (l.toX - l.fromX) * (1 - t);
      const dy = (l.toY - l.fromY) * (1 - t);
      const offX = -dx * 22;
      const offY = -dy * 22;
      it.offsetX = offX;
      it.offsetY = offY;
      // Apply the same visual offset to every captured rider so they
      // appear to glide with the boat. Mobiles read offsetX/offsetY in
      // the mobile-renderer's per-frame draw; items consult them in
      // tile-renderer for static draw.
      if (l.riders?.length) {
        for (const r of l.riders) {
          if (r.ent.map !== it.map) continue;
          r.ent.offsetX = offX;
          r.ent.offsetY = offY;
        }
      }
      if (t >= 1) {
        it.x = l.toX; it.y = l.toY; it.facing = l.facing;
        // Audit #37 client P1 #1 — swap multi graphic on lerp end.
        const newMulti = multiForFacing(it.multiId, l.facing);
        if (newMulti !== it.multiId) it.multiId = newMulti;
        it.offsetX = 0; it.offsetY = 0;
        const ddx = l.toX - l.fromX;
        const ddy = l.toY - l.fromY;
        if (l.riders?.length) {
          // Translate riders by the same delta the boat just travelled
          // so their logical coords stay on the deck; clear offsets.
          for (const r of l.riders) {
            if (!r.logicalMoved) {
              const oldX = r.ent.x, oldY = r.ent.y;
              r.ent.x += ddx;
              r.ent.y += ddy;
              if (r.isMobile) {
                world.reindexMobile?.(r.ent, oldX, oldY, r.ent.map ?? it.map ?? 1);
              } else {
                world.reindexItem?.(r.ent, oldX, oldY, r.ent.map ?? it.map ?? 1, r.ent.parent | 0);
              }
            }
            r.ent.offsetX = 0;
            r.ent.offsetY = 0;
          }
        }
        // Audit #34 P3 #12 — re-scan the OLD footprint at lerp completion
        // for items/mobiles that landed on the deck mid-lerp (server
        // pushed a 0x1A cargo pile or a player walked aboard during the
        // 200-400 ms transition). Those weren't in `l.riders` so they'd
        // stay stranded on the source tile when the boat finished
        // moving. Union them in now and translate.
        if (ddx !== 0 || ddy !== 0) {
          const fp = multiFootprint(it.multiId);
          if (fp) {
            // Footprint at the BOAT'S OLD position.
            const lx = l.fromX + fp.minX, rx = l.fromX + fp.maxX;
            const ty = l.fromY + fp.minY, by = l.fromY + fp.maxY;
            const cx = ((lx + rx) / 2) | 0;
            const cy = ((ty + by) / 2) | 0;
            const radius = Math.max(rx - lx, by - ty) + 1;
            const seen = this._adoptSeenScratch;
            seen.clear();
            for (const r of l.riders ?? []) seen.add(r.ent);
            const adopt = (ent, isMobile) => {
              if (seen.has(ent)) return;
              if (ent.map !== it.map) return;
              if (ent.x < lx || ent.x > rx || ent.y < ty || ent.y > by) return;
              const oldX = ent.x, oldY = ent.y;
              ent.x += ddx; ent.y += ddy;
              ent.offsetX = 0; ent.offsetY = 0;
              if (isMobile) {
                world.reindexMobile?.(ent, oldX, oldY, ent.map ?? it.map ?? 1);
              } else {
                world.reindexItem?.(ent, oldX, oldY, ent.map ?? it.map ?? 1, ent.parent | 0);
              }
            };
            const mapId = it.map ?? world.mapId ?? 1;
            if (typeof world.forEachMobileNear === 'function') {
              world.forEachMobileNear(cx, cy, mapId, radius, true, (m) => adopt(m, true));
            } else {
              const mobs = world.mobilesNear
                ? world.mobilesNear(cx, cy, mapId, radius, true)
                : world.mobiles.values();
              for (const m of mobs) adopt(m, true);
            }
            if (typeof world.forEachItemNear === 'function') {
              world.forEachItemNear(cx, cy, mapId, radius, (w) => { if (w !== it) adopt(w, false); });
            } else {
              const items = world.itemsNear
                ? world.itemsNear(cx, cy, mapId, radius)
                : world.items.values();
              for (const w of items) if (w !== it) adopt(w, false);
            }
            seen.clear();
          }
        }
        this._lerps.delete(serial);
      }
    }
  }
}

export const boatMovingManager = new BoatMovingManager();
