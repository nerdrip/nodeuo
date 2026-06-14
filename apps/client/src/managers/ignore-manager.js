// IgnoreManager — list of player names whose chat is hidden. Mirrors
// CUO `Game/Managers/IgnoreManager.cs`. Persists to per-character
// profile under `ignored.names`.
//
// MessageManager queries `isIgnored(name)` before dispatching; we keep
// our own copy here so the game-scene UI / `IgnoreManagerGump` can
// edit the list directly without poking MessageManager internals.

import { profile } from './profile-manager.js';
import { messageManager } from './message-manager.js';
import { bus } from '../core/event-bus.js';

class IgnoreManager {
  constructor() {
    /** @type {Set<string>} lowercased names */
    this._set = new Set();
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    const saved = profile.get?.('ignored.names');
    if (Array.isArray(saved)) {
      for (const n of saved) this._set.add(String(n).toLowerCase());
    }
    // Mirror to MessageManager so the chat filter sees the list.
    for (const n of this._set) messageManager.ignore(n);
  }

  add(name) {
    const k = String(name || '').toLowerCase().trim();
    if (!k || this._set.has(k)) return;
    this._set.add(k);
    messageManager.ignore(k);
    this._persist();
    bus.emit('ignore:changed', { names: this.list() });
  }

  remove(name) {
    const k = String(name || '').toLowerCase().trim();
    if (!this._set.delete(k)) return;
    messageManager.unignore(k);
    this._persist();
    bus.emit('ignore:changed', { names: this.list() });
  }

  /** Audit rev.4 P3 — wildcard pattern match. Names containing `*` in
   *  the ignored set are matched as glob patterns (`Spammer*` → all
   *  names starting with `spammer`). Exact-match path runs first; the
   *  wildcard fallback only fires when the set has at least one `*`
   *  pattern. Compiled regexes are cached. */
  has(name) {
    const k = String(name || '').toLowerCase();
    if (this._set.has(k)) return true;
    for (const pat of this._set) {
      if (!pat.includes('*')) continue;
      if (this._patternToRegex(pat).test(k)) return true;
    }
    return false;
  }

  _patternToRegex(pat) {
    this._reCache ??= new Map();
    let re = this._reCache.get(pat);
    if (re) return re;
    const esc = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    re = new RegExp(`^${esc}$`, 'i');
    this._reCache.set(pat, re);
    return re;
  }

  list() { return [...this._set]; }
  clear() {
    for (const n of this._set) messageManager.unignore(n);
    this._set.clear();
    this._persist();
    bus.emit('ignore:changed', { names: [] });
  }

  _persist() {
    try { profile.set?.('ignored.names', [...this._set]); } catch { /* noop */ }
  }
}

export const ignoreManager = new IgnoreManager();
