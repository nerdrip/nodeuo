// AutoLootManager — automated corpse looting with a per-character
// allowlist. Mirrors ClassicUO's Game/Managers/AutoLootManager.cs but
// driven entirely by the existing client-side `world.items` mirror.
//
// Activation: when the corpse manager fires `corpse:open` (the player
// double-clicked a corpse and the server replied with 0x3C contents),
// we walk the children, match each item against the allowlist (itemId
// + optional hue), and emit a 0x07 LiftReq → 0x08 DropReq pair targeting
// the player's backpack. Throttled to one lift per frame so the server
// has time to ack each move (otherwise the second lift bounces).
//
// Configuration: persisted in localStorage `uo.autoloot` as a list of
// `{ itemId, hue?, name? }` rules. The OptionsGump drives edits.
//
// Disabled by default — opt-in via profile flag `autoloot.enabled` to
// avoid surprising ServUO PvP shards where autolooting is bannable.

import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { buildLiftReq, buildDropReq } from '../net/outgoing.js';
import { world } from '../world/world.js';
import { profile } from './profile-manager.js';
import { dragDrop } from './drag-drop.js';
import { tooltips } from './tooltip-manager.js';

const KEY = 'uo.autoloot';
const LIFT_INTERVAL_MS = 250;     // ServUO-side anti-cheat is ~150ms.

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rule = {};
  if (typeof raw.itemId === 'number') rule.itemId = raw.itemId | 0;
  if (typeof raw.hue === 'number') rule.hue = raw.hue | 0;
  if (typeof raw.name === 'string' && raw.name.trim()) {
    rule.name = raw.name.trim();
    rule.nameLc = rule.name.toLowerCase();
  }
  if (raw.priority != null) rule.priority = raw.priority | 0;
  return (rule.itemId != null || rule.hue != null || rule.name) ? rule : null;
}

class AutoLootManager {
  constructor() {
    /** @type {{ itemId?:number, hue?:number, name?:string, priority?:number }[]} */
    this.rules = [];
    this._queue = [];                  // {serial, priority} pending lift
    this._queueHead = 0;
    this._lastLiftAt = 0;
    this._load();
  }

  install() {
    bus.on('container:contents', (ev) => this._onContainer(ev));
    bus.on('frame:tick', (now) => this._drainQueue(now));
  }

  /** Add a rule. itemId/hue match the wire fields; name does a
   *  case-insensitive substring match against the item's tooltip first
   *  line (mirrors CUO's "filter by name" feature). priority is a number;
   *  higher priorities are lifted first. Rules with no itemId match
   *  purely by name. */
  addRule(itemId, hue, { name, priority } = {}) {
    const rule = normalizeRule({ itemId, hue, name, priority });
    if (!rule) return;
    this.rules.push(rule);
    this._save();
  }
  removeRuleAt(idx) { this.rules.splice(idx, 1); this._save(); }
  clearRules()      { this.rules = []; this._save(); }

  _onContainer({ containerSerial, items }) {
    if (!profile.get('autoloot.enabled')) return;
    if (!items?.length) return;
    // Only auto-loot a corpse — corpse items have a `body` field set
    // server-side. The cheap proxy here: container itemId 0x2006 is a
    // corpse graphic. Anything else is opt-in via a UI button later.
    const container = world.items.get(containerSerial >>> 0);
    if (!container || container.itemId !== 0x2006) return;
    // Build a (serial, priority) list. Higher priority lifts first.
    const matches = [];
    for (const it of items) {
      const r = this._matchRule(it);
      if (r) matches.push({ serial: it.serial >>> 0, priority: r.priority | 0 });
    }
    matches.sort((a, b) => b.priority - a.priority);
    for (const m of matches) this._queue.push(m.serial);
  }

  /** Find the first rule that matches the item. Returns the rule or null. */
  _matchRule(item) {
    let itemNameLc = null;
    for (const r of this.rules) {
      if (r.itemId != null && r.itemId !== (item.itemId | 0)) continue;
      if (r.hue != null && r.hue !== (item.hue | 0)) continue;
      if (r.name) {
        if (itemNameLc === null) {
          const itemNameText = this._itemNameText(item);
          itemNameLc = itemNameText ? itemNameText.toLowerCase() : '';
        }
        if (!itemNameLc || !itemNameLc.includes(r.nameLc ?? r.name.toLowerCase())) continue;
      }
      return r;
    }
    return null;
  }

  /** Pull the item's tooltip name from the shared tooltip cache. Returns
   *  null when the tooltip hasn't arrived yet — caller treats this as a
   *  miss for the name filter. */
  _itemNameText(item) {
    const cache = tooltips?._cache;
    const lines = cache?.get?.(item.serial >>> 0);
    if (!lines?.length) return null;
    // First OPL line is the item name. The line's `args` field may be a
    // string like "longsword\t" or contain template fragments; the
    // canonical "name" is the first segment up to a tab.
    const first = lines[0];
    const raw = typeof first === 'string' ? first
              : (first?.args ?? first?.text ?? '');
    const text = String(raw);
    const tab = text.indexOf('\t');
    return (tab >= 0 ? text.slice(0, tab) : text).trim();
  }

  _drainQueue(now = performance.now()) {
    if (this._queueHead >= this._queue.length) {
      if (this._queue.length) this._queue.length = 0;
      this._queueHead = 0;
      return;
    }
    if (now - this._lastLiftAt < LIFT_INTERVAL_MS) return;
    const pack = world.player?.equipment?.get?.(21);
    if (!pack) return;
    // Client audit #6 #5 — don't race a manual lift. If the user is
    // already carrying something, defer until the next tick.
    if (dragDrop?.held) return;
    const serial = this._queue[this._queueHead++];
    if (this._queueHead >= this._queue.length) {
      this._queue.length = 0;
      this._queueHead = 0;
    } else if (this._queueHead > 32 && this._queueHead * 2 > this._queue.length) {
      this._queue.splice(0, this._queueHead);
      this._queueHead = 0;
    }
    if (!serial) return;
    const it = world.items.get(serial);
    if (!it) return;
    try {
      net.send(buildLiftReq(serial, it.amount ?? 1));
      // Drop into pack at "any free slot" — UO uses 0xFFFF/0xFFFF for
      // grid x/y when the destination is a container.
      net.send(buildDropReq(serial, 0xFFFF, 0xFFFF, 0, 0, pack.serial >>> 0));
    } catch { /* socket transient */ }
    this._lastLiftAt = now;
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      // CUO AutoLoot rules can be name-only (no itemId binding). Old
      // filter dropped any { name: '...' } rule on the floor. Accept a
      // rule when it has any of itemId, hue, or name set.
      if (Array.isArray(arr)) {
        this.rules = [];
        for (const rawRule of arr) {
          const rule = normalizeRule(rawRule);
          if (rule) this.rules.push(rule);
        }
      }
    } catch { /* corrupted; start fresh */ }
  }
  _save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.rules.map(({ nameLc, ...rule }) => rule)));
    }
    catch { /* localStorage may be full */ }
  }
}

export const autoloot = new AutoLootManager();
