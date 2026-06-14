// JournalManager — backing store for the journal gump.
//
// Mirrors ClassicUO `Game/Managers/JournalManager.cs`. We retain a
// rolling buffer of every `message:journal` event so a freshly-opened
// JournalGump can replay history (rather than starting empty until
// the next chat line). MessageManager fans out the live stream;
// JournalManager just acts as the durable reader.
//
// Buffer cap matches CUO (`JournalManager.MAX_LINES = 256`). We size
// at 512 so shards with chatty NPCs don't lose context when 256 lines
// of cliloc spam push player speech off the top.

import { bus } from '../core/event-bus.js';

const MAX_LINES = 512;

// Audit rev.4 P3 — disk persistence. localStorage key per day so the
// user can audit yesterday's session even after a refresh. Trimmed to
// the last 7 days to keep storage bounded.
const DISK_KEY_PREFIX = 'uo.journal.';
const DISK_MAX_DAYS = 7;
const DISK_FLUSH_EVERY = 60_000;   // 1 minute

class JournalManager {
  constructor() {
    /** @type {{ name?:string, text:string, textType:number, hue:number, ts:number, matchesVendorKeyword?:boolean }[]} */
    this._entries = [];
    this._dirty = false;
    bus.on('message:journal', (m) => this._push(m));
    bus.on('journal:clear', () => { this._entries.length = 0; bus.emit('journal:cleared'); });
    // Re-hydrate today's entries on init so the player sees the
    // session continuity across reloads.
    try { this._loadToday(); } catch { /* noop */ }
    // Background flush — non-blocking and cheap (entries are POD).
    setInterval(() => this._flushDirty(), DISK_FLUSH_EVERY);
    // Last-chance flush before tab close.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this._flushDirty());
    }
  }

  _push(m) {
    if (!m || typeof m.text !== 'string') return;
    // Server-driven gump-bridge markers (e.g. `@@OPEN_CRAFT_GUMP@@…`)
    // travel through the same message:journal bus as regular speech.
    // They're parsed by `scenes/game-scene.js` to spawn the matching
    // typed gump (craft / banker / stable / etc); the marker text
    // itself is internal protocol and should not surface in the
    // journal — user report 2026-05-17 saw the huge inscription
    // recipe blob spill into chat when they clicked a craft skill.
    if (m.text.startsWith('@@OPEN_') && m.text.includes('_GUMP@@')) return;
    this._entries.push({
      name: m.name || '',
      text: m.text,
      textType: m.textType ?? 1,
      hue: m.hue ?? 0xfff0c0,
      matchesVendorKeyword: !!m.matchesVendorKeyword,
      ts: Date.now(),
    });
    if (this._entries.length > MAX_LINES) {
      this._entries.splice(0, this._entries.length - MAX_LINES);
    }
    this._dirty = true;
  }

  _dayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${DISK_KEY_PREFIX}${y}-${m}-${d}`;
  }

  _loadToday() {
    if (typeof localStorage === 'undefined') return;
    const k = this._dayKey();
    const raw = localStorage.getItem(k);
    if (!raw) return;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) this._entries = arr.slice(-MAX_LINES);
    } catch { /* corrupt entry — wipe */ localStorage.removeItem(k); }
  }

  _flushDirty() {
    if (!this._dirty) return;
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this._dayKey(), JSON.stringify(this._entries));
      this._dirty = false;
      this._gcOldDays();
    } catch (e) { console.warn('[journal] disk flush failed', e?.message); }
  }

  _gcOldDays() {
    if (typeof localStorage === 'undefined') return;
    const cutoff = Date.now() - DISK_MAX_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DISK_KEY_PREFIX)) continue;
      const datePart = k.slice(DISK_KEY_PREFIX.length);
      const t = Date.parse(datePart);
      if (Number.isFinite(t) && t < cutoff) {
        localStorage.removeItem(k);
        i--;       // index shifts on delete
      }
    }
  }

  /** Snapshot of the buffer for a newly-opened journal gump. */
  history() { return this._entries.slice(); }

  /** Callback iteration for UI that only needs a one-pass replay. */
  forEachHistory(fn) {
    if (typeof fn !== 'function') return;
    for (const entry of this._entries) fn(entry);
  }

  /** Filtered view by tab id (matches JournalGump TABS). */
  filtered(tab) {
    if (!tab || tab === 'all') return this.history();
    const wanted = TAB_FILTER[tab];
    if (!wanted) return this.history();
    return this._entries.filter((e) => wanted(e));
  }
}

const TAB_FILTER = {
  system: (e) => e.textType === 1 || e.textType === 8,
  chat:   (e) => e.textType === 0 || e.textType === 5,         // Normal + Party
  combat: (e) => e.textType === 7,
  spells: (e) => e.textType === 10,
};

export const journalManager = new JournalManager();
