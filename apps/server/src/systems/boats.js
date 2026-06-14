// Boat system — extends the script-side `[boat` MVP with:
//   - sail-state (Stop / Slow / Medium / Full) → continuous tick movement
//   - anchor (drops/raises; anchored boats refuse sail commands)
//   - owner + spare keys (only owner / key-holder may pilot)
//   - per-boat damage (HP) — naval combat hooks update boat.boatHp
//   - boat-deed items (double-click → places a rowboat under feet)
//
// ServUO reference: Scripts/Multis/Boats/BaseBoat.cs (~3000 LOC).
// Intentional simplifications:
//   - No multi-tile hull collision: hull is still 1 tile (the deck).
//     Visual hull rendering is the client's job.
//   - Naval combat = bog-standard damage() against `boat.boatHp` with
//     a destroy-on-zero callback that turns the boat into a wreck.
//
// Persistence: every field below is on `item.boat` (already in
// MOBILE_EXT_KEYS' sibling whitelist). Saves round-trip the state.

const SAIL_INTERVAL_MS = {
  stop: 0,
  slow: 1500,
  medium: 1000,
  full: 600,
};

const FACING_DELTAS = {
  N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0],
};

const PLANK_ITEM_ID = 0x3EAA;

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
  small:    { graphic: 0x3E5C, hpMax: 1000, plankCount: 1, label: 'small ship' },
  medium:   { graphic: 0x3E5E, hpMax: 1500, plankCount: 2, label: 'medium ship' },
  large:    { graphic: 0x3E60, hpMax: 2000, plankCount: 2, label: 'large ship' },
  galleon:  { graphic: 0x3E62, hpMax: 3000, plankCount: 2, label: 'galleon' },
  // SA Galleons. graphic ids match ServUO Multis/Boats/BaseGalleon.cs
  // (each hull mounts 6 cannons broadside — 3 per side — except Orc
  // which crowds the deck with 8 light cannons). Speed +0 vs galleon.
  britannian: {
    graphic: 0x4002, hpMax: 4000, plankCount: 2, label: 'Britannian ship of the line',
    cannonMounts: [
      { dx: -1, dy: -2, kind: 'medium' }, { dx: -1, dy: 0, kind: 'medium' }, { dx: -1, dy: 2, kind: 'medium' },
      { dx:  1, dy: -2, kind: 'medium' }, { dx:  1, dy: 0, kind: 'medium' }, { dx:  1, dy: 2, kind: 'medium' },
    ],
  },
  tokuno: {
    graphic: 0x4006, hpMax: 3500, plankCount: 2, label: 'Tokuno galleon',
    cannonMounts: [
      { dx: -1, dy: -1, kind: 'light' }, { dx: -1, dy: 0, kind: 'medium' }, { dx: -1, dy: 1, kind: 'light' },
      { dx:  1, dy: -1, kind: 'light' }, { dx:  1, dy: 0, kind: 'medium' }, { dx:  1, dy: 1, kind: 'light' },
    ],
  },
  orc: {
    graphic: 0x4008, hpMax: 3200, plankCount: 2, label: 'Orc galleon',
    cannonMounts: [
      { dx: -2, dy: -1, kind: 'light' }, { dx: -1, dy: -1, kind: 'light' },
      { dx: -2, dy:  1, kind: 'light' }, { dx: -1, dy:  1, kind: 'light' },
      { dx:  1, dy: -1, kind: 'light' }, { dx:  2, dy: -1, kind: 'light' },
      { dx:  1, dy:  1, kind: 'light' }, { dx:  2, dy:  1, kind: 'light' },
    ],
  },
  gargish: {
    graphic: 0x400A, hpMax: 4500, plankCount: 2, label: 'Gargish galleon',
    cannonMounts: [
      { dx: -1, dy: -2, kind: 'heavy'  }, { dx: -1, dy: 1, kind: 'heavy' },
      { dx:  1, dy: -2, kind: 'heavy'  }, { dx:  1, dy: 1, kind: 'heavy' },
      { dx:  0, dy: -2, kind: 'medium' }, { dx: 0, dy: 2, kind: 'medium' },
    ],
  },
});

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
  const boat = createWorldItem(api, {
    itemId: hull.graphic, name: opts.name ?? hull.label,
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
  // Place each cannon and hook it back to the hull. The cannons system
  // (apps/server/src/systems/cannons.js) owns the per-cannon state; we
  // only stamp `_mountSerial` so `_tickBoat` can drag them along when
  // the boat sails.
  if (Array.isArray(hull.cannonMounts) && api.systems?.cannons?.placeCannon) {
    for (const mount of hull.cannonMounts) {
      const cannon = api.systems.cannons.placeCannon(api.world, {
        x: boat.x + mount.dx, y: boat.y + mount.dy, z: boat.z, map: boat.map,
        kind: mount.kind, facing: 0,
      });
      if (!cannon) continue;
      cannon._mountSerial = boat.serial;
      cannon._mountDx = mount.dx;
      cannon._mountDy = mount.dy;
      boat.boat.cannons.push(cannon.serial);
    }
  }
  if (opts.kind === 'galleon' || Array.isArray(hull.cannonMounts)) {
    createBoatPlanks(api, boat, hull);
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
  const b = boat?.boat;
  if (!b) return { ok: false, reason: 'not-a-boat' };
  if (!b.anchored) return { ok: false, reason: 'must-be-anchored' };
  if ((b.riders?.size | 0) > 0) return { ok: false, reason: 'riders-aboard' };
  // Destroy attached objects that otherwise survive as orphaned world
  // entities after the hull is removed.
  for (const cs of b.cannons ?? []) {
    destroyWorldItem(api, cs);
  }
  for (const ps of b.planks ?? []) {
    destroyWorldItem(api, ps);
  }
  if (b.tillermanSerial) {
    destroyWorldMobile(api, b.tillermanSerial);
  }
  const deedName = b.name ?? boat.name ?? `${b.hullKind ?? 'ship'} deed`;
  const deed = createWorldItem(api, {
    itemId: 0x14F0, name: `${b.hullKind} galleon deed`,
    x: ownerMob?.x ?? boat.x, y: ownerMob?.y ?? boat.y, z: ownerMob?.z ?? boat.z,
    map: ownerMob?.map ?? boat.map,
    boatDeed: { hullKind: b.hullKind, name: deedName, ownerSerial: b.ownerSerial },
    parent: ownerMob?._packSerial,
  });
  if (deed) {
    deed.boatDeed = { hullKind: b.hullKind, name: deedName, ownerSerial: b.ownerSerial };
    deed.script = 'servuo-boat-deed';
  }
  destroyWorldItem(api, boat.serial);
  api.world._boats?.delete?.(boat.serial >>> 0);
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
    m.client.send(pkt);
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

  const broadcastBoatPos = (boat) => {
    if (!api.protocol?.worldItemSA) return;
    const wi = api.protocol.worldItemSA({
      serial: boat.serial, itemId: boat.itemId, hue: boat.hue,
      amount: 1, x: boat.x, y: boat.y, z: boat.z,
    });
    for (const m of nearbyClientIter(boat.map, boat.x, boat.y, 18)) {
      m.client.send(wi);
    }
  };

  const broadcastMobile = (mob) => {
    if (!api.protocol?.mobileMoving) return;
    const moving = api.protocol.mobileMoving({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue,
      flags: mob.flags, notoriety: mob.notoriety,
    });
    for (const other of nearbyClientIter(mob.map, mob.x, mob.y, 18)) {
      other.client.send(moving);
    }
  };

  const moveAttachedObjects = (boat, dx, dy) => {
    const b = boat?.boat;
    if (!b) return 0;
    let moved = 0;
    if (b.planks?.length) {
      for (const ps of b.planks) {
        const p = api.world.items.get(ps >>> 0);
        if (!p) continue;
        p.x += dx; p.y += dy;
        api.world.sectors?.moveItem?.(p);
        broadcastBoatPos(p);
        moved++;
      }
    }
    if (b.cannons?.length) {
      for (const cs of b.cannons) {
        const c = api.world.items.get(cs >>> 0);
        if (!c) continue;
        c.x += dx; c.y += dy;
        api.world.sectors?.moveItem?.(c);
        broadcastBoatPos(c);
        moved++;
      }
    }
    if (b.tillermanSerial) {
      const t = api.world.mobiles.get(b.tillermanSerial >>> 0);
      if (t) {
        t.x += dx; t.y += dy;
        api.world.sectors?.moveMobile?.(t);
        broadcastMobile(t);
        moved++;
      }
    }
    return moved;
  };

  const sailOnce = (boat) => {
    /** @type {BoatState} */
    const b = boat.boat;
    if (!b || b.anchored || b.wrecked) return false;
    const [dx, dy] = FACING_DELTAS[b.facing] ?? [0, 0];
    const nx = boat.x + dx, ny = boat.y + dy;
    if (!isWater(boat.map ?? 1, nx, ny)) {
      // Smashed into shore: stop sails and warn riders.
      b.sailState = 'stop';
      tillermanSay(boat, 'Avast! The shore approaches!', api);
      for (const rs of b.riders) {
        const r = api.world.mobiles.get(rs);
        r?.client?.sendSystemMessage?.('The boat grinds to a halt against the shore.');
      }
      return false;
    }
    boat.x = nx; boat.y = ny;
    // Bug-hunt #5 A4: re-bucket in sectors after every tile move.
    // Without these calls boat/plank/rider/cannon stayed in their
    // initial sectors → `nearbyMobiles`/`nearbyItems` missed them
    // and observers from a distance saw frozen ghosts + plank desync.
    api.world.sectors?.moveItem?.(boat);
    moveAttachedObjects(boat, dx, dy);
    for (const rs of b.riders) {
      const r = api.world.mobiles.get(rs);
      if (!r) continue;
      r.x = nx; r.y = ny;
      api.world.sectors?.moveMobile?.(r);
      broadcastMobile(r);
    }
    broadcastBoatPos(boat);
    return true;
  };

  // Per-shard boat index. Lazy-populated on first tick (walks
  // world.items once) — afterwards `placeGalleon` / boat-deed handlers
  // add to the Set, `destroyItem` removes via the items.js hook.
  // Bug-hunt #2 B4: previously every 250ms tick walked all 110k
  // world.items just to find ~10 boats. With the index that drops to
  // ~10 iterations.
  function ensureBoatIndex() {
    if (api.world._boats instanceof Set) return api.world._boats;
    const s = new Set();
    for (const it of api.world.items.values()) if (it.boat) s.add(it.serial);
    api.world._boats = s;
    return s;
  }
  const tick = () => {
    const now = Date.now();
    const idx = ensureBoatIndex();
    for (const serial of [...idx]) {
      const it = api.world.items.get(serial);
      if (!it?.boat) { idx.delete(serial); continue; }
      const b = it.boat;
      if (b.anchored || b.wrecked) continue;
      const interval = SAIL_INTERVAL_MS[b.sailState ?? 'stop'];
      if (interval <= 0) continue;
      if (now < (b.nextSailAt ?? 0)) continue;
      b.nextSailAt = now + interval;
      sailOnce(it);
    }
  };

  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();

  return {
    stop() { clearInterval(timer); },
    sailOnce,
    setSailState(boat, state) {
      if (!boat?.boat) return false;
      if (boat.boat.anchored) return false;
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
      boat.itemId = hull.graphic;
      boat.boat.hull = hullKey;
      boat.boat.boatHpMax = hull.hpMax;
      boat.boat.boatHp = hull.hpMax;
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
    /** Apply damage to a boat — returns true if the boat sank. */
    damage(boat, amount) {
      if (!boat?.boat) return false;
      boat.boat.boatHpMax ??= 1000;
      boat.boat.boatHp ??= boat.boat.boatHpMax;
      boat.boat.boatHp = Math.max(0, boat.boat.boatHp - (amount | 0));
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
    if (!l) return false;
    const tid = l.tileId | 0;
    if (tid >= 0x00A8 && tid <= 0x00AB) return true;
    if (tid >= 0x0136 && tid <= 0x0137) return true;
    return false;
  };
}
