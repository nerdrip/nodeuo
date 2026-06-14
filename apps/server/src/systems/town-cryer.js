// Town Cryer — port of ServUO `Scripts/Services/Town Cryer/`.
// In-game news ticker. GMs (or the server's bulletin scheduler) post
// short news messages with an expiry time; players within hearing range
// of any Town Cryer NPC get the headline broadcast as overhead speech,
// and any player can `[news` for the full active list.

const MAX_BACKLOG = 50;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

const _news = [];        // [{ id, body, until, postedAt, postedBy }]
let _nextId = 1;

export function postNews({ body, ttlMs = DEFAULT_TTL_MS, postedBy = 'GM' }) {
  if (!body || typeof body !== 'string') return null;
  const entry = {
    id: _nextId++,
    body: body.slice(0, 240),
    postedAt: Date.now(),
    postedBy,
    until: Date.now() + Math.max(60_000, ttlMs | 0),
  };
  _news.unshift(entry);
  if (_news.length > MAX_BACKLOG) _news.length = MAX_BACKLOG;
  return entry;
}

export function listActiveNews(now = Date.now()) {
  return _news.filter((n) => n.until > now);
}

export function removeNews(id) {
  const idx = _news.findIndex((n) => n.id === id);
  if (idx < 0) return false;
  _news.splice(idx, 1);
  return true;
}

/** Cadence tick — pulse the latest active headline through every Town
 *  Cryer NPC's overhead speech once per cadence. Caller drives this from
 *  the main loop, e.g. every 5 minutes. */
export function tickHeadlinePulse(world, broadcastNear) {
  const active = listActiveNews();
  if (active.length === 0) return 0;
  const headline = active[0];
  let count = 0;
  for (const npc of world?.mobiles?.values?.() ?? []) {
    if (!npc?._townCryer) continue;
    broadcastNear?.(npc, `Hear ye, hear ye! ${headline.body}`);
    count++;
  }
  return count;
}

/** Subscribe to shard-events and auto-post matching events as headlines.
 *  Idempotent — call once at boot via main.js or a script that has
 *  access to both `town-cryer` and `shard-events`. Returns the
 *  unsubscribe function. The TTL is shorter for noisy events (logins,
 *  deaths) and longer for capstone events (champions, world bosses). */
let _autoUnsub = null;
export function wireAutoNews(shardEvents) {
  if (_autoUnsub) return _autoUnsub;
  if (!shardEvents?.subscribe) return () => {};
  const TTL_BY_KIND = {
    'champion-defeat':       12 * 60 * 60 * 1000,    // 12h
    'champion-tier':          1 * 60 * 60 * 1000,    // 1h
    'world-boss-spawn':       6 * 60 * 60 * 1000,    // 6h
    'world-boss-defeat':     24 * 60 * 60 * 1000,    // 24h
    'artifact-discovered':   12 * 60 * 60 * 1000,    // 12h
    'achievement-unlocked':   1 * 60 * 60 * 1000,    // 1h
    'house-built':            4 * 60 * 60 * 1000,    // 4h
    'house-demolished':       2 * 60 * 60 * 1000,    // 2h
    'faction-corruption':     6 * 60 * 60 * 1000,
    'sigil-captured':         6 * 60 * 60 * 1000,
  };
  // Quiet events that should NEVER appear on the town cryer.
  const SKIP = new Set(['login', 'logout', 'death', 'system', 'weather', 'season-change']);
  _autoUnsub = shardEvents.subscribe((ev) => {
    if (SKIP.has(ev.kind)) return;
    const ttl = TTL_BY_KIND[ev.kind] ?? 60 * 60 * 1000;
    postNews({ body: ev.message, ttlMs: ttl, postedBy: 'Town Cryer' });
  });
  return _autoUnsub;
}
