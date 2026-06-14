// MacroGump — list/edit/remove macros + key-capture record button.
// Mirrors ClassicUO's Game/UI/Gumps/MacroGump.cs at MVP scope.
//
// Layout:
//   ┌──────────────────────────────────────────┐
//   │ Macros                              [X]  │
//   │ ┌──────────────────┐ ┌────────────────┐  │
//   │ │ Macro list       │ │ Editor         │  │
//   │ │ - Ctrl+J Journal │ │ Hotkey: …      │  │
//   │ │ - F1 Heal        │ │ Actions:       │  │
//   │ │ ...              │ │  · open-…      │  │
//   │ │ + New            │ │ [Record key]   │  │
//   │ └──────────────────┘ │ [Save] [Del]   │  │
//   │                      └────────────────┘  │
//   └──────────────────────────────────────────┘
//
// "Record key" listens for a single keydown (with ctrl/shift/alt) and
// stores it on the macro under edit. Action editing is keyword-based:
// the user types `open-journal`, `say Hello`, `cast Greater Heal`,
// etc. Validation is loose (the runner ignores unknown kinds).

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { TextInput } from '../controls/text-input.js';
import { macroManager } from '../../managers/macro-manager.js';
import { formatHotkeyCombo } from '../../shared/hotkey-combo.js';

/** Audit rev.4 P2 — coarse categorization of the ~143 macro actions.
 *  Mirrors CUO's MacroType groups (Speech / Combat / Spells / Skills /
 *  Targeting / Movement / Items / Pets / UI / Misc) so the user can
 *  navigate the flat action list without remembering exact kind names. */
const MACRO_CATEGORIES = [
  { name: 'Speech',    kinds: ['say', 'emote', 'whisper', 'yell'] },
  { name: 'Combat',    kinds: ['attack-last', 'attack-selected', 'clear-target', 'toggle-war',
                               'primary-ability', 'secondary-ability', 'arm-disarm', 'equip-last'] },
  { name: 'Spells',    kinds: ['cast', 'cast-last', 'open-spellbook'] },
  { name: 'Skills',    kinds: ['use-skill', 'last-skill', 'meditation', 'hiding', 'stealth', 'peacemaking'] },
  { name: 'Targeting', kinds: ['target-self', 'target-last', 'target-next', 'beneficial-target'] },
  { name: 'Movement',  kinds: ['toggle-run', 'walk-north', 'walk-south', 'walk-east', 'walk-west'] },
  { name: 'Items',     kinds: ['bandage-self', 'use-item', 'open-backpack', 'last-object'] },
  { name: 'Pets',      kinds: ['all-kill', 'all-follow', 'all-guard', 'all-stay', 'all-come'] },
  { name: 'UI',        kinds: ['open-paperdoll', 'open-journal', 'open-skills', 'open-status',
                               'open-map', 'open-party', 'close-all-gumps'] },
  { name: 'Misc',      kinds: ['delay', 'if', 'loop', 'break', 'wait-for-target', 'wait-for-cast'] },
];

class TextButton extends Control {
  constructor({ label, width = 80, height = 22, onClick }) {
    super();
    this.width = width;
    this.height = height;
    this._label = label;
    this._onClick = onClick;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._txt.acceptMouseInput = false;
    this.add(this._txt);
    this.acceptMouseInput = true;
    this._draw();
  }
  setLabel(label) { this._label = label; this._txt.setText(label); this._draw(); }
  onMouseDown() { this._onClick?.(); }
  _draw() {
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height).fill({ color: 0x1c1612 }).stroke({ width: 1, color: 0x4a3818 });
    this._txt.setPosition((this.width - this._label.length * 6) / 2, 4);
  }
}

class ListItem extends Control {
  constructor({ label, width = 200, active = false, onClick, onContext }) {
    super();
    this.width = width;
    this.height = 18;
    this._label = label;
    this._active = active;
    this._onClick = onClick;
    this._onContext = onContext;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Label(label, { fontSize: 11, hue: 0xc0b890, stroke: false });
    this._txt.acceptMouseInput = false;
    this.add(this._txt);
    this._txt.setPosition(6, 3);
    this.acceptMouseInput = true;
    this._draw();
  }
  setActive(v) { this._active = v; this._draw(); }
  onMouseDown(btn) {
    if (btn === 2) this._onContext?.();
    else this._onClick?.();
  }
  _draw() {
    this._gfx.clear();
    if (this._active) this._gfx.rect(0, 0, this.width, this.height).fill({ color: 0x4a3818 });
  }
}

export class MacroGump extends WindowGump {
  constructor() {
    super({ title: 'Macros', width: 460, height: 320, x: 80, y: 60 });

    /** index in macroManager.macros that's being edited, or -1 for new. */
    this._editingIndex = -1;
    /** scratch macro under edit. */
    this._draft = this._newDraft();
    /** captured key handler when "Record" is active. */
    this._captureHandler = null;

    this._listItems = [];
    this._buildList();
    this._buildEditor();
  }

  _newDraft() {
    return { key: '', ctrl: false, shift: false, alt: false, actions: [] };
  }

  _buildList() {
    const lblHdr = new Label('Saved macros', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    lblHdr.setPosition(12, 28);
    this.add(lblHdr);

    // Slot counter — CUO `MacroGump.cs::TitleString` shows "N / 256".
    // Just an honest count; users can self-restrain since we don't
    // server-gate macros.
    this._slotCounter = new Label('0 / 256', { fontSize: 10, hue: 0xa08868, stroke: false });
    this._slotCounter.setPosition(180, 30);
    this.add(this._slotCounter);
    this._triggerCounter = new Label('0 triggers', { fontSize: 10, hue: 0xa08868, stroke: false });
    this._triggerCounter.setPosition(180, 42);
    this.add(this._triggerCounter);

    this._listY0 = 50;
    this._refreshList();

    const newBtn = new TextButton({
      label: '+ New', width: 200, onClick: () => {
        this._editingIndex = -1;
        this._draft = this._newDraft();
        this._refreshEditor();
        this._refreshList();
      },
    });
    newBtn.setPosition(12, 290);
    this.add(newBtn);

    // Audit rev.4 P3 — export / import macros. We export the local
    // JSON snapshot and also import ClassicUO macros.xml for profile
    // migration.
    const exportBtn = new TextButton({
      label: 'Export', width: 60, onClick: () => this._exportMacros(),
    });
    exportBtn.setPosition(218, 290);
    this.add(exportBtn);
    const importBtn = new TextButton({
      label: 'Import', width: 60, onClick: () => this._importMacros(),
    });
    importBtn.setPosition(282, 290);
    this.add(importBtn);
    const triggersBtn = new TextButton({
      label: 'Triggers', width: 72, onClick: () => this._showTriggers(),
    });
    triggersBtn.setPosition(346, 290);
    this.add(triggersBtn);
  }

  _exportMacros() {
    const json = macroManager.exportToString();
    // Open in a tiny modal with a copy-to-clipboard textarea.
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:9999; background:#1f1a12; border:2px solid #6e5520;
      padding:14px; width:520px; font:12px Consolas, monospace; color:#e8d0a0;
    `;
    div.innerHTML = `
      <div style="margin-bottom:8px">Macro export (copy this JSON):</div>
      <textarea style="width:100%; height:240px; background:#0a0908; color:#e8d0a0; border:1px solid #4a3818; font:11px Consolas; padding:6px">${json.replace(/</g, '&lt;')}</textarea>
      <div style="text-align:right; margin-top:10px"><button id="cc-mx-close" style="padding:4px 14px">Close</button></div>
    `;
    document.body.appendChild(div);
    div.querySelector('#cc-mx-close').onclick = () => div.remove();
  }

  _importMacros() {
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:9999; background:#1f1a12; border:2px solid #6e5520;
      padding:14px; width:520px; font:12px Consolas, monospace; color:#e8d0a0;
    `;
    div.innerHTML = `
      <div style="margin-bottom:8px">Paste macro JSON or ClassicUO macros.xml to import (overwrites current set):</div>
      <textarea id="cc-mx-input" style="width:100%; height:200px; background:#0a0908; color:#e8d0a0; border:1px solid #4a3818; font:11px Consolas; padding:6px"></textarea>
      <div style="text-align:right; margin-top:10px">
        <button id="cc-mx-cancel" style="padding:4px 14px; margin-right:6px">Cancel</button>
        <button id="cc-mx-apply"  style="padding:4px 14px; background:#5a3a18; color:#fff">Import</button>
      </div>
    `;
    document.body.appendChild(div);
    div.querySelector('#cc-mx-cancel').onclick = () => div.remove();
    div.querySelector('#cc-mx-apply').onclick = () => {
      const text = div.querySelector('#cc-mx-input').value;
      const n = macroManager.importFromString(text);
      if (n >= 0) {
        this._editingIndex = -1;
        this._draft = this._newDraft();
        this._refreshList();
        this._refreshEditor();
      }
      div.remove();
    };
  }

  _showTriggers() {
    const rows = macroManager.triggerSummaries?.() ?? [];
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
    const body = rows.length
      ? rows.map((r) => `
        <tr>
          <td>${esc(r.label)}</td>
          <td>${esc(r.event)}</td>
          <td>${esc(r.predicate || 'always')}</td>
          <td>${esc(r.action || '-')}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="color:#a08868">No reactive triggers configured.</td></tr>';
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:9999; background:#1f1a12; border:2px solid #6e5520;
      padding:14px; width:640px; font:12px Consolas, monospace; color:#e8d0a0;
    `;
    div.innerHTML = `
      <div style="margin-bottom:8px">Reactive macro triggers</div>
      <table style="width:100%; border-collapse:collapse">
        <thead>
          <tr style="color:#ffefb0">
            <th style="text-align:left">Macro</th>
            <th style="text-align:left">Event</th>
            <th style="text-align:left">Predicate</th>
            <th style="text-align:left">First action</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
      <div style="text-align:right; margin-top:10px"><button id="cc-mx-tr-close" style="padding:4px 14px">Close</button></div>
    `;
    document.body.appendChild(div);
    div.querySelector('#cc-mx-tr-close').onclick = () => div.remove();
  }

  _refreshList() {
    for (const it of this._listItems) {
      try { it.dispose?.(); } catch { /* ignore */ }
    }
    this._listItems = [];
    let y = this._listY0;
    if (this._slotCounter) this._slotCounter.setText(`${macroManager.macros.length} / 256`);
    if (this._triggerCounter) {
      const n = macroManager.triggerSummaries?.().length ?? 0;
      this._triggerCounter.setText(`${n} trigger${n === 1 ? '' : 's'}`);
    }
    for (let i = 0; i < macroManager.macros.length; i++) {
      const m = macroManager.macros[i];
      const desc = `${this._formatKey(m)} — ${(m.actions[0]?.kind ?? '?')}${m.actions[0]?.arg ? ' ' + m.actions[0].arg.slice(0, 14) : ''}`;
      const it = new ListItem({
        label: desc, width: 180, active: i === this._editingIndex,
        onClick: () => {
          this._editingIndex = i;
          this._draft = JSON.parse(JSON.stringify(m));
          this._refreshEditor();
          this._refreshList();
        },
        onContext: () => {
          macroManager.remove(i);
          if (this._editingIndex === i) {
            this._editingIndex = -1;
            this._draft = this._newDraft();
            this._refreshEditor();
          }
          this._refreshList();
        },
      });
      it.setPosition(12, y);
      this.add(it);
      this._listItems.push(it);
      // Up / down reorder buttons — pragmatic substitute for drag.
      const upBtn = new TextButton({
        label: '↑', width: 18, height: 18,
        onClick: () => this._reorder(i, i - 1),
      });
      upBtn.setPosition(196, y);
      this.add(upBtn);
      this._listItems.push(upBtn);
      const downBtn = new TextButton({
        label: '↓', width: 18, height: 18,
        onClick: () => this._reorder(i, i + 1),
      });
      downBtn.setPosition(218, y);
      this.add(downBtn);
      this._listItems.push(downBtn);
      y += 20;
      if (y > 280) break;
    }
  }

  /** Move macro at index `from` to index `to`, clamping at list bounds. */
  _reorder(from, to) {
    const arr = macroManager.macros;
    if (from === to || from < 0 || from >= arr.length || to < 0 || to >= arr.length) return;
    const [m] = arr.splice(from, 1);
    arr.splice(to, 0, m);
    if (this._editingIndex === from) this._editingIndex = to;
    else if (this._editingIndex === to) this._editingIndex = from;
    macroManager._save?.();
    this._refreshList();
  }

  _formatKey(m) {
    return formatHotkeyCombo(m) || '?';
  }

  _buildEditor() {
    const X = 246;
    let y = 50;

    const hdr = new Label('Editor', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    hdr.setPosition(X, 28);
    this.add(hdr);

    this._keyLabel = new Label(`Hotkey: ${this._formatKey(this._draft)}`, {
      fontSize: 11, hue: 0xc0b890, stroke: false });
    this._keyLabel.setPosition(X, y);
    this.add(this._keyLabel);
    y += 22;

    this._recordBtn = new TextButton({
      label: 'Record key', width: 130, onClick: () => this._startRecording(),
    });
    this._recordBtn.setPosition(X, y);
    this.add(this._recordBtn);
    y += 28;

    // Audit rev.4 P2 — MacroGump categorization. CUO ships a tree of
    // 78 MacroType enums grouped by topic; we flatten 143 actions, so
    // a category picker is the practical way to navigate them. Click
    // the category label to cycle, then tap an action below to inject
    // its kind into the input.
    this._categoryIndex = 0;
    this._catLabel = new Label(`Cat: ${MACRO_CATEGORIES[0].name}`, {
      fontSize: 11, hue: 0xffe080, stroke: false });
    this._catLabel.setPosition(X, y);
    this._catLabel.acceptMouseInput = true;
    this._catLabel.onClick = () => this._cycleCategory(+1);
    this._catLabel.onDoubleClick = () => this._cycleCategory(-1);
    this.add(this._catLabel);
    y += 16;

    const lblA = new Label('Action (kind [arg]):', { fontSize: 11, hue: 0xc0b890, stroke: false });
    lblA.setPosition(X, y);
    this.add(lblA);
    y += 16;

    this._actionInput = new TextInput({
      width: 196, height: 20,
      placeholder: 'e.g. say Vas Mani · cast Heal',
      text: this._draft.actions[0]
        ? `${this._draft.actions[0].kind}${this._draft.actions[0].arg ? ' ' + this._draft.actions[0].arg : ''}`
        : '',
    });
    this._actionInput.setPosition(X, y);
    this.add(this._actionInput);
    y += 22;

    // Quick-pick row — first 4 actions from the current category as
    // tappable chips. Tapping fills the input with the action's kind.
    this._catChips = [];
    this._renderCategoryChips(X, y);
    y += 22;

    // Audit #46 P3 — per-step delay input. MacroManager accepts
    // `stepDelayMs` on runAsync; previously only programmatic callers
    // could set it. Now the editor exposes a per-macro field saved on
    // the macro object.
    const delayLbl = new Label('Step delay (ms):', {
      fontSize: 11, hue: 0xc0b890, stroke: false });
    delayLbl.setPosition(X, y);
    this.add(delayLbl);
    this._delayInput = new TextInput({
      width: 80, height: 20,
      text: String(this._draft.stepDelayMs ?? 0),
      maxLength: 6,
    });
    this._delayInput.setPosition(X + 110, y - 4);
    this.add(this._delayInput);
    y += 22;

    // Audit #46 P3 — reactive trigger config. Format:
    //   <event>|<field><op><value>
    // e.g. `combat:damage|amount>50` → fires macro on a hit ≥50 dmg.
    const trigLbl = new Label('Trigger (event|field op val):', {
      fontSize: 11, hue: 0xc0b890, stroke: false });
    trigLbl.setPosition(X, y);
    this.add(trigLbl);
    y += 16;
    const trig = this._draft.trigger;
    const triggerStr = trig
      ? `${trig.event}|${trig.when?.[0]?.field ?? ''}${trig.when?.[0]?.op ?? ''}${trig.when?.[0]?.value ?? ''}`
      : '';
    this._triggerInput = new TextInput({
      width: 196, height: 20,
      text: triggerStr,
      placeholder: 'message:journal|text contains heal',
    });
    this._triggerInput.setPosition(X, y);
    this.add(this._triggerInput);
    y += 24;

    const saveBtn = new TextButton({
      label: 'Save', width: 60, onClick: () => this._save(),
    });
    saveBtn.setPosition(X, y);
    this.add(saveBtn);

    const delBtn = new TextButton({
      label: 'Delete', width: 60, onClick: () => this._delete(),
    });
    delBtn.setPosition(X + 70, y);
    this.add(delBtn);
  }

  /** Audit rev.4 P2 — cycle the visible category. Wraps around so the
   *  user can ping back and forth without remembering which group
   *  they're in. */
  _cycleCategory(dir) {
    const n = MACRO_CATEGORIES.length;
    this._categoryIndex = ((this._categoryIndex + dir) % n + n) % n;
    this._catLabel?.setText?.(`Cat: ${MACRO_CATEGORIES[this._categoryIndex].name}`);
    this._renderCategoryChips(this._catChipsX ?? 246, this._catChipsY ?? 0);
  }

  _renderCategoryChips(X, y) {
    this._catChipsX = X;
    this._catChipsY = y;
    // Remove existing chips.
    for (const c of this._catChips) {
      try { c.dispose?.(); } catch { /* noop */ }
    }
    this._catChips = [];
    const cat = MACRO_CATEGORIES[this._categoryIndex];
    let cx = X;
    for (const kind of cat.kinds.slice(0, 5)) {
      const chip = new TextButton({
        label: kind, width: Math.min(96, 12 + kind.length * 6), height: 18,
        onClick: () => {
          // Inject kind into the action input.
          this._actionInput?.setValue(kind);
        },
      });
      chip.setPosition(cx, y);
      this.add(chip);
      this._catChips.push(chip);
      cx += chip.width + 4;
      if (cx > X + 200) break;
    }
  }

  _refreshEditor() {
    this._keyLabel?.setText?.(`Hotkey: ${this._formatKey(this._draft)}`);
    if (this._actionInput) {
      this._actionInput.setValue(
        this._draft.actions[0]
          ? `${this._draft.actions[0].kind}${this._draft.actions[0].arg ? ' ' + this._draft.actions[0].arg : ''}`
          : ''
      );
    }
  }

  _startRecording() {
    if (this._captureHandler) return;
    this._recordBtn?.setLabel('Press a key…');
    const handler = (e) => {
      e.preventDefault(); e.stopPropagation();
      this._draft.key = e.key.toLowerCase();
      this._draft.ctrl = !!e.ctrlKey;
      this._draft.shift = !!e.shiftKey;
      this._draft.alt = !!e.altKey;
      this._refreshEditor();
      this._stopRecording();
    };
    this._captureHandler = handler;
    document.addEventListener('keydown', handler, { capture: true, once: true });
  }

  _stopRecording() {
    this._captureHandler = null;
    this._recordBtn?.setLabel('Record key');
  }

  _save() {
    const raw = (this._actionInput?.value ?? '').trim();
    if (!raw) return;
    const space = raw.indexOf(' ');
    const kind = space >= 0 ? raw.slice(0, space) : raw;
    const arg  = space >= 0 ? raw.slice(space + 1) : undefined;
    this._draft.actions = arg ? [{ kind, arg }] : [{ kind }];
    // Audit #46 P3 — per-step delay + reactive trigger.
    const ms = parseInt(this._delayInput?.value ?? '0', 10) | 0;
    this._draft.stepDelayMs = Math.max(0, Math.min(60000, ms));
    const trigRaw = (this._triggerInput?.value ?? '').trim();
    if (trigRaw) {
      const [event, predicate] = trigRaw.split('|').map((s) => s.trim());
      if (event) {
        const when = [];
        if (predicate) {
          const m = predicate.match(/^(\w+)\s*(==|!=|<=|>=|<|>|contains|startsWith|endsWith)\s*(.+)$/);
          if (m) when.push({ field: m[1], op: m[2], value: m[3] });
        }
        this._draft.trigger = { event, when };
      } else {
        delete this._draft.trigger;
      }
    } else {
      delete this._draft.trigger;
    }
    if (!this._draft.key && !this._draft.trigger) return;
    if (this._editingIndex >= 0) {
      macroManager.macros[this._editingIndex] = this._draft;
      macroManager._save?.();
      macroManager.attachTriggers?.();
    } else {
      macroManager.add(this._draft);
      macroManager.attachTriggers?.();
    }
    this._editingIndex = macroManager.macros.indexOf(this._draft);
    if (this._editingIndex < 0) {
      this._editingIndex = macroManager.macros.length - 1;
    }
    this._refreshList();
  }

  _delete() {
    if (this._editingIndex < 0) {
      this._draft = this._newDraft();
      this._refreshEditor();
      return;
    }
    macroManager.remove(this._editingIndex);
    this._editingIndex = -1;
    this._draft = this._newDraft();
    this._refreshEditor();
    this._refreshList();
  }

  get type() { return 'macros'; }
}
