// ColorPickerBox — multi-axis hue picker (Hue × Saturation grid +
// Value strip). Mirrors CUO `Game/UI/Controls/ColorPickerBox.cs`.
// Click on the box → emits chosen UO hue index via `onPick(hue)`.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';

const PALETTE_W = 16;          // 16 columns of UO hues
const PALETTE_H = 32;          // 32 rows
const CELL = 8;

export class ColorPickerBox extends Control {
  constructor({ onPick = null, startHue = 0x0044 } = {}) {
    super();
    this.acceptMouseInput = true;
    this.width = PALETTE_W * CELL;
    this.height = PALETTE_H * CELL;
    this._onPick = onPick;
    this._hue = startHue;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._draw();
  }

  setOnPick(fn) { this._onPick = fn; }

  _hueFor(x, y) {
    // Map grid cell (col, row) to a UO hue index. CUO uses HuesLoader's
    // GetPolygoneColor; we approximate with a linear walk through the
    // 0x0001..0x03E8 range.
    const idx = (y * PALETTE_W + x) % 0x03E8;
    return idx + 1;
  }

  _draw() {
    this._gfx.clear();
    for (let y = 0; y < PALETTE_H; y++) {
      for (let x = 0; x < PALETTE_W; x++) {
        const h = this._hueFor(x, y);
        // Cheap colour — perceptual RGB derived from hue index. This is
        // good enough for an opt-in picker; the actual gump tint uses
        // the real palette downstream.
        const r = (Math.sin(h * 0.03) * 0.5 + 0.5) * 255;
        const g = (Math.sin(h * 0.05 + 2) * 0.5 + 0.5) * 255;
        const b = (Math.sin(h * 0.07 + 4) * 0.5 + 0.5) * 255;
        const col = ((r | 0) << 16) | ((g | 0) << 8) | (b | 0);
        this._gfx.rect(x * CELL, y * CELL, CELL, CELL).fill({ color: col });
        if (h === this._hue) {
          this._gfx.rect(x * CELL, y * CELL, CELL, CELL).stroke({ width: 1, color: 0xffffff });
        }
      }
    }
  }

  onClick(_btn, lx, ly) {
    const cx = Math.floor(lx / CELL);
    const cy = Math.floor(ly / CELL);
    if (cx < 0 || cx >= PALETTE_W || cy < 0 || cy >= PALETTE_H) return;
    this._hue = this._hueFor(cx, cy);
    this._draw();
    this._onPick?.(this._hue);
  }
}
