// BookGump — modern 2-page parchment book reader/editor. Mirrors
// CUO `Game/UI/Gumps/ModernBookGump.cs`. Two facing pages render side
// by side with page-corner navigation; in editable books the page text
// is editable in-place (multi-line `<textarea>` overlays mounted on the
// Pixi canvas via `gc.domMount`).
//
// Server hooks:
//   - 0xD4 OpenBookNew opens the book (handled in net handlers).
//   - 0x66 BookPageData replies with up-to-N pages of text.
//   - We post edits back via `buildBookPage` per page.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { net } from '../../net/net-client.js';
import { buildBookPage, buildBookHeader } from '../../net/outgoing.js';

const PAGE_W   = 220;
const PAGE_H   = 280;
const GAP      = 16;
const LINES_PER_PAGE = 14;

class PageCorner extends Control {
  constructor(label, side, onClick) {
    super();
    this.width = 24;
    this.height = 24;
    this.acceptMouseInput = true;
    this._g = new Graphics();
    this._g.poly(side === 'left'
      ? [0, 0, 24, 12, 0, 24]
      : [24, 0, 0, 12, 24, 24])
      .fill({ color: 0x6a4a18, alpha: 0.85 })
      .stroke({ width: 1, color: 0xfff0c0 });
    this.node.addChild(this._g);
    this._lbl = new Label(label, { fontSize: 14, hue: 0xfff0c0 });
    this._lbl.setPosition(side === 'left' ? 4 : 8, 4);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
  }
  onClick() { this._onClick?.(); }
}

export class BookGump extends WindowGump {
  /** @param {{serial:number, writable:boolean, pageCount:number,
   *           title:string, author:string, pages?:Array<string[]>}} info */
  constructor(info) {
    super({
      title: info.title || 'Book',
      width: PAGE_W * 2 + GAP * 2 + 16,
      height: PAGE_H + 80,
      x: 220, y: 140,
      backgroundId: 0x1F40,
    });
    this.info = info;
    this.pageIndex = 0;        // index of the LEFT page (right = +1)
    this._editorsLeft  = [];
    this._editorsRight = [];
    this._labelsLeft   = [];
    this._labelsRight  = [];
    this._domEditors   = [];

    // Author / title strip.
    this._titleLbl = new Label(info.title || '(untitled)', { fontSize: 12, hue: 0xfff0c0 });
    this.addContent(this._titleLbl, 12, 28);
    this._authorLbl = new Label(`by ${info.author || 'unknown'}`, { fontSize: 11, hue: 0x8a6a30 });
    this.addContent(this._authorLbl, 12, 44);

    // Page corners.
    const prev = new PageCorner('◀', 'left', () => this._turnPage(-2));
    prev.setPosition(8, PAGE_H + 50);
    this.add(prev);
    const next = new PageCorner('▶', 'right', () => this._turnPage(+2));
    next.setPosition(this._w - 32, PAGE_H + 50);
    this.add(next);

    // Page indicator.
    this._pageIndicator = new Label('', { fontSize: 10, hue: 0x6a5430 });
    this.addContent(this._pageIndicator, this._w / 2 - 40, PAGE_H + 56);

    // Save (editable books).
    if (info.writable) {
      const save = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 60, height: 22,
        label: 'Save', action: ButtonAction.Activate,
      });
      save.setPosition(this._w / 2 - 30, PAGE_H + 50);
      save.onClick = () => this._saveAll();
      this.add(save);
    }

    this._renderPair();
  }

  get type() { return `book:${this.info.serial}`; }
  get positionKey() { return 'book'; }

  dispose() {
    for (const ed of this._domEditors) ed.remove();
    this._domEditors.length = 0;
    super.dispose();
  }

  _turnPage(delta) {
    const newIdx = Math.max(0, Math.min((this.info.pageCount | 0) - 1,
                                       this.pageIndex + delta));
    if (newIdx === this.pageIndex) return;
    if (this.info.writable) this._captureEditors();   // persist edits before flip
    this.pageIndex = newIdx;
    this._renderPair();
  }

  _renderPair() {
    // Drop old labels.
    for (const lbl of [...this._labelsLeft, ...this._labelsRight]) lbl.dispose?.();
    this._labelsLeft.length = 0;
    this._labelsRight.length = 0;
    for (const ed of this._domEditors) ed.remove();
    this._domEditors.length = 0;

    const left  = this.info.pages?.[this.pageIndex]     ?? [];
    const right = this.info.pages?.[this.pageIndex + 1] ?? [];
    this._renderPage(left,  PAGE_W + GAP - PAGE_W, 60, this._labelsLeft,  this.pageIndex);
    this._renderPage(right, PAGE_W + GAP * 2,       60, this._labelsRight, this.pageIndex + 1);

    const total = this.info.pageCount | 0;
    this._pageIndicator.setText(
      `Page ${this.pageIndex + 1}-${Math.min(total, this.pageIndex + 2)} / ${total}`
    );
  }

  _renderPage(lines, x, y, into, idx) {
    if (this.info.writable) {
      // Multi-line textarea overlay. We position it relative to the
      // gump container's screen-space — the gump owner (UIManager)
      // exposes node.getGlobalPosition() during draw which is what we
      // use for the host coords. As a simpler alternative we overlay
      // the textarea at fixed gump-local coords mounted into the parent
      // DOM so the editor visually sits over the parchment.
      const ta = document.createElement('textarea');
      ta.className = 'uo-panel';
      ta.dataset.bookPage = String(idx);
      ta.style.cssText = `
        position:absolute; box-sizing:border-box;
        font:12px 'Times New Roman', serif; color:#3c2010;
        background:rgba(248, 230, 195, 0.9); padding:6px;
        border:1px solid #6a4a18; resize:none;
      `;
      ta.style.width  = `${PAGE_W - 8}px`;
      ta.style.height = `${PAGE_H - 16}px`;
      ta.value = lines.join('\n');
      // Attach to body — the gump itself doesn't host DOM. The editor
      // needs a manual reposition each frame because Pixi gump can be
      // dragged. We piggyback on requestAnimationFrame.
      document.body.appendChild(ta);
      this._domEditors.push(ta);
      const pos = () => {
        const rect = this._getScreenRect();
        if (!rect) { ta.style.display = 'none'; return; }
        ta.style.display = 'block';
        ta.style.left = `${rect.x + x}px`;
        ta.style.top  = `${rect.y + y}px`;
      };
      pos();
      ta._reposition = pos;
      return;
    }
    let yy = y;
    for (const line of lines.slice(0, LINES_PER_PAGE)) {
      const lbl = new Label(line, { fontSize: 11, hue: 0xfff0c0 });
      this.addContent(lbl, x, yy);
      into.push(lbl);
      yy += 14;
    }
  }

  _getScreenRect() {
    // Walk the Pixi container parent chain to find absolute screen coords.
    if (!this.node) return null;
    const wp = this.node.getGlobalPosition?.();
    if (!wp) return null;
    return { x: wp.x, y: wp.y };
  }

  _captureEditors() {
    if (!this.info.writable || !this.info.pages) return;
    for (const ta of this._domEditors) {
      const idx = +ta.dataset.bookPage;
      if (Number.isFinite(idx)) {
        this.info.pages[idx] = String(ta.value || '').split('\n');
      }
    }
  }

  _saveAll() {
    if (!this.info.writable) return;
    this._captureEditors();
    try {
      net.send(buildBookHeader(this.info.serial, this.info.title || '',
        this.info.author || '', this.info.pageCount | 0));
    } catch { /* socket */ }
    for (let i = 0; i < (this.info.pageCount | 0); i++) {
      const lines = this.info.pages?.[i] ?? [];
      try { net.send(buildBookPage(this.info.serial, i + 1, lines)); }
      catch { /* socket */ }
    }
  }

  // Reposition the textarea(s) every Pixi tick so they ride along with a
  // dragged book gump. UIManager exposes a per-tick hook via the gump's
  // own `tick()` callback.
  tick() {
    for (const ta of this._domEditors) ta._reposition?.();
  }
}
