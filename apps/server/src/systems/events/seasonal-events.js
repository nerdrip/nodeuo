// Seasonal Events — ENGINE ONLY.
//
// Event window definitions live in apps/scripts/src/data/world/seasonal-events.json
// and are loaded at startup by apps/scripts/src/systems/events/seasonal-events.js,
// which also wires per-event open/close hooks.
//
// Engine responsibilities:
//   - hold the event table (set by script via setEvents)
//   - track which events are currently inside their window
//   - fire registered open/close hooks on edge transitions
//   - post town-cryer headlines on open (if shard has cryer)

let _events = [];

const _hooks = new Map();      // id -> { open: fn[], close: fn[] }
const _state = new Map();      // id -> 'active' | 'inactive'

export function setEvents(list) {
  _events = Array.isArray(list) ? list.slice() : [];
  _hooks.clear();
  _state.clear();
}

function inWindow(d, ev) {
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const [sm, sd] = ev.startMD, [em, ed] = ev.endMD;
  if (sm > em || (sm === em && sd > ed)) {
    return (m > sm || (m === sm && day >= sd))
        || (m < em || (m === em && day <= ed));
  }
  return (m > sm || (m === sm && day >= sd))
      && (m < em || (m === em && day <= ed));
}

export function listEvents() { return [..._events]; }
export function isActive(id, now = Date.now()) {
  const ev = _events.find((e) => e.id === id);
  return ev ? inWindow(new Date(now), ev) : false;
}
export function activeNow(now = Date.now()) {
  return _events.filter((ev) => inWindow(new Date(now), ev));
}

/** Register hooks for one event. Multiple registrations stack. */
export function registerEventHooks(id, { onOpen, onClose } = {}) {
  if (!_events.find((e) => e.id === id)) {
    throw new Error(`seasonal-events: unknown event id ${id}`);
  }
  const cur = _hooks.get(id) ?? { open: [], close: [] };
  if (onOpen) cur.open.push(onOpen);
  if (onClose) cur.close.push(onClose);
  _hooks.set(id, cur);
}

/** Tick — call once per minute. Detects window edges and fires hooks. */
export function tick(world, now = Date.now()) {
  for (const ev of _events) {
    const active = inWindow(new Date(now), ev);
    const prev = _state.get(ev.id) ?? 'inactive';
    const cur  = active ? 'active' : 'inactive';
    if (prev === cur) continue;
    _state.set(ev.id, cur);
    const hooks = _hooks.get(ev.id) ?? { open: [], close: [] };
    const list = active ? hooks.open : hooks.close;
    for (const fn of list) {
      try { fn(world, ev); }
      catch (e) { console.warn(`[seasonal-events] ${ev.id} ${active ? 'open' : 'close'} hook threw`, e); }
    }
    try {
      world?.systems?.townCryer?.post?.({
        title: ev.title,
        body: ev.message,
        ttlMs: 7 * 24 * 60 * 60 * 1000,
      });
    } catch { /* no town cryer */ }
  }
}

/** For tests / reload. */
export function reset() {
  _events = [];
  _hooks.clear();
  _state.clear();
}
