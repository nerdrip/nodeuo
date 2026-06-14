// DataBox — reusable sortable / pageable table widget.
// Mirrors ClassicUO `Game/UI/Controls/DataBox.cs` semantics:
//
//   const tbl = new DataBox({ width: 300, height: 200, columns: [
//     { key: 'name',  label: 'Name',  width: 140 },
//     { key: 'qty',   label: 'Qty',   width: 60, align: 'right' },
//     { key: 'price', label: 'Price', width: 80, align: 'right' },
//   ] });
//   tbl.setRows([{ name:'cloth', qty:3, price:12 }, ...]);
//
// Click a header to sort; click a row to fire `onRowClick(row, index)`.
// The control owns a single Graphics for backgrounds + headers and an
// array of Label children for cells. Cells re-fill on `setRows()`.

import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

export class DataBox extends Control {
  constructor({ width = 300, height = 200, columns = [], rowHeight = 18 } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.columns = columns;
    this.rowHeight = rowHeight;
    this._rows = [];
    this._sortKey = null;
    this._sortDir = 1;
    this._scrollY = 0;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._cellPool = [];     // re-used Label objects
    this.acceptMouseInput = true;
    this._draw();
  }

  setRows(rows) {
    this._rows = Array.isArray(rows) ? rows.slice() : [];
    if (this._sortKey) this._applySort();
    this._draw();
  }

  _applySort() {
    const key = this._sortKey, dir = this._sortDir;
    this._rows.sort((a, b) => {
      const av = a?.[key], bv = b?.[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }

  onMouseDown(_btn, lx, ly) {
    // Header click → sort.
    if (ly < this.rowHeight) {
      let cx = 0;
      for (const c of this.columns) {
        if (lx >= cx && lx < cx + c.width) {
          if (this._sortKey === c.key) this._sortDir = -this._sortDir;
          else { this._sortKey = c.key; this._sortDir = 1; }
          this._applySort();
          this._draw();
          return;
        }
        cx += c.width;
      }
      return;
    }
    // Body click → onRowClick callback.
    const idx = Math.floor((ly - this.rowHeight) / this.rowHeight) + Math.floor(this._scrollY / this.rowHeight);
    if (idx >= 0 && idx < this._rows.length) this.onRowClick?.(this._rows[idx], idx);
  }

  /** Audit #46 P2 — mousewheel scroll. Without this `_scrollY` never
   *  advanced and any list >visRows could not be reached. UIManager
   *  walks ancestors looking for `onWheel`, so this lights up on hover. */
  onWheel(deltaY) {
    const visRows = Math.max(1, Math.floor((this.height - this.rowHeight) / this.rowHeight));
    const maxScroll = Math.max(0, (this._rows.length - visRows) * this.rowHeight);
    this._scrollY = Math.max(0, Math.min(maxScroll, this._scrollY + (deltaY > 0 ? this.rowHeight : -this.rowHeight)));
    this._draw();
  }

  _draw() {
    const g = this._gfx;
    g.clear();
    // Background.
    g.rect(0, 0, this.width, this.height)
      .fill({ color: 0x0a0908, alpha: 0.85 })
      .stroke({ width: 1, color: 0x3a2a14 });
    // Header.
    g.rect(0, 0, this.width, this.rowHeight)
      .fill({ color: 0x2a1f10, alpha: 0.95 });
    // Hide existing labels.
    for (const l of this._cellPool) if (l?.node) l.node.visible = false;
    let cellIdx = 0;
    let cx = 0;
    for (const c of this.columns) {
      const arrow = (this._sortKey === c.key) ? (this._sortDir > 0 ? ' ▲' : ' ▼') : '';
      this._reuseLabel(cellIdx++, c.label + arrow, cx + 4, 3, { hue: 0xffe080, bold: true });
      cx += c.width;
    }
    // Body rows.
    const startRow = Math.floor(this._scrollY / this.rowHeight);
    const visRows = Math.floor((this.height - this.rowHeight) / this.rowHeight);
    for (let i = 0; i < visRows; i++) {
      const r = this._rows[startRow + i];
      if (!r) break;
      const y = this.rowHeight + i * this.rowHeight;
      // Zebra striping.
      if (i % 2 === 1) g.rect(0, y, this.width, this.rowHeight).fill({ color: 0x140e08, alpha: 0.5 });
      let bx = 0;
      for (const c of this.columns) {
        const v = r[c.key];
        const text = v == null ? '' : String(v);
        const tx = c.align === 'right' ? bx + c.width - (text.length * 6 + 4) : bx + 4;
        this._reuseLabel(cellIdx++, text, tx, y + 3, { hue: 0xe8d0a0 });
        bx += c.width;
      }
    }
  }

  _reuseLabel(idx, text, x, y, opts) {
    let lbl = this._cellPool[idx];
    if (!lbl) {
      lbl = new Label(text, { fontSize: 11, hue: opts?.hue ?? 0xe8d0a0, stroke: false });
      this.node.addChild(lbl.node);
      this._cellPool[idx] = lbl;
    } else {
      lbl.setText(text);
      lbl.setHue?.(opts?.hue ?? 0xe8d0a0);
    }
    lbl.setPosition(x, y);
    lbl.node.visible = true;
  }
}
