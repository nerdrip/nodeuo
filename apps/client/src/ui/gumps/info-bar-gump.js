// InfoBarGump — pinned strip of stat cells driven by InfoBarManager.
// Mirrors CUO `Game/UI/Gumps/InfoBarGump.cs`.
//
// Each cell shows `<label>: <value>` for one InfoBarVar. The bar polls
// `infoBar.valueFor(var)` each frame; values that change visibly trigger
// a re-render. Right-click a cell to remove it. Drag the bar header to
// reposition.

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Label } from '../controls/label.js';
import { bus } from '../../core/event-bus.js';
import { infoBar } from '../../managers/info-bar-manager.js';

const PAD = 4;
const CELL_W = 88;
const CELL_H = 22;
const REFRESH_MS = 100;

class InfoCell extends Control {
  constructor(item) {
    super();
    this.item = item;
    this.width = CELL_W;
    this.height = CELL_H;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this._frame.rect(0, 0, CELL_W, CELL_H)
      .fill({ color: 0x14263e, alpha: 0.95 })
      .stroke({ width: 1, color: 0x6a4a18 });
    this.node.addChild(this._frame);
    this._kLabel = new Label(infoBar.labelFor(item.var) + ':', {
      fontSize: 10, hue: 0xc0a070,
    });
    this._kLabel.setPosition(4, 5);
    this._kLabel.acceptMouseInput = false;
    this.add(this._kLabel);
    this._vLabel = new Label('-', { fontSize: 11, hue: item.hue });
    this._vLabel.setPosition(36, 4);
    this._vLabel.acceptMouseInput = false;
    this.add(this._vLabel);
    this._lastValue = null;
  }
  refresh() {
    const v = infoBar.valueFor(this.item.var);
    const text = v == null ? '-' : String(v);
    if (text !== this._lastValue) {
      this._lastValue = text;
      this._vLabel.setText(text);
    }
  }
  onClick(button) {
    if (button !== 2) return;
    // Right click → remove from configured items.
    const items = infoBar.getItems().filter((it) => it.var !== this.item.var);
    infoBar.setItems(items);
  }
  // Audit #46 P2 — double-click anywhere on a cell → open InfoBarBuilder
  // so the user can add/remove vars without right-click-deleting first.
  onDoubleClick() {
    try {
      // Bus event is canonical entry point (see game-scene macro:gump router).
      import('../../core/event-bus.js').then(({ bus }) =>
        bus.emit('macro:gump', { kind: 'info-bar-builder' }));
    } catch { /* ignore */ }
  }
}

export class InfoBarGump extends Gump {
  constructor(x = 8, y = 60) {
    super();
    this.setPosition(x, y);
    this._cells = [];
    this._lastRefreshAt = 0;
    this._unsubs = [
      bus.on('infobar:changed', () => this._build()),
      bus.on('frame:tick',      (now) => this._refresh(now)),
    ];
    this._build();
  }
  get type() { return 'infobar'; }
  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  _build() {
    // Drop existing children, rebuild from manager state.
    for (const c of this._cells) try { this.remove(c); } catch { /* noop */ }
    this._cells.length = 0;
    if (this._bgCtrl) try { this.remove(this._bgCtrl); } catch { /* noop */ }

    const items = infoBar.getItems();
    const w = items.length * (CELL_W + PAD) + PAD;
    const h = CELL_H + PAD * 2;
    this.setSize(w, h);

    const bg = new Graphics();
    bg.rect(0, 0, w, h)
      .fill({ color: 0x0d1320, alpha: 0.85 })
      .stroke({ width: 1, color: 0x6a4a18 });
    const bgCtrl = new Control();
    bgCtrl.width = w; bgCtrl.height = h;
    bgCtrl.acceptMouseInput = true;
    bgCtrl.isDragHandle = true;
    bgCtrl.node.addChild(bg);
    this.add(bgCtrl);
    this._bgCtrl = bgCtrl;

    let cx = PAD;
    for (const item of items) {
      const cell = new InfoCell(item);
      cell.setPosition(cx, PAD);
      this.add(cell);
      this._cells.push(cell);
      cx += CELL_W + PAD;
    }
    this._refresh(performance.now(), true);
  }
  _refresh(now = performance.now(), force = false) {
    if (!force && now - this._lastRefreshAt < REFRESH_MS) return;
    this._lastRefreshAt = now;
    for (const cell of this._cells) cell.refresh();
  }
}
