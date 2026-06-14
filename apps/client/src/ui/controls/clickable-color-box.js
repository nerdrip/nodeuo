// ClickableColorBox — hue-square picker. Mirrors ClassicUO
// `Game/UI/Controls/ClickableColorBox.cs`. Click opens a tiny popup
// hue grid; user picks; onChange(newHue) fires. Used by per-channel
// chat hues, paperdoll skin hue, marker color, etc.

import { Control } from '../control.js';
import { ColorBox, approxHueRgb } from './color-box.js';

export class ClickableColorBox extends Control {
  constructor({ width = 20, height = 20, hue = 0, palette = null, hueRgbFn = null } = {}) {
    super();
    this.width = width;
    this.height = height;
    this._hue = hue;
    this._palette = palette;
    this._hueRgbFn = hueRgbFn || approxHueRgb;
    this._box = new ColorBox({ width, height, hue: this._hue, hueRgbFn: this._hueRgbFn });
    this.add(this._box);
    this.acceptMouseInput = true;
  }

  get hue() { return this._hue; }
  setHue(h) { this._hue = h | 0; this._draw(); this.onChange?.(this._hue); }

  onMouseDown() { this._openPicker(); }

  _draw() {
    this._box?.setHue(this._hue);
  }

  _openPicker() {
    if (this._picker) return;
    // Use a simple DOM popup grid — Pixi gump infra is heavy for a
    // 16-entry palette. Anchored near the box's screen position.
    const palette = this._palette ?? this._defaultPalette();
    const div = document.createElement('div');
    div.style.cssText = `
      position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
      z-index:9999; background:#1f1a12; border:2px solid #6e5520;
      padding:8px; display:grid; grid-template-columns:repeat(8,1fr); gap:3px;
    `;
    for (const h of palette) {
      const sw = document.createElement('div');
      const rgb = this._hueRgbFn(h);
      sw.style.cssText = `width:22px; height:22px; cursor:pointer; background:#${rgb.toString(16).padStart(6, '0')}; border:1px solid ${h === this._hue ? '#ffe080' : '#1a1108'};`;
      sw.onclick = () => { this.setHue(h); div.remove(); this._picker = null; };
      div.appendChild(sw);
    }
    document.body.appendChild(div);
    this._picker = div;
    // Click outside to close.
    setTimeout(() => {
      const close = (ev) => {
        if (!div.contains(ev.target)) {
          div.remove(); this._picker = null;
          document.removeEventListener('mousedown', close, true);
        }
      };
      document.addEventListener('mousedown', close, true);
    }, 0);
  }

  _defaultPalette() {
    // A reasonable subset of the UO hue range — full 3500 colors is
    // overwhelming for a picker. Caller can pass a custom palette.
    return [0x0000, 0x0021, 0x0033, 0x0044, 0x0057, 0x0059, 0x0040,
            0x0026, 0x0035, 0x0142, 0x03B2, 0x002B, 0x004F, 0x0061,
            0x0072, 0x0085];
  }
}
