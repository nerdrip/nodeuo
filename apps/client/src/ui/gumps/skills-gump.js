// SkillsGump — list of skills with values + lock cycling. Mirrors
// ClassicUO's Game/UI/Gumps/StandardSkillsGump.cs (without the grouping
// folders for now).
//
// Receives full snapshots via the 0x3A SkillsList packet and updates
// in-place. Clicking the lock cycles up/down/locked → emits 0x3A
// ChangeSkillLock back to the server.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Container } from 'pixi.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { bus } from '../../core/event-bus.js';
import { skillsGroupManager } from '../../managers/skills-group-manager.js';
import { net } from '../../net/net-client.js';
import { buildChangeSkillLock, buildStatusRequest, buildUseSkill } from '../../net/outgoing.js';
import { world } from '../../world/world.js';
import { skillClientIndexHasAction, skillNameFromClientIndex } from '../../shared/skill-ids.js';

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

export class SkillsGump extends WindowGump {
  constructor() {
    super({ title: 'Skills', width: 320, height: 360, x: 80, y: 80, backgroundId: 0x0A28 });

    this._scroll = new ScrollArea({ width: 300, height: 320 });
    this.addContent(this._scroll, 10, 28);

    this._inner = new Container();
    this._scroll.addContent(this._inner);

    /** @type {Map<number, {value:number, base:number, lock:number, cap:number}>} */
    this._skills = new Map();
    this._sortedSkillIds = [];
    this._headerLabelPool = [];
    this._rowLabelPool = [];
    this._footerLabelPool = [];

    this._unsubs = [
      bus.on('skills:list',   (info) => this._onList(info)),
      bus.on('skills:update', (info) => this._onUpdate(info)),
      bus.on('nodeuo:skill-insight', ({ payload }) => {
        this._skillInsight = payload ?? null;
        this._redraw();
      }),
    ];
    // Ask the server for our skills list. CUO sends 0x34 StatusReq with
    // kind=5 (skills) the moment the gump opens; without it the server
    // never pushes 0x3A and the panel stays blank.
    try {
      const s = world.player?.serial;
      if (s) net.send(buildStatusRequest(s, 5));
    } catch { /* ignore — module not yet ready */ }
    this._redraw(true);
  }

  get type() { return 'skills'; }

  dispose() {
    // Mark dead BEFORE running children's destroy() — any window-bound
    // pointerup handler (per-skill drag, see :243-301) that fires after
    // dispose will see this flag and bail instead of touching the now-
    // destroyed Pixi Graphics inside ScrollArea (`Cannot read 'clear' of
    // null` crash trail).
    this._destroyed = true;
    for (const u of this._unsubs) u();
    this._destroyLabelPools();
    super.dispose();
  }

  _destroyLabelPools() {
    for (const pool of [this._headerLabelPool, this._rowLabelPool, this._footerLabelPool]) {
      for (const lbl of pool) {
        try { lbl?.node?.destroy?.({ children: true }); } catch { /* ignore */ }
      }
      pool.length = 0;
    }
  }

  _beginLabelFrame() {
    this._headerLabelIndex = 0;
    this._rowLabelIndex = 0;
    this._footerLabelIndex = 0;
  }

  _finishLabelFrame() {
    const hide = (pool, from) => {
      for (let i = from; i < pool.length; i++) {
        const node = pool[i]?.node;
        if (!node || node.destroyed) continue;
        node.visible = false;
        node.eventMode = 'none';
        node.removeAllListeners?.();
      }
    };
    hide(this._headerLabelPool, this._headerLabelIndex | 0);
    hide(this._rowLabelPool, this._rowLabelIndex | 0);
    hide(this._footerLabelPool, this._footerLabelIndex | 0);
  }

  _acquireHeaderLabel(text, hue = 0xfff0c0) {
    const idx = this._headerLabelIndex++ | 0;
    let lbl = this._headerLabelPool[idx];
    if (!lbl || lbl.node.destroyed) {
      lbl = new Label('', { fontSize: 12, hue, stroke: false });
      this._headerLabelPool[idx] = lbl;
      this._inner.addChild(lbl.node);
    }
    return resetPooledLabel(lbl, text, hue);
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

  _acquireFooterLabel(text) {
    const idx = this._footerLabelIndex++ | 0;
    let lbl = this._footerLabelPool[idx];
    if (!lbl || lbl.node.destroyed) {
      lbl = new Label('', { fontSize: 12, hue: 0xfff0c0 });
      this._footerLabelPool[idx] = lbl;
      this._inner.addChild(lbl.node);
    }
    return resetPooledLabel(lbl, text, 0xfff0c0);
  }

  _redraw(immediate = false) {
    if (this._destroyed) return;
    if (immediate) {
      this._redrawQueued = false;
      this._doRedraw();
      return;
    }
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    scheduleFrame(() => {
      this._redrawQueued = false;
      if (!this._destroyed) this._doRedraw();
    });
  }

  _onList({ skills }) {
    this._skills.clear();
    this._sortedSkillIds.length = 0;
    for (const s of skills) {
      this._skills.set(s.id, s);
      this._sortedSkillIds.push(s.id | 0);
    }
    this._sortedSkillIds.sort((a, b) => a - b);
    this._redraw();
  }
  _onUpdate({ skill }) {
    const cur = this._skills.get(skill.id) ?? { value: 0, base: 0, lock: 0, cap: 1000 };
    if (!this._skills.has(skill.id)) {
      this._sortedSkillIds.push(skill.id | 0);
      this._sortedSkillIds.sort((a, b) => a - b);
    }
    this._skills.set(skill.id, { ...cur, ...skill });
    this._redraw();
  }

  _doRedraw() {
    this._beginLabelFrame();

    // Group skills by SkillsGroupManager folder. Each folder gets a
    // header line; collapsed/expanded state is held on the gump itself
    // (not persisted — refreshes back to expanded after reopening).
    if (!this._collapsed) this._collapsed = new Set();
    // Audit rev.9 P2 #5 — record header hit-rect ranges so per-skill
    // drag can resolve target group from cursor screen coords.
    this._headerRects = [];
    /** @type {Map<string, {id:number, s:any}[]>} */
    const groups = new Map();
    for (const folder of skillsGroupManager.groups()) groups.set(folder, []);
    for (const id of this._sortedSkillIds) {
      const s = this._skills.get(id);
      if (!s) continue;
      const folder = skillsGroupManager.groupFor(id);
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push({ id, s });
    }

    let y = 0, totalSum = 0;
    // Audit #46 P2 — drag-reorder + per-folder lock-all + rename. Folders
    // walked in `skillsGroupManager.groups()` order (now user-mutable).
    let folderIdx = -1;
    for (const [folder, list] of groups) {
      folderIdx++;
      if (list.length === 0) continue;
      const isCollapsed = this._collapsed.has(folder);
      const sum = list.reduce((a, e) => a + (e.s.value | 0), 0);
      totalSum += sum;
      const label = skillsGroupManager.labelFor?.(folder) ?? folder;
      // Header shows: chevron + label + count + sum + lock-all glyph.
      const groupLock = skillsGroupManager.getGroupLock?.(folder);
      const lockGlyph = groupLock != null ? [' ↑', ' ↓', ' 🔒'][groupLock] : '';
      const hdr = this._acquireHeaderLabel(
        `${isCollapsed ? '▶' : '▼'} ${label} (${list.length})  ${(sum / 10).toFixed(1)}${lockGlyph}`,
      );
      hdr.node.position.set(2, y);
      hdr.node.eventMode = 'static';
      hdr.node.cursor = 'pointer';
      const fIdxClosure = folderIdx;
      hdr.node.on('pointerdown', (ev) => {
        ev.stopPropagation?.();
        // Shift+click → rename. Ctrl+click → lock-all cycle. Alt+click →
        // move up in folder order. Plain click → collapse toggle.
        const ne = ev.nativeEvent ?? ev.data?.originalEvent ?? ev;
        if (ne?.shiftKey) {
          const next = window.prompt?.(`Rename group "${label}":`, label);
          if (next && next.trim()) skillsGroupManager.renameGroup?.(folder, next.trim());
          this._redraw();
          return;
        }
        if (ne?.ctrlKey) {
          const cur = skillsGroupManager.getGroupLock?.(folder);
          const nxt = cur == null ? 0 : (cur + 1) % 3;
          skillsGroupManager.lockAll?.(folder, nxt);
          for (const { id } of list) {
            try { net.send(buildChangeSkillLock(id, nxt)); } catch { /* ignore */ }
          }
          this._redraw();
          return;
        }
        if (ne?.altKey) {
          skillsGroupManager.reorderGroup?.(fIdxClosure, Math.max(0, fIdxClosure - 1));
          this._redraw();
          return;
        }
        if (this._collapsed.has(folder)) this._collapsed.delete(folder);
        else this._collapsed.add(folder);
        this._redraw();
      });
      // Stash the header rect (in inner-content coords) for DnD drop
      // hit-test. The drop handler converts cursor screen→inner via
      // the gump's getBounds().
      this._headerRects.push({ group: folder, y, h: 16 });
      y += 16;
      if (isCollapsed) continue;
      for (const { id, s } of list) {
        const name = skillNameFromClientIndex(id);
        const lockChar = ['↑', '↓', '🔒'][s.lock] ?? ' ';
        // Crystal indicator (◆) marks an INVOKABLE skill — click to
        // trigger via 0x12 (TextCommand type 0x24 = UseSkill, payload
        // is the skill id). Passive skills (Tactics, weapon skills,
        // Eval Int, Magic Resist, etc.) render a non-clickable spacer
        // so column alignment stays consistent.
        const isUsable = skillClientIndexHasAction(id);
        const crystal = isUsable ? '◆ ' : '  ';
        const lbl = this._acquireRowLabel(
          `${crystal}${name.padEnd(18, ' ')} ${(s.value / 10).toFixed(1).padStart(5)}  / ${(s.cap / 10).toFixed(1).padStart(5)}  ${lockChar}`,
          isUsable ? 0x88ddff : 0xc0b890,
        );
        lbl.node.position.set(2, y);
        // Swap the click semantics — canonical UO has LMB on the blue
        // diamond INVOKE the skill (open craft menu, evaluate target,
        // etc.) and RMB or the small lock-arrow column cycle the
        // up/down/locked state. The previous code had it inverted:
        // every plain click cycled the lock and the invoke was hidden
        // behind right-click. User report 2026-05-17 — "skille klik na
        // niebieskie kropki tylko zmienialy lock" + "po kilku
        // zamknieciach przestaly sie wyswietlac".
        //
        // We keep the lock-cycle wired but move it to the lock glyph
        // column at the end of the row — see the `lockHit` rect below.
        if (isUsable) {
          // Left-click → invoke skill via 0x12 textCommand type 0x24.
          // `decodeSkills` stores skill ids as 0-indexed (`wireId - 1`)
          // so the gump's keys agree with client-side row indexes; the server's
          // `useSkill` handler expects the canonical 1-indexed wire id
          // back. Without the `+1` correction a click on Evaluating
          // Intelligence (idx 16) sent `16` which the server matched
          // to Discordance (canon id 16, a bard skill) and replied
          // "needs musical instrument" (user report 2026-05-17).
          lbl.node.on('pointertap', (ev) => {
            const btn = ev.button ?? ev.data?.originalEvent?.button ?? 0;
            if (btn !== 0) return;     // right-button → lock-cycle path
            ev.stopPropagation?.();
            try { net.send(buildUseSkill(id + 1)); }
            catch { /* socket transient */ }
          });
        }
        // Right-click → cycle the lock state (up → down → locked → up).
        // Bound on every row, not just isUsable, because every skill has
        // a lock state (passive skills can still be capped).
        lbl.node.on('rightdown', (ev) => {
          ev.stopPropagation?.();
          const cur = (this._skills.get(id)?.lock ?? 0);
          const next = (cur + 1) % 3;
          const entry = this._skills.get(id);
          if (entry) this._skills.set(id, { ...entry, lock: next });
          try { net.send(buildChangeSkillLock(id, next)); }
          catch { /* socket transient */ }
          this._redraw();
        });
        // Click anywhere on the row to cycle the lock state up→down→lock→up
        // — matches CUO StandardSkillsGump where the lock arrow is the
        // hit target. We use the whole row because the glyph is part of
        // the same Label and we don't have a sub-region picker; close
        // enough for MVP. ServUO `Mobile.OnSkillLock` accepts 0=up,
        // 1=down, 2=lock.
        lbl.node.eventMode = 'static';
        lbl.node.cursor = 'pointer';
        // Audit rev.9 P2 #5 — per-skill drag-to-reorder between groups.
        // Capture pointerdown coordinates; if the cursor leaves the row
        // by more than 4 px before pointerup, treat it as a drag and
        // open a DOM ghost label that follows the cursor. On drop over
        // a header row we call `skillsGroupManager.setGroupFor(id,
        // group)` and re-render.
        lbl.node.on('pointerdown', (ev) => {
          ev.stopPropagation?.();
          const ne = ev.nativeEvent ?? ev.data?.originalEvent ?? ev;
          const startX = ne?.clientX ?? 0;
          const startY = ne?.clientY ?? 0;
          const skillId = id;
          let dragging = false;
          let ghost = null;
          const onMove = (mEv) => {
            const dx = (mEv.clientX | 0) - startX;
            const dy = (mEv.clientY | 0) - startY;
            if (!dragging && dx * dx + dy * dy > 16) {
              dragging = true;
              try {
                ghost = document.createElement('div');
                ghost.style.cssText = 'position:fixed;pointer-events:none;background:#1c1208;color:#fff0c0;border:1px solid #b88040;padding:3px 6px;font:11px Consolas;border-radius:3px;z-index:99999;box-shadow:0 3px 8px #000a;';
                ghost.textContent = `${skillNameFromClientIndex(skillId)}`;
                document.body?.appendChild(ghost);
              } catch { /* SSR safe */ }
            }
            if (ghost) {
              ghost.style.left = `${mEv.clientX + 8}px`;
              ghost.style.top  = `${mEv.clientY + 8}px`;
            }
          };
          const onUp = (mEv) => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup',   onUp);
            if (ghost?.parentNode) ghost.parentNode.removeChild(ghost);
            // Plain (non-drag) click: do nothing here. The blue-diamond
            // pointertap above handles `invoke skill` for usable rows,
            // and the row's `rightdown` handler below cycles the lock
            // state — canonical UO LMB invokes, RMB cycles lock. The
            // previous code cycled lock on every LMB which made every
            // gain-tracked skill toggle ↑↓🔒 instead of opening the
            // craft menu (user report 2026-05-17).
            if (!dragging) return;
            // Drag: locate the header underneath the cursor by mapping
            // the cursor's screen coords into the inner-content space
            // and walking `_headerRects` for a Y-range hit.
            try {
              const bnd = this._inner?.getBounds?.();
              if (bnd && this._headerRects) {
                const localY = mEv.clientY - bnd.y;
                for (const r of this._headerRects) {
                  if (localY >= r.y && localY < r.y + r.h) {
                    skillsGroupManager.setGroupFor?.(skillId, r.group);
                    this._redraw();
                    break;
                  }
                }
              }
            } catch { /* getBounds may throw if Pixi v8 stale */ }
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup',   onUp);
        });
        y += 14;
      }
      y += 4;       // breathing room between folders
    }
    // Total at the bottom — CUO StandardSkillsGump shows the sum of all
    // current skill values, an at-a-glance progress hint.
    const total = this._acquireFooterLabel(`Total: ${(totalSum / 10).toFixed(1)}`);
    total.node.position.set(2, y);
    y += 16;
    if (this._skillInsight?.lifecycle) {
      const insight = this._skillInsight;
      const life = insight.lifecycle;
      const training = this._acquireFooterLabel(
        `Training #${insight.skillId}: ${Number(insight.base).toFixed(1)}/${Number(insight.cap).toFixed(1)} · uses ${life.attempts} · gains tracked server-side`,
      );
      training.node.position.set(2, y);
      y += 16;
    }
    this._scroll.setContentHeight(y);
    this._finishLabelFrame();
  }
}
