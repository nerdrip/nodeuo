// HotkeyBox — single-key recorder control. Mirrors ClassicUO
// `Game/UI/Controls/HotkeyBox.cs`. Click → arm record mode; the
// next keydown is captured (with modifiers) and fired via
// `onCapture({ key, ctrl, shift, alt })`.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';
import { formatHotkeyCombo, normalizeHotkeyKey } from '../../shared/hotkey-combo.js';

function formatKey(b) { return formatHotkeyCombo(b) || 'Click to record'; }

export class HotkeyBox extends Control {
  constructor({ width = 160, height = 22, binding = null } = {}) {
    super();
    this.width = width;
    this.height = height;
    this._binding = binding;
    this._recording = false;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._lbl = new Label(formatKey(this._binding), { fontSize: 11, hue: 0xe8d0a0 });
    this._lbl.setPosition(6, 4);
    this.node.addChild(this._lbl.node);
    this.acceptMouseInput = true;
    this._draw();
  }

  get binding() { return this._binding; }
  setBinding(b) { this._binding = b; this._lbl.setText(formatKey(b)); this._draw(); }

  onMouseDown() { this._startRecord(); }

  _startRecord() {
    if (this._recording) return;
    this._recording = true;
    this._lbl.setText('Press any key…');
    this._draw();
    const handler = (e) => {
      // Ignore lone modifiers; capture the real key with current mods.
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const b = {
        key: normalizeHotkeyKey(e.key),
        ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey,
      };
      this.setBinding(b);
      this._recording = false;
      document.removeEventListener('keydown', handler, true);
      this.onCapture?.(b);
    };
    document.addEventListener('keydown', handler, true);
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    g.rect(0, 0, this.width, this.height)
      .fill({ color: this._recording ? 0x3a2a14 : 0x1c1612 })
      .stroke({ width: 1, color: 0x4a3818 });
  }
}
