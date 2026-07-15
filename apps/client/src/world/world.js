// World — singleton client-side mirror of relevant world state. Mirrors a
// stripped-down ClassicUO Game/World.cs:
//   - the player character (serial, body, position, hue)
//   - all visible mobiles
//   - all items in range
//   - the current map id + bounds
//
// Net handlers update this; the renderer reads from it. Scenes also read
// it for camera follow / paperdoll / chat origin / etc.

// Mobile flag bits — server packs these into the `flags` byte of 0x77 /
// 0x78 / 0x20. Mirrors CUO `Game/Data/EntityFlags.cs::Flags`.
//   0x01 = Frozen (paralyzed)
//   0x02 = Female
//   0x04 = Poisoned
//   0x08 = YellowHits (invulnerable / yellow bar)
//   0x10 = IgnoreMobiles
//   0x20 = WarMode (hostile)
//   0x40 = Hidden / running (context-sensitive)
//   0x80 = WarModeAlt
export const FLAG_FROZEN     = 0x01;
export const FLAG_FEMALE     = 0x02;
export const FLAG_POISONED   = 0x04;
export const FLAG_YELLOW     = 0x08;
export const FLAG_IGN_MOBS   = 0x10;
export const FLAG_WARMODE    = 0x40;
export const FLAG_HIDDEN     = 0x80;

// Death-mobile bodies + race-body tables now live in /shared/bodies.js
// so server-side spawners, the in-game renderer, and the admin editor
// all index the same set. Reused via the `isDeadBody()` predicate
// below — keeping the local DEAD_BODIES name as a re-export so any
// downstream tooling that imports it from world.js keeps working.
import { DEAD_BODIES, isDeadBody } from '../shared/bodies.js';
export { DEAD_BODIES };

class Mobile {
  constructor(serial) {
    this.serial = serial >>> 0;
    this.name = '';
    this.body = 0;
    this.hue = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.direction = 0;
    this._flags = 0;
    this.notoriety = 1;
    /** Status booleans derived from `flags`. Kept as plain fields (vs
     *  computed getters) so renderer hot paths don't pay the lookup
     *  cost. Updated in `set flags(v)` below. */
    this.frozen   = false;
    this.poisoned = false;
    this.yellowHits = false;
    this.hidden   = false;
    this.warMode  = false;
    this.dead     = false;
    /** @type {Map<number, { itemId:number, hue:number }>} layer → equipped item info */
    this.equipment = new Map();
    this._equipmentRevision = 0;
    this._equipmentHash = 0;
    this._equipmentHashRevision = -1;
    /** @type {boolean} true when this is the local player */
    this.isPlayer = false;
    /** Movement interpolation — visual offset in screen pixels. The
     *  *logical* (x,y,z) is the destination tile (server-confirmed);
     *  these decay from `-screen_delta` (sprite at old tile) to 0
     *  (sprite at new tile) over the walk animation. Mirrors CUO
     *  Mobile.Offset.X/Y/Z (Mobile.cs:771-779). */
    this.offsetX = 0;
    this.offsetY = 0;
    this.offsetZ = 0;
    /** Lerp endpoints — when `offsetEndAt` is in the future, the
     *  renderer interpolates `offsetX/Y/Z` from `offsetStartX/Y/Z` → 0. */
    this.offsetStartX = 0;
    this.offsetStartY = 0;
    this.offsetStartZ = 0;
    this.offsetStartAt = 0;
    this.offsetEndAt = 0;
    /** Exact iso rows for depth sorting while a step is interpolated.
     *  They are kept separately from the pixel offset because offsetStartY
     *  also contains `dz * 4`; recovering an old row from that value makes
     *  a five-z stair look like a two-tile move and can draw the avatar in
     *  front of an adjacent upper wall. */
    this.moveSortStartRow = 0;
    this.moveSortEndRow = 0;
    /** Whether the currently interpolated step uses the run cadence. */
    this.moveRunning = false;
    /** Deque of pending steps for NPC multi-step movement smoothing.
     *  Server can broadcast a multi-tile MoveTo via successive 0x77; we
     *  enqueue them here so the renderer can chain lerps without snapping
     *  to each tile boundary. Mirrors CUO `Mobile.Steps` (Mobile.cs:741). */
    /** @type {{dx:number, dy:number, dz:number, run:boolean}[]} */
    this.steps = [];
    this._stepsHead = 0;
  }

  /** `Object.assign(mob, info)` from incoming.js sets `flags` directly,
   *  so we expose it as an accessor that materialises the boolean
   *  derivatives. Reading `mob.flags` returns the byte; writing it
   *  refreshes `frozen`/`poisoned`/etc. */
  get flags() { return this._flags; }
  set flags(v) {
    const f = v | 0;
    this._flags = f;
    this.frozen     = (f & FLAG_FROZEN)   !== 0;
    this.poisoned   = (f & FLAG_POISONED) !== 0;
    this.yellowHits = (f & FLAG_YELLOW)   !== 0;
    this.warMode    = (f & FLAG_WARMODE)  !== 0;
    this.hidden     = (f & FLAG_HIDDEN)   !== 0;
  }

  /** True when this mobile's body indicates a death-ghost form. */
  get isDead() { return this.dead || isDeadBody(this.body); }

  /** Has a Layer.Mount item equipped (CUO Layer enum 25). Renderer
   *  uses this to swap the human "Walk" sprite for the mounted variant. */
  get isMounted() { return this.equipment?.has?.(25) ?? false; }
  /** The mount's body graphic, when riding. */
  get mountBody() { return this.equipment?.get?.(25)?.itemId ?? 0; }
  /** Hidden = anim 50% alpha + footstep silence. */
  get isHidden() { return this.hidden; }

  /** Begin a "just stepped from `(x-dx, y-dy, z-dz)` to here" visual
   *  slide. `durationMs` is typically 200 (walk) or 100 (run).
   *
   *  When a previous step is still lerping, ACCUMULATE the new delta
   *  on top of whatever offset is currently visible — without this,
   *  every subsequent predicted step yanked the sprite back to
   *  `(-dx*22, -dy*22)` of the new tile, producing the visible
   *  staccato during continuous walking. We start the new lerp from
   *  `currentOffset + newDelta` so the sprite stays geometrically
   *  on the path with no snapping. */
  beginMoveStep(dx, dy, dz, durationMs, now, running = durationMs <= 250,
                sortStartRow = null, sortEndRow = null) {
    const sx = (dx - dy) * 22;
    const sy = (dx + dy) * 22 - dz * 4;
    const inFlight = this.offsetEndAt > now;
    // Residual offsets from the prior step (already in screen-pixel
    // space). When idle they're zero so this collapses to the simple
    // `start = -delta` form.
    const residX = inFlight ? this.offsetX : 0;
    const residY = inFlight ? this.offsetY : 0;
    const residZ = inFlight ? this.offsetZ : 0;
    this.offsetStartX = residX - sx;
    this.offsetStartY = residY - sy;
    this.offsetStartZ = residZ;
    this.offsetX = this.offsetStartX;
    this.offsetY = this.offsetStartY;
    this.offsetZ = this.offsetStartZ;
    this.offsetStartAt = now;
    this.offsetEndAt = now + durationMs;
    this.moveRunning = !!running;
    const logicalEndRow = Number.isFinite(sortEndRow)
      ? Number(sortEndRow)
      : ((this.x | 0) + (this.y | 0));
    this.moveSortEndRow = logicalEndRow;
    this.moveSortStartRow = Number.isFinite(sortStartRow)
      ? Number(sortStartRow)
      : logicalEndRow - (dx | 0) - (dy | 0);
  }

  /** Append a step to the deque. Called from the 0x77 handler when the
   *  current lerp is still in flight — chains the next step onto the
   *  end so the sprite walks continuously instead of snapping.
   *  `dir` (0..7) carries the facing for that step so a multi-step
   *  path with mid-route turns rotates the sprite in sync with each
   *  segment instead of holding the original facing. */
  enqueueStep(dx, dy, dz, run, dir) {
    if (this.queuedStepCount >= 5) {
      // CUO MAX_STEP_COUNT cap. Drop the oldest pending step rather than
      // snapping (the sprite is already past it visually anyway).
      this._stepsHead += 1;
    }
    // Incoming packets update logical x/y before queuing. Preserve the row
    // belonging to this particular packet; by the time it is drained the
    // mobile may already hold coordinates from a later queued packet.
    const sortEndRow = (this.x | 0) + (this.y | 0);
    this.steps.push({
      dx, dy, dz, run: !!run, dir: (dir | 0) & 7,
      sortStartRow: sortEndRow - (dx | 0) - (dy | 0),
      sortEndRow,
    });
    this._compactSteps();
  }

  get queuedStepCount() {
    const count = this.steps.length - this._stepsHead;
    return count > 0 ? count : 0;
  }

  /** True only while a real tile transition is being interpolated/queued.
   * A 0x77 facing-only update must not start a walk animation. */
  hasActiveMoveStep(now = performance.now()) {
    return this.offsetEndAt > now || this.queuedStepCount > 0;
  }

  clearSteps() {
    this.steps.length = 0;
    this._stepsHead = 0;
  }

  _compactSteps() {
    if (this._stepsHead <= 0) return;
    if (this._stepsHead >= this.steps.length) {
      this.clearSteps();
      return;
    }
    if (this._stepsHead > 8 && this._stepsHead * 2 > this.steps.length) {
      this.steps.splice(0, this._stepsHead);
      this._stepsHead = 0;
    }
  }

  /** When a step finishes (offsetEndAt elapses) the renderer pulls the
   *  next pending step and starts a fresh lerp. Returns true if a new
   *  step was started. Updates `direction` on dequeue so the sprite
   *  faces the segment it's currently walking (CUO ProcessSteps). */
  drainNextStep(now) {
    if (this.offsetEndAt > now) return false;
    const next = this.steps[this._stepsHead++];
    this._compactSteps();
    if (!next) return false;
    if (typeof next.dir === 'number') this.direction = next.dir;
    const durationMs = this.isMounted
      ? (next.run ? 100 : 200)
      : (next.run ? 200 : 400);
    this.beginMoveStep(
      next.dx, next.dy, next.dz, durationMs, now, next.run,
      next.sortStartRow, next.sortEndRow,
    );
    return true;
  }

  /** Per-frame lerp toward zero. Returns true while still animating.
   *
   *  LINEAR interpolation for continuous walking — the previous ease-out
   *  cubic (k = inv³) produced visible "skok" bursts: every step started
   *  at full speed and slowed to a crawl at the end, then the next step
   *  whip-cracked back to full speed. With key-held continuous motion
   *  the deceleration on each tile read as stuttering.
   *
   *  We keep a small ease-out only on the FINAL step (no more pending
   *  inputs) so the avatar still decelerates gracefully when the
   *  player releases the key. Detection is lazy — `tickMoveStep` can't
   *  see the queue, so we expose `isFinalStep` flag set by the
   *  movement layer (`game-scene._sendMove`) when no held key follows.
   */
  tickMoveStep(now) {
    if (this.offsetEndAt <= 0) {
      this.moveRunning = false;
      this.moveSortStartRow = this.moveSortEndRow = (this.x | 0) + (this.y | 0);
      return false;
    }
    if (now >= this.offsetEndAt) {
      this.offsetX = this.offsetY = this.offsetZ = 0;
      this.offsetStartAt = this.offsetEndAt = 0;
      this.moveRunning = false;
      this.moveSortStartRow = this.moveSortEndRow = (this.x | 0) + (this.y | 0);
      return false;
    }
    const dur = this.offsetEndAt - this.offsetStartAt;
    const t = (now - this.offsetStartAt) / dur;
    // k = residual fraction. 1 at t=0 → at start tile; 0 at t=1 → at
    // destination. Linear keeps sprite speed constant during sustained
    // walking.
    const k = 1 - t;
    this.offsetX = this.offsetStartX * k;
    this.offsetY = this.offsetStartY * k;
    this.offsetZ = this.offsetStartZ * k;
    return true;
  }
}

class Item {
  constructor(serial) {
    this.serial = serial >>> 0;
    this.itemId = 0;
    this.hue = 0;
    this.amount = 1;
    this.x = 0; this.y = 0; this.z = 0;
    this.direction = 0;
    this.layer = 0;
    /** parent serial (0 = world) */
    this.parent = 0;
    /** when set, this Item is the origin of a multi (house/boat) and
     *  `multiId` indexes into `assets.multis`. */
    this.multiId = 0;
  }
}

export class World {
  constructor() {
    /** @type {Mobile | null} */
    this.player = null;
    /** @type {Map<number, Mobile>} */
    this.mobiles = new Map();
    /** @type {Map<number, Item>} */
    this.items = new Map();
    this.mapId = 1;
    this.mapWidth = 6144;
    this.mapHeight = 4096;
    this.lightLevel = 0;
    this.lastLightPacketAt = 0;
    this.season = 1;
    this.playerIndoors = false;
    this.lastRegionKind = null;
    /** Ctrl+Q toggle — when true, walls fade near the player so the
     *  avatar isn't hidden behind tall structures. CUO `Constants.cs`
     *  GAME_OPTIONS_CIRCLE_OF_TRANSPARENCY. */
    this.transparentWalls = false;
    /** monotonically increasing seq counter for outgoing 0x02. ServUO+CUO
     * convention: first packet after login is 0; subsequent values rotate
     * 1..255 (0 reserved for re-init). */
    this.moveSequence = 0;
    /** Reverse index: equipped-item serial → { mob, layer }. Lets
     *  removeEntity detach a freshly-removed wearable in O(1) instead
     *  of walking every mobile × every equipment entry. The walk was a
     *  per-TP freeze contributor — a refresh that brought 30 entity:removed
     *  events did 30 × 200 mobiles × ~10 worn = 60k sync ops on the
     *  renderer thread. Build via equipOnMobile / unequipFromMobile. */
    /** @type {Map<number, { mob: Mobile, layer: number }>} */
    this._equipIndex = new Map();
    /** Reverse index parentSerial → Set<itemSerial>. Lets container
     *  gumps + macros + drag-drop find "all items inside container X"
     *  in O(1) instead of walking world.items.values() every refresh.
     *  Maintained by `linkItemParent` / `unlinkItemParent` — call them
     *  from net handlers whenever an item's parent changes. */
    /** @type {Map<number, Set<number>>} */
    this._itemsByParent = new Map();
    this._spatialRevision = 0;
    this._mobileSpatialRevision = 0;
    this._itemSpatialRevision = 0;
    this._mobilesAtCache = new Map();
    this._itemsAtCache = new Map();
    this._spatialBatchDepth = 0;
    this._spatialBatchKind = '';
    this._spatialBatchClear = false;
    this._descendantScratch = { seen: new Set(), stack: [] };
    this._descendantScratchBusy = false;
  }

  _bumpSpatialRevision(kind = 'all', { clear = false } = {}) {
    if (this._spatialBatchDepth > 0) {
      this._spatialBatchKind = this._mergeSpatialKind(this._spatialBatchKind, kind);
      this._spatialBatchClear = this._spatialBatchClear || !!clear;
      return;
    }
    this._applySpatialRevision(kind, { clear });
  }

  _mergeSpatialKind(a = '', b = 'all') {
    if (a === 'all' || b === 'all') return 'all';
    if (!a) return b;
    if (!b || a === b) return a;
    return 'all';
  }

  _applySpatialRevision(kind = 'all', { clear = false } = {}) {
    this._spatialRevision = (this._spatialRevision + 1) >>> 0;
    if (kind === 'all' || kind === 'mobile') {
      this._mobileSpatialRevision = (this._mobileSpatialRevision + 1) >>> 0;
      if (clear) this._mobilesAtCache.clear();
    }
    if (kind === 'all' || kind === 'item') {
      this._itemSpatialRevision = (this._itemSpatialRevision + 1) >>> 0;
      if (clear) this._itemsAtCache.clear();
    }
  }

  batchSpatialMutations(fn) {
    this._spatialBatchDepth++;
    try {
      return fn();
    } finally {
      this._spatialBatchDepth--;
      if (this._spatialBatchDepth === 0 && this._spatialBatchKind) {
        const kind = this._spatialBatchKind;
        const clear = this._spatialBatchClear;
        this._spatialBatchKind = '';
        this._spatialBatchClear = false;
        this._applySpatialRevision(kind, { clear });
      }
    }
  }

  _rememberSpatialQuery(cache, key, items, revision) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, { revision, items });
    const MAX_SPATIAL_QUERY_CACHE = 128;
    while (cache.size > MAX_SPATIAL_QUERY_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  _spatialQueryKey(cx, cy, map, radius, flag = 0) {
    // Exact numeric key, no string allocation in render hot paths.
    // x/y fit UO maps' 16-bit tile coords; map/radius/flag stay in the
    // high bits under JS's 53-bit integer precision limit.
    return ((cx & 0xffff)
      + (cy & 0xffff) * 0x10000
      + (map & 0xff) * 0x100000000
      + (radius & 0xff) * 0x10000000000
      + (flag & 0xff) * 0x1000000000000);
  }

  /** Reset all world state. Called on disconnect / scene swap to login. */
  reset() {
    this._resetting = true;
    this._resetEpoch = ((this._resetEpoch | 0) + 1) >>> 0;
    Object.assign(this, {
      player: null,
      lightLevel: 0,
      lastLightPacketAt: 0,
      season: 1,
      playerIndoors: false,
      lastRegionKind: null,
      mobiles: new Map(),
      items: new Map(),
      _equipIndex: new Map(),
      _itemsByParent: new Map(),
      _mobsBySector: new Map(),
      _itemsBySector: new Map(),
    });
    this._spatialDirty = true;
    this._bumpSpatialRevision('all', { clear: true });
    this.moveSequence = 0;
    this._resetting = false;
    return this._resetEpoch;
  }

  /** Commit an authoritative container snapshot in one synchronous batch.
   * All rows are validated before the live indexes are touched. */
  replaceContainerContents(containerSerial, rows = []) {
    const parent = containerSerial >>> 0;
    if (!parent) return { ok: false, reason: 'invalid-parent', items: [] };
    const staged = [];
    const serials = new Set();
    for (const row of rows) {
      const serial = row?.serial >>> 0;
      if (!serial || serials.has(serial)) return { ok: false, reason: 'duplicate-or-invalid-serial', items: [] };
      serials.add(serial);
      staged.push({
        ...row, serial, parent, itemId: row.itemId | 0, amount: Math.max(1, row.amount | 0),
        hue: row.hue | 0, gridX: row.gridX | 0, gridY: row.gridY | 0,
      });
    }
    this.batchSpatialMutations(() => {
      const previous = new Set(this._itemsByParent.get(parent) ?? []);
      for (const data of staged) {
        let item = this.items.get(data.serial);
        if (!item) { item = new Item(data.serial); this.items.set(data.serial, item); }
        const oldParent = item.parent >>> 0;
        const oldX = item.x; const oldY = item.y; const oldMap = item.map ?? this.mapId;
        Object.assign(item, data);
        this.linkItemParent(item, oldParent);
        this.reindexItem(item, oldX, oldY, oldMap, oldParent);
        previous.delete(data.serial);
      }
      for (const serial of previous) {
        const item = this.items.get(serial);
        if (!item || (item.parent >>> 0) !== parent) continue;
        this.unlinkItemParent(item);
        this.items.delete(serial);
      }
      this._bumpSpatialRevision('item');
    });
    const integrity = this.validateGraph({ repair: true });
    return { ok: integrity.ok, items: staged, integrity };
  }

  /** Swap every equipment layer at once. The renderer observes either the
   * previous Map or the complete replacement, never a half-cleared paperdoll. */
  replaceEquipment(mob, rows = []) {
    if (!mob) return { ok: false, reason: 'missing-mobile' };
    const next = new Map();
    for (const row of rows) {
      const serial = row?.serial >>> 0; const layer = row?.layer | 0;
      if (!serial || layer <= 0 || next.has(layer)) return { ok: false, reason: 'invalid-or-duplicate-layer' };
      next.set(layer, { ...row, serial, layer, itemId: row.itemId | 0, hue: row.hue | 0 });
    }
    this.batchSpatialMutations(() => {
      const nextSerials = new Set([...next.values()].map((entry) => entry.serial >>> 0));
      for (const old of mob.equipment?.values?.() ?? []) {
        const oldSerial = old.serial >>> 0;
        this._equipIndex.delete(oldSerial);
        if (nextSerials.has(oldSerial)) continue;
        const staleItem = this.items.get(oldSerial);
        if (staleItem && (staleItem.parent >>> 0) === (mob.serial >>> 0)) {
          this.unlinkItemParent(staleItem);
          this.items.delete(oldSerial);
        }
      }
      mob.equipment = next;
      for (const [layer, eq] of next) {
        this._equipIndex.set(eq.serial, { mob, layer });
        let item = this.items.get(eq.serial);
        if (!item) { item = new Item(eq.serial); this.items.set(eq.serial, item); }
        const oldParent = item.parent >>> 0;
        const oldX = item.x; const oldY = item.y; const oldMap = item.map ?? this.mapId;
        Object.assign(item, { itemId: eq.itemId, hue: eq.hue, layer, parent: mob.serial });
        this.linkItemParent(item, oldParent);
        this.reindexItem(item, oldX, oldY, oldMap, oldParent);
      }
      mob._equipmentRevision = ((mob._equipmentRevision | 0) + 1) >>> 0;
      mob._equipmentHashRevision = -1;
    });
    const integrity = this.validateGraph({ repair: true });
    return { ok: integrity.ok, equipment: next, integrity };
  }

  /** Verify the three live relationships used by containers and paperdolls.
   * Repair is intentionally deterministic and only rebuilds indexes. */
  validateGraph({ repair = false } = {}) {
    const issues = [];
    const expectedParents = new Map();
    for (const item of this.items.values()) {
      if (!item || (item.serial >>> 0) === 0) { issues.push({ type: 'invalid-item' }); continue; }
      const parent = item.parent >>> 0;
      if (!parent) continue;
      let set = expectedParents.get(parent);
      if (!set) { set = new Set(); expectedParents.set(parent, set); }
      set.add(item.serial >>> 0);
    }
    for (const [parent, expected] of expectedParents) {
      const actual = this._itemsByParent.get(parent);
      for (const serial of expected) if (!actual?.has(serial)) issues.push({ type: 'missing-parent-index', parent, serial });
    }
    for (const [parent, actual] of this._itemsByParent) {
      for (const serial of actual ?? []) {
        const item = this.items.get(serial >>> 0);
        if (!item || (item.parent >>> 0) !== (parent >>> 0)) issues.push({ type: 'stale-parent-index', parent, serial });
      }
    }
    for (const mob of this.mobiles.values()) {
      for (const [layer, eq] of mob.equipment ?? []) {
        const serial = eq?.serial >>> 0;
        const slot = this._equipIndex.get(serial);
        if (!serial || slot?.mob !== mob || (slot?.layer | 0) !== (layer | 0)) issues.push({ type: 'missing-equipment-index', serial, layer });
        const item = this.items.get(serial);
        if (!item || (item.parent >>> 0) !== (mob.serial >>> 0) || (item.layer | 0) !== (layer | 0)) issues.push({ type: 'equipment-item-mismatch', serial, layer });
      }
    }
    for (const [serial, slot] of this._equipIndex) {
      if ((slot?.mob?.equipment?.get?.(slot.layer)?.serial >>> 0) !== (serial >>> 0)) {
        issues.push({ type: 'stale-equipment-index', serial, layer: slot?.layer });
      }
    }
    if (repair && issues.length) {
      this._itemsByParent = expectedParents;
      this._equipIndex = new Map();
      for (const mob of this.mobiles.values()) {
        for (const [layer, eq] of mob.equipment ?? []) this._equipIndex.set(eq.serial >>> 0, { mob, layer });
      }
    }
    const repaired = !!repair && issues.length > 0;
    return { ok: issues.length === 0 || repaired, issues, repaired };
  }

  /** Update the parent-child reverse index when an item's parent is
   *  set or changes. `oldParent` may be undefined for a fresh item. */
  linkItemParent(item, oldParent) {
    if (!item) return;
    const newParent = (item.parent ?? 0) >>> 0;
    const oldP = (oldParent ?? 0) >>> 0;
    if (oldP === newParent) return;
    if (oldP) {
      const set = this._itemsByParent.get(oldP);
      if (set) {
        set.delete(item.serial >>> 0);
        if (set.size === 0) this._itemsByParent.delete(oldP);
      }
    }
    if (newParent) {
      let set = this._itemsByParent.get(newParent);
      if (!set) { set = new Set(); this._itemsByParent.set(newParent, set); }
      set.add(item.serial >>> 0);
    }
  }

  /** Drop an item from the parent index entirely (on remove). */
  unlinkItemParent(item) {
    if (!item) return;
    const p = (item.parent ?? 0) >>> 0;
    if (!p) return;
    const set = this._itemsByParent.get(p);
    if (!set) return;
    set.delete(item.serial >>> 0);
    if (set.size === 0) this._itemsByParent.delete(p);
  }

  /** Iterator over child items of a given container/mob serial. O(N)
   *  in *only* the children, not the full world.items. */
  *childrenOf(parentSerial) {
    const set = this._itemsByParent.get((parentSerial ?? 0) >>> 0);
    if (!set) return;
    for (const s of set) {
      const it = this.items.get(s);
      if (it) yield it;
    }
  }

  /** Depth-first iterator over every nested child under a container or
   *  mobile serial. Used by backpack counters/macros so pouches do not
   *  force full `world.items` scans. */
  *descendantsOf(parentSerial) {
    const root = (parentSerial ?? 0) >>> 0;
    if (!root) return;
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) {
      const parent = stack.pop();
      for (const it of this.childrenOf(parent)) {
        const serial = it.serial >>> 0;
        if (seen.has(serial)) continue;
        seen.add(serial);
        yield it;
        stack.push(serial);
      }
    }
  }

  /** Callback-based descendant walk for hot paths. Avoids generator,
   *  iterator, and transient Set/Array churn when counters/macros scan
   *  backpack trees repeatedly. Return false from `fn` to stop early. */
  forEachDescendant(parentSerial, fn) {
    const root = (parentSerial ?? 0) >>> 0;
    if (!root || typeof fn !== 'function') return 0;
    const reuse = !this._descendantScratchBusy;
    const scratch = reuse ? this._descendantScratch : { seen: new Set(), stack: [] };
    const { seen, stack } = scratch;
    seen.clear();
    stack.length = 0;
    seen.add(root);
    stack.push(root);
    if (reuse) this._descendantScratchBusy = true;
    let visited = 0;
    try {
      while (stack.length) {
        const parent = stack.pop();
        const set = this._itemsByParent.get(parent);
        if (!set) continue;
        for (const s of set) {
          const serial = s >>> 0;
          if (seen.has(serial)) continue;
          seen.add(serial);
          const it = this.items.get(serial);
          if (!it) continue;
          visited++;
          if (fn(it) === false) return visited;
          stack.push(serial);
        }
      }
      return visited;
    } finally {
      if (reuse) {
        seen.clear();
        stack.length = 0;
        this._descendantScratchBusy = false;
      }
    }
  }

  /** Sector-bucket lookup for "what mobs/items sit on or near tile
   *  (x, y) on `mapId`". Sector is 8×8 tiles (matches CUO + server
   *  sectorization). Tested up to a 5-tile radius (hit-test path);
   *  larger radii fall back to a full walk because the bucket walk
   *  cost outgrows the linear scan past ~12 sectors.
   *
   *  Index is built lazily on first call after a mobile/item moves;
   *  consumers re-call `_resyncSpatial()` if they need a fresh view
   *  before the next ambient resync (every 1s in game-scene tick). */
  _spatialDirty = true;
  _mobsBySector = new Map();   // sectorKey → Set<mobSerial>
  _itemsBySector = new Map();  // sectorKey → Set<itemSerial>

  _sectorKey(x, y, map) {
    const sx = (x | 0) >> 3, sy = (y | 0) >> 3;
    return ((map | 0) << 22) | ((sy & 0x7FF) << 11) | (sx & 0x7FF);
  }

  _deleteSectorEntry(index, serial, x, y, map) {
    if (this._spatialDirty) return;
    const key = this._sectorKey(x, y, map ?? 1);
    const set = index.get(key);
    if (!set) return;
    set.delete(serial >>> 0);
    if (set.size === 0) index.delete(key);
  }

  _moveSectorEntry(index, serial, oldX, oldY, oldMap, newX, newY, newMap) {
    if (this._spatialDirty) return;
    const oldKey = this._sectorKey(oldX, oldY, oldMap ?? 1);
    const newKey = this._sectorKey(newX, newY, newMap ?? 1);
    if (oldKey === newKey) return;
    const oldSet = index.get(oldKey);
    if (oldSet) {
      oldSet.delete(serial >>> 0);
      if (oldSet.size === 0) index.delete(oldKey);
    }
    let newSet = index.get(newKey);
    if (!newSet) { newSet = new Set(); index.set(newKey, newSet); }
    newSet.add(serial >>> 0);
  }

  reindexMobile(mob, oldX, oldY, oldMap) {
    if (!mob || this._spatialDirty) return;
    this._moveSectorEntry(
      this._mobsBySector,
      mob.serial,
      oldX, oldY, oldMap ?? mob.map ?? 1,
      mob.x, mob.y, mob.map ?? 1,
    );
    this._bumpSpatialRevision('mobile');
  }

  reindexItem(item, oldX, oldY, oldMap, oldParent = item?.parent ?? 0) {
    if (!item || this._spatialDirty) return;
    const serial = item.serial >>> 0;
    const wasWorld = !oldParent;
    const isWorld = !item.parent;
    if (!wasWorld && !isWorld) return;
    if (wasWorld && !isWorld) {
      const oldKey = this._sectorKey(oldX, oldY, oldMap ?? item.map ?? 1);
      const set = this._itemsBySector.get(oldKey);
      if (set) {
        set.delete(serial);
        if (set.size === 0) this._itemsBySector.delete(oldKey);
      }
      this._bumpSpatialRevision('item');
      return;
    }
    if (!wasWorld && isWorld) {
      const key = this._sectorKey(item.x, item.y, item.map ?? 1);
      let set = this._itemsBySector.get(key);
      if (!set) { set = new Set(); this._itemsBySector.set(key, set); }
      set.add(serial);
      this._bumpSpatialRevision('item');
      return;
    }
    this._moveSectorEntry(
      this._itemsBySector,
      serial,
      oldX, oldY, oldMap ?? item.map ?? 1,
      item.x, item.y, item.map ?? 1,
    );
    this._bumpSpatialRevision('item');
  }

  _resyncSpatial() {
    this._mobsBySector.clear();
    this._itemsBySector.clear();
    for (const m of this.mobiles.values()) {
      const k = this._sectorKey(m.x, m.y, m.map ?? 1);
      let set = this._mobsBySector.get(k);
      if (!set) { set = new Set(); this._mobsBySector.set(k, set); }
      set.add(m.serial >>> 0);
    }
    for (const it of this.items.values()) {
      if (it.parent) continue;       // contained items aren't on the world tile
      const k = this._sectorKey(it.x, it.y, it.map ?? 1);
      let set = this._itemsBySector.get(k);
      if (!set) { set = new Set(); this._itemsBySector.set(k, set); }
      set.add(it.serial >>> 0);
    }
    this._spatialDirty = false;
    this._bumpSpatialRevision('all');
  }

  /** Return a cached array of mobs within `radius` tiles of (cx, cy).
   *  Hot render paths use this to avoid generator overhead while the
   *  public `mobilesAt()` iterator below stays source-compatible. */
  mobilesNear(cx, cy, map = 1, radius = 5, includeGhosts = false) {
    if (this._spatialDirty) this._resyncSpatial();
    cx |= 0; cy |= 0; map |= 0; radius |= 0;
    const key = this._spatialQueryKey(cx, cy, map, radius, includeGhosts ? 1 : 0);
    const cached = this._mobilesAtCache.get(key);
    if (cached?.revision === this._mobileSpatialRevision) return cached.items;
    const out = [];
    const sxLo = ((cx - radius) | 0) >> 3;
    const sxHi = ((cx + radius) | 0) >> 3;
    const syLo = ((cy - radius) | 0) >> 3;
    const syHi = ((cy + radius) | 0) >> 3;
    const sectorCount = (sxHi - sxLo + 1) * (syHi - syLo + 1);
    if (sectorCount > this.mobiles.size) {
      for (const m of this.mobiles.values()) {
        if ((m.map ?? 1) !== (map | 0)) continue;
        if (!includeGhosts && m.ghost) continue;
        if (Math.abs(m.x - cx) > radius) continue;
        if (Math.abs(m.y - cy) > radius) continue;
        out.push(m);
      }
      this._rememberSpatialQuery(this._mobilesAtCache, key, out, this._mobileSpatialRevision);
      return out;
    }
    for (let sy = syLo; sy <= syHi; sy++) {
      for (let sx = sxLo; sx <= sxHi; sx++) {
        const k = ((map | 0) << 22) | ((sy & 0x7FF) << 11) | (sx & 0x7FF);
        const set = this._mobsBySector.get(k);
        if (!set) continue;
        for (const s of set) {
          const m = this.mobiles.get(s);
          if (!m) continue;
          if (!includeGhosts && m.ghost) continue;
          if (Math.abs(m.x - cx) > radius) continue;
          if (Math.abs(m.y - cy) > radius) continue;
          out.push(m);
        }
      }
    }
    this._rememberSpatialQuery(this._mobilesAtCache, key, out, this._mobileSpatialRevision);
    return out;
  }

  /** Yield every mob within `radius` tiles of (cx, cy) on `map`.
   *  Caller passes the radius in tiles; we widen to cover sectors.
   *  Skips ghosts unless `includeGhosts` is true. */
  *mobilesAt(cx, cy, map = 1, radius = 5, includeGhosts = false) {
    yield* this.mobilesNear(cx, cy, map, radius, includeGhosts);
  }

  /** Callback version of `mobilesNear` for one-off scans. */
  forEachMobileNear(cx, cy, map = 1, radius = 5, includeGhosts = false, fn) {
    if (this._spatialDirty) this._resyncSpatial();
    if (typeof fn !== 'function') return 0;
    cx |= 0; cy |= 0; map |= 0; radius |= 0;
    const sxLo = ((cx - radius) | 0) >> 3;
    const sxHi = ((cx + radius) | 0) >> 3;
    const syLo = ((cy - radius) | 0) >> 3;
    const syHi = ((cy + radius) | 0) >> 3;
    const sectorCount = (sxHi - sxLo + 1) * (syHi - syLo + 1);
    let visited = 0;
    if (sectorCount > this.mobiles.size) {
      for (const m of this.mobiles.values()) {
        if ((m.map ?? 1) !== map) continue;
        if (!includeGhosts && m.ghost) continue;
        if (Math.abs(m.x - cx) > radius) continue;
        if (Math.abs(m.y - cy) > radius) continue;
        visited++;
        if (fn(m) === false) return visited;
      }
      return visited;
    }
    for (let sy = syLo; sy <= syHi; sy++) {
      for (let sx = sxLo; sx <= sxHi; sx++) {
        const k = ((map | 0) << 22) | ((sy & 0x7FF) << 11) | (sx & 0x7FF);
        const set = this._mobsBySector.get(k);
        if (!set) continue;
        for (const s of set) {
          const m = this.mobiles.get(s);
          if (!m) continue;
          if (!includeGhosts && m.ghost) continue;
          if (Math.abs(m.x - cx) > radius) continue;
          if (Math.abs(m.y - cy) > radius) continue;
          visited++;
          if (fn(m) === false) return visited;
        }
      }
    }
    return visited;
  }

  /** Return a cached array of world-items (parent === 0) nearby. */
  itemsNear(cx, cy, map = 1, radius = 5) {
    if (this._spatialDirty) this._resyncSpatial();
    cx |= 0; cy |= 0; map |= 0; radius |= 0;
    const key = this._spatialQueryKey(cx, cy, map, radius, 0);
    const cached = this._itemsAtCache.get(key);
    if (cached?.revision === this._itemSpatialRevision) return cached.items;
    const out = [];
    const sxLo = ((cx - radius) | 0) >> 3;
    const sxHi = ((cx + radius) | 0) >> 3;
    const syLo = ((cy - radius) | 0) >> 3;
    const syHi = ((cy + radius) | 0) >> 3;
    const sectorCount = (sxHi - sxLo + 1) * (syHi - syLo + 1);
    if (sectorCount > this.items.size) {
      for (const it of this.items.values()) {
        if (it.parent) continue;
        if ((it.map ?? 1) !== (map | 0)) continue;
        if (Math.abs(it.x - cx) > radius) continue;
        if (Math.abs(it.y - cy) > radius) continue;
        out.push(it);
      }
      this._rememberSpatialQuery(this._itemsAtCache, key, out, this._itemSpatialRevision);
      return out;
    }
    for (let sy = syLo; sy <= syHi; sy++) {
      for (let sx = sxLo; sx <= sxHi; sx++) {
        const k = ((map | 0) << 22) | ((sy & 0x7FF) << 11) | (sx & 0x7FF);
        const set = this._itemsBySector.get(k);
        if (!set) continue;
        for (const s of set) {
          const it = this.items.get(s);
          if (!it) continue;
          if (Math.abs(it.x - cx) > radius) continue;
          if (Math.abs(it.y - cy) > radius) continue;
          out.push(it);
        }
      }
    }
    this._rememberSpatialQuery(this._itemsAtCache, key, out, this._itemSpatialRevision);
    return out;
  }

  /** Callback version of `itemsNear` for hit-tests that only need to
   *  inspect results once. Avoids allocating/caching a result array for
   *  many one-off radius-0 queries, e.g. multi placement checks. */
  forEachItemNear(cx, cy, map = 1, radius = 5, fn) {
    if (this._spatialDirty) this._resyncSpatial();
    if (typeof fn !== 'function') return 0;
    cx |= 0; cy |= 0; map |= 0; radius |= 0;
    const sxLo = ((cx - radius) | 0) >> 3;
    const sxHi = ((cx + radius) | 0) >> 3;
    const syLo = ((cy - radius) | 0) >> 3;
    const syHi = ((cy + radius) | 0) >> 3;
    const sectorCount = (sxHi - sxLo + 1) * (syHi - syLo + 1);
    let visited = 0;
    if (sectorCount > this.items.size) {
      for (const it of this.items.values()) {
        if (it.parent) continue;
        if ((it.map ?? 1) !== map) continue;
        if (Math.abs(it.x - cx) > radius) continue;
        if (Math.abs(it.y - cy) > radius) continue;
        visited++;
        if (fn(it) === false) return visited;
      }
      return visited;
    }
    for (let sy = syLo; sy <= syHi; sy++) {
      for (let sx = sxLo; sx <= sxHi; sx++) {
        const k = ((map | 0) << 22) | ((sy & 0x7FF) << 11) | (sx & 0x7FF);
        const set = this._itemsBySector.get(k);
        if (!set) continue;
        for (const s of set) {
          const it = this.items.get(s);
          if (!it) continue;
          if (Math.abs(it.x - cx) > radius) continue;
          if (Math.abs(it.y - cy) > radius) continue;
          visited++;
          if (fn(it) === false) return visited;
        }
      }
    }
    return visited;
  }

  /** Yield every world-item (parent === 0) within `radius` tiles. */
  *itemsAt(cx, cy, map = 1, radius = 5) {
    yield* this.itemsNear(cx, cy, map, radius);
  }

  markSpatialDirty() {
    this._spatialDirty = true;
    this._bumpSpatialRevision('all', { clear: true });
  }

  ensureMobile(serial) {
    let m = this.mobiles.get(serial >>> 0);
    if (!m) {
      m = new Mobile(serial);
      this.mobiles.set(m.serial, m);
      // Client perf round 2 #3: brand-new mobile may end up at non-zero
      // (x, y) by the next packet; mark dirty so the sector index does
      // not silently retain stale 0,0 for queries.
      this._spatialDirty = true;
      this._bumpSpatialRevision('mobile');
    }
    return m;
  }

  ensureItem(serial) {
    let it = this.items.get(serial >>> 0);
    if (!it) {
      it = new Item(serial);
      this.items.set(it.serial, it);
      this._spatialDirty = true;
      this._bumpSpatialRevision('item');
    }
    return it;
  }

  /** Stamp `eq` (= { serial, itemId, hue }) on `mob.equipment[layer]`
   *  and register it in the reverse index. Use this from net handlers
   *  / paperdoll / equip flow instead of `mob.equipment.set` directly
   *  so removeEntity stays O(1). */
  equipOnMobile(mob, layer, eq) {
    if (!mob || !eq) return;
    if (!mob.equipment) mob.equipment = new Map();
    const existing = mob.equipment.get(layer);
    if (existing
        && (existing.serial >>> 0) === (eq.serial >>> 0)
        && (existing.itemId | 0) === (eq.itemId | 0)
        && (existing.hue | 0) === (eq.hue | 0)) return;
    if (existing) this._equipIndex.delete((existing.serial >>> 0));
    mob.equipment.set(layer, eq);
    this._equipIndex.set((eq.serial >>> 0), { mob, layer });
    mob._equipmentRevision = ((mob._equipmentRevision | 0) + 1) >>> 0;
  }

  /** Inverse of equipOnMobile — pulls a worn item off a layer. */
  unequipFromMobile(mob, layer) {
    if (!mob?.equipment) return;
    const eq = mob.equipment.get(layer);
    if (!eq) return;
    mob.equipment.delete(layer);
    this._equipIndex.delete((eq.serial >>> 0));
    mob._equipmentRevision = ((mob._equipmentRevision | 0) + 1) >>> 0;
  }

  removeEntity(serial) {
    const s = serial >>> 0;
    const mob = this.mobiles.get(s);
    if (mob) this._deleteSectorEntry(this._mobsBySector, s, mob.x, mob.y, mob.map ?? 1);
    this.mobiles.delete(s);
    const it = this.items.get(s);
    if (it) {
      this.unlinkItemParent(it);
      if (!it.parent) this._deleteSectorEntry(this._itemsBySector, s, it.x, it.y, it.map ?? 1);
    }
    this.items.delete(s);
    if (mob && it) this._bumpSpatialRevision('all');
    else if (mob) this._bumpSpatialRevision('mobile');
    else if (it) this._bumpSpatialRevision('item');
    // O(1) reverse-index lookup. Replaced a previous nested walk
    // (every mobile × every equipped item) which fired per
    // `entity:removed` event — a single TP refresh that produced 30+
    // removes scanned ~200 mobiles × ~10 worn = 60k sync ops. With 30
    // removes that compounded to ~1.8M sync ops on the renderer thread.
    const slot = this._equipIndex.get(s);
    if (slot) {
      slot.mob.equipment?.delete?.(slot.layer);
      this._equipIndex.delete(s);
      // Keep every equipment consumer on the same revision. Paperdoll
      // redraws directly from mob.equipment on entity:removed, while the
      // world MobileRenderer caches an equipHash keyed by this revision.
      // Missing this bump left the removed robe rendered in-world even
      // though the paperdoll correctly stopped showing it.
      slot.mob._equipmentRevision = ((slot.mob._equipmentRevision | 0) + 1) >>> 0;
    }
  }
}

export const world = new World();
export { Mobile, Item };
