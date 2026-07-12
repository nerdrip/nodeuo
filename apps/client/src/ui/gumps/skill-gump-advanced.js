// SkillGumpAdvanced — search + sort variant of the skills panel. Mirrors
// ClassicUO `Game/UI/Gumps/SkillGumpAdvanced.cs`. Shares the bus events
// (`skills:list` / `skills:update`) with the legacy SkillsGump so opening
// either keeps both in sync — only the presentation differs.
//
// Features beyond StandardSkillsGump:
//   - Top text-search box: filter skills whose name contains the query.
//   - Sort cycler: Alpha (by name) / Value↓ (current value descending) /
//     Cap↓ (cap descending).
//   - Flat list (no folder grouping) — the search use-case is "find the
//     one skill I want" so groups would be noise.
//
// Opens via `bus.emit('macro:gump', { kind: 'skills-advanced' })`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { TextInput } from '../controls/text-input.js';
import { Control } from '../control.js';
import { Container } from 'pixi.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { buildChangeSkillLock, buildStatusRequest, buildUseSkill } from '../../net/outgoing.js';
import { world } from '../../world/world.js';
import { skillClientIndexHasAction, skillNameFromClientIndex } from '../../shared/skill-ids.js';
import { calculateVirtualWindow } from '../../shared/virtual-list.js';

const SORT_MODES = ['alpha', 'value', 'cap'];
const SORT_LABEL = {
  alpha: 'A→Z',
  value: 'Value↓',
  cap:   'Cap↓',
};
const SKILL_ROW_H = 16;
const SKILL_ROW_OVERSCAN = 4;

const _skillNameCache = new Map();
const _skillNameLowerCache = new Map();
function skillNameText(id) {
  let name = _skillNameCache.get(id);
  if (name) return name;
  name = skillNameFromClientIndex(id);
  _skillNameCache.set(id, name);
  return name;
}
function skillNameLower(id) {
  let name = _skillNameLowerCache.get(id);
  if (name) return name;
  name = skillNameText(id).toLowerCase();
  _skillNameLowerCache.set(id, name);
  return name;
}

function scheduleFrame(fn) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(fn);
  } else {
    setTimeout(fn, 0);
  }
}

function resetPooledLabel(label, text, hue) {
  label.setText?.(text);
  label.setHue?.(hue);
  label.node.visible = true;
  label.node.eventMode = 'none';
  label.node.cursor = '';
  label.node.removeAllListeners?.();
  return label;
}

class SortChip extends Control {
  constructor(onClick) {
    super();
    this.width = 64; this.height = 18;
    this.acceptMouseInput = true;
    this._lbl = new Label(`Sort: ${SORT_LABEL.alpha}`, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
  }
  setMode(m) { this._lbl.setText?.(`Sort: ${SORT_LABEL[m]}`); }
  onMouseEnter() { this._lbl.setHue?.(0xffd060); }
  onMouseLeave() { this._lbl.setHue?.(0xfff0c0); }
  onClick(btn) { if (btn === 0) this._onClick?.(); }
}

export class SkillGumpAdvanced extends WindowGump {
  constructor() {
    super({
      title: 'Skills (Advanced)',
      width: 360, height: 400, x: 100, y: 90,
      backgroundId: 0x0A28,
    });
    /** @type {Map<number, {value:number, base:number, lock:number, cap:number}>} */
    this._skills = new Map();
    this._query = '';
    this._sort = 'alpha';
    this._rowLabelPool = [];
    this._rowIds = [];
    this._rowHeight = SKILL_ROW_H;

    // Search box. TextInput emits onChange, so filtering stays immediate
    // without a background polling timer.
    this._search = new TextInput({
      width: 180, height: 18, placeholder: 'Search skills…',
    });
    this._search.onChange = (txt) => {
      this._query = String(txt ?? '').trim();
      this._redraw();
    };
    this._search.onSubmit = this._search.onChange;
    this.addContent(this._search, 10, 28);

    // Sort cycler.
    this._sortChip = new SortChip(() => {
      const i = SORT_MODES.indexOf(this._sort);
      this._sort = SORT_MODES[(i + 1) % SORT_MODES.length];
      this._sortChip.setMode(this._sort);
      this._redraw();
    });
    this.addContent(this._sortChip, 200, 30);

    // Scrollable list.
    this._scroll = new ScrollArea({ width: 340, height: 340 });
    this._scroll.onScroll = () => this._redraw();
    this.addContent(this._scroll, 10, 52);
    this._inner = new Container();
    this._scroll.addContent(this._inner);

    this._unsubs = [
      bus.on('skills:list',   (info) => this._onList(info)),
      bus.on('skills:update', (info) => this._onUpdate(info)),
    ];

    // Pull a fresh snapshot when we open — same path as SkillsGump.
    try {
      const s = world.player?.serial;
      if (s) net.send(buildStatusRequest(s, 5));
    } catch { /* module not ready yet */ }

    this._redraw(true);
  }

  get type() { return 'skills-advanced'; }
  dispose() {
    this._destroyed = true;
    for (const u of this._unsubs) u();
    this._destroyLabelPools();
    super.dispose();
  }

  _destroyLabelPools() {
    for (const lbl of this._rowLabelPool) {
      try { lbl?.node?.destroy?.({ children: true }); } catch { /* ignore */ }
    }
    this._rowLabelPool.length = 0;
  }

  _beginLabelFrame() {
    this._rowLabelIndex = 0;
  }

  _finishLabelFrame() {
    for (let i = this._rowLabelIndex | 0; i < this._rowLabelPool.length; i++) {
      const node = this._rowLabelPool[i]?.node;
      if (!node || node.destroyed) continue;
      node.visible = false;
      node.eventMode = 'none';
      node.removeAllListeners?.();
    }
  }

  _acquireRowLabel(text, hue) {
    const idx = this._rowLabelIndex++ | 0;
    let lbl = this._rowLabelPool[idx];
    if (!lbl || lbl.node.destroyed) {
      lbl = new Label('', { fontSize: 11, hue, stroke: false });
      this._rowLabelPool[idx] = lbl;
      this._inner.addChild(lbl.node);
    }
    return resetPooledLabel(lbl, text, hue);
  }

  _onList({ skills }) {
    this._skills.clear();
    for (const s of skills) this._skills.set(s.id, s);
    this._redraw();
  }
  _onUpdate({ skill }) {
    const cur = this._skills.get(skill.id) ?? { value: 0, base: 0, lock: 0, cap: 1000 };
    this._skills.set(skill.id, { ...cur, ...skill });
    this._redraw();
  }

  _redraw(immediate = false) {
    if (this._destroyed) return;
    if (!immediate) {
      if (this._redrawQueued) return;
      this._redrawQueued = true;
      scheduleFrame(() => {
        this._redrawQueued = false;
        if (!this._destroyed) this._redraw(true);
      });
      return;
    }
    this._beginLabelFrame();
    // Build filtered + sorted list.
    const q = this._query.toLowerCase();
    const rows = this._rowIds;
    rows.length = 0;
    for (const [id] of this._skills) {
      if (q && !skillNameLower(id).includes(q)) continue;
      rows.push(id);
    }
    if (this._sort === 'alpha') {
      rows.sort((a, b) => skillNameText(a).localeCompare(skillNameText(b)));
    } else if (this._sort === 'value') {
      rows.sort((a, b) => ((this._skills.get(b)?.value ?? 0) | 0) - ((this._skills.get(a)?.value ?? 0) | 0));
    } else if (this._sort === 'cap') {
      rows.sort((a, b) => ((this._skills.get(b)?.cap ?? 0) | 0) - ((this._skills.get(a)?.cap ?? 0) | 0));
    }

    const rowH = this._rowHeight || SKILL_ROW_H;
    const viewH = this._scroll?.height ?? 340;
    const scrollY = this._scroll?.scrollY ?? 0;
    const { start, end } = calculateVirtualWindow({
      scrollY,
      viewportSize: viewH,
      itemSize: rowH,
      itemCount: rows.length,
      overscan: SKILL_ROW_OVERSCAN,
    });

    let y = start * rowH;
    for (let i = start; i < end; i++) {
      const id = rows[i];
      const s = this._skills.get(id);
      if (!s) continue;
      const name = skillNameText(id);
      const lockChar = ['↑', '↓', '🔒'][s.lock] ?? ' ';
      const isUsable = skillClientIndexHasAction(id);
      const crystal = isUsable ? '◆ ' : '  ';
      const lbl = this._acquireRowLabel(
        `${crystal}${name.padEnd(20, ' ')} ${(s.value / 10).toFixed(1).padStart(5)}  / ${(s.cap / 10).toFixed(1).padStart(5)}  ${lockChar}`,
        isUsable ? 0xc0d8ff : 0xb8b0a0,
      );
      lbl.node.position.set(2, y);
      // Click the lock char to cycle up/down/locked. CUO uses 3 buttons;
      // a single cycler keeps the row compact.
      lbl.node.eventMode = 'static';
      lbl.node.cursor = 'pointer';
      lbl.node.on('pointerdown', (ev) => {
        ev.stopPropagation?.();
        const next = ((s.lock | 0) + 1) % 3;
        try { net.send(buildChangeSkillLock(id, next)); } catch { /* socket */ }
      });
      if (isUsable) {
        // Right-click name -> invoke skill (0x12 type 0x24).
        lbl.node.on('rightdown', (ev) => {
          ev.stopPropagation?.();
          try { net.send(buildUseSkill(id + 1)); } catch { /* socket */ }
        });
      }
      y += rowH;
    }

    if (rows.length === 0) {
      const empty = this._acquireRowLabel(
        this._query ? `No skill matches "${this._query}".` : 'No skills loaded.',
        0x808080,
      );
      empty.node.position.set(2, 4);
    }
    this._scroll.setContentHeight(rows.length === 0 ? 20 : rows.length * rowH);
    this._finishLabelFrame();
  }
}
