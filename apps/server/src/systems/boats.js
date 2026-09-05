// Authoritative boat system:
//   - sail-state (Stop / Slow / Medium / Full) → continuous tick movement
//   - anchor (drops/raises; anchored boats refuse sail commands)
//   - owner + spare keys (only owner / key-holder may pilot)
//   - per-boat damage (HP) — naval combat hooks update boat.boatHp
//   - boat-deed items (double-click → places a rowboat under feet)
//
// ServUO reference: Scripts/Multis/Boats/BaseBoat.cs (~3000 LOC).
// Naval combat applies armor-aware damage to `boat.boatHp` and converts a
// destroyed hull into a persistent wreck through the standard world pipeline.
//
// Persistence: every field below is on `item.boat` (already in
// MOBILE_EXT_KEYS' sibling whitelist). Saves round-trip the state.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nearbyClients } from '../world/visibility.js';

const SAIL_INTERVAL_MS = {
  stop: 0,
  slow: 1500,
  medium: 1000,
  full: 600,
};

const FACING_DELTAS = {
  N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0],
};
const FACINGS = ['N', 'E', 'S', 'W'];

const PLANK_ITEM_ID = 0x3EAA;
const MULTI_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'client', 'public', 'assets', 'multi.json');
let multiCatalog = null;
const boatFootprintCache = new Map();

function loadMultiCatalog() {
  if (multiCatalog) return multiCatalog;
  try {
    const raw = JSON.parse(fs.readFileSync(MULTI_FILE, 'utf8'));
    multiCatalog = raw.multis ?? raw;
  } catch { multiCatalog = {}; }
  return multiCatalog;
}

function footprintForMulti(multiId) {
  const id = multiId | 0;
  if (boatFootprintCache.has(id)) return boatFootprintCache.get(id);
  const seen = new Set();
  const cells = [];
  for (const tile of loadMultiCatalog()?.[id] ?? []) {
    if ((tile?.id | 0) === 1) continue;
    const key = `${tile.x | 0}:${tile.y | 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push([tile.x | 0, tile.y | 0]);
  }
  if (!cells.length) cells.push([0, 0]);
  boatFootprintCache.set(id, cells);
  return cells;
}

function invalidateMultiCatalog() {
  multiCatalog = null;
  boatFootprintCache.clear();
}

function createWorldItem(api, data) {
  return api.items?.createItem?.(api.world, data)
      ?? api.world?.createItem?.(data)
      ?? null;
}

function destroyWorldItem(api, serial) {
  if (!serial) return;
  if (api.items?.destroyItem) api.items.destroyItem(api.world, serial >>> 0);
  else api.world?.destroyItem?.(serial >>> 0);
}

function destroyWorldMobile(api, serial) {
  if (!serial) return;
  if (api.game?.mobile?.destroy) api.game.mobile.destroy(serial >>> 0);
  else if (api.ops?.destroyMobile) api.ops.destroyMobile(serial >>> 0);
  else api.world?.destroyMobile?.(serial >>> 0);
}

function broadcastRemoval(api, entity) {
  if (!entity) return;
  for (const mobile of nearbyClients(api.world, entity)) {
    try {
      if (mobile.client?.sendRemove) mobile.client.sendRemove(entity.serial);
      else if (api.protocol?.removeEntity) mobile.client?.send?.(api.protocol.removeEntity(entity.serial));
    } catch { /* disconnected observer */ }
  }
}

function createBoatPlanks(api, boat, hull) {
  if (!boat?.boat || boat.boat.planks?.length) return [];
  const count = Math.max(1, hull?.plankCount | 0);
  const mounts = count <= 1
    ? [[1, 0, 'E']]
    : [[-1, 0, 'W'], [1, 0, 'E']];
  const made = [];
  for (const [dx, dy, side] of mounts) {
    const plank = createWorldItem(api, {
      itemId: PLANK_ITEM_ID,
      x: boat.x + dx,
      y: boat.y + dy,
      z: boat.z,
      map: boat.map,
      name: 'a plank',
      movable: false,
      boatPlank: { boatSerial: boat.serial, side },
    });
    if (!plank) continue;
    plank.boatPlank = { boatSerial: boat.serial, side };
    boat.boat.planks.push(plank.serial);
    made.push(plank);
  }
  return made;
}

function itemCarriedBy(world, itemSerial, mobSerial) {
  let item = world?.items?.get?.(itemSerial >>> 0);
  const owner = mobSerial >>> 0;
  const seen = new Set();
  while (item?.parent != null) {
    const parent = item.parent >>> 0;
    if (parent === owner) return true;
    if (seen.has(parent)) return false;
    seen.add(parent);
    item = world.items.get(parent);
  }
  return false;
}

function backpackOf(world, mob) {
  if (!world?.items || !mob) return null;
  const cached = world.items.get(mob._packSerial >>> 0);
  if (cached?.parent === (mob.serial >>> 0) && cached.layer === 21) return cached;
  const children = world._childrenByParent?.get?.(mob.serial >>> 0);
  if (children) {
    for (const serial of children) {
      const item = world.items.get(serial >>> 0);
      if (item?.parent === (mob.serial >>> 0) && item.layer === 21) {
        mob._packSerial = item.serial >>> 0;
        return item;
      }
    }
    return null;
  }
  for (const item of world.items.values()) {
    if (item.parent === (mob.serial >>> 0) && item.layer === 21) {
      mob._packSerial = item.serial >>> 0;
      return item;
    }
  }
  return null;
}

// Hull variants — small / medium / large / galleon classes. The four
// SA-era Galleon hulls (Britannian / Tokuno / Orc / Gargish) ride on
// the same movement rules as a regular galleon but mount cannons at
// faction-specific gun ports and have higher HP. Each picks a graphic
// from BaseBoat's facing-set + an HP cap. Speed cadence is independent
// of hull class (matches ServUO).
//
// `cannonMounts` is an array of { dx, dy, kind } offsets relative to
// the boat origin tile — `placeGalleon()` instantiates a cannon at
// each mount and stamps `cannon._mountSerial = boat.serial` so the
// cannons travel with the boat in `_tickBoat()`.
export const BOAT_HULLS = Object.freeze({
  // Canonical ServUO BaseMulti ids, not static-art component ids.
  small:    { multiBase: 0x00, hpMax: 1000, armor: 0.05, speedMultiplier: 1.15, plankCount: 1, label: 'small ship' },
  medium:   { multiBase: 0x08, hpMax: 1500, armor: 0.10, speedMultiplier: 1.05, plankCount: 2, label: 'medium ship' },
  large:    { multiBase: 0x10, hpMax: 2000, armor: 0.15, speedMultiplier: 0.95, plankCount: 2, label: 'large ship' },
  galleon:  { multiBase: 0x40, hpMax: 3000, armor: 0.20, speedMultiplier: 0.90, plankCount: 2, label: 'galleon' },
  // SA Galleons. graphic ids match ServUO Multis/Boats/BaseGalleon.cs
  // (each hull mounts 6 cannons broadside — 3 per side — except Orc
  // which crowds the deck with 8 light cannons). Speed +0 vs galleon.
  britannian: {
    multiBase: 0x40, hpMax: 4000, armor: 0.28, speedMultiplier: 0.82, plankCount: 2, label: 'Britannian ship of the line',
    cannonMounts: [
      { dx: -1, dy: -2, kind: 'medium' }, { dx: -1, dy: 0, kind: 'medium' }, { dx: -1, dy: 2, kind: 'medium' },
      { dx:  1, dy: -2, kind: 'medium' }, { dx:  1, dy: 0, kind: 'medium' }, { dx:  1, dy: 2, kind: 'medium' },
    ],
  },
  tokuno: {
    multiBase: 0x30, hpMax: 3500, armor: 0.18, speedMultiplier: 1.00, plankCount: 2, label: 'Tokuno galleon',
    cannonMounts: [
      { dx: -1, dy: -1, kind: 'light' }, { dx: -1, dy: 0, kind: 'medium' }, { dx: -1, dy: 1, kind: 'light' },
      { dx:  1, dy: -1, kind: 'light' }, { dx:  1, dy: 0, kind: 'medium' }, { dx:  1, dy: 1, kind: 'light' },
    ],
  },
  orc: {
    multiBase: 0x18, hpMax: 3200, armor: 0.12, speedMultiplier: 1.08, plankCount: 2, label: 'Orc galleon',
    cannonMounts: [
      { dx: -2, dy: -1, kind: 'light' }, { dx: -1, dy: -1, kind: 'light' },
      { dx: -2, dy:  1, kind: 'light' }, { dx: -1, dy:  1, kind: 'light' },
      { dx:  1, dy: -1, kind: 'light' }, { dx:  2, dy: -1, kind: 'light' },
      { dx:  1, dy:  1, kind: 'light' }, { dx:  2, dy:  1, kind: 'light' },
    ],
  },
  gargish: {
    multiBase: 0x24, hpMax: 4500, armor: 0.32, speedMultiplier: 0.78, plankCount: 2, label: 'Gargish galleon',
    cannonMounts: [
      { dx: -1, dy: -2, kind: 'heavy'  }, { dx: -1, dy: 1, kind: 'heavy' },
      { dx:  1, dy: -2, kind: 'heavy'  }, { dx:  1, dy: 1, kind: 'heavy' },
      { dx:  0, dy: -2, kind: 'medium' }, { dx: 0, dy: 2, kind: 'medium' },
    ],
  },
});

function hullForBoat(boat) {
  const key = String(boat?.boat?.hullKind ?? boat?.boat?.hull ?? 'small').toLowerCase();
  return { key: BOAT_HULLS[key] ? key : 'small', def: BOAT_HULLS[key] ?? BOAT_HULLS.small };
}

function multiIdForFacing(hull, facing) {
  const index = Math.max(0, FACINGS.indexOf(facing));
  return (hull.multiBase | 0) + index;
}

function normalizeBoatState(boat) {
  const b = boat?.boat;
  if (!b) return null;
  const { key, def } = hullForBoat(boat);
  b.hullKind ??= key;
  b.boatHpMax ??= def.hpMax;
  b.boatHp ??= b.boatHpMax;
  b.armor ??= def.armor;
  b.speedMultiplier ??= def.speedMultiplier;
  b.cannons ??= [];
  b.planks ??= [];
  b.riders = b.riders instanceof Set ? b.riders : new Set(b.riders ?? []);
  const multiId = multiIdForFacing(def, b.facing ?? 'N');
  boat.multiId = multiId;
  boat.itemId = multiId;
  boat.artId = multiId;
  return { b, key, def };
}

export function boatStats(boat, now = Date.now()) {
  const state = normalizeBoatState(boat);
  if (!state) return null;
  const { b, key, def } = state;
  const hp = Math.max(0, b.boatHp | 0);
  const hpMax = Math.max(1, b.boatHpMax | 0);
  const ratio = hp / hpMax;
  const condition = b.wrecked || ratio <= 0 ? 'sunk'
    : ratio <= 0.25 ? 'critical'
      : ratio <= 0.6 ? 'damaged' : 'sound';
  const conditionSpeed = condition === 'critical' ? 0.55 : condition === 'damaged' ? 0.80 : 1;
  return Object.freeze({
    serial: boat.serial >>> 0,
    name: b.name ?? boat.name ?? def.label,
    hullKind: key,
    hp,
    hpMax,
    hpPercent: Math.round(ratio * 100),
    armorPercent: Math.round(Math.max(0, Math.min(0.8, Number(b.armor))) * 100),
    condition,
    speedMultiplier: Number((Math.max(0.1, Number(b.speedMultiplier) || 1) * conditionSpeed).toFixed(2)),
    sailState: b.sailState ?? 'stop',
    anchored: !!b.anchored,
    sailsDisabledMs: Math.max(0, (b.sailsDisabledUntil ?? 0) - now),
    cannonCount: b.cannons.length,
    course: b.course ? {
      points: b.course.waypoints?.length ?? 0,
      index: b.course.index | 0,
      running: !!b.course.running,
      loop: !!b.course.loop,
    } : null,
  });
}

/**
 * Place a galleon at the given tile and instantiate its cannon mounts.
 * Returns the boat item. Mirrors ServUO `BaseGalleon.OnCreate` →
 * `AddCannon` per mount slot.
 *
 * @param {*} api  same shape as ScriptAPI (world, items, protocol, …)
 * @param {{ kind:keyof BOAT_HULLS, x:number, y:number, z?:number, map?:number,
 *           facing?:'N'|'E'|'S'|'W', ownerSerial?:number, name?:string }} opts
 */
export function placeGalleon(api, opts) {
  const hull = BOAT_HULLS[opts.kind];
  if (!hull) throw new Error(`unknown galleon kind: ${opts.kind}`);
  const facing = opts.facing ?? 'N';
  const multiId = multiIdForFacing(hull, facing);
  const isWater = api.isWaterAt ?? defaultIsWaterAt(api);
  const targetCells = footprintForMulti(multiId).map(([dx, dy]) => [
    (opts.x | 0) + dx, (opts.y | 0) + dy,
  ]);
  for (const [x, y] of targetCells) {
    if (x < 0 || x > 7167 || y < 0 || y > 4095 || !isWater(opts.map | 0, x, y)) {
      throw new Error(`the complete hull does not fit navigable water at (${x},${y})`);
    }
    if ([...(api.world?.multiSpatial?.blockersAt?.(opts.map | 0, x, y) ?? [])].length) {
      throw new Error(`the hull collides with a multi at (${x},${y})`);
    }
    for (const serial of api.world?.sectors?.itemSerialsAt?.(opts.map | 0, x, y) ?? []) {
      const item = api.world.items.get(serial);
      // Do not silently capture pre-existing ground objects as deck cargo at
      // launch time. Cargo is carried only after a player deliberately puts
      // a movable item onto an already placed hull.
      if (item?.parent == null) {
        throw new Error(`the hull collides with an item at (${x},${y})`);
      }
    }
    for (const serial of api.world?.sectors?.mobileSerialsNear?.(opts.map | 0, x, y, 0) ?? []) {
      if ((serial >>> 0) === (opts.ownerSerial >>> 0)) continue;
      const mob = api.world.mobiles.get(serial);
      if (mob && mob.map === (opts.map | 0) && mob.x === x && mob.y === y && !mob.ghost) {
        throw new Error(`the hull collides with a mobile at (${x},${y})`);
      }
    }
  }
  const targetKeys = new Set(targetCells.map(([x, y]) => `${x}:${y}`));
  for (const serial of api.world?._boats ?? []) {
    const other = api.world.items.get(serial);
    if (!other?.boat || other.map !== (opts.map | 0)) continue;
    const { def } = hullForBoat(other);
    const otherMulti = multiIdForFacing(def, other.boat.facing ?? 'N');
    if (footprintForMulti(otherMulti).some(([dx, dy]) => targetKeys.has(`${other.x + dx}:${other.y + dy}`))) {
      throw new Error('the hull overlaps another boat');
    }
  }
  const boat = createWorldItem(api, {
    itemId: multiId, multiId, name: opts.name ?? hull.label,
    x: opts.x | 0, y: opts.y | 0, z: opts.z | 0, map: opts.map | 0,
    boat: {
      facing, riders: new Set(), planks: [], sailState: 'stop', anchored: true,
      ownerSerial: opts.ownerSerial,
      keys: [], boatHp: hull.hpMax, boatHpMax: hull.hpMax,
      hullKind: opts.kind, name: opts.name ?? hull.label, cannons: [],
    },
  });
  if (!boat) throw new Error('world item factory unavailable');
  api.world._boats ||= new Set();
  api.world._boats.add(boat.serial >>> 0);
  const createdAttachments = [];
  // Place each cannon and hook it back to the hull. The cannons system
  // (apps/server/src/systems/cannons.js) owns the per-cannon state; we
  // only stamp `_mountSerial` so `_tickBoat` can drag them along when
  // the boat sails.
  try {
    if (Array.isArray(hull.cannonMounts) && api.systems?.cannons?.placeCannon) {
      for (const mount of hull.cannonMounts) {
        const cannon = api.systems.cannons.placeCannon(api.world, {
          x: boat.x + mount.dx, y: boat.y + mount.dy, z: boat.z, map: boat.map,
          kind: mount.kind,
          facing: Math.abs(mount.dx) >= Math.abs(mount.dy)
            ? (mount.dx < 0 ? 3 : 1)
            : (mount.dy < 0 ? 0 : 2),
        });
        if (!cannon) throw new Error('cannon factory returned no item');
        cannon._mountSerial = boat.serial;
        cannon._mountDx = mount.dx;
        cannon._mountDy = mount.dy;
        boat.boat.cannons.push(cannon.serial);
        createdAttachments.push(cannon.serial);
      }
    }
    const planks = createBoatPlanks(api, boat, hull);
    createdAttachments.push(...planks.map((plank) => plank.serial));
    if (planks.length < Math.max(1, hull.plankCount | 0)) throw new Error('plank factory returned an incomplete set');
  } catch (error) {
    for (const serial of createdAttachments.reverse()) destroyWorldItem(api, serial);
    destroyWorldItem(api, boat.serial);
    api.world._boats?.delete?.(boat.serial >>> 0);
    throw new Error(`boat placement rolled back: ${error.message}`, { cause: error });
  }
  return boat;
}

/**
 * Dry-dock a galleon: removes the hull and its cannons from the world,
 * issues a deed item to `ownerMob` (or returns the deed object if no
 * mob given so callers can place it elsewhere). Refuses if the boat is
 * not anchored or has riders aboard. Mirrors ServUO `BaseGalleon.Dry
 * Dock` flow.
 */
export function dryDockGalleon(api, boat, ownerMob) {
  const normalized = normalizeBoatState(boat);
  if (!normalized) return { ok: false, reason: 'not-a-boat' };
  const b = normalized.b;
  if (!b.anchored) return { ok: false, reason: 'must-be-anchored' };
  const hullCells = new Set(footprintForMulti(boat.multiId ?? boat.itemId)
    .map(([dx, dy]) => `${(boat.x | 0) + dx}:${(boat.y | 0) + dy}`));
  for (const serial of [...b.riders]) {
    const rider = api.world?.mobiles?.get?.(serial >>> 0);
    const aboard = rider?.map === boat.map
      && hullCells.has(`${rider.x | 0}:${rider.y | 0}`)
      && Math.abs((rider.z | 0) - (boat.z | 0)) <= 20;
    if (aboard) return { ok: false, reason: 'riders-aboard' };
    b.riders.delete(serial); // stale disconnect/manual-walk registration
    if (rider?._boardedBoat === (boat.serial >>> 0)) delete rider._boardedBoat;
  }
  for (const mob of api.world?.mobiles?.values?.() ?? []) {
    if ((mob.serial >>> 0) === (b.tillermanSerial >>> 0) || mob.map !== boat.map) continue;
    if (hullCells.has(`${mob.x | 0}:${mob.y | 0}`)
        && Math.abs((mob.z | 0) - (boat.z | 0)) <= 20) {
      return { ok: false, reason: 'passengers-aboard' };
    }
  }
  const attachments = new Set([boat.serial >>> 0, ...(b.cannons ?? []), ...(b.planks ?? [])]);
  for (const item of api.world?.items?.values?.() ?? []) {
    if (attachments.has(item.serial >>> 0) || item.parent != null || item.map !== boat.map) continue;
    if (hullCells.has(`${item.x | 0}:${item.y | 0}`)
        && Math.abs((item.z | 0) - (boat.z | 0)) <= 20) {
      return { ok: false, reason: 'cargo-aboard' };
    }
  }
  const hasCarriedKey = !!ownerMob && (b.keys ?? [])
    .some((serial) => itemCarriedBy(api.world, serial, ownerMob.serial));
  if (ownerMob && b.ownerSerial && (b.ownerSerial >>> 0) !== (ownerMob.serial >>> 0)
      && !hasCarriedKey) {
    return { ok: false, reason: 'not-owner' };
  }
  const backpack = ownerMob ? backpackOf(api.world, ownerMob) : null;
  if (ownerMob && !backpack) return { ok: false, reason: 'no-backpack' };
  const deedName = b.name ?? boat.name ?? `${b.hullKind ?? 'ship'} deed`;
  const deed = createWorldItem(api, {
    itemId: 0x14F0, name: `${b.hullKind} galleon deed`,
    x: ownerMob?.x ?? boat.x, y: ownerMob?.y ?? boat.y, z: ownerMob?.z ?? boat.z,
    map: ownerMob?.map ?? boat.map,
    boatDeed: { hullKind: b.hullKind, name: deedName, ownerSerial: b.ownerSerial },
    parent: backpack?.serial,
  });
  if (deed) {
    deed.boatDeed = { hullKind: b.hullKind, name: deedName, ownerSerial: b.ownerSerial };
    deed.script = 'servuo-boat-deed';
  }
  if (!deed) return { ok: false, reason: 'deed-create-failed' };
  // Only remove the hull after the replacement deed exists.
  for (const serial of [...(b.cannons ?? []), ...(b.planks ?? [])]) {
    const item = api.world.items.get(serial >>> 0);
    broadcastRemoval(api, item);
    destroyWorldItem(api, serial);
  }
  for (const keySerial of b.keys ?? []) {
    ownerMob?.client?.sendRemove?.(keySerial);
    destroyWorldItem(api, keySerial);
  }
  if (b.tillermanSerial) {
    const tillerman = api.world.mobiles.get(b.tillermanSerial >>> 0);
    broadcastRemoval(api, tillerman);
    destroyWorldMobile(api, b.tillermanSerial);
  }
  broadcastRemoval(api, boat);
  destroyWorldItem(api, boat.serial);
  api.world._boats?.delete?.(boat.serial >>> 0);
  if (ownerMob?.client && backpack && api.protocol?.containerContentUpdate) {
    try { ownerMob.client.send(api.protocol.containerContentUpdate(deed, backpack.serial)); }
    catch { /* reconnect will receive authoritative backpack contents */ }
  }
  return { ok: true, deedSerial: deed?.serial };
}

/** Pick the right tillerman speech line for a sailing event. */
function tillermanSay(boat, line, api) {
  const t = boat?.boat?.tillermanSerial;
  if (!t) return;
  if (!api.protocol?.unicodeMessage) return;
  const tiller = api.world.mobiles.get(t);
  if (!tiller) return;
  const pkt = api.protocol.unicodeMessage({
    serial: tiller.serial, graphic: tiller.body | 0, type: 0,
    hue: 0x03B2, font: 3, language: 'ENU',
    name: tiller.name ?? 'tillerman', text: line,
  });
  for (const m of api.world.mobiles.values()) {
    if (!m.client || m.map !== boat.map) continue;
    if (Math.abs(m.x - boat.x) > 18 || Math.abs(m.y - boat.y) > 18) continue;
    try { m.client.send(pkt); } catch { /* disconnected observer */ }
  }
}

/** @typedef {{
 *   facing: 'N'|'E'|'S'|'W',
 *   riders: Set<number>,
 *   planks: number[],
 *   sailState?: 'stop'|'slow'|'medium'|'full',
 *   anchored?: boolean,
 *   ownerSerial?: number,
 *   keys?: number[],
 *   nextSailAt?: number,
 *   boatHp?: number,
 *   boatHpMax?: number,
 *   wrecked?: boolean,
 *   name?: string,
 * }} BoatState */

/**
 * Start the boats subsystem. Pumps every tick — moves any boat with a
 * non-stop sail state in its facing direction at the appropriate cadence.
 *
 * @param {Object} api  same shape as ScriptAPI: { world, items, protocol, time }
 */
export function startBoatSystem(api) {
  const TICK_MS = 250;

  const isWater = api.isWaterAt ?? defaultIsWaterAt(api);

  const footprintAt = (boat, x = boat.x, y = boat.y, facing = boat.boat?.facing ?? 'N') => {
    const { def } = hullForBoat(boat);
    const multiId = multiIdForFacing(def, facing);
    return footprintForMulti(multiId).map(([dx, dy]) => [x + dx, y + dy]);
  };

  const canOccupy = (boat, x, y, map = boat.map, facing = boat.boat?.facing ?? 'N', ignoreMobile = 0) => {
    if (!boat?.boat || boat.boat.wrecked) return false;
    const cells = footprintAt(boat, x | 0, y | 0, facing);
    const wanted = new Set(cells.map(([cx, cy]) => `${cx}:${cy}`));
    const currentDeck = new Set(footprintAt(boat).map(([cx, cy]) => `${cx}:${cy}`));
    const own = new Set([boat.serial >>> 0, ...(boat.boat.planks ?? []), ...(boat.boat.cannons ?? [])]);
    const ownMobiles = new Set([
      ignoreMobile >>> 0,
      boat.boat.tillermanSerial >>> 0,
    ]);
    for (const serial of [...boat.boat.riders]) {
      const rider = api.world.mobiles.get(serial >>> 0);
      if (rider?.map === boat.map && currentDeck.has(`${rider.x | 0}:${rider.y | 0}`)
          && Math.abs((rider.z | 0) - (boat.z | 0)) <= 20) {
        ownMobiles.add(serial >>> 0);
      } else {
        boat.boat.riders.delete(serial);
        if (rider?._boardedBoat === (boat.serial >>> 0)) delete rider._boardedBoat;
      }
    }
    for (const [cx, cy] of cells) {
      if (cx < 0 || cx > 7167 || cy < 0 || cy > 4095 || !isWater(map, cx, cy)) return false;
      for (const blocker of api.world.multiSpatial?.blockersAt?.(map, cx, cy) ?? []) {
        if ((blocker.serial >>> 0) !== (boat.serial >>> 0)) return false;
      }
      for (const serial of api.world.sectors?.itemSerialsAt?.(map, cx, cy) ?? []) {
        if (own.has(serial >>> 0)) continue;
        const item = api.world.items.get(serial);
        if (!item || item.parent != null) continue;
        const movableDeckCargo = item.movable !== false && !item.boat && !item.solid && !item.door
          && currentDeck.has(`${item.x | 0}:${item.y | 0}`)
          && Math.abs((item.z | 0) - (boat.z | 0)) <= 20;
        if (movableDeckCargo) continue;
        if (item.boat || item.solid || (item.door && !item.door.isOpen)) return false;
      }
      for (const serial of api.world.sectors?.mobileSerialsNear?.(map, cx, cy, 0) ?? []) {
        if (ownMobiles.has(serial >>> 0)) continue;
        const mob = api.world.mobiles.get(serial);
        if (mob && currentDeck.has(`${mob.x | 0}:${mob.y | 0}`)
            && Math.abs((mob.z | 0) - (boat.z | 0)) <= 20) continue;
        if (mob && mob.map === map && mob.x === cx && mob.y === cy && !mob.ghost) return false;
      }
    }
    for (const serial of api.world._boats ?? []) {
      if ((serial >>> 0) === (boat.serial >>> 0)) continue;
      const other = api.world.items.get(serial);
      if (!other?.boat || other.map !== map) continue;
      if (footprintAt(other).some(([cx, cy]) => wanted.has(`${cx}:${cy}`))) return false;
    }
    return true;
  };

  const looseDeckItems = (boat) => {
    const own = new Set([boat.serial >>> 0, ...(boat.boat?.planks ?? []), ...(boat.boat?.cannons ?? [])]);
    const found = new Map();
    for (const [x, y] of footprintAt(boat)) {
      for (const serial of api.world.sectors?.itemSerialsAt?.(boat.map, x, y) ?? []) {
        if (own.has(serial >>> 0)) continue;
        const item = api.world.items.get(serial);
        if (item?.parent == null && item.movable !== false && !item.boat && !item.solid && !item.door
            && item.map === boat.map && item.x === x && item.y === y
            && Math.abs((item.z | 0) - (boat.z | 0)) <= 20) found.set(item.serial, item);
      }
    }
    return [...found.values()];
  };

  const deckMobiles = (boat) => {
    const found = new Map();
    const tillerman = boat.boat?.tillermanSerial >>> 0;
    const footprint = footprintAt(boat);
    const deck = new Set(footprint.map(([x, y]) => `${x}:${y}`));
    for (const [x, y] of footprint) {
      for (const serial of api.world.sectors?.mobileSerialsNear?.(boat.map, x, y, 0) ?? []) {
        if ((serial >>> 0) === tillerman) continue;
        const mob = api.world.mobiles.get(serial);
        if (mob && mob.map === boat.map && mob.x === x && mob.y === y
            && Math.abs((mob.z | 0) - (boat.z | 0)) <= 20) found.set(mob.serial, mob);
      }
    }
    // Minimal test worlds and embedders may not install a sector index. Also
    // prune registrations for characters who walked ashore or disappeared.
    for (const serial of [...(boat.boat?.riders ?? [])]) {
      const mob = api.world.mobiles.get(serial >>> 0);
      if (mob?.map === boat.map && deck.has(`${mob.x | 0}:${mob.y | 0}`)
          && Math.abs((mob.z | 0) - (boat.z | 0)) <= 20) {
        found.set(mob.serial, mob);
      } else {
        boat.boat.riders.delete(serial);
        if (mob?._boardedBoat === (boat.serial >>> 0)) delete mob._boardedBoat;
      }
    }
    return [...found.values()];
  };

  // Sector-aware fan-out — boat tick runs 4 Hz × all sailing boats;
  // a full 11.7k mobile walk per tick was wasted CPU. Bug-hunt #5 D.
  function nearbyClientIter(map, x, y, range) {
    const sectors = api.world.sectors;
    if (sectors?.mobileSerialsNear) {
      return (function* () {
        for (const s of sectors.mobileSerialsNear(map, x, y, range)) {
          const m = api.world.mobiles.get(s);
          if (m?.client && m.map === map
              && Math.abs(m.x - x) <= range && Math.abs(m.y - y) <= range) yield m;
        }
      })();
    }
    return (function* () {
      for (const m of api.world.mobiles.values()) {
        if (!m.client || m.map !== map) continue;
        if (Math.abs(m.x - x) > range || Math.abs(m.y - y) > range) continue;
        yield m;
      }
    })();
  }

  const broadcastBoatPos = (boat, { legacyOnly = false } = {}) => {
    if (!api.protocol?.worldItemSA) return;
    // Hulls are real type-2 multis; planks/cannons moved by the same helper
    // are ordinary items and must remain type 0.
    const isMulti = boat?.boat != null || boat?.multiId != null;
    const wi = api.protocol.worldItemSA({
      serial: boat.serial, itemId: isMulti ? (boat.multiId ?? boat.itemId) : boat.itemId, hue: boat.hue,
      amount: 1, x: boat.x, y: boat.y, z: boat.z,
      dataType: isMulti ? 2 : 0,
    });
    for (const m of nearbyClientIter(boat.map, boat.x, boat.y, 18)) {
      if (legacyOnly && m.client._supportsBoatMoving) continue;
      try { m.client.send(wi); } catch { /* disconnected observer */ }
    }
  };

  const broadcastMobile = (mob, { legacyOnly = false } = {}) => {
    if (!api.protocol?.mobileMoving) return;
    const moving = api.protocol.mobileMoving({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue,
      flags: mob.flags, notoriety: mob.notoriety,
    });
    for (const other of nearbyClientIter(mob.map, mob.x, mob.y, 18)) {
      if (legacyOnly && other.client._supportsBoatMoving) continue;
      try { other.client.send(moving); } catch { /* disconnected observer */ }
    }
  };

  const broadcastAtomicBoatMove = (boat, entities) => {
    if (!api.protocol?.boatMoving) return;
    const b = boat.boat;
    const speed = ({ stop: 0, slow: 1, medium: 2, full: 3 })[b.sailState] ?? 0;
    const direction = Math.max(0, FACINGS.indexOf(b.facing)) * 2;
    const passengers = [...new Map(entities.filter(Boolean)
      .map((entity) => [entity.serial >>> 0, entity])).values()]
      .map((entity) => ({ serial: entity.serial, x: entity.x, y: entity.y, z: entity.z }));
    let packet;
    try {
      packet = api.protocol.boatMoving({
        serial: boat.serial, speed, direction, facing: direction,
        x: boat.x, y: boat.y, z: boat.z, passengers,
      });
    } catch { return; }
    for (const viewer of nearbyClientIter(boat.map, boat.x, boat.y, 18)) {
      if (!viewer.client._supportsBoatMoving) continue;
      try { viewer.client.send(packet); } catch { /* disconnected observer */ }
    }
  };

  const moveAttachedObjects = (boat, dx, dy, legacyOnly = false) => {
    const b = boat?.boat;
    if (!b) return 0;
    let moved = 0;
    if (b.planks?.length) {
      for (const ps of b.planks) {
        const p = api.world.items.get(ps >>> 0);
        if (!p) continue;
        p.x += dx; p.y += dy;
        api.world.sectors?.moveItem?.(p);
        broadcastBoatPos(p, { legacyOnly });
        moved++;
      }
    }
    if (b.cannons?.length) {
      for (const cs of b.cannons) {
        const c = api.world.items.get(cs >>> 0);
        if (!c) continue;
        c.x += dx; c.y += dy;
        api.world.sectors?.moveItem?.(c);
        broadcastBoatPos(c, { legacyOnly });
        moved++;
      }
    }
    if (b.tillermanSerial) {
      const t = api.world.mobiles.get(b.tillermanSerial >>> 0);
      if (t) {
        t.x += dx; t.y += dy;
        api.world.sectors?.moveMobile?.(t);
        broadcastMobile(t, { legacyOnly });
        moved++;
      }
    }
    return moved;
  };

  const setFacing = (boat, facing) => {
    const b = boat?.boat;
    const nextIndex = FACINGS.indexOf(facing);
    const oldIndex = FACINGS.indexOf(b?.facing);
    if (!b || nextIndex < 0) return false;
    if (!canOccupy(boat, boat.x, boat.y, boat.map, facing)) return false;
    if (oldIndex < 0 || oldIndex === nextIndex) {
      b.facing = facing;
      const { def } = hullForBoat(boat);
      boat.multiId = multiIdForFacing(def, facing);
      boat.itemId = boat.multiId;
      boat.artId = boat.multiId;
      return true;
    }
    const turns = (nextIndex - oldIndex + 4) % 4;
    const rotate = (dx, dy) => {
      for (let i = 0; i < turns; i++) [dx, dy] = [-dy, dx];
      return [dx, dy];
    };
    const passengers = deckMobiles(boat);
    const looseItems = looseDeckItems(boat);
    for (const rider of passengers) {
      if (!rider) continue;
      const [dx, dy] = rotate((rider.x | 0) - (boat.x | 0), (rider.y | 0) - (boat.y | 0));
      rider.x = (boat.x | 0) + dx; rider.y = (boat.y | 0) + dy;
      api.world.sectors?.moveMobile?.(rider);
      broadcastMobile(rider, { legacyOnly: true });
    }
    for (const item of looseItems) {
      const [dx, dy] = rotate((item.x | 0) - (boat.x | 0), (item.y | 0) - (boat.y | 0));
      item.x = (boat.x | 0) + dx; item.y = (boat.y | 0) + dy;
      api.world.sectors?.moveItem?.(item);
      broadcastBoatPos(item, { legacyOnly: true });
    }
    for (const serial of [...(b.planks ?? []), ...(b.cannons ?? [])]) {
      const item = api.world.items.get(serial >>> 0);
      if (!item) continue;
      const [dx, dy] = rotate((item.x | 0) - (boat.x | 0), (item.y | 0) - (boat.y | 0));
      item.x = (boat.x | 0) + dx;
      item.y = (boat.y | 0) + dy;
      if (item.cannon) item.cannon.facing = ((item.cannon.facing | 0) + turns) & 3;
      if (item.boatPlank?.side) {
        const side = FACINGS.indexOf(item.boatPlank.side);
        if (side >= 0) item.boatPlank.side = FACINGS[(side + turns) & 3];
      }
      api.world.sectors?.moveItem?.(item);
      broadcastBoatPos(item, { legacyOnly: true });
    }
    if (b.tillermanSerial) {
      const tiller = api.world.mobiles.get(b.tillermanSerial >>> 0);
      if (tiller) {
        const [dx, dy] = rotate((tiller.x | 0) - (boat.x | 0), (tiller.y | 0) - (boat.y | 0));
        tiller.x = (boat.x | 0) + dx;
        tiller.y = (boat.y | 0) + dy;
        api.world.sectors?.moveMobile?.(tiller);
        broadcastMobile(tiller, { legacyOnly: true });
      }
    }
    b.facing = facing;
    const { def } = hullForBoat(boat);
    boat.multiId = multiIdForFacing(def, facing);
    boat.itemId = boat.multiId;
    boat.artId = boat.multiId;
    broadcastBoatPos(boat, { legacyOnly: true });
    broadcastAtomicBoatMove(boat, [
      ...passengers, ...looseItems,
      ...(b.planks ?? []).map((serial) => api.world.items.get(serial >>> 0)),
      ...(b.cannons ?? []).map((serial) => api.world.items.get(serial >>> 0)),
      api.world.mobiles.get(b.tillermanSerial >>> 0),
    ]);
    return true;
  };

  const sailOnce = (boat) => {
    /** @type {BoatState} */
    const b = boat.boat;
    if (!b || b.anchored || b.wrecked) return false;
    const [dx, dy] = FACING_DELTAS[b.facing] ?? [0, 0];
    const nx = boat.x + dx, ny = boat.y + dy;
    if (!canOccupy(boat, nx, ny, boat.map ?? 1, b.facing)) {
      // Smashed into shore: stop sails and warn riders.
      b.sailState = 'stop';
      tillermanSay(boat, 'Avast! The shore approaches!', api);
      for (const rs of b.riders) {
        const r = api.world.mobiles.get(rs);
        r?.client?.sendSystemMessage?.('The boat grinds to a halt against the shore.');
      }
      return false;
    }
    const looseItems = looseDeckItems(boat);
    const passengers = deckMobiles(boat);
    boat.x = nx; boat.y = ny;
    // Bug-hunt #5 A4: re-bucket in sectors after every tile move.
    // Without these calls boat/plank/rider/cannon stayed in their
    // initial sectors → `nearbyMobiles`/`nearbyItems` missed them
    // and observers from a distance saw frozen ghosts + plank desync.
    api.world.sectors?.moveItem?.(boat);
    moveAttachedObjects(boat, dx, dy, true);
    for (const item of looseItems) {
      item.x += dx; item.y += dy;
      api.world.sectors?.moveItem?.(item);
      broadcastBoatPos(item, { legacyOnly: true });
    }
    for (const r of passengers) {
      if (!r) continue;
      r.x += dx; r.y += dy;
      api.world.sectors?.moveMobile?.(r);
      broadcastMobile(r, { legacyOnly: true });
    }
    broadcastBoatPos(boat, { legacyOnly: true });
    broadcastAtomicBoatMove(boat, [
      ...passengers, ...looseItems,
      ...(b.planks ?? []).map((serial) => api.world.items.get(serial >>> 0)),
      ...(b.cannons ?? []).map((serial) => api.world.items.get(serial >>> 0)),
      api.world.mobiles.get(b.tillermanSerial >>> 0),
    ]);
    return true;
  };

  // Per-shard boat index. Lazy-populated on first tick (walks
  // world.items once) — afterwards `placeGalleon` / boat-deed handlers
  // add to the Set, `destroyItem` removes via the items.js hook.
  // Bug-hunt #2 B4: previously every 250ms tick walked all 110k
  // world.items just to find ~10 boats. With the index that drops to
  // ~10 iterations.
  function ensureBoatIndex() {
    if (api.world._boatIndexReady && api.world._boats instanceof Set) return api.world._boats;
    const s = api.world._boats instanceof Set ? api.world._boats : new Set();
    // The Set can exist before the system starts (a new boat was placed)
    // while restored boats are not indexed yet. Reconcile once and also
    // migrate legacy static-art hull graphics to canonical BaseMulti ids.
    for (const it of api.world.items.values()) {
      if (!it.boat) continue;
      normalizeBoatState(it);
      s.add(it.serial);
    }
    api.world._boats = s;
    api.world._boatIndexReady = true;
    return s;
  }
  const tick = () => {
    const now = Date.now();
    const idx = ensureBoatIndex();
    for (const serial of idx) {
      const it = api.world.items.get(serial);
      if (!it?.boat) { idx.delete(serial); continue; }
      const b = it.boat;
      if (b.anchored || b.wrecked) continue;
      const stats = boatStats(it, now);
      if ((b.sailsDisabledUntil ?? 0) > now) {
        b.sailState = 'stop';
        continue;
      }
      const baseInterval = SAIL_INTERVAL_MS[b.sailState ?? 'stop'];
      const interval = baseInterval > 0
        ? Math.max(180, Math.round(baseInterval / Math.max(0.1, stats?.speedMultiplier ?? 1)))
        : 0;
      if (interval <= 0) continue;
      if (now < (b.nextSailAt ?? 0)) continue;
      b.nextSailAt = now + interval;
      sailOnce(it);
    }
  };

  ensureBoatIndex();
  const removeAssetListener = api.world?.events?.on?.('assets:changed', (change) => {
    if (change?.kind === 'multi') invalidateMultiCatalog();
  }) ?? (() => {});
  const timer = api.scheduler?.every
    ? api.scheduler.every('boats', TICK_MS, tick)
    : setInterval(tick, TICK_MS);
  timer.unref?.();

  return {
    stop() {
      removeAssetListener();
      if (typeof timer?.cancel === 'function') timer.cancel();
      else clearInterval(timer);
    },
    sailOnce,
    setSailState(boat, state) {
      if (!normalizeBoatState(boat)) return false;
      if (boat.boat.anchored) return false;
      if ((boat.boat.sailsDisabledUntil ?? 0) > Date.now()) return false;
      if (!(state in SAIL_INTERVAL_MS)) return false;
      boat.boat.sailState = state;
      boat.boat.nextSailAt = Date.now();
      const lines = {
        stop:   'All stop!',
        slow:   'Aye, forward slow.',
        medium: 'Aye, forward medium.',
        full:   'Aye, forward full!',
      };
      tillermanSay(boat, lines[state] ?? 'Aye!', api);
      return true;
    },
    dropAnchor(boat) {
      if (!boat?.boat) return false;
      boat.boat.anchored = true;
      boat.boat.sailState = 'stop';
      tillermanSay(boat, 'Anchor dropped!', api);
      return true;
    },
    raiseAnchor(boat) {
      if (!boat?.boat) return false;
      boat.boat.anchored = false;
      tillermanSay(boat, 'Anchor raised, awaitin\' yer command.', api);
      return true;
    },
    /** Apply hull stats from BOAT_HULLS to a freshly-spawned boat. */
    applyHull(boat, hullKey = 'small') {
      const hull = BOAT_HULLS[hullKey];
      if (!boat?.boat || !hull) return false;
      boat.multiId = multiIdForFacing(hull, boat.boat?.facing ?? 'N');
      boat.itemId = boat.multiId;
      boat.artId = boat.multiId;
      boat.boat.hull = hullKey;
      boat.boat.hullKind = hullKey;
      boat.boat.boatHpMax = hull.hpMax;
      boat.boat.boatHp = hull.hpMax;
      boat.boat.armor = hull.armor;
      boat.boat.speedMultiplier = hull.speedMultiplier;
      boat.boat.label = hull.label;
      return true;
    },
    /** Bind a tillerman NPC to the boat — ServUO spawns one per hull. */
    setTillerman(boat, tillerman) {
      if (!boat?.boat || !tillerman) return false;
      boat.boat.tillermanSerial = tillerman.serial >>> 0;
      tillerman._boatSerial = boat.serial >>> 0;
      tillerman.invulnerable = true;     // tillermen are unkillable
      return true;
    },
    /** Set the boat's friendly name — shown by the tillerman. */
    rename(boat, newName) {
      if (!boat?.boat) return false;
      boat.boat.name = String(newName).slice(0, 30);
      return true;
    },
    /** Apply armor-aware damage to a boat — returns true if it sank. */
    damage(boat, amount, { damageType = 'physical', ignoreArmor = false } = {}) {
      const state = normalizeBoatState(boat);
      if (!state) return false;
      const raw = Math.max(0, amount | 0);
      const armor = ignoreArmor ? 0 : Math.max(0, Math.min(0.8, Number(state.b.armor) || 0));
      const typeMultiplier = damageType === 'fire' ? 1.15 : damageType === 'cold' ? 0.85 : 1;
      const applied = raw <= 0 ? 0 : Math.max(1, Math.round(raw * typeMultiplier * (1 - armor)));
      boat.boat.boatHp = Math.max(0, boat.boat.boatHp - applied);
      boat.boat.lastDamage = { raw, applied, damageType, at: Date.now() };
      if (boat.boat.boatHp <= 0 && !boat.boat.wrecked) {
        boat.boat.wrecked = true;
        boat.boat.sailState = 'stop';
        // Eject riders — clear the rider Set so dryDock / cleanup
        // can proceed AND so a disconnected rider doesn't keep them
        // pinned to a wreck after relog. Bug-hunt #2 A10.
        for (const rs of [...boat.boat.riders]) {
          const r = api.world.mobiles.get(rs);
          r?.client?.sendSystemMessage?.('The boat splinters beneath your feet!');
          // Push the rider one tile off the wreck so they end up in
          // water and can swim ashore (or teleport via [recall).
          if (r) {
            r.x = boat.x + 1;
            r.y = boat.y;
            api.world.sectors?.moveMobile?.(r);
          }
          boat.boat.riders.delete(rs);
        }
        return true;
      }
      return false;
    },
    stats(boat) {
      return boatStats(boat);
    },
    canSailTo(boat, x, y, map = boat?.map ?? 1) {
      return canOccupy(boat, x | 0, y | 0, map, boat?.boat?.facing ?? 'N');
    },
    isMultiIdInUse(multiId) {
      const wanted = multiId | 0;
      for (const serial of api.world._boats ?? []) {
        const boat = api.world.items.get(serial >>> 0);
        if (!boat?.boat) continue;
        const { def } = hullForBoat(boat);
        if (FACINGS.some((facing) => multiIdForFacing(def, facing) === wanted)) return true;
      }
      return false;
    },
    disableSails(boat, durationMs = 8000) {
      if (!boat?.boat) return false;
      boat.boat.sailsDisabledUntil = Math.max(
        boat.boat.sailsDisabledUntil ?? 0,
        Date.now() + Math.max(0, durationMs | 0),
      );
      boat.boat.sailState = 'stop';
      boat.boat.course && (boat.boat.course.running = false);
      tillermanSay(boat, 'The rigging is fouled! We cannot make sail!', api);
      return true;
    },
    /** Verify caller has rights (owner or key-holder). */
    hasPilotRights(boat, mob) {
      const b = boat?.boat;
      if (!b) return false;
      if (!b.ownerSerial) return true;
      if (b.ownerSerial === mob.serial) return true;
      if (!b.keys) return false;
      return b.keys.some((keySerial) => itemCarriedBy(api.world, keySerial, mob.serial));
    },
    /** Move planks, mounted cannons and tillerman with a manually moved
     *  hull. Text-command one-shot sailing uses this to share the same
     *  attachment path as the continuous boat tick. */
    moveAttachedObjects(boat, dx, dy) {
      return moveAttachedObjects(boat, dx | 0, dy | 0);
    },
    setFacing,
    footprintAt,
    canOccupy,
    /** Spawn a galleon hull at the caller's tile. Caller is the
     *  `[boat spawn <hull>` command; the underlying `placeGalleon`
     *  module-export does the cannon-mount work. */
    placeGalleon(callerApi, opts) {
      return placeGalleon(callerApi, opts);
    },
    dryDockGalleon(callerApi, boat, ownerMob) {
      return dryDockGalleon(callerApi ?? api, boat, ownerMob);
    },
    /** Read-only view of the BOAT_HULLS table for callers that want
     *  to render dropdowns or scale-up base hulls. */
    _HULLS: BOAT_HULLS,
  };
}

function defaultIsWaterAt(api) {
  const land = api.landProvider;
  if (!land) return () => true;
  return (facet, x, y) => {
    const l = land.landAt?.(facet, x, y);
    if (l) {
      const tid = l.tileId | 0;
      if (tid >= 0x00A8 && tid <= 0x00AB) return true;
      if (tid >= 0x0136 && tid <= 0x0137) return true;
    }
    return (land.staticsAt?.(facet, x | 0, y | 0) ?? [])
      .some((entry) => (entry.tileId | 0) >= 0x1796 && (entry.tileId | 0) <= 0x17B2);
  };
}
