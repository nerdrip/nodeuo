// Shared post-bulk visibility refresh.
//
// `[createworld` and the per-stage commands ([decorate, [signgen, ...) push
// hundreds of thousands of items through the script item factory. That
// path is INTENTIONALLY silent — broadcasting one
// `worldItemSA` packet per item × N players would emit millions of frames
// for a single command (and the player only sees ~18 tiles around them
// anyway). But the user complaint was "wszystko się załadowało, musiałem
// się przelogować żeby to zobaczyć" — they couldn't see any of it without
// reconnecting.
//
// `broadcastBulkPlacement` walks every connected player ONCE after the
// bulk apply finishes and resends every item within their 18-tile UO
// update radius. That's identical to what login does in
// `bringIntoWorld → for (item of nearbyItems) state.sendItem(item)`. Cost:
// O(visiblePlayers × itemsInWorld) but pre-filtered by sector index so
// it's actually O(visiblePlayers × ~80 nearby items) — fast enough to
// run after every stage.

import { nearbyItems, onlineMobiles } from '../_spatial.js';

/** Canonical post-bulk refresh. Unlike a raw sendItem blast this updates the
 * NetState visibility baseline, removes stale serials and uses the server's
 * bounded item batches. */
export function refreshBulkVisibility(api) {
  const refresh = api.ctx?.handlers?.refreshSurroundings;
  if (typeof refresh !== 'function') return 0;
  let count = 0;
  for (const m of onlineMobiles(api)) {
    if (!m?.client) continue;
    try { refresh(m.client); count++; }
    catch (e) { api.log?.(`[bulk-refresh] client refresh failed: ${e.message}`); }
  }
  return count;
}

export function queueBulkSave(api) {
  try {
    const pending = api.persistence?.requestSave?.(api.world, api.persistence.saveDir);
    pending?.catch?.((e) => api.log?.(`[bulk-save] save failed: ${e.message}`));
  } catch (e) {
    api.log?.(`[bulk-save] save queue failed: ${e.message}`);
  }
}

/**
 * Resend nearby items to every connected player so a bulk apply (decorate,
 * doorgen, signgen, telgen, moongates) shows up without a reconnect.
 *
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export function broadcastBulkPlacement(api) {
  // Kept for compatibility with older scripts. New generators should call
  // refreshBulkVisibility so the visibility cache cannot drift.
  const world = api.world;
  if (!world) return 0;
  let sent = 0;
  const players = onlineMobiles(api);
  for (const m of players) {
    if (!m.client) continue;
    const items = api.query?.itemsNear?.(m, 18) ?? nearbyItems(world, m);
    for (const item of items) {
      try { m.client.sendItem(item); sent++; }
      catch { /* socket already closed; ignore */ }
    }
  }
  return sent;
}
