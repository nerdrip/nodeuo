import { resolveStandingZ } from './world/movement.js';
import { applySpawnDirectives } from './systems/xml-spawner.js';
import { runtimeGovernor } from './systems/runtime-governor.js';
// Spawner — periodically respawn hostile mobs inside rectangular areas.
//
// Each spawn-group declares: a rect {x1,y1,x2,y2,map}, a max count, a
// respawn-delay (min/max), and a list of kinds. Kinds are resolved by
// calling a script-provided `factory(world, kind, pos) -> mob` so we stay
// decoupled from any particular monster catalog.
//
// Ticks are driven from main.js at a low rate (e.g. once per 10s). A group
// respawns one mob per due tick until it reaches its cap, then sleeps. A
// reverse mobile→group index wakes its deadline immediately on death/taming;
// the global mobile map is never scanned to discover freed slots.
//
// Extensions over the PHASE-1 baseline (mirror ServUO `Spawner.cs`):
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
 *  @property {boolean} [enabled]                     false pauses the group without deleting it
 *  @property {'stationary'|'home'|'free'} [roaming] AI roaming policy
 *  @property {{days?:number[],startHour?:number,endHour?:number}} [schedule] UTC schedule
 *  @property {{minPlayers?:number,maxPlayers?:number,region?:string}} [regionConditions]
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
    this._groupsBySector = new Map();
    this._sectorsByGroup = new Map();
    this._globalGroups = new Set();
    // Script hot-reload removes then immediately re-adds definitions. Keep
    // their live serial sets across that narrow lifecycle so a reload cannot
    // orphan the old pack and spawn a duplicate one beside it.
    this._detachedRuntime = new Map();
    // Deadline heap: with several thousand definitions the old round-robin
    // walked and allocated an array for every group every ten seconds.  A
    // min-heap lets a tick touch only groups whose deadline has elapsed.
    // Versions make rescheduling O(log n) without searching/removing an old
    // heap row; stale rows are discarded lazily and periodically compacted.
    this._dueHeap = [];
    this._dueVersions = new Map();
    this._dueSequence = 0;
    this._mobileToGroup = new Map();
    // Rebuild runtime ownership from the canonical world snapshot. The old
    // standalone spawner-persistence module was never imported, so a restart
    // forgot every live serial and immediately spawned duplicates. One O(N)
    // boot scan is cheaper and cannot drift from world persistence.
    this._restoredByGroup = new Map();
    for (const mobile of world.mobiles?.values?.() ?? []) {
      const groupId = String(mobile.spawnerId ?? '').trim();
      if (!groupId) continue;
      const serials = this._restoredByGroup.get(groupId) ?? new Set();
      serials.add(mobile.serial >>> 0);
      this._restoredByGroup.set(groupId, serials);
    }
    this._densityFactor = 1;
    this.maxGroupsPerTick = 256;
    this.diagnostics = {
      ticks: 0, groupsChecked: 0, groupsSpawned: 0, staleDeadlines: 0,
      heapCompactions: 0, releasedMobiles: 0, proximityWakeups: 0,
    };
    this._removeDestroyHook = world.onMobileDestroyed?.((serial) => this.releaseMobile(serial));
    world._spawner = this;
  }

  _heapBefore(a, b) { return a.due < b.due || (a.due === b.due && a.sequence < b.sequence); }
  _heapPush(row) {
    const heap = this._dueHeap;
    let index = heap.push(row) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this._heapBefore(row, heap[parent])) break;
      heap[index] = heap[parent]; index = parent;
    }
    heap[index] = row;
  }
  _heapPop() {
    const heap = this._dueHeap;
    if (!heap.length) return null;
    const root = heap[0];
    const last = heap.pop();
    if (heap.length) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= heap.length) break;
        const right = left + 1;
        const child = right < heap.length && this._heapBefore(heap[right], heap[left]) ? right : left;
        if (!this._heapBefore(heap[child], last)) break;
        heap[index] = heap[child]; index = child;
      }
      heap[index] = last;
    }
    return root;
  }
  _enqueue(id, due) {
    const normalized = Number.isFinite(Number(due)) ? Number(due) : Date.now();
    const version = (this._dueVersions.get(id) ?? 0) + 1;
    this._dueVersions.set(id, version);
    this._heapPush({ id, due: normalized, version, sequence: ++this._dueSequence });
  }
  _installDeadline(group, value) {
    let due = Number.isFinite(Number(value)) ? Number(value) : 0;
    Object.defineProperty(group, 'nextSpawnAt', {
      configurable: true,
      enumerable: true,
      get: () => due,
      set: (next) => {
        due = Number.isFinite(Number(next)) ? Number(next) : Date.now();
        this._enqueue(group.id, due);
      },
    });
    group.nextSpawnAt = due;
  }
  _validDeadline(row) {
    const group = this.groups.get(row?.id);
    return group && this._dueVersions.get(row.id) === row.version
      && group.nextSpawnAt === row.due ? group : null;
  }
  _compactDeadlines() {
    const limit = this.groups.size * 4 + 128;
    if (this._dueHeap.length <= limit) return;
    this._dueHeap.length = 0;
    for (const group of this.groups.values()) {
      const version = this._dueVersions.get(group.id);
      this._heapPush({ id: group.id, due: group.nextSpawnAt, version, sequence: ++this._dueSequence });
    }
    this.diagnostics.heapCompactions++;
  }

  _sectorKey(map, sx, sy) { return `${map | 0}:${sx | 0}:${sy | 0}`; }

  /** Spawn one ungrouped mobile for encounters/camps/admin scripts. */
  spawn(kind, pos) {
    if (!kind || !pos) return null;
    let mob = null;
    try { mob = this.factory(this.world, String(kind), {
      x: pos.x | 0, y: pos.y | 0, z: pos.z | 0, map: pos.map ?? 1,
    }); }
    catch (error) { console.error('[spawner] direct spawn factory threw:', error); }
    if (mob) mob.kind ??= String(kind);
    return mob;
  }

  list() { return [...this.groups.values()]; }

  setDensity(factor) {
    this._densityFactor = Math.max(0.1, Math.min(10, Number(factor) || 1));
    const now = Date.now();
    for (const group of this.groups.values()) {
      const cap = Math.max(0, Math.round((group.maxCount | 0) * this._densityFactor));
      if (group.spawnedSerials.size < cap) group.nextSpawnAt = Math.min(group.nextSpawnAt, now);
    }
    return this._densityFactor;
  }
  _unindexGroup(id) {
    for (const key of this._sectorsByGroup.get(id) ?? []) {
      const set = this._groupsBySector.get(key); set?.delete(id);
      if (set?.size === 0) this._groupsBySector.delete(key);
    }
    this._sectorsByGroup.delete(id); this._globalGroups.delete(id);
  }
  _indexGroup(g) {
    this._unindexGroup(g.id);
    const sx0 = g.rect.x1 >> 3, sy0 = g.rect.y1 >> 3, sx1 = g.rect.x2 >> 3, sy1 = g.rect.y2 >> 3;
    const count = (sx1 - sx0 + 1) * (sy1 - sy0 + 1);
    if (count > 4096) { this._globalGroups.add(g.id); return; }
    const keys = [];
    for (let sx = sx0; sx <= sx1; sx++) for (let sy = sy0; sy <= sy1; sy++) {
      const key = this._sectorKey(g.map, sx, sy); const set = this._groupsBySector.get(key) ?? new Set();
      set.add(g.id); this._groupsBySector.set(key, set); keys.push(key);
    }
    this._sectorsByGroup.set(g.id, keys);
  }

  /** @param {SpawnGroup} g */
  add(g) {
    const previous = this.groups.get(g.id);
    const detached = this._detachedRuntime.get(g.id);
    if (previous) {
      for (const serial of previous.spawnedSerials ?? []) {
        if (this._mobileToGroup.get(serial >>> 0) === g.id) this._mobileToGroup.delete(serial >>> 0);
      }
    }
    g.spawnedSerials = g.spawnedSerials ?? previous?.spawnedSerials
      ?? detached?.spawnedSerials ?? this._restoredByGroup.get(g.id) ?? new Set();
    this._restoredByGroup.delete(g.id);
    let nextSpawnAt = g.nextSpawnAt ?? previous?.nextSpawnAt ?? detached?.nextSpawnAt;
    this._detachedRuntime.delete(g.id);
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
    if (!nextSpawnAt) {
      const lo = g.respawnMs?.[0] ?? 0;
      const hi = g.respawnMs?.[1] ?? lo;
      nextSpawnAt = Date.now() + lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    }
    this.groups.set(g.id, g);
    this._installDeadline(g, nextSpawnAt);
    for (const serial of g.spawnedSerials) this._mobileToGroup.set(serial >>> 0, g.id);
    this._indexGroup(g);
    this._compactDeadlines();
    return g;
  }

  remove(id, { preserveRuntime = false, despawn = false } = {}) {
    const group = this.groups.get(id);
    if (preserveRuntime && group) {
      this._detachedRuntime.set(id, {
        spawnedSerials: group.spawnedSerials,
        nextSpawnAt: group.nextSpawnAt,
      });
    } else this._detachedRuntime.delete(id);
    this._unindexGroup(id);
    this.groups.delete(id);
    this._dueVersions.set(id, (this._dueVersions.get(id) ?? 0) + 1);
    if (!preserveRuntime && group) {
      if (despawn) {
        for (const serial of [...(group.spawnedSerials ?? [])]) {
          this._mobileToGroup.delete(serial >>> 0);
          try { this.world.destroyMobile?.(serial); }
          catch { /* already removed */ }
        }
        group.spawnedSerials?.clear?.();
      }
      for (const serial of group.spawnedSerials ?? []) {
        if (this._mobileToGroup.get(serial >>> 0) === id) this._mobileToGroup.delete(serial >>> 0);
      }
    }
  }

  /** Release a destroyed, tamed or otherwise detached mobile immediately.
   *  This keeps full groups asleep and makes refill event-driven. */
  releaseMobile(mobOrSerial) {
    const serial = (typeof mobOrSerial === 'object' ? mobOrSerial?.serial : mobOrSerial) >>> 0;
    if (!serial) return false;
    const id = this._mobileToGroup.get(serial);
    if (!id) return false;
    this._mobileToGroup.delete(serial);
    const group = this.groups.get(id);
    if (!group?.spawnedSerials?.delete(serial)) return false;
    group.nextSpawnAt = Math.min(group.nextSpawnAt || Date.now(), Date.now());
    this.diagnostics.releasedMobiles++;
    return true;
  }

  *groupsNear(map, x, y, range = 0) {
    const seen = new Set(this._globalGroups);
    const sx0 = (x - range) >> 3, sy0 = (y - range) >> 3, sx1 = (x + range) >> 3, sy1 = (y + range) >> 3;
    for (let sx = sx0; sx <= sx1; sx++) for (let sy = sy0; sy <= sy1; sy++) {
      for (const id of this._groupsBySector.get(this._sectorKey(map, sx, sy)) ?? []) seen.add(id);
    }
    for (const id of seen) { const group = this.groups.get(id); if (group) yield group; }
  }

  /** Event-driven wake-up when a player enters a new sector. Only groups
   * whose expanded rectangle contains that player are rescheduled; sleeping
   * definitions elsewhere remain untouched. */
  activateNear(center, range = 64, now = Date.now()) {
    if (!center) return 0;
    let activated = 0;
    for (const group of this.groupsNear(center.map, center.x, center.y, range)) {
      if (group.enabled === false || !(group.proximityRange > 0)) continue;
      const proximity = group.proximityRange | 0;
      if (center.x < group.rect.x1 - proximity || center.x > group.rect.x2 + proximity
          || center.y < group.rect.y1 - proximity || center.y > group.rect.y2 + proximity) continue;
      const cap = Math.max(0, Math.round((group.maxCount | 0) * this._densityFactor));
      if (group.spawnedSerials.size >= cap || group.nextSpawnAt <= now) continue;
      group.nextSpawnAt = now;
      activated++;
    }
    this.diagnostics.proximityWakeups += activated;
    return activated;
  }

  validateIndex({ repair = false } = {}) {
    const indexed = new Set([...this._groupsBySector.values()].flatMap((set) => [...set]));
    for (const id of this._globalGroups) indexed.add(id);
    const missing = [...this.groups.keys()].filter((id) => !indexed.has(id));
    const orphaned = [...indexed].filter((id) => !this.groups.has(id));
    if (repair && (missing.length || orphaned.length)) {
      this._groupsBySector.clear(); this._sectorsByGroup.clear(); this._globalGroups.clear();
      for (const group of this.groups.values()) this._indexGroup(group);
    }
    return { ok: missing.length === 0 && orphaned.length === 0, missing, orphaned, repaired: !!(repair && (missing.length || orphaned.length)) };
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
    this.despawnWhere(() => true);
    this._mobileToGroup.clear();
  }

  /** Despawn occupants of matching groups while retaining definitions. */
  despawnWhere(predicate = () => true) {
    const destroyMobile = this.world.destroyMobile?.bind(this.world);
    let groupsMatched = 0; let mobilesRemoved = 0;
    for (const group of this.groups.values()) {
      if (!predicate(group)) continue;
      groupsMatched++;
      for (const serial of [...(group.spawnedSerials ?? [])]) {
        this._mobileToGroup.delete(serial >>> 0);
        if (!destroyMobile || !this.world.mobiles?.has?.(serial >>> 0)) continue;
        try { destroyMobile(serial); mobilesRemoved++; }
        catch { /* mob may have died already — ignore */ }
      }
      group.spawnedSerials?.clear?.();
      group.nextSpawnAt = 0;
    }
    return { groupsMatched, mobilesRemoved };
  }

  /**
   * Forget all live spawn instances but retain the group definitions.
   *
   * This is the reset `[wipeworld` needs: the explicit world-population
   * gate keeps the groups dormant, while a later `[createworld` can resume
   * the complete script-owned catalogue without restarting the server.
   * Deleting the definitions here used to permanently lose non-XML groups
   * (fauna, dungeon and default wilderness spawns) for the current process.
   *
   * @param {{now?:number}} options
   * @returns {{groupsReset:number, trackedMobilesForgotten:number}}
   */
  resetRuntime({ now = Date.now() } = {}) {
    let trackedMobilesForgotten = 0;
    this._mobileToGroup.clear();
    this._restoredByGroup.clear();
    for (const group of this.groups.values()) {
      trackedMobilesForgotten += group.spawnedSerials?.size ?? 0;
      group.spawnedSerials ??= new Set();
      group.spawnedSerials.clear();
      const lo = Math.max(0, Number(group.respawnMs?.[0]) || 0);
      const hi = Math.max(lo, Number(group.respawnMs?.[1]) || lo);
      group.nextSpawnAt = now + lo
        + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
    }
    // Older WipeWorld builds cleared `groups` without clearing these maps.
    // Rebuild when necessary so the surviving definitions are authoritative.
    this.validateIndex({ repair: true });
    return { groupsReset: this.groups.size, trackedMobilesForgotten };
  }

  /**
   * Remove every runtime spawn definition and all of its secondary index
   * entries.  Calling `groups.clear()` directly only empties the canonical
   * Map; `_groupsBySector`, `_sectorsByGroup` and `_globalGroups` would keep
   * stale ids and make a later CreateWorld operate on a half-reset registry.
   *
   * @param {{despawn?: boolean}} options
   * @returns {{groupsRemoved:number, trackedMobilesRemoved:number}}
   */
  reset({ despawn = true } = {}) {
    const groupsRemoved = this.groups.size;
    let trackedMobilesRemoved = 0;
    if (despawn) {
      for (const group of this.groups.values()) {
        trackedMobilesRemoved += group.spawnedSerials?.size ?? 0;
      }
      this.clearAll();
    }
    this.groups.clear();
    this._groupsBySector.clear();
    this._sectorsByGroup.clear();
    this._globalGroups.clear();
    this._detachedRuntime.clear();
    this._restoredByGroup.clear();
    this._dueHeap.length = 0;
    this._dueVersions.clear();
    this._mobileToGroup.clear();
    return { groupsRemoved, trackedMobilesRemoved };
  }

  tick(now = Date.now()) {
    const tickStarted = performance.now();
    // Don't tick spawner until `[createworld` has finished. Bug-hunt #3
    // drobiazgi: without this gate, a respawn fires DURING the bulk
    // initial-spawn pass and produces phantom mobs that are tracked
    // by spawner but missing from the just-finalised state.
    if (this.world._createWorldDone === false) return;
    const adaptiveBudget = runtimeGovernor.budgets.spawners;
    const budget = Math.max(1, Math.min(this.maxGroupsPerTick | 0, adaptiveBudget.current | 0));
    let checked = 0;
    // A few unit/integration consumers still attach `mobile.client` directly
    // instead of calling World.markMobileOnline(). Keep their historical
    // immediate re-check semantics without penalising the real server, whose
    // authoritative online index wakes nearby groups on sector/login events.
    const compatibilityDeferred = [];
    while (checked < budget && this._dueHeap.length) {
      const deadline = this._heapPop();
      const g = this._validDeadline(deadline);
      if (!g) { this.diagnostics.staleDeadlines++; continue; }
      if (deadline.due > now) { this._heapPush(deadline); break; }
      checked++;
      // Conditions are polled only as a safety net. Player sector crossings
      // call `activateNear`, so proximity-gated groups wake immediately while
      // disabled/calendar groups do not churn at the top of the due heap.
      if (g.enabled === false || !this._scheduleActive(g, now) || !this._regionConditionsMet(g)) {
        if (this.world._onlineMobilesAuthoritative) {
          g.nextSpawnAt = now + (g.enabled === false || !this._scheduleActive(g, now) ? 60_000 : 10_000);
        } else {
          compatibilityDeferred.push(deadline);
        }
        continue;
      }
      // Cull dead/missing/escaped/tamed serials. Bug-hunt #10 #5: a
      // tamed mob keeps eating spawner slots forever (`controlMaster` set
      // → still in world.mobiles but not the spawner's responsibility).
      // Same for a mob that wandered or got `[teled` far outside the
      // group's spawn rect — let the spawner refill the wild.
      for (const serial of g.spawnedSerials) {
        const m = this.world.mobiles.get(serial);
        if (!m || m.controlMaster || (g.map != null && m.map !== g.map)) {
          g.spawnedSerials.delete(serial);
          this._mobileToGroup.delete(serial >>> 0);
        }
      }
      const effectiveMax = Math.max(0, Math.round((g.maxCount | 0) * this._densityFactor));
      if (g.spawnedSerials.size >= effectiveMax) {
        g.nextSpawnAt = now + 60_000;
        continue;
      }
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
      mob.homeRange = g.roaming === 'stationary' ? 0 : g.roaming === 'free' ? 0 : (g.homeRange ?? 10);
      mob.roaming = g.roaming ?? 'home';
      if (typeof g.team === 'number') mob.team = g.team;
      mob._xmlSpawnerEntry = entry.raw ?? entry.kind;
      g.spawnedSerials.add(mob.serial);
      this._mobileToGroup.set(mob.serial >>> 0, g.id);
      try { applySpawnDirectives(mob, { world: this.world, group: g, entry }); }
      catch (e) { console.error(`[spawner ${g.id}] xml directives threw:`, e); }
      try { g.onSpawn?.(this.world, mob, g); }
      catch (e) { console.error(`[spawner ${g.id}] onSpawn threw:`, e); }
      this.diagnostics.groupsSpawned++;
    }
    for (const deadline of compatibilityDeferred) this._heapPush(deadline);
    this._compactDeadlines();
    const tickMs = performance.now() - tickStarted;
    this.diagnostics.ticks++;
    this.diagnostics.groupsChecked += checked;
    adaptiveBudget.observe(tickMs);
    if (checked >= budget && this._dueHeap[0]?.due <= now) adaptiveBudget.noteSkipped(1);
    runtimeGovernor.watchdog.record('spawner', tickMs);
  }

  runtimeSnapshot() {
    return {
      ...this.diagnostics,
      groups: this.groups.size,
      densityFactor: this._densityFactor,
      trackedMobiles: this._mobileToGroup.size,
      scheduledDeadlines: this._dueHeap.length,
    };
  }

  dispose() {
    this._removeDestroyHook?.();
    this._removeDestroyHook = null;
    if (this.world?._spawner === this) this.world._spawner = null;
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
    if (this.world._onlineMobilesAuthoritative && sectors?.onlineCountNear) {
      return sectors.onlineCountNear(this.world, g.map, cx, cy, r) > 0;
    }
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

  _scheduleActive(g, now) {
    const schedule = g.schedule;
    if (!schedule || typeof schedule !== 'object') return true;
    const date = new Date(now);
    if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(date.getUTCDay())) return false;
    const hour = date.getUTCHours();
    const start = Math.max(0, Math.min(23, Number(schedule.startHour) || 0));
    const end = Math.max(0, Math.min(24, Number(schedule.endHour) || 24));
    if (start === end) return true;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  _regionConditionsMet(g) {
    const conditions = g.regionConditions;
    if (!conditions || typeof conditions !== 'object') return true;
    let players = 0;
    const cx = (g.rect.x1 + g.rect.x2) >> 1, cy = (g.rect.y1 + g.rect.y2) >> 1;
    const range = Math.max(g.rect.x2 - cx, g.rect.y2 - cy);
    if (this.world._onlineMobilesAuthoritative && this.world.sectors?.onlineCountNear) {
      const players = this.world.sectors.onlineCountNear(this.world, g.map, cx, cy, range, g.rect);
      const min = Math.max(0, Number(conditions.minPlayers) || 0);
      const max = Math.max(min, Number.isFinite(Number(conditions.maxPlayers)) ? Number(conditions.maxPlayers) : Number.POSITIVE_INFINITY);
      return players >= min && players <= max;
    }
    const serials = this.world.sectors?.mobileSerialsNear
      ? this.world.sectors.mobileSerialsNear(g.map, cx, cy, range)
      : this.world.mobiles.keys();
    for (const serial of serials) {
      const mobile = this.world.mobiles.get(serial);
      if (!mobile?.client || mobile.map !== g.map) continue;
      if (mobile.x < g.rect.x1 || mobile.x > g.rect.x2 || mobile.y < g.rect.y1 || mobile.y > g.rect.y2) continue;
      players++;
    }
    const min = Math.max(0, Number(conditions.minPlayers) || 0);
    const max = Math.max(min, Number.isFinite(Number(conditions.maxPlayers)) ? Number(conditions.maxPlayers) : Number.POSITIVE_INFINITY);
    return players >= min && players <= max;
  }
}
