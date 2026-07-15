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
import {
  beginSkillShortcutDrag, dropSpellShortcutOnActionBar,
} from './spell-shortcut-drag.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';

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
    this.width = 96; this.height = 20;
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
      width: 470, height: 490, x: 100, y: 90,
      backgroundId: 0x0A28,
    });
    /** @type {Map<number, {value:number, base:number, lock:number, cap:number}>} */
    this._skills = new Map();
    this._query = '';
    this._sort = 'alpha';
    this._rowLabelPool = [];
    this._rowIds = [];
    this._rowHeight = SKILL_ROW_H;
    this._selectedIndex = 0;
    this.keyboardFocusable = true;

    // Search box. TextInput emits onChange, so filtering stays immediate
    // without a background polling timer.
    this._search = new TextInput({
      width: 236, height: 22, placeholder: 'Search skills…', fontSize: 12,
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
    this.addContent(this._sortChip, 264, 29);

    this._summary = new Label('0 skills · Total 0.0', {
      fontSize: 11, hue: 0xbcae8d, maxWidth: 410,
    });
    this.addContent(this._summary, 10, 56);

    this._viewChip = new SortChip(() => {
      this._rowHeight = this._rowHeight === SKILL_ROW_H ? 22 : SKILL_ROW_H;
      this._viewChip._lbl.setText(this._rowHeight === SKILL_ROW_H ? 'Compact' : 'Comfort');
      this._redraw();
    });
    this._viewChip._lbl.setText('Compact');
    this.addContent(this._viewChip, 360, 29);

    this._detail = new Label('Select a skill to see base, cap and lock state.', {
      fontSize: 11, hue: 0xc7b995, maxWidth: 410, wordWrap: true,
    });
    this.addContent(this._detail, 10, 448);

    // Scrollable list.
    this._scroll = new ScrollArea({ width: 420, height: 370 });
    this._scroll.onScroll = () => this._redraw();
    this.addContent(this._scroll, 10, 76);
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
        `${crystal}${name.padEnd(24, ' ')} ${(s.value / 10).toFixed(1).padStart(5)}  / ${(s.cap / 10).toFixed(1).padStart(5)}  ${lockChar}`,
        isUsable ? 0xc0d8ff : 0xb8b0a0,
      );
      lbl.node.position.set(2, y);
      // Primary click invokes active skills. Right-click changes the lock;
      // this mirrors the standard panel and avoids changing caps when the
      // player merely tries to use Anatomy, Hiding, etc.
      lbl.node.eventMode = 'static';
      lbl.node.cursor = 'pointer';
      lbl.node.on('pointertap', (ev) => {
        ev.stopPropagation?.();
        this._selectedIndex = i;
        this._updateDetail(id, s);
        if (!isUsable) return;
        try { net.send(buildUseSkill(id + 1)); } catch { /* socket */ }
      });
      lbl.node.on('rightdown', (ev) => {
        ev.stopPropagation?.();
        const next = ((s.lock | 0) + 1) % 3;
        const cur = this._skills.get(id);
        if (cur) this._skills.set(id, { ...cur, lock: next });
        try { net.send(buildChangeSkillLock(id, next)); } catch { /* socket */ }
        this._redraw();
      });
      lbl.node.on('pointerdown', (ev) => {
        const native = ev.nativeEvent ?? ev.data?.originalEvent ?? ev;
        const startX = native?.clientX ?? 0;
        const startY = native?.clientY ?? 0;
        let dragging = false;
        const onMove = (move) => {
          const dx = move.clientX - startX;
          const dy = move.clientY - startY;
          if (!dragging && dx * dx + dy * dy > 25) {
            dragging = beginSkillShortcutDrag({ id: id + 1, name });
          }
        };
        const onUp = (up) => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          if (!dragging) return;
          const ui = uiManagerInstance.get();
          let control = ui?.pickAtScreen?.(up.clientX, up.clientY)?.control;
          while (control && !Number.isInteger(control.actionBarSlotIndex)) control = control.parent;
          if (control) dropSpellShortcutOnActionBar(control.actionBarSlotIndex);
          else bus.emit('ui:physical-drag-finished', {
            claimed: false, x: up.clientX, y: up.clientY,
          });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
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
    let total = 0;
    for (const s of this._skills.values()) total += Number(s.value) || 0;
    this._summary.setText(`${rows.length}/${this._skills.size} skills · Total ${(total / 10).toFixed(1)} · LMB use · RMB lock`);
    this._finishLabelFrame();
  }

  _updateDetail(id, skill) {
    const lock = ['raising', 'lowering', 'locked'][skill?.lock | 0] ?? 'unknown';
    this._detail.setText(
      `${skillNameText(id)} · current ${((skill?.value ?? 0) / 10).toFixed(1)} · ` +
      `base ${((skill?.base ?? skill?.value ?? 0) / 10).toFixed(1)} · ` +
      `cap ${((skill?.cap ?? 0) / 10).toFixed(1)} · ${lock}`,
    );
  }

  onKeyDown(event) {
    if (!this._rowIds.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      this._selectedIndex = Math.max(0, Math.min(this._rowIds.length - 1, this._selectedIndex + delta));
      const id = this._rowIds[this._selectedIndex];
      this._scroll.scrollTo(Math.max(0, this._selectedIndex * this._rowHeight - this._scroll.height / 2));
      this._updateDetail(id, this._skills.get(id));
    } else if (event.key === 'Enter') {
      const id = this._rowIds[this._selectedIndex];
      if (skillClientIndexHasAction(id)) {
        event.preventDefault();
        try { net.send(buildUseSkill(id + 1)); } catch { /* socket */ }
      }
    }
  }
}
