// Light-source decay registry. Torches, lanterns and candles burn for
// a fixed duration after being lit and snuff themselves automatically
// once the timer expires. Mirrors ServUO `BaseLight.Burnout`.
//
// Designs:
//   - Lights register themselves via `arm(serial, item, durationMs)`.
//     We keep them in a small Set so the tick walks only LIT items
//     instead of the full 110k world.items map.
//   - On expiry the item's `_lit` flag flips off, `itemId` reverts to
//     the captured unlit graphic, and a small system message goes to
//     anyone in 8 tiles (matches CUO "your torch goes out" range).

const _active = new Map();   // serial → { item, expiresAt, snuff }

/** Default burn time per item type. Mirrors ServUO defaults. */
export const BURN_TIMES = {
  torch:    1   * 60 * 60_000,    // 1 hour
  lantern:  4   * 60 * 60_000,    // 4 hours
  candle:   30  * 60_000,         // 30 minutes
};

/** Light a tracked source. `snuff(item)` runs when the timer expires;
 *  callers pass an item-specific snuff handler (script onUse path). */
export function arm(serial, item, durationMs, snuff) {
  if (!item || !Number.isFinite(durationMs) || durationMs <= 0) return;
  _active.set(serial >>> 0, {
    item,
    expiresAt: Date.now() + (durationMs | 0),
    snuff: typeof snuff === 'function' ? snuff : null,
  });
  item._lightBurnUntil = Date.now() + (durationMs | 0);
}

/** Cancel a light-decay timer (player snuffed manually). */
export function disarm(serial) {
  const entry = _active.get(serial >>> 0);
  if (!entry) return;
  _active.delete(serial >>> 0);
  if (entry.item) entry.item._lightBurnUntil = 0;
}

/** Periodic burn-out check. Walks the active-only registry, runs
 *  per-item snuff for expired entries, drops them. Cheap — typical
 *  shard never has more than a few dozen lit lights at once. */
export function tickLightDecay(now = Date.now()) {
  for (const [serial, entry] of _active) {
    if (entry.expiresAt > now) continue;
    _active.delete(serial);
    try { entry.snuff?.(entry.item); } catch { /* advisory */ }
    if (entry.item) entry.item._lightBurnUntil = 0;
  }
}

/** Visible only for tests / [admin debug. */
export function activeCount() { return _active.size; }
