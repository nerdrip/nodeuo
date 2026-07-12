// Combobox — dropdown selector. Mirrors ClassicUO `Combobox.cs` at MVP
// scope. Click on the head opens a popup list; clicking an entry sets
// the selected value, fires `onChange(value)`, and closes the popup.
// Keyboard not supported yet — touch / mouse only.

import { Graphics, Text } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';

export class Combobox extends Control {
  /**
   * @param {Object} opts
   * @param {string[]} opts.values
   * @param {string}   [opts.value]      preselected value
   * @param {number}   [opts.width]      total width (default 160)
   * @param {number}   [opts.height]     row height (default 22)
   * @param {(v:string) => void} [opts.onChange]
   */
  constructor({ values = [], value = '', width = 160, height = 22, onChange = null }) {
    super();
    this._values = values.slice();
    this._value = value || values[0] || '';
    this._onChange = onChange;
    this.width = width;
    this.height = height;
    this.acceptMouseInput = true;

    this._head = new Graphics();
    this.node.addChild(this._head);
    this._headText = new Label(this._value, { fontSize: 12, hue: 0xfff0c0 });
    this._headText.setPosition(8, 4);
    this._headText.acceptMouseInput = false;
    this.add(this._headText);

    this._arrow = new Text({
      text: '▼',
      style: { fill: 0xfff0c0, fontSize: 10, fontFamily: UI_FONT_FAMILY, fontWeight: 700 },
      resolution: UI_TEXT_RESOLUTION,
      roundPixels: true,
    });
    this._arrow.position.set(width - 16, 5);
    this.node.addChild(this._arrow);

    this._popup = null;
    this._draw(false);
  }

  _draw(open) {
    this._head.clear();
    this._head.roundRect(0, 0, this.width, this.height, 2)
      .fill({ color: open ? 0x2a3450 : 0x14263e, alpha: 0.92 })
      .stroke({ width: 1, color: open ? 0xfff0a0 : 0x6a4a18 });
  }

  setValue(v, { silent = false } = {}) {
    if (this._value === v) return;
    this._value = v;
    this._headText.setText?.(v);
    if (!silent) this._onChange?.(v);
  }

  setValues(values) {
    this._values = values.slice();
    if (!this._values.includes(this._value)) {
      this.setValue(this._values[0] ?? '', { silent: true });
    }
  }

  onMouseEnter() { /* hover handled in _draw transitions if needed */ }

  onClick() { this._toggle(); }

  _toggle() {
    if (this._popup) { this._closePopup(); return; }
    this._openPopup();
  }

  _openPopup() {
    this._draw(true);
    const popup = new PopupList({
      values: this._values,
      width: this.width, rowHeight: this.height,
      onPick: (v) => { this.setValue(v); this._closePopup(); },
    });
    // Stack below the head — reusing the same parent so the popup
    // moves with our gump.
    popup.node.position.set(0, this.height + 1);
    this.add(popup);
    this._popup = popup;
  }

  _closePopup() {
    if (!this._popup) return;
    try { this._popup.dispose?.(); }
    catch { /* ignore */ }
    this._popup = null;
    this._draw(false);
  }

  dispose() { this._closePopup(); super.dispose?.(); }
}

class PopupList extends Control {
  constructor({ values, width, rowHeight, onPick }) {
    super();
    this.width = width;
    this.height = Math.max(rowHeight, values.length * rowHeight);
    this.acceptMouseInput = true;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._gfx.roundRect(0, 0, width, this.height, 2)
      .fill({ color: 0x0d1320, alpha: 0.96 })
      .stroke({ width: 1, color: 0x6a4a18 });
    let y = 0;
    for (const v of values) {
      const row = new PopupRow({ value: v, width, height: rowHeight, onClick: () => onPick?.(v) });
      row.setPosition(0, y);
      this.add(row);
      y += rowHeight;
    }
  }
}

class PopupRow extends Control {
  constructor({ value, width, height, onClick }) {
    super();
    this.width = width; this.height = height;
    this.acceptMouseInput = true;
    this._bg = new Graphics();
    this.node.addChild(this._bg);
    this._bg.rect(0, 0, width, height).fill({ color: 0x14263e, alpha: 0 });
    const lbl = new Label(value, { fontSize: 11, hue: 0xfff0c0 });
    lbl.setPosition(8, 4);
    lbl.acceptMouseInput = false;
    this.add(lbl);
    this._onClick = onClick;
  }
  onMouseEnter() {
    this._bg.clear();
    this._bg.rect(0, 0, this.width, this.height).fill({ color: 0x2a3450, alpha: 0.95 });
  }
  onMouseLeave() {
    this._bg.clear();
    this._bg.rect(0, 0, this.width, this.height).fill({ color: 0x14263e, alpha: 0 });
  }
  onClick() { this._onClick?.(); }
}
