// Lightweight pub/sub. Used to decouple net handlers from scene/UI code.
// Mirrors the ClassicUO event hooks idea but is simpler (string topics).

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._subs = new Map();
  }

  on(topic, fn) {
    let set = this._subs.get(topic);
    if (!set) { set = new Set(); this._subs.set(topic, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  off(topic, fn) {
    this._subs.get(topic)?.delete(fn);
  }

  emit(topic, payload) {
    const set = this._subs.get(topic);
    if (!set) return;
    for (const fn of set) {
      try { fn(payload); }
      catch (e) { console.error(`[bus] ${topic} listener threw`, e); }
    }
  }

  clear() { this._subs.clear(); }
}

export const bus = new EventBus();
