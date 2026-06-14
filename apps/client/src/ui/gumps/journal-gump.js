// JournalGump (ResizableJournal port) — tabbed message log with type
// filters and substring search. Mirrors ClassicUO's
// `Game/UI/Gumps/ResizableJournal.cs`.
//
// Tabs (matches CUO):
//   0 All        — every line
//   1 System     — sysop / cliloc broadcasts
//   2 Chat       — player speech (ASCII + Unicode normal/whisper/yell)
//   3 Combat     — damage / heal / death events
//   4 Spells     — spell casts overheard
//
// We hook MessageManager's `message:journal` (preferred) and fall back
// to the raw chat:* channels if the manager isn't installed.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Graphics } from 'pixi.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { TextInput } from '../controls/text-input.js';
import { Control } from '../control.js';
import { GumpPic } from '../controls/gump-pic.js';
import { Button } from '../controls/button.js';
import { bus } from '../../core/event-bus.js';
import { TextType } from '../../managers/message-manager.js';
import { profile } from '../../managers/profile-manager.js';
import { hueForTextType } from '../../managers/chat-manager.js';
import { journalManager } from '../../managers/journal-manager.js';
import { compileJournalFilter, makeJournalFilterId, normalizeJournalFilters } from '../../shared/journal-filter.js';

const MAX_LINES = 512;
const ROW_PAD = 1;
const JOURNAL_ROW_FALLBACK_H = 15;
const JOURNAL_OVERSCAN_ROWS = 4;
const COMBAT_LINE_RE = /(damage|hit|miss|heal|killed|dies|attacks)/;
const SPELL_LINE_RE = /(in mani|in vas|kal|por|ort|grav|vas flam|corp por|invocat)/;

const BASE_TABS = [
  { id: 'all',     label: 'All' },
  { id: 'system',  label: 'System' },
  { id: 'chat',    label: 'Chat' },
  { id: 'combat',  label: 'Combat' },
  { id: 'spells',  label: 'Spells' },
];

const CUSTOM_ROW_Y = 48;
const SCROLL_TOP = 72;

function scheduleFrame(fn) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 0);
  }
}

function makeJournalLine({ name = '?', text = '', hue = 0, textType = TextType.Normal,
                           time = Date.now(), matchesVendorKeyword = false } = {}) {
  const safeName = name || '?';
  const safeText = text || '';
  return {
    name: safeName,
    text: safeText,
    hue: hue || 0,
    textType,
    time,
    matchesVendorKeyword: !!matchesVendorKeyword,
    lowerName: String(safeName).toLowerCase(),
    lowerText: String(safeText).toLowerCase(),
  };
}

/** Tab button with canonical UO chrome — uses gump 0x098D as the
 *  background art (108×23 native, the small tab/header strip the
 *  classic client uses on inset panels). Hover + active states swap
 *  to brighter / darker hue tints over the same art instead of the
 *  earlier flat dark-blue Graphics rect that read as "modern dropdown"
 *  not UO. */
class TabBtn extends Control {
  constructor(label, onClick, { width = 50 } = {}) {
    super();
    this.width = width;
    this.height = 20;
    this.acceptMouseInput = true;
    this._bg = new GumpPic(0x098D, { width: this.width, height: this.height });
    this._bg.acceptMouseInput = false;
    this.add(this._bg);
    this._lbl = new Label(label, { fontSize: 10, hue: 0xfff0c0 });
    this._lbl.setPosition(10, 4);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
    this._active = false;
    this._layoutLabel();
    this._applyState(false);
  }
  setActive(on) { this._active = !!on; this._applyState(false); }
  setLabel(text) { this._lbl.setText?.(text ?? ''); this._layoutLabel(); }
  _layoutLabel() { this._lbl.setPosition(Math.max(4, ((this.width - this._lbl.width) / 2) | 0), 4); }
  _applyState(hover) {
    if (!this._bg?.node) return;
    // Active = full opacity + warm cream label. Hover = slight
    // brightening. Idle = dim parchment (the gump art is already
    // brass-bordered so we just modulate alpha + label hue).
    if (this._active) {
      this._bg.node.alpha = 1.0;
      this._lbl.setHue?.(0xfff070);
    } else if (hover) {
      this._bg.node.alpha = 0.92;
      this._lbl.setHue?.(0xfff0c0);
    } else {
      this._bg.node.alpha = 0.7;
      this._lbl.setHue?.(0xc0a878);
    }
  }
  onMouseEnter() { this._applyState(true); }
  onMouseLeave() { this._applyState(false); }
  onClick() { this._onClick?.(); }
}

class JournalFilterEditorGump extends WindowGump {
  constructor({ filter = null, onSave, onDelete } = {}) {
    super({ title: filter ? 'Edit Journal Filter' : 'New Journal Filter', width: 360, height: 170, x: 180, y: 120, backgroundId: 0x0A28 });
    this._filter = filter;
    this._onSave = onSave;
    this._onDelete = onDelete;

    this.addContent(new Label('Name', { fontSize: 10, hue: 0xc0b890 }), 14, 32);
    this._labelInput = new TextInput({
      width: 120, height: 20, maxLength: 16,
      text: filter?.label ?? 'Filter',
      placeholder: 'Filter',
      fontSize: 10,
    });
    this.addContent(this._labelInput, 70, 28);

    this.addContent(new Label('Expression', { fontSize: 10, hue: 0xc0b890 }), 14, 66);
    this._exprInput = new TextInput({
      width: 270, height: 20, maxLength: 160,
      text: filter?.expr ?? 'Contains(bank)',
      placeholder: 'Contains(bank) && type:chat',
      fontSize: 10,
    });
    this.addContent(this._exprInput, 70, 62);

    const save = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 70, height: 22, label: 'Save',
    });
    save.setPosition(70, 122);
    save.onClick = () => {
      this._onSave?.({
        id: this._filter?.id,
        label: this._labelInput.value,
        expr: this._exprInput.value,
      });
      this.close();
    };
    this.add(save);

    if (filter && onDelete) {
      const del = new Button({
        normalGumpId: 0x0483, pressedGumpId: 0x0484,
        width: 70, height: 22, label: 'Delete',
      });
      del.setPosition(150, 122);
      del.onClick = () => { this._onDelete?.(); this.close(); };
      this.add(del);
    }

    const close = new Button({
      normalGumpId: 0x0483, pressedGumpId: 0x0484,
      width: 70, height: 22, label: 'Close',
    });
    close.setPosition(240, 122);
    close.onClick = () => this.close();
    this.add(close);
  }

  get type() { return 'journal-filter-editor'; }
}

export class JournalGump extends WindowGump {
  constructor() {
    super({ title: 'Journal', width: 460, height: 320, x: 60, y: 60, backgroundId: 0x0A28 });
    /** @type {{name:string,text:string,hue:number,textType:number,time:number}[]} */
    this._lines = [];
    journalManager.forEachHistory?.((m) => {
      const text = m.text || '';
      if (!text) return;
      this._lines.push(makeJournalLine({
        name: m.name || '?',
        text,
        hue: m.hue || 0,
        textType: m.textType ?? TextType.Normal,
        time: m.ts ?? Date.now(),
        matchesVendorKeyword: !!m.matchesVendorKeyword,
      }));
    });
    // Restore last-used tab + search from profile so the gump remembers
    // user's filter across reopens (CUO `JournalGump` does the same via
    // Profile.cs::JournalGumpFilter / SearchText).
    const saved = profile.get('ui.journal') ?? {};
    this._customFilters = normalizeJournalFilters(saved.customFilters);
    this._customPredicates = new Map(this._customFilters.map((f) => [f.id, compileJournalFilter(f.expr)]));
    this._activeTab = this._knownTab(saved.tab) ? saved.tab : 'all';
    this._searchQuery = String(saved.query ?? '');
    this._scrollLocked = !!saved.lock;

    // 5 tabs × 52 stride + 8 lead = 268 ≤ search-x (290). No overlap
    // between the tab strip and the search input on the right.
    let cx = 8;
    this._tabs = BASE_TABS.map((t) => {
      const b = new TabBtn(t.label, () => this._setTab(t.id));
      b.setPosition(cx, 26);
      this.add(b);
      cx += 52;
      return { id: t.id, btn: b };
    });
    this._customTabControls = [];
    this._newFilterBtn = new TabBtn('+', () => this._openFilterEditor(), { width: 26 });
    this._newFilterBtn.setPosition(8, CUSTOM_ROW_Y);
    this.add(this._newFilterBtn);
    this._rebuildCustomTabs();
    this._syncTabStates();

    this._search = new TextInput({ width: 140, height: 18, placeholder: 'search...', fontSize: 10 });
    this._search.setPosition(this._w - 170, 26);
    if (this._searchQuery) this._search.setValue?.(this._searchQuery);
    this._search._onChange = (v) => { this._searchQuery = v.toLowerCase(); this._persistFilter(); this._scheduleRedraw(); };
    // TextInput doesn't fire change events natively; we poll on tick.
    this.add(this._search);

    // Scroll-lock toggle — when on, _redraw() leaves the user's
    // scrollY untouched even if it'd otherwise auto-follow new lines.
    // CUO has the same toggle on ResizableJournal (lock icon top-right).
    const lockBtn = new TabBtn(this._scrollLocked ? '🔒' : '🔓', () => {
      this._scrollLocked = !this._scrollLocked;
      lockBtn._lbl.setText?.(this._scrollLocked ? '🔒' : '🔓');
      this._persistFilter();
    });
    lockBtn.width = 24;
    lockBtn.setPosition(this._w - 28, 26);
    this.add(lockBtn);
    this._lockBtn = lockBtn;

    this._scroll = new ScrollArea({ width: this._w - 20, height: this._h - SCROLL_TOP - 10 });
    this.addContent(this._scroll, 10, SCROLL_TOP);
    this._rowPool = [];
    this._rowHeight = JOURNAL_ROW_FALLBACK_H;
    this._scroll.onScroll = () => this._scheduleRedraw();

    // Audit #46 P2 — bottom-right resize grip. Drag to grow/shrink the
    // journal panel; minimum 360×220, max 1200×900. Persisted via
    // profile.ui.journal.size so reopens restore the chosen dims.
    this._resizeHandle = new (class extends Control {
      constructor(parent) {
        super();
        this.width = 14; this.height = 14;
        this.acceptMouseInput = true;
        this._parent = parent;
        this._g = new Graphics();
        this._g.poly([0, 14, 14, 14, 14, 0]).fill({ color: 0x444444, alpha: 0.6 });
        this.node.addChild(this._g);
        this.isDragHandle = false;        // we manage drag manually
      }
      onMouseDown(btn, lx, ly) {
        if (btn !== 0) return;
        this._dragging = true;
        this._startX = this._parent._w;
        this._startY = this._parent._h;
        this._startMouseX = (this.node.parent?.parent?.x ?? 0) + this.x + lx;
        this._startMouseY = (this.node.parent?.parent?.y ?? 0) + this.y + ly;
        const move = (e) => {
          if (!this._dragging) return;
          const nw = Math.max(360, Math.min(1200, this._startX + (e.clientX - this._startMouseX)));
          const nh = Math.max(220, Math.min(900, this._startY + (e.clientY - this._startMouseY)));
          this._parent._resizeTo(nw, nh);
        };
        const up = () => {
          this._dragging = false;
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          this._parent._persistFilter();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }
    })(this);
    // Restore saved size before placing the handle so initial layout uses
    // the persisted dimensions.
    if (saved.size?.w && saved.size?.h) this._resizeTo(saved.size.w, saved.size.h);
    this._resizeHandle.setPosition(this._w - 16, this._h - 16);
    this.add(this._resizeHandle);

    this._unsubs = [
      bus.on('message:journal', (m) => this._appendFromManager(m)),
      bus.on('journal:cleared', () => { this._lines.length = 0; this._scheduleRedraw(); }),
      // Defensive fallback when MessageManager isn't installed.
      bus.on('chat:ascii',   (m) => this._appendRaw(m, false)),
      bus.on('chat:unicode', (m) => this._appendRaw(m, true)),
    ];
    this._redraw();
  }

  get type() { return 'journal'; }
  dispose() {
    this._destroyed = true;
    for (const u of this._unsubs) u();
    super.dispose();
  }

  _scheduleRedraw() {
    if (this._redrawQueued || this._destroyed) return;
    this._redrawQueued = true;
    scheduleFrame(() => {
      this._redrawQueued = false;
      if (!this._destroyed) this._redraw();
    });
  }

  _appendFromManager(m) {
    if (!m?.text) return;
    // Server-driven gump-bridge markers (`@@OPEN_<NAME>_GUMP@@<payload>`)
    // travel as system messages through the same bus as regular speech.
    // scenes/game-scene.js parses them and spawns the matching typed
    // gump. The marker payload (often a multi-kB recipe blob) is
    // internal protocol — never user-facing. Filter here too because
    // this gump subscribes to `message:journal` directly, parallel to
    // JournalManager._push which has its own copy of this guard.
    if (typeof m.text === 'string'
        && m.text.startsWith('@@OPEN_') && m.text.includes('_GUMP@@')) return;
    this._lines.push(makeJournalLine({
      name: m.name || '?', text: m.text,
      hue: m.hue || 0, textType: m.textType ?? TextType.Normal,
      matchesVendorKeyword: !!m.matchesVendorKeyword,
      time: Date.now(),
    }));
    this._cap();
    this._scheduleRedraw();
  }
  _appendRaw(m, _isUnicode) {
    if (!m?.text) return;
    if (m.name === 'You see') return;        // single-click probe response
    if (typeof m.text === 'string'
        && m.text.startsWith('@@OPEN_') && m.text.includes('_GUMP@@')) return;
    let textType = TextType.Normal;
    if (m.hue === 0xFFFF || m.name === 'SYSTEM') textType = TextType.System;
    this._lines.push(makeJournalLine({
      name: m.name || '?', text: m.text, hue: m.hue || 0,
      textType, time: Date.now(),
    }));
    this._cap();
    this._scheduleRedraw();
  }
  _cap() { if (this._lines.length > MAX_LINES) this._lines.splice(0, this._lines.length - MAX_LINES); }

  _setTab(id) {
    if (!this._knownTab(id)) id = 'all';
    this._activeTab = id;
    this._syncTabStates();
    this._persistFilter();
    this._redraw();
  }

  _knownTab(id) {
    return BASE_TABS.some((t) => t.id === id) || this._customFilters.some((f) => f.id === id);
  }

  _syncTabStates() {
    for (const t of this._tabs) t.btn.setActive(t.id === this._activeTab);
  }

  _rebuildCustomTabs() {
    for (const t of this._customTabControls) {
      try { this.remove(t.btn); } catch { /* noop */ }
    }
    this._customTabControls = [];
    this._tabs = this._tabs.filter((t) => !String(t.id).startsWith('custom:'));

    let x = 40;
    const maxW = Math.max(220, this._w - 210);
    for (const f of this._customFilters) {
      if (x + 74 > maxW) break;
      const b = new TabBtn(f.label, () => this._setTab(f.id), { width: 72 });
      b.setPosition(x, CUSTOM_ROW_Y);
      b.onDoubleClick = () => this._openFilterEditor(f.id);
      this.add(b);
      const row = { id: f.id, btn: b };
      this._tabs.push(row);
      this._customTabControls.push(row);
      x += 76;
    }
    this._syncTabStates();
  }

  _openFilterEditor(id = null) {
    const filter = this._customFilters.find((f) => f.id === id) ?? null;
    bus.emit('gump:open', {
      gump: new JournalFilterEditorGump({
        filter,
        onSave: (next) => this._saveCustomFilter(next),
        onDelete: filter ? () => this._deleteCustomFilter(filter.id) : null,
      }),
    });
  }

  _saveCustomFilter(next) {
    const expr = String(next?.expr ?? '').trim();
    if (!expr) return;
    const label = String(next?.label || 'Filter').trim().slice(0, 16) || 'Filter';
    const existingId = next?.id && String(next.id).startsWith('custom:') ? next.id : null;
    const id = existingId || makeJournalFilterId(label, this._customFilters);
    const row = { id, label, expr };
    const idx = this._customFilters.findIndex((f) => f.id === id);
    if (idx >= 0) this._customFilters.splice(idx, 1, row);
    else this._customFilters.push(row);
    this._customFilters = normalizeJournalFilters(this._customFilters);
    this._customPredicates = new Map(this._customFilters.map((f) => [f.id, compileJournalFilter(f.expr)]));
    this._activeTab = id;
    this._rebuildCustomTabs();
    this._persistFilter();
    this._redraw();
  }

  _deleteCustomFilter(id) {
    this._customFilters = this._customFilters.filter((f) => f.id !== id);
    this._customPredicates.delete(id);
    if (this._activeTab === id) this._activeTab = 'all';
    this._rebuildCustomTabs();
    this._persistFilter();
    this._redraw();
  }

  _persistFilter() {
    profile.set('ui.journal', {
      tab: this._activeTab,
      query: this._searchQuery,
      lock: this._scrollLocked,
      customFilters: this._customFilters,
      size: { w: this._w, h: this._h },
    });
  }

  /** Audit #46 P2 — apply a new size from resize-handle drag. */
  _resizeTo(w, h) {
    this._w = w | 0;
    this._h = h | 0;
    // WindowGump body re-frame.
    try { this.setSize?.(this._w, this._h); } catch { /* ignore */ }
    // Reposition layout-anchored controls so they track the new edge.
    if (this._search) this._search.setPosition(this._w - 170, 26);
    if (this._lockBtn) this._lockBtn.setPosition(this._w - 28, 26);
    if (this._scroll) {
      this._scroll.setSize?.(this._w - 20, this._h - SCROLL_TOP - 10);
      // setSize may not exist on every ScrollArea variant — fall back
      // to re-creating its node bounds via private props if present.
      if (this._scroll._maskW != null) {
        this._scroll._maskW = this._w - 20;
        this._scroll._maskH = this._h - SCROLL_TOP - 10;
        this._scroll.redraw?.();
      }
    }
    this._rebuildCustomTabs?.();
    if (this._resizeHandle) this._resizeHandle.setPosition(this._w - 16, this._h - 16);
    this._redraw?.();
  }

  _matchesTab(line) {
    if (this._activeTab === 'all') return true;
    if (this._activeTab === 'system') return line.textType === TextType.System;
    if (this._activeTab === 'chat')   return line.textType === TextType.Normal || line.textType === TextType.Party
                                         || line.textType === TextType.Guild  || line.textType === TextType.Alliance;
    if (this._activeTab === 'combat') {
      return COMBAT_LINE_RE.test(line.lowerText ?? String(line.text ?? '').toLowerCase());
    }
    if (this._activeTab === 'spells') {
      return SPELL_LINE_RE.test(line.lowerText ?? String(line.text ?? '').toLowerCase());
    }
    const custom = this._customPredicates.get(this._activeTab);
    if (custom) return !!custom(line);
    return true;
  }

  _redraw() {
    // Auto-scroll only when the user was already at (or near) the
    // bottom. CUO `JournalGump` does the same — appending a new line
    // shouldn't yank a user who's scrolled up reading history back
    // down to the latest message. Threshold: within 2 px of max.
    const viewH = (this._h - SCROLL_TOP - 10);
    const scrollY = this._scroll?.scrollY ?? 0;
    const prevMax = Math.max(0, (this._scroll?.contentHeight ?? this._scroll?._contentH ?? 0) - viewH);
    const wasAtBottom = !this._scroll || scrollY >= (prevMax - 2);
    const rowH = this._rowHeight || JOURNAL_ROW_FALLBACK_H;
    const startY = Math.max(0, scrollY - rowH * JOURNAL_OVERSCAN_ROWS);
    const endY = scrollY + viewH + rowH * JOURNAL_OVERSCAN_ROWS;

    const q = this._searchQuery;
    let row = 0;
    let matched = 0;
    for (const line of this._lines) {
      if (!this._matchesTab(line)) continue;
      if (q && !(line.lowerText ?? '').includes(q) && !(line.lowerName ?? '').includes(q)) continue;
      const y = matched * rowH;
      matched++;
      if (y + rowH < startY || y > endY) continue;
      // Per-channel hue from profile (chat.speechHue/whisperHue/etc.).
      // Falls back to the raw packet hue, then the cream default.
      const raw = line.hue || 0;
      const channelHue = hueForTextType(line.textType, raw || 0xFFFF);
      let useHue = (channelHue && channelHue !== 0xFFFF) ? channelHue
                   : (line.textType === TextType.System ? 0xa0c0e0 : 0xc0b890);
      // Audit rev.9 P3 #2 — vendor-keyword highlight: messages tagged
      // by message-manager get a cyan tint so the player sees which
      // speech NPCs will react to.
      if (line.matchesVendorKeyword) useHue = 0x60ffff;
      let lbl = this._rowPool[row];
      if (!lbl) {
        lbl = new Label('', { fontSize: 11, hue: useHue, stroke: false });
        lbl.acceptMouseInput = false;
        this._rowPool[row] = lbl;
        this._scroll.add(lbl);
      }
      lbl.setText?.(`${line.name}: ${line.text}`);
      lbl.setHue?.(useHue);
      lbl.visible = true;
      lbl.node.visible = true;
      lbl.setPosition(2, y);
      const measuredRowH = (lbl.height || 13) + ROW_PAD;
      if (measuredRowH > 0 && measuredRowH !== this._rowHeight) this._rowHeight = measuredRowH;
      row++;
    }
    if (matched === 0) {
      let lbl = this._rowPool[row];
      if (!lbl) {
        lbl = new Label('', { fontSize: 11, hue: 0x808080, stroke: false });
        lbl.acceptMouseInput = false;
        this._rowPool[row] = lbl;
        this._scroll.add(lbl);
      }
      lbl.setText?.(this._searchQuery ? `No journal entry matches "${this._searchQuery}".` : 'No journal entries.');
      lbl.setHue?.(0x808080);
      lbl.visible = true;
      lbl.node.visible = true;
      lbl.setPosition(2, 4);
      row++;
    }
    for (let i = row; i < this._rowPool.length; i++) {
      const lbl = this._rowPool[i];
      if (lbl?.node) lbl.node.visible = false;
    }
    const contentH = matched === 0 ? 20 : matched * (this._rowHeight || rowH);
    this._scroll.setContentHeight(contentH);
    if (wasAtBottom && !this._scrollLocked) {
      this._scroll.scrollTo(Math.max(0, contentH - viewH));
    }
  }
}
