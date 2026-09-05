// Item decay sweeper. ServUO `Item.cs::Decays` + `OnDecay` parity.
//
// Standard UO behaviour: an item that lives loose on the ground (no
// parent container, no mobile holding it) ages out after ~60 minutes
// and silently disappears. This keeps shards from drowning in ten years
// of dropped torches and broken weapons. Items inside containers, worn
// equipment, deeded house pieces, vendor stock — all immune.
//
// Opt-out flags:
//   item.movable === false   item is bolted down (vendor stalls, doors)
//   item.isDecoration        placed by `[createworld`; survives forever
//   item._noDecay            quest items, GM marks, anything pinned
//
// Decay timestamp lives on `item.decayAt` (epoch ms). The sweeper sets
// it the first time it sees an eligible item and destroys the item once
// `now > decayAt`. `decayAt` rides through saves via persistence.js
// ITEM_EXT_KEYS — without persistence the timer would reset on every
// restart and items would effectively never decay on a frequently-
// restarted dev shard.
//
// `tickDecay` is also responsible for broadcasting `0x1D RemoveEntity`
// to nearby clients so the item visually vanishes; without that the
// client keeps painting a sprite that no longer exists server-side.

import { destroyItem } from './items.js';
import { removeEntity } from '@uo/protocol';

/** Default lifetime for ground items: 60 minutes (UO standard). */
export const DEFAULT_DECAY_MS = 60 * 60 * 1000;
/** Faster lifetime for resources (gold, reagents, ingots, logs, ores,
 *  gems, ammo, food). ServUO `Item.DecayTime` defaults this class to
 *  ~5 minutes — a 1 h delay on dropped gold piles encouraged griefer
 *  hoards. Per-item override via `item._decayMs` always wins. */
export const RESOURCE_DECAY_MS = 5 * 60 * 1000;
/** How often the sweeper runs. 60 s is a good compromise — fine-grained
 *  enough that a 1 h decay is honoured to within ~2 % accuracy and
 *  cheap (one Map walk per minute). */
export const DEFAULT_SWEEP_MS  = 60 * 1000;

// Resource-class detection. Anything stackable (`amount > 1`) qualifies —
// gold/ingots/regs/logs/ores/gems/ammo/food are all stack types. Single-
// stack items (weapons/armour/tools) keep the long timer. Items can
// explicitly mark themselves resource (`_resource = true`) or pin a
// custom decay window (`_decayMs = ms`).
function decayTimeFor(item) {
  if (Number.isFinite(item?._decayMs)) return item._decayMs | 0;
  if (item?._resource) return RESOURCE_DECAY_MS;
  if ((item?.amount | 0) > 1) return RESOURCE_DECAY_MS;
  return DEFAULT_DECAY_MS;
}

/**
 * Single decay pass. Stamps `decayAt` on freshly-eligible items and
 * destroys any whose timer has expired.
 *
 * @param {import('./world.js').World} world
 * @param {number} [now]      epoch ms; defaults to `Date.now()`
 * @param {number} [decayMs]  per-item lifetime; defaults to 1 h
 * @returns {{stamped:number, expired:number}}
 */
export function tickDecay(world, now = Date.now(), decayMs = DEFAULT_DECAY_MS) {
  let stamped = 0;
  /** @type {any[]} */
  const expired = [];
  // BH #13 B4 — items resting inside a player's house rect should not
  // decay. Lookup via houses registry.
  const houses = world.houses ?? world.systems?.houses ?? world._houses;
  const inHouse = (it) => {
    if (it._inHouseLockdown) return true;
    if (it.locked === true) return true;
    if (houses?.houseAt && it.map != null) {
      return !!houses.houseAt(it.x, it.y, it.map);
    }
    return false;
  };
  // Walk only ground items via the sector index — `world.sectors._itAt`
  // is bucketed on parent-less items only, so the inner loop skips the
  // 105k worn / contained entries that the legacy `world.items.values()`
  // walk had to filter out. On a populated shard this drops the per-
  // minute decay tick from a 110k iteration spike (≈30 ms event-loop
  // hiccup) to ~5k iterations. Test fixtures that bypass `createItem`
  // get the legacy walk via the same heuristic visibility uses.
  const sectorsOk = world.sectors
                 && (world.items.size === 0 || world.sectors.itemsIndexed() > 0);
  // Per-item lifetime via decayTimeFor — resources expire in 5 min
  // while equipment keeps the legacy 1 h. The `decayMs` arg becomes
  // the *fallback* when the heuristic can't classify (used by tests
  // that pass an explicit value).
  if (sectorsOk) {
    for (const serial of world.sectors.allItemSerials()) {
      const it = world.items.get(serial);
      if (!it) continue;
      if (it.parent != null) continue;
      if (it.movable === false) continue;
      if (it.isDecoration) continue;
      if (it._noDecay) continue;
      if (inHouse(it)) continue;                         // BH #13 B4
      if (it.decayAt == null) {
        const lifetime = decayMs !== DEFAULT_DECAY_MS ? decayMs : decayTimeFor(it);
        it.decayAt = now + lifetime;
        stamped++;
        continue;
      }
      if (it.decayAt <= now) expired.push(it);
    }
  } else {
    for (const it of world.items.values()) {
      if (it.parent != null) continue;
      if (it.movable === false) continue;
      if (it.isDecoration) continue;
      if (it._noDecay) continue;
      if (inHouse(it)) continue;                         // BH #13 B4
      if (it.decayAt == null) {
        const lifetime = decayMs !== DEFAULT_DECAY_MS ? decayMs : decayTimeFor(it);
        it.decayAt = now + lifetime;
        stamped++;
        continue;
      }
      if (it.decayAt <= now) expired.push(it);
    }
  }
  if (expired.length === 0) return { stamped, expired: 0 };

  // Visibility-gated removal broadcast. Without this clients keep
  // painting a sprite that no longer exists server-side until they walk
  // out of and back into the chunk. Per-expired-item nearby walk uses
  // the sector index too — otherwise a fall of 100 expired items in
  // one tick walks 100 × 200 mobs = 20k ops anyway.
  for (const it of expired) {
    try {
      const pkt = removeEntity(it.serial);
      if (sectorsOk && world.sectors.mobilesIndexed() >= world.mobiles.size) {
        for (const serial of world.sectors.mobileSerialsNear(it.map | 0, it.x, it.y, 18)) {
          const m = world.mobiles.get(serial);
          if (!m?.client) continue;
          if (Math.abs(m.x - it.x) > 18 || Math.abs(m.y - it.y) > 18) continue;
          m.client.send(pkt);
        }
      } else {
        for (const m of world.mobiles.values()) {
          if (!m.client) continue;
          if (m.map !== it.map) continue;
          if (Math.abs(m.x - it.x) > 18 || Math.abs(m.y - it.y) > 18) continue;
          m.client.send(pkt);
        }
      }
    } catch { /* best-effort broadcast */ }
    try { destroyItem(world, it.serial); } catch { /* already gone */ }
  }
  return { stamped, expired: expired.length };
}

/** Bounded round-robin decay pass used by production scheduling. */
export function tickDecayBudgeted(world, now = Date.now(), decayMs = DEFAULT_DECAY_MS, maxItems = 512) {
  const budget = Math.max(1, maxItems | 0);
  let state = world._decayBudgetState;
  if (!state?.iterator) state = world._decayBudgetState = { iterator: world.sectors?.allItemSerials?.() ?? world.items.keys(), cycles: 0 };
  const serials = [];
  let completed = false;
  while (serials.length < budget) {
    const next = state.iterator.next();
    if (next.done) { completed = true; break; }
    serials.push(next.value);
  }
  let stats = { stamped: 0, expired: 0 };
  if (serials.length) {
    const view = Object.create(world);
    const sectors = Object.create(world.sectors ?? null);
    sectors.allItemSerials = () => serials.values();
    sectors.itemsIndexed = () => serials.length;
    view.sectors = sectors;
    stats = tickDecay(view, now, decayMs);
  }
  if (completed) {
    state.iterator = world.sectors?.allItemSerials?.() ?? world.items.keys();
    state.cycles++;
  }
  return { ...stats, processed: serials.length, remaining: !completed, cycles: state.cycles };
}

/**
 * Schedule the sweeper on `setInterval`. Returns the handle so the
 * caller can `clearInterval(handle)` on shutdown.
 *
 * @param {import('./world.js').World} world
 * @param {{ intervalMs?:number, decayMs?:number, onTick?:(stats:{stamped:number,expired:number,now:number})=>void }} [opts]
 */
export function startDecaySweeper(world, opts = {}) {
  const intervalMs = opts.intervalMs ?? DEFAULT_SWEEP_MS;
  const decayMs    = opts.decayMs    ?? DEFAULT_DECAY_MS;
  const tick = () => {
    try {
      const now = Date.now();
      const stats = opts.maxPerTick
        ? tickDecayBudgeted(world, now, decayMs, opts.maxPerTick)
        : tickDecay(world, now, decayMs);
      if (opts.onTick) opts.onTick({ ...stats, now });
    } catch (e) {
      console.error('[decay] sweep failed:', e);
    }
  };
  const handle = opts.scheduler?.every
    ? opts.scheduler.every('item-decay', intervalMs, tick)
    : setInterval(tick, intervalMs);
  // Don't keep the Node event loop alive purely for the sweeper —
  // matches how the spawner / save cron behave.
  if (typeof handle?.unref === 'function') handle.unref();
  return handle;
}
