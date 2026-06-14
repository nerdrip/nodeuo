// Help/Page queue — port of ServUO `Scripts/Services/Help/PageQueue.cs`.
//
// In-game GM support: a player presses `Help` (0x9B) → opens a category
// gump → server enqueues a PageEntry. Online staff (accessLevel >= GM)
// can list (`[pages`), claim (`[claim N`), respond, and resolve. We
// keep the queue in-memory; a save/load pair would persist across
// restarts but ServUO never persisted them either.

const CATEGORIES = Object.freeze([
  'Stuck',          // 0
  'Bug',            // 1
  'Account',        // 2
  'Other',          // 3
  'Vendor',         // 4   (legacy enums in PageType.cs)
  'Bug report',     // 5
  'Harassment',     // 6
  'Suggestion',     // 7
  'Other request',  // 8
]);

let _nextId = 1;
/** @type {Map<number, PageEntry>} */
const _queue = new Map();

/** @typedef {{id:number, sender:string, senderSerial:number, text:string, category:number, when:number, claimedBy:string|null, resolved:boolean}} PageEntry */

/** Enqueue a new help page. Returns the id. */
export function enqueue({ sender, senderSerial, text, category = 0 }) {
  const id = _nextId++;
  /** @type {PageEntry} */
  const entry = {
    id,
    sender: sender ?? '(anonymous)',
    senderSerial: senderSerial ?? 0,
    text: String(text ?? '').slice(0, 1024),
    category: Math.max(0, Math.min(CATEGORIES.length - 1, category | 0)),
    when: Date.now(),
    claimedBy: null,
    resolved: false,
  };
  _queue.set(id, entry);
  return id;
}

/** Snapshot of unresolved entries — for `[pages` listing. */
export function listOpen() {
  const out = [];
  for (const e of _queue.values()) if (!e.resolved) out.push({ ...e });
  out.sort((a, b) => a.when - b.when);
  return out;
}

/** Claim a page (admin/GM only). Returns the entry or null if missing. */
export function claim(id, claimer) {
  const e = _queue.get(id | 0);
  if (!e || e.resolved) return null;
  e.claimedBy = claimer;
  return { ...e };
}

/** Resolve and drop a page. */
export function resolve(id) {
  const e = _queue.get(id | 0);
  if (!e) return false;
  e.resolved = true;
  _queue.delete(id | 0);
  return true;
}

/** Lookup a single entry. */
export function get(id) {
  const e = _queue.get(id | 0);
  return e ? { ...e } : null;
}

/** Names for `[pages` display. */
export function categoryName(idx) {
  return CATEGORIES[idx | 0] ?? '(unknown)';
}

/** Reset queue (tests). */
export function clearAll() { _queue.clear(); _nextId = 1; }
