// Shard event log + broadcast — central pub/sub for game-wide
// announcements. Mirrors ServUO `Server/EventSink` + `Misc/ShardPoller`
// without the polling part.
//
// Use cases:
//   - Champion spawn boss kill → "The champion of Rikktor has fallen!"
//   - Artifact discovery       → "An adventurer has discovered the legendary artifact: Hat of the Magi!"
//   - Player achievement       → "Congratulations to <Player> for unlocking <Title>!"
//   - World boss spawn         → "A Stygian Dragon has appeared in the Abyss!"
//
// Each event carries (timestamp, kind, message, payload?). Subscribers
// can filter by kind. The log keeps the last N events in a ring buffer
// so a `[events` command + an in-game scroll can replay them.

const MAX_LOG = 200;

const _log = [];
const _subscribers = new Set();

/** @typedef {{ ts:number, kind:string, message:string, payload?:any }} ShardEvent */

/**
 * Publish a new shard event. Calls every subscriber and appends to the
 * ring buffer. Caller is responsible for actually broadcasting the
 * payload to clients (e.g. via `cliloc-broadcast`); this module just
 * decouples producers from consumers.
 *
 * @param {string} kind
 * @param {string} message
 * @param {any}    [payload]
 */
export function emit(kind, message, payload) {
  const ev = { ts: Date.now(), kind, message, payload };
  _log.push(ev);
  if (_log.length > MAX_LOG) _log.shift();
  for (const fn of _subscribers) {
    try { fn(ev); }
    catch (e) { console.error('[shard-events] subscriber threw:', e?.message ?? e); }
  }
  return ev;
}

/** Subscribe to all events. Returns an unsubscribe function. */
export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

/** Subscribe with a kind filter. */
export function subscribeKind(kind, fn) {
  return subscribe((ev) => { if (ev.kind === kind) fn(ev); });
}

/** Recent events (newest first), filtered by kind if specified. */
export function recent(n = 20, kind = null) {
  const slice = _log.slice(-Math.max(1, n)).reverse();
  return kind ? slice.filter((e) => e.kind === kind) : slice;
}

/** Wipe the log. Useful for tests + admin commands. */
export function clear() { _log.length = 0; }

export const SHARD_EVENT_KINDS = Object.freeze([
  'system', 'login', 'logout', 'death',
  'champion-defeat', 'champion-tier', 'world-boss-spawn', 'world-boss-defeat',
  'artifact-discovered', 'achievement-unlocked',
  'house-built', 'house-demolished',
  'faction-corruption', 'sigil-captured',
  'season-change', 'weather',
]);
