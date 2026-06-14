// ActiveIconsManager — port of ClassicUO `Game/Managers/ActiveIconsManager.cs`.
// Maintains a flat list of currently-active buff/debuff icons (the
// payload comes from the existing 0xDF BuffPacket dispatcher) and
// emits `active-icons:changed` whenever the set mutates so any gump
// that wants to render them (BuffGump, CounterBar, top-bar pulse) can
// subscribe.

import { bus } from '../core/event-bus.js';

class ActiveIconsManager {
  constructor() {
    /** @type {Map<number, { iconId:number, name:string, expiresAt:number, source:string }>} */
    this._icons = new Map();
    this._nextExpiryAt = Infinity;
    bus.on?.('buff:add',    (b) => this._add(b));
    bus.on?.('buff:remove', (b) => this._remove((b?.icon ?? b?.iconId) ?? b));
    bus.on?.('buff:clear',  () => this.clear());
    // Audit #37 P1 #3 — the prune `tick()` was defined but never
    // called. Without it expired icons stayed in the set forever and
    // the consumer queries (spell-already-active toggle, top-bar
    // pulse, counter-bar dim) all read stale "still active" data.
    // Wire to the global `frame:tick` so any RAF-driven scene drives
    // the prune.
    bus.on?.('frame:tick', (now) => this.tick(now ?? performance.now()));
  }
  _add(b) {
    // ServUO `BuffPacket.WriteHeader` uses field `icon` (16-bit
    // GumpId). Earlier code looked for `iconId` only, leaving the
    // manager empty forever — every consumer of `_icons` (top-bar
    // pulse, counter-bar dim, status check) silently broke.
    const icon = b?.icon ?? b?.iconId;
    if (!icon) return;
    // Audit #31 P1 #2 — ServUO 0xDF carries `timer` in seconds; CUO
    // converts it to a deadline so `tick()` can prune. We received the
    // raw `duration` from the decoder but never derived `expiresAt`,
    // so the prune loop above never fired — icons stacked forever
    // until the server sent an explicit 0xDF action=0x00 remove.
    const durationS = b?.duration | 0;
    const expiresAt = b?.expiresAt
      ?? (durationS > 0 ? performance.now() + durationS * 1000 : 0);
    this._icons.set(icon, {
      iconId: icon, name: b.name ?? '',
      expiresAt,
      source: b.source ?? '',
    });
    this._refreshNextExpiry();
    bus.emit?.('active-icons:changed');
  }
  _remove(iconId) {
    if (!this._icons.delete(iconId | 0)) return;
    this._refreshNextExpiry();
    bus.emit?.('active-icons:changed');
  }
  clear() {
    if (this._icons.size === 0) return;
    this._icons.clear();
    this._nextExpiryAt = Infinity;
    bus.emit?.('active-icons:changed');
  }
  list() { return Array.from(this._icons.values()); }
  has(iconId) { return this._icons.has(iconId | 0); }
  get count() { return this._icons.size; }

  /** Per-frame: prune expired (call from main loop). */
  tick(now = performance.now()) {
    if (now < this._nextExpiryAt) return;
    let changed = false;
    for (const [k, v] of this._icons) {
      if (v.expiresAt && v.expiresAt > 0 && now > v.expiresAt) {
        this._icons.delete(k);
        changed = true;
      }
    }
    this._refreshNextExpiry();
    if (changed) bus.emit?.('active-icons:changed');
  }

  _refreshNextExpiry() {
    let next = Infinity;
    for (const v of this._icons.values()) {
      if (v.expiresAt && v.expiresAt > 0 && v.expiresAt < next) next = v.expiresAt;
    }
    this._nextExpiryAt = next;
  }
}

export const activeIcons = new ActiveIconsManager();
