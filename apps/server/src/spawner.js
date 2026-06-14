import { resolveStandingZ } from './world/movement.js';
import { applySpawnDirectives } from './systems/xml-spawner.js';
// Spawner — periodically respawn hostile mobs inside rectangular areas.
//
// Each spawn-group declares: a rect {x1,y1,x2,y2,map}, a max count, a
// respawn-delay (min/max), and a list of kinds. Kinds are resolved by
// calling a script-provided `factory(world, kind, pos) -> mob` so we stay
// decoupled from any particular monster catalog.
//
// Ticks are driven from main.js at a low rate (e.g. once per 10s). A group
// respawns one mob per tick until it reaches its cap, then sleeps until a
// tracked mob dies (detected by walking world.mobiles and matching the
// `group.spawnedSerials` set).
//
// Extensions over the FAZA-1 baseline (mirror ServUO `Spawner.cs`):
//   - `proximityRange`  — gate spawning on a player being within N tiles
//   - `homeRange`       — stamp spawn-home on each mob so wander AI has
//                          an anchor and won't drift across continents
//   - weighted kinds    — pass `kinds` as `[ ['rat', 4], ['lich', 1] ]`
//                          to bias the rolls
//   - `team`            — stamps a team id on every mob for shared
//                          aggression (ServUO `Mobile.Team`)
//   - `onSpawn`         — optional callback `(world, mob, group) => void`
//                          for content scripts to bless / configure /
//                          loot-stamp the freshly-spawned mob

/** @typedef {Object} SpawnGroup
 *  @property {string} id
 *  @property {number} map
 *  @property {{x1:number,y1:number,x2:number,y2:number}} rect
 *  @property {number} maxCount
 *  @property {[number, number]} respawnMs           min..max ms between respawns
 *  @property {(string | [string, number])[]} kinds   uniform OR weighted
 *  @property {number} [proximityRange]              0 = always; >0 = require player within N tiles
 *  @property {number} [homeRange]                    distance the mob may wander from its spawn point
 *  @property {number} [team]                         team id stamped on every mob (default 0)
 *  @property {(world:any, mob:any, group:SpawnGroup) => void} [onSpawn]
 *  @property {Set<number>} [spawnedSerials]          filled at runtime
 *  @property {number} [nextSpawnAt]                  ms timestamp
 */

export class Spawner {
  /**
   * @param {import('./world/world.js').World} world
   * @param {(world: import('./world/world.js').World, kind: string, pos: {x:number,y:number,z:number,map:number}) => (import('./world/world.js').Mobile|null)} factory
   */
  constructor(world, factory) {
    this.world = world;
    this.factory = factory;
    /** @type {Map<string, SpawnGroup>} */
    this.groups = new Map();
  }

  /** @param {SpawnGroup} g */
  add(g) {
    g.spawnedSerials = g.spawnedSerials ?? new Set();
    // Validate respawn bounds — bug-hunt #9 #1. A swapped `[hi, lo]` would
    // collapse to `lo` and effectively pin respawn to a single value.
    if (Array.isArray(g.respawnMs) && g.respawnMs[1] < g.respawnMs[0]) {
      console.warn(`[spawner] ${g.id}: respawnMs upper < lower; swapping.`);
      g.respawnMs = [g.respawnMs[1], g.respawnMs[0]];
    }
    // Bug-hunt #9 #1: on first add (cold boot or restart) stagger the
    // initial respawn timer so all groups don't fire on the very first
    // tick after boot — that produced a multi-thousand-mob burst when
    // every spawner was "due now". Random delay in [lo, hi] mirrors the
    // normal respawn cadence.
    if (!g.nextSpawnAt) {
      const lo = g.respawnMs?.[0] ?? 0;
      const hi = g.respawnMs?.[1] ?? lo;
      g.nextSpawnAt = Date.now() + lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    }
    this.groups.set(g.id, g);
    return g;
  }

  remove(id) {
    this.groups.delete(id);
  }

  /**
   * Force-despawn every group entry. Used by `[wipeworld` and
   * `[resetspawn`. Bug-hunt 2026-05-12 A5: the previous body only
   * cleared the tracking Set — mobs remained in `world.mobiles` as
   * zombies (spawner forgot them but they kept eating ticks and
   * counting toward `world.mobiles.size`). Caller-side `[wipeworld`
   * compensated by walking `world.mobiles` manually, but any other
   * caller (test fixtures, `/api/world/cmd resetspawn`) would leave
   * orphans behind. Now we destroy each tracked mob via the same
   * path `[del` uses so the world stays consistent.
   */
  clearAll() {
    const destroyMobile = this.world.destroyMobile?.bind(this.world);
    for (const g of this.groups.values()) {
      for (const serial of g.spawnedSerials) {
        if (destroyMobile) {
          try { destroyMobile(serial); }
          catch { /* mob may have died already — ignore */ }
        }
      }
      g.spawnedSerials.clear();
      g.nextSpawnAt = 0;
    }
  }

  tick(now = Date.now()) {
    // Don't tick spawner until `[createworld` has finished. Bug-hunt #3
    // drobiazgi: without this gate, a respawn fires DURING the bulk
    // initial-spawn pass and produces phantom mobs that are tracked
    // by spawner but missing from the just-finalised state.
    if (this.world._createWorldDone === false) return;
    for (const g of this.groups.values()) {
      // Cull dead/missing/escaped/tamed serials. Bug-hunt #10 #5: a
      // tamed mob keeps eating spawner slots forever (`controlMaster` set
      // → still in world.mobiles but not the spawner's responsibility).
      // Same for a mob that wandered or got `[teled` far outside the
      // group's spawn rect — let the spawner refill the wild.
      for (const serial of [...g.spawnedSerials]) {
        const m = this.world.mobiles.get(serial);
        if (!m) { g.spawnedSerials.delete(serial); continue; }
        if (m.controlMaster) { g.spawnedSerials.delete(serial); continue; }
        if (g.map != null && m.map !== g.map) { g.spawnedSerials.delete(serial); continue; }
      }
      if (g.spawnedSerials.size >= g.maxCount) continue;
      if (now < g.nextSpawnAt) continue;
      // Proximity gate: don't waste mobs / wake CPU when no player is
      // around. ServUO-style; defaults to "always on" when unset.
      if (g.proximityRange && g.proximityRange > 0) {
        if (!this._playerNear(g)) {
          // Re-check soon, but no faster than the lower respawn bound.
          g.nextSpawnAt = now + g.respawnMs[0];
          continue;
        }
      }
      const [lo, hi] = g.respawnMs;
      g.nextSpawnAt = now + lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
      const entry = this._pickKindEntry(g.kinds);
      const kind = entry?.kind;
      if (!kind) continue;
      const pos = this._pickPos(g.rect, g.map);
      if (!pos) continue;
      if (entry.z != null) pos.z = entry.z | 0;
      let mob;
      try { mob = this.factory(this.world, kind, pos); }
      catch (e) { console.error('[spawner] factory threw:', e); continue; }
      if (!mob) continue;
      // Stamp anchor + team so wander AI / aggro can use them.
      mob.kind ??= kind;
      mob.spawnerId = g.id;
      mob.homeX = pos.x;
      mob.homeY = pos.y;
      mob.homeZ = pos.z;
      mob.homeRange = g.homeRange ?? 10;
      if (typeof g.team === 'number') mob.team = g.team;
      mob._xmlSpawnerEntry = entry.raw ?? entry.kind;
      g.spawnedSerials.add(mob.serial);
      try { applySpawnDirectives(mob, { world: this.world, group: g, entry }); }
      catch (e) { console.error(`[spawner ${g.id}] xml directives threw:`, e); }
      try { g.onSpawn?.(this.world, mob, g); }
      catch (e) { console.error(`[spawner ${g.id}] onSpawn threw:`, e); }
    }
  }

  _pickPos(rect, map) {
    // Audit #40 P3 #18 — ServUO `Spawner.cs:574 GetSpawnPosition` retries
    // up to 10 times when the random tile fails `CanSpawnMobile`. Was:
    // we picked any (x,y), resolved standing Z, and dropped the mob
    // even when an impassable wall / closed door / static blocker sat
    // on that tile → mobs spawned on top of walls / inside crates.
    for (let attempt = 0; attempt < 10; attempt++) {
      const x = rect.x1 + Math.floor(Math.random() * (rect.x2 - rect.x1 + 1));
      const y = rect.y1 + Math.floor(Math.random() * (rect.y2 - rect.y1 + 1));
      let z = 0;
      try {
        const standZ = resolveStandingZ(map | 0, x, y, 0);
        if (Number.isFinite(standZ)) z = standZ;
      } catch { /* fall back to z=0 */ }
      const canSpawn = this.world?.canSpawnMobile;
      if (!canSpawn || canSpawn(x, y, z, map)) return { x, y, z, map };
    }
    return null;     // 10 misses — skip this tick
  }

  /**
   * Accept either `['kindA', 'kindB']` (uniform) or `[['kindA', 4], ['kindB', 1]]`
   * (weighted). Returns the chosen kind name.
   */
  _pickKind(kinds) {
    return this._pickKindEntry(kinds)?.kind ?? null;
  }

  _pickKindEntry(kinds) {
    if (!kinds || kinds.length === 0) return null;
    // Weighted form: every entry is [name, weight].
    if (Array.isArray(kinds[0])) {
      let total = 0;
      for (const [, w] of kinds) total += Math.max(0, w | 0);
      if (total <= 0) return this._normaliseKindEntry(kinds[0]);
      let roll = Math.random() * total;
      for (const entry of kinds) {
        const [, w] = entry;
        roll -= Math.max(0, w | 0);
        if (roll <= 0) return this._normaliseKindEntry(entry);
      }
      return this._normaliseKindEntry(kinds[kinds.length - 1]);
    }
    const objWeighted = kinds.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    if (objWeighted) {
      let total = 0;
      for (const entry of kinds) total += Math.max(0, entry.weight ?? entry.max ?? 1);
      let roll = Math.random() * Math.max(1, total);
      for (const entry of kinds) {
        roll -= Math.max(0, entry.weight ?? entry.max ?? 1);
        if (roll <= 0) return this._normaliseKindEntry(entry);
      }
      return this._normaliseKindEntry(kinds[kinds.length - 1]);
    }
    return this._normaliseKindEntry(kinds[Math.floor(Math.random() * kinds.length)]);
  }

  _normaliseKindEntry(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return { kind: entry, weight: 1 };
    if (Array.isArray(entry)) {
      const [kind, weight = 1, meta = null] = entry;
      if (meta && typeof meta === 'object') return { kind, weight, ...meta };
      return { kind, weight };
    }
    return { ...entry, kind: entry.kind ?? entry.name };
  }

  /**
   * True when any player-controlled mobile is within `g.proximityRange`
   * Manhattan tiles of the rectangle's centre. Manhattan keeps it cheap
   * — no sqrt — and matches how ServUO does proximity gating.
   *
   * Prefers the sector index when available: walking only the buckets
   * that overlap the range drops the inner loop from ~11.7k mobs to
   * the handful in the proximity neighbourhood. Falls back to a full
   * walk when the sector index is missing (e.g. unit tests that build
   * `world` directly without sectors wired).
   */
  _playerNear(g) {
    const cx = (g.rect.x1 + g.rect.x2) >> 1;
    const cy = (g.rect.y1 + g.rect.y2) >> 1;
    const r  = g.proximityRange | 0;
    const sectors = this.world.sectors;
    if (sectors?.mobileSerialsNear) {
      for (const serial of sectors.mobileSerialsNear(g.map, cx, cy, r)) {
        const m = this.world.mobiles.get(serial);
        if (!m || !m.client) continue;
        if (m.map !== g.map) continue;
        if (Math.abs(m.x - cx) > r) continue;
        if (Math.abs(m.y - cy) > r) continue;
        return true;
      }
      return false;
    }
    for (const m of this.world.mobiles.values()) {
      if (!m.client) continue;
      if (m.map !== g.map) continue;
      if (Math.abs(m.x - cx) > r) continue;
      if (Math.abs(m.y - cy) > r) continue;
      return true;
    }
    return false;
  }
}
