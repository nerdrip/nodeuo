// Item-script registry — hooks an item template up to lifecycle events.
//
// items.json declares a `script` field (string) referring to an entry
// here. The script object holds optional callbacks for every event we
// dispatch. Missing callbacks default to no-op so a "torch" script can
// implement only `onUse` while a "trap" script implements only
// `onWalkOn`. Returning `true` from a hook means "I handled this,
// stop further dispatch"; returning `false` (or undefined) means
// "continue with default behaviour" (e.g. let the legacy template
// onUse path run).
//
// Events:
//   onUse(world, item, user)        — double-click on the item
//   onEquip(world, item, mob)       — moved to a paperdoll layer
//   onUnequip(world, item, mob)     — removed from a paperdoll layer
//   onWalkOn(world, item, mob)      — mobile stepped onto item's tile
//   onWalkOff(world, item, mob)     — mobile stepped off the tile
//   onDrop(world, item, dropped, dropper)
//                                  — item dropped on this scripted item
//                                    (target-side drag/drop); returning
//                                    true consumes the held item, returning
//                                    {handled:true, consumeHeld:false}
//                                    handles without consuming it
//   onPickUp(world, item, mob)      — item lifted into someone's hand
//   onDestroy(world, item)          — item removed from world
//   onCreate(world, item)           — item spawned (mirrors template.onCreate)
//   onTick(world, item, dt)         — periodic tick (only if hasTick=true)
//
// Scripts opt-in to ticking by setting `hasTick: true`. The world tick
// loop polls only items with that flag, so most items pay zero cost.

/** @typedef {Object} ItemScript
 *  @property {string} name
 *  @property {boolean} [hasTick]
 *  @property {(world: any, item: any, user: any) => boolean | void} [onUse]
 *  @property {(world: any, item: any, mob: any) => void} [onEquip]
 *  @property {(world: any, item: any, mob: any) => void} [onUnequip]
 *  @property {(world: any, item: any, mob: any) => void} [onWalkOn]
 *  @property {(world: any, item: any, mob: any) => void} [onWalkOff]
 *  @property {(world: any, item: any, dropped: any, mob: any) => any} [onDrop]
 *  @property {(world: any, item: any, mob: any) => void} [onPickUp]
 *  @property {(world: any, item: any) => void} [onDestroy]
 *  @property {(world: any, item: any) => void} [onCreate]
 *  @property {(world: any, item: any, dt: number) => void} [onTick]
 */

/** @type {Map<string, ItemScript>} */
const REGISTRY = new Map();

/** @param {ItemScript} script */
export function registerItemScript(script) {
  if (!script || typeof script.name !== 'string') {
    throw new Error('itemScript needs a name');
  }
  REGISTRY.set(script.name, script);
}

export function unregisterItemScript(name) { REGISTRY.delete(name); }

export function getItemScript(name) { return REGISTRY.get(name); }

export function allItemScripts() { return [...REGISTRY.values()]; }

/**
 * Dispatch a named lifecycle event to an item's script (if any).
 * Returns the script's return value (`true` = handled / stop, `false`
 * or undefined = continue). Errors in handlers are caught + logged so
 * one buggy script can't crash the world.
 *
 * @param {any} item
 * @param {string} eventName  e.g. 'onUse'
 * @param {...any} args        forwarded to the handler after `world`+`item`
 */
export function dispatchItemEvent(world, item, eventName, ...args) {
  const scriptName = item?.script;
  if (!scriptName) return undefined;
  const s = REGISTRY.get(scriptName);
  if (!s) return undefined;
  const fn = s[eventName];
  if (typeof fn !== 'function') return undefined;
  try { return fn(world, item, ...args); }
  catch (e) {
    console.error(`[item-script] ${scriptName}.${eventName} threw:`, e);
    return undefined;
  }
}

/**
 * PHASE BQ — fire walk-on / walk-off lifecycle hooks for every grounded
 * scripted item at the source and destination tiles of a step. Centralises
 * the logic so both player movement (handlers.js) and AI movement (ai.js
 * stepMobile) get identical trap / pressure-plate semantics.
 *
 * Ground items only: items in containers / on paperdolls don't have a
 * meaningful "tile" and shouldn't fire.
 *
 * Sector-indexed when available (8×8 buckets via `world.sectors`). The
 * earlier full O(items) scan was THE post-TP server-freeze culprit —
 * called for every step of every mob (handlers.js movement path + AI
 * step), so on a 110k-item shard with ~200 NPCs ticking at 2 steps/sec
 * each it burned ~44M iterations per second. With sectors we touch the
 * one bucket containing the source tile and the one containing the
 * destination — at most ~80 items checked per step.
 *
 * @param {any} world
 * @param {any} mob
 * @param {{x:number,y:number,z:number,map:number}} from
 * @param {{x:number,y:number,z:number,map:number}} to
 */
export function dispatchTileWalkEvents(world, mob, from, to) {
  if (!world?.items) return;
  // Use the sector index only when it's actively maintained. Test
  // fixtures bypass createItem and stuff values into world.items via
  // `.set()` — an empty index would silently drop walk-on/walk-off
  // events. Same heuristic as visibility.js: empty index + non-empty
  // world.items → test fixture → fall back to linear walk.
  const sectorsOk = world.sectors
                 && (world.items.size === 0 || world.sectors.itemsIndexed() > 0);
  if (sectorsOk) {
    // Two single-tile bucket lookups — `itemSerialsAt` reads ONE 8×8
    // bucket each. Walks scripted items only, so the inner loop body
    // is identical to the legacy code below.
    const visit = (tile, kind) => {
      for (const serial of world.sectors.itemSerialsAt(tile.map | 0, tile.x, tile.y)) {
        const it = world.items.get(serial);
        if (!it || it.parent != null || !it.script) continue;
        if (it.x !== tile.x || it.y !== tile.y || it.map !== tile.map) continue;
        const s = REGISTRY.get(it.script);
        if (!s) continue;
        const fn = kind === 'off' ? s.onWalkOff : s.onWalkOn;
        if (!fn) continue;
        try { fn(world, it, mob); }
        catch (e) { console.error(`[item-script] ${it.script}.${kind === 'off' ? 'onWalkOff' : 'onWalkOn'} threw:`, e); }
      }
    };
    visit(from, 'off');
    visit(to, 'on');
    return;
  }
  for (const it of world.items.values()) {
    if (it.parent != null) continue;
    if (!it.script) continue;
    const s = REGISTRY.get(it.script);
    if (!s) continue;
    if (s.onWalkOff && it.map === from.map && it.x === from.x && it.y === from.y) {
      try { s.onWalkOff(world, it, mob); }
      catch (e) { console.error(`[item-script] ${it.script}.onWalkOff threw:`, e); }
    }
    if (s.onWalkOn && it.map === to.map && it.x === to.x && it.y === to.y) {
      try { s.onWalkOn(world, it, mob); }
      catch (e) { console.error(`[item-script] ${it.script}.onWalkOn threw:`, e); }
    }
  }
}

/**
 * Walk every world.items entry whose script opts into ticking and
 * call `onTick(world, item, dt)`. Called from main.js at a steady
 * cadence — current default 1Hz matches resource regen so timer
 * pressure stays reasonable.
 *
 * Short-circuits when no registered script declared `hasTick:true`.
 * On a 110k-item shard the prior implementation ran a full
 * world.items walk every second EVEN when zero scripts wanted ticks;
 * the inner check (item.script falsy → skip) was cheap but the
 * outer iteration alone burned ~10-30 ms of sync work per tick,
 * visible as a stutter that compounded with the post-TP packet flood.
 */
let _anyScriptHasTick = false;
let _tickCacheGen = -1;
function _refreshTickCache() {
  // REGISTRY mutates on `defineItemScript`. Cheap re-scan; it's only
  // called when a script registration happens (size of REGISTRY changes).
  _anyScriptHasTick = false;
  for (const s of REGISTRY.values()) {
    if (s?.hasTick) { _anyScriptHasTick = true; break; }
  }
  _tickCacheGen = REGISTRY.size;
}
/** Cheap predicate used by items.createItem to decide whether a new
 *  item should be added to `world._tickingItems`. Caller passes the
 *  bare script name string. */
export function _scriptHasTick(name) {
  const s = name ? REGISTRY.get(name) : null;
  return !!s?.hasTick;
}

export function rebuildTickingItemIndex(world) {
  if (!world?.items) return 0;
  const idx = new Set();
  for (const item of world.items.values()) {
    if (item?.script && _scriptHasTick(item.script)) idx.add(item.serial);
  }
  world._tickingItems = idx;
  return idx.size;
}

export function tickAllItemScripts(world, dt) {
  if (!world?.items) return;
  if (_tickCacheGen !== REGISTRY.size) _refreshTickCache();
  if (!_anyScriptHasTick) return;
  // Fast path — walk `world._tickingItems` (maintained by items.js's
  // createItem/destroyItem hooks). Typical content has <50 ticking
  // items even on a populated shard. Falls back to the legacy O(items)
  // walk when the index is missing — covers tests that bypass
  // createItem by setting world.items entries directly + the very
  // first tick after a fresh boot before items.setItemScriptsModule
  // is wired.
  const idx = world._tickingItems;
  if (idx) {
    // Deleting the current Set entry during iteration is defined and safe;
    // avoid cloning the whole ticking index once per second.
    for (const serial of idx) {
      const item = world.items.get(serial);
      if (!item) { idx.delete(serial); continue; }
      const s = item.script ? REGISTRY.get(item.script) : null;
      if (!s?.hasTick) { idx.delete(serial); continue; }
      try { s.onTick?.(world, item, dt); }
      catch (e) {
        console.error(`[item-script] ${item.script}.onTick threw:`, e);
      }
    }
    return;
  }
  for (const item of world.items.values()) {
    const s = item.script ? REGISTRY.get(item.script) : null;
    if (!s?.hasTick) continue;
    try { s.onTick?.(world, item, dt); }
    catch (e) {
      console.error(`[item-script] ${item.script}.onTick threw:`, e);
    }
  }
}
