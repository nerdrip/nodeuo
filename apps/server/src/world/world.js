// In-memory world. This is the minimum needed for Phase 2 login flow and
// Phase 3 placing a player in the world. Sectors, item containers, and
// multi-facet trees are added in Phase 4/5.

import { SerialAllocator } from './serial.js';
import { SectorIndex } from './sectors.js';
import { createItem as createWorldItem, destroyItem as destroyWorldItem } from './items.js';
import { TypedSpatialRegistry } from '../systems/runtime-governor.js';

/**
 * @typedef {Object} Point3
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} [map]
 */

/**
 * @typedef {Object} Mobile
 * @property {number} serial
 * @property {string} name
 * @property {number} body        graphic id
 * @property {number} hue
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} direction   0..7
 * @property {number} map         facet
 * @property {number} flags
 * @property {number} notoriety   1 Innocent, 2 Ally, 3 Gray, 4 Criminal, 5 Enemy, 6 Murderer, 7 Invul
 * @property {number} [hp]
 * @property {number} [hpMax]
 * @property {number} [mana]
 * @property {number} [manaMax]
 * @property {number} [stam]
 * @property {number} [stamMax]
 * @property {number} [str]
 * @property {number} [dex]
 * @property {number} [int]
 * @property {number} [gold]
 * @property {number} [sex]
 * @property {Record<number, number>} [skills]   skillId → value (0..100)
 * @property {import('../net/net-state.js').NetState | null} client  owning client, if any
 */

/**
 * @typedef {Object} Item
 * @property {number} serial
 * @property {number} itemId
 * @property {number} hue
 * @property {number} amount
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} map
 */

export class World {
  constructor() {
    // Shared, non-string brand used by script helpers to distinguish a World
    // from the full script API without probing optional capability names.
    // Symbol keys are intentionally ignored by persistence.
    this[Symbol.for('uo.world')] = true;
    this.serial = new SerialAllocator();
    /** @type {Map<number, Mobile>} */
    this.mobiles = new Map();
    /** @type {Map<number, Item>} */
    this.items = new Map();
    /** Facets whose canonical public-moongate network was reconciled during
     *  this process. Rebuilt from saved items by the moongate script. */
    this._moongatesApplied = new Set();
    /** Runtime XmlSpawner registrations are rebuilt from these durable ids on
     *  boot. Defining the sets up front also makes Script API auditing
     *  distinguish intentional world state from a misspelled capability. */
    this._xmlSpawnersApplied = new Set();
    this._treasureChestsApplied = new Set();
    /** Connected player-mobile index. Optional but authoritative once
     *  enabled by the server entrypoint; tests that mutate `mob.client`
     *  directly still fall back to scanning when the index is disabled. */
    this._onlineMobiles = new Set();
    this._onlineMobilesAuthoritative = false;
    // Reverse indexes for small mobile subsets touched by frequent timers.
    // Keeping these on every runtime World turns the normal empty case into
    // an O(0) pass rather than a scan of every NPC.
    this._pets = new Set();
    this._combatMobiles = new Set();
    this._mobsWithEffects = new Set();
    this._tickingMobiles = new Set();
    this._xmlAttachmentEntities = new Set();
    this._xmlAttachmentIndexReady = false;
    this._subscribersByChannel = new Map([['region', new Set()], ['weather', new Set()]]);
    /** Sector spatial index — populated automatically on createMobile/
     *  removeMobile and from items.js on createItem/destroyItem.
     *  Movement handlers must call `world.sectors.moveMobile(mob)` after
     *  changing mob.x/y/map. */
    this.sectors = new SectorIndex();
    /** Typed indexes for systems that previously searched every item: doors,
     * teleporters, signs, spawners and area effects. They are an internal
     * accelerator and do not alter the Ultima protocol. */
    this.spatial = new TypedSpatialRegistry();
    this._spatialTypesByItem = new Map();
    this._sectorIndexAuthoritative = false;
    this._groundItemCount = 0;
    /** Global event bus — ServUO `EventSink`. Systems publish gameplay
     *  events here (`bod:turnedIn`, `region:enter`, `player:death`, …)
     *  and listeners (achievements, region greetings, quest objective
     *  tickers) subscribe. Server parity audit #7 P1: prior to this the
     *  `deps.events?.emit` calls in `bods.js` and friends were dead.
     *  Simple lightweight pub-sub — listeners are functions; errors in
     *  one listener don't break the others. */
    /** @type {Map<string, Set<Function>>} */
    this._eventListeners = new Map();
    this.events = {
      on: (name, fn) => {
        if (typeof fn !== 'function' || !name) return () => {};
        let s = this._eventListeners.get(name);
        if (!s) { s = new Set(); this._eventListeners.set(name, s); }
        s.add(fn);
        return () => s.delete(fn);
      },
      off: (name, fn) => {
        this._eventListeners.get(name)?.delete(fn);
      },
      emit: (name, payload) => {
        const s = this._eventListeners.get(name);
        if (!s) return 0;
        let fired = 0;
        for (const fn of s) {
          try { fn(payload); fired++; }
          catch (e) { console.error(`[world.events ${name}]`, e); }
        }
        return fired;
      },
      listenerCount: (name) => this._eventListeners.get(name)?.size ?? 0,
    };
  }

  enableOnlineMobileIndex() {
    this._onlineMobilesAuthoritative = true;
    this._onlineMobiles.clear();
    for (const m of this.mobiles.values()) {
      if (m?.client) this.markMobileOnline(m);
    }
  }

  /** Mark spatial indexes authoritative after persistence/create-world has
   * finished. Until then unit fixtures that inject Map entries directly keep
   * the compatibility fallback. */
  enableSpatialIndexes() {
    this.sectors.rebuild(this);
    this.spatial = new TypedSpatialRegistry();
    this._spatialTypesByItem.clear();
    this._groundItemCount = 0;
    for (const item of this.items.values()) {
      if (!item.parent) this._groundItemCount++;
      this.syncSpatialItem(item);
    }
    this._sectorIndexAuthoritative = true;
    return this.spatial.validate();
  }

  syncSpatialItem(item) {
    if (!item?.serial) return;
    const old = this._spatialTypesByItem.get(item.serial) ?? [];
    for (const type of old) this.spatial.remove(type, item.serial);
    const types = [];
    if (!item.parent) {
      if (item.door || item.kind === 'door') types.push('door');
      if (item.teleporter || item.destination || item.linkLocation || item.kind === 'teleporter') types.push('teleporter');
      if (item.sign || item.kind === 'sign') types.push('sign');
      if (item.spawner || item.xmlSpawner || item.kind === 'spawner') types.push('spawner');
      if (item.areaEffect || item.fieldSpell || item.kind === 'area-effect') types.push('area-effect');
    }
    for (const type of types) this.spatial.add(type, item.serial, item, item);
    if (types.length) this._spatialTypesByItem.set(item.serial, types);
    else this._spatialTypesByItem.delete(item.serial);
  }

  removeSpatialItem(serial) {
    for (const type of this._spatialTypesByItem.get(serial) ?? []) this.spatial.remove(type, serial);
    this._spatialTypesByItem.delete(serial);
  }

  *spatialNear(type, position, range = 0) {
    yield* this.spatial.near(type, position, range);
  }

  markMobileOnline(mob) {
    if (!mob?.serial) return;
    this._onlineMobiles.add(mob.serial >>> 0);
    this.subscribeMobile('region', mob);
    this.subscribeMobile('weather', mob);
  }

  markMobileOffline(mobOrSerial) {
    const serial = typeof mobOrSerial === 'number'
      ? mobOrSerial >>> 0
      : mobOrSerial?.serial >>> 0;
    if (!serial) return;
    this._onlineMobiles.delete(serial);
    for (const subscribers of this._subscribersByChannel.values()) subscribers.delete(serial);
  }

  subscribeMobile(channel, mobOrSerial) {
    const serial = typeof mobOrSerial === 'number' ? mobOrSerial >>> 0 : mobOrSerial?.serial >>> 0;
    if (!serial) return () => {};
    const key = String(channel); const set = this._subscribersByChannel.get(key) ?? new Set();
    set.add(serial); this._subscribersByChannel.set(key, set);
    return () => set.delete(serial);
  }

  *subscribedMobiles(channel) {
    const set = this._subscribersByChannel.get(String(channel));
    for (const serial of set ?? []) {
      const mobile = this.mobiles.get(serial);
      if (mobile?.client) yield mobile;
      else set.delete(serial);
    }
  }

  *onlineMobiles() {
    if (this._onlineMobilesAuthoritative) {
      for (const serial of this._onlineMobiles) {
        const m = this.mobiles.get(serial);
        if (!m?.client) {
          this._onlineMobiles.delete(serial);
          continue;
        }
        yield m;
      }
      return;
    }
    for (const m of this.mobiles.values()) {
      if (m.client) yield m;
    }
  }

  /** O(1) online presence check once the explicit index is enabled. */
  hasOnlineMobiles() {
    if (this._onlineMobilesAuthoritative) {
      for (const serial of this._onlineMobiles) {
        const mob = this.mobiles.get(serial);
        if (mob?.client) return true;
        this._onlineMobiles.delete(serial);
      }
      return false;
    }
    for (const mob of this.mobiles.values()) {
      if (mob.client) return true;
    }
    return false;
  }

  /**
   * Create a new mobile and allocate its serial.
   * @param {Partial<Mobile>} data
   * @returns {Mobile}
   */
  createMobile(data) {
    const serial = this.serial.allocMobile();
    /** @type {Mobile} */
    const m = {
      serial,
      name: data.name ?? 'Nameless',
      body: data.body ?? 0x0190,        // male human
      hue:  data.hue  ?? 0,
      // Spawn at Trinsic Gate — 54 statics with **39 walls + 6 roofs**
      // (verified column-major). Britain Inn (1496, 1624) is a virtue
      // shrine with mostly small floor decorations. Trinsic gate has
      // visible city walls and roofed gatehouse — what the player
      // expects to see as a "town with buildings".
      x: data.x ?? 1825,
      y: data.y ?? 2728,
      z: data.z ?? 0,
      // Default facing = 4 (S — South). Animation .mul stores 5 unique
      // direction sets per action; for body 0x190 Idle the dirs are:
      //   0(SE)  11×30   3(W)  11×52
      //   1(S)   22×39   4(NW)  8×47   ← S is the WIDEST, most "person
      //   2(SW)  21×47                    looking at camera" pose
      // UO dir 0 (N) maps to anim dir 3 which is 11×52 back-of-head —
      // the avatar looked like a thin vertical line because they were
      // facing AWAY from the camera. Spawn south so newcomers actually
      // SEE their character.
      direction: data.direction ?? 4,
      map: data.map ?? 1,               // Trammel by default
      flags: data.flags ?? 0,
      notoriety: data.notoriety ?? 1,
      hp: data.hp ?? 50,
      hpMax: data.hpMax ?? 50,
      mana: data.mana ?? 50,
      manaMax: data.manaMax ?? 50,
      stam: data.stam ?? 50,
      stamMax: data.stamMax ?? 50,
      str: data.str ?? 50,
      dex: data.dex ?? 50,
      int: data.int ?? 50,
      gold: data.gold ?? 0,
      sex: data.sex ?? 0,
      skills: data.skills ?? {},
      client: null,
    };
    Object.defineProperty(m, '_world', {
      value: this, writable: true, configurable: true, enumerable: false,
    });
    this.mobiles.set(serial, m);
    this.sectors.addMobile(m);
    return m;
  }

  removeMobile(serial) {
    this.markMobileOffline(serial);
    this.mobiles.delete(serial);
    this.sectors.removeMobile(serial);
    this._summons?.delete?.(serial);
    this._pets?.delete?.(serial);
    this._combatMobiles?.delete?.(serial);
    this._mobsWithEffects?.delete?.(serial);
    this._tickingMobiles?.delete?.(serial);
    this._xmlAttachmentEntities?.delete?.(serial);
    // Fire registered destroy hooks — guild/party/pet/etc. cleanups
    // attach via `onMobileDestroyed`. Bug-hunt #4 A6 (guild leak).
    if (this._destroyHooks?.length) {
      for (const fn of this._destroyHooks) {
        try { fn(serial); } catch (e) { console.error('[world] destroy hook threw:', e?.message); }
      }
    }
  }

  /** Register a cleanup hook to fire when a mobile is removed. Used by
   *  guild/party/pet systems to drop stale serials from their member
   *  lists. Returns an unregister fn. */
  onMobileDestroyed(fn) {
    this._destroyHooks ||= [];
    this._destroyHooks.push(fn);
    return () => {
      const i = this._destroyHooks.indexOf(fn);
      if (i >= 0) this._destroyHooks.splice(i, 1);
    };
  }

  /** Alias used by spawner / corpse / summon-expire / admin paths.
   *  Removes the mobile AND drops its sector index entry — the previous
   *  `world.mobiles.delete()` direct calls leaked stale serials into
   *  `sectors.mobileSerialsNear` results (bug-hunt #2 A4). Idempotent. */
  destroyMobile(serial) { this.removeMobile(serial); }

  /** Public item destruction facade for scripts/tests that only hold a World.
   *  Keeps item script hooks, sector indexes, parent indexes and history in
   *  the same path as the lower-level world/items.js helper. */
  createItem(data) { return createWorldItem(this, data); }
  destroyItem(serial) { destroyWorldItem(this, serial); }
}
