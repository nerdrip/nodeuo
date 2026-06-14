// Item history — small ring-buffer log of item lifecycle events
// (create/equip/drop/lift/destroy). Mirrors ServUO's GMLog feature
// for tracking exploit reports + per-player loot rollbacks.
//
// Entries are best-effort and held in-memory only (200 most recent
// per item; unbounded total). Production use would persist via the
// existing `world/persistence.js` pipeline.

const MAX_PER_ITEM = 200;
const _items = new Map();   // serial → array<entry>

/** @typedef {{ ts:number, kind:string, who?:number, where?:string, payload?:any }} HistoryEntry */

/** Append an event for `serial`. */
export function record(serial, kind, opts = {}) {
  if (!serial) return;
  const s = serial >>> 0;
  let log = _items.get(s);
  if (!log) { log = []; _items.set(s, log); }
  log.push({
    ts: Date.now(),
    kind,
    who: opts.who | 0 || undefined,
    where: opts.where ?? undefined,
    payload: opts.payload,
  });
  if (log.length > MAX_PER_ITEM) log.splice(0, log.length - MAX_PER_ITEM);
}

/** Snapshot the history for an item, newest first. */
export function historyOf(serial) {
  return [...(_items.get(serial >>> 0) ?? [])].reverse();
}

export function clearItem(serial) { _items.delete(serial >>> 0); }
export function clearAll()        { _items.clear(); }
export function trackedCount()    { return _items.size; }
