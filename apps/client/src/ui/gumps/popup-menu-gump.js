// PopupMenuGump — context-menu list for a clicked entity. Mirrors CUO
// `Game/UI/Gumps/PopupMenuGump.cs`.
//
// Server emits 0xBF subop 0x14 DisplayContextMenu after we send 0xBF
// subop 0x15 PopupMenuRequest. Each entry is { responseId, cliloc,
// flags (disabled / coloured), colour }. Clicking sends 0xBF subop 0x16
// PopupMenuChoice with the selected responseId.

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Label } from '../controls/label.js';
import { GumpPic } from '../controls/gump-pic.js';
import { net } from '../../net/net-client.js';
import { buildPopupMenuChoice } from '../../net/outgoing.js';
import { assets } from '../../assets/asset-manager.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';

const ROW_H = 22;
const PAD   = 6;

class MenuRow extends Control {
  constructor(width, label, { disabled = false, colour = 0, onClick, hasSubmenu = false, onHover }) {
    super();
    this.width = width;
    this.height = ROW_H;
    this.acceptMouseInput = !disabled;
    this._disabled = disabled;
    this._hasSubmenu = hasSubmenu;
    this._onHover = onHover;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    const hue = colour ? (0xff0000 ^ (colour & 0xffff)) : (disabled ? 0x707080 : 0xfff0c0);
    this._lbl = new Label(label, { fontSize: 11, hue });
    this._lbl.setPosition(8, 5);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    if (hasSubmenu) {
      this._arrow = new Label('▶', { fontSize: 10, hue });
      this._arrow.setPosition(width - 14, 6);
      this._arrow.acceptMouseInput = false;
      this.add(this._arrow);
    }
    this._onClick = onClick;
  }
  _draw(hover) {
    this._frame.clear();
    // Subtle parchment-tinted hover. The popup menu's background is now
    // the canonical UO 0x0910 art (see PopupMenuGump.constructor),
    // so the per-row hover is just a soft brown highlight that reads
    // against the parchment instead of the modern dark-blue rectangle.
    if (hover) {
      this._frame.rect(0, 0, this.width, this.height)
        .fill({ color: 0xc89060, alpha: 0.28 });
    }
  }
  onMouseEnter() {
    if (this._disabled) return;
    this._draw(true);
    if (this._hasSubmenu) this._onHover?.();
  }
  onMouseLeave() { this._draw(false); }
  onClick() {
    if (this._disabled) return;
    if (this._hasSubmenu) this._onHover?.();   // open the submenu on click too
    else this._onClick?.();
  }
}

export class PopupMenuGump extends Gump {
  /** @param {{ serial:number, entries:{responseId:number, cliloc:number, flags:number, colour:number}[] }} info */
  constructor({ serial, entries }, sx = 200, sy = 200) {
    super();
    this.serial = serial >>> 0;
    this.entries = entries ?? [];
    // Resolve cliloc text once.
    this._labels = this.entries.map((e) => assets.cl(e.cliloc, '') || `#${e.cliloc}`);
    const widest = Math.max(80, ...this._labels.map((s) => s.length * 7 + 24));
    const w = Math.min(280, widest);
    const h = this.entries.length * (ROW_H + 2) + PAD * 2;
    this.setPosition(sx, sy);
    this.setSize(w, h);
    // Canonical UO context-menu background (0x0910 — 296×136 parchment
    // with brass border baked in). Stretched to fit the menu rect; UO
    // art tolerates moderate stretching since the chrome is mostly
    // border + flat fill. Replaces the earlier dark-blue Graphics
    // rect that read as "Discord context menu", not UO. Marcin asked
    // for canonical chrome everywhere.
    const bg = new GumpPic(0x0910, { width: w, height: h });
    bg.acceptMouseInput = true;
    bg.isDragHandle = true;
    this.add(bg);
    let y = PAD;
    /** @type {PopupMenuGump | null} active submenu — closed before opening another */
    this._submenu = null;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      // ServUO context-menu sub-menu flag is bit 0x02 in `flags`. The
      // `children` array (set by client-side providers) takes priority
      // and lets us nest synthetic menus that don't go through the
      // 0xBF subop 0x14 wire path.
      const hasSubmenu = !!(e.children?.length) || (e.flags & 0x02) !== 0;
      const row = new MenuRow(w - PAD * 2, this._labels[i] || '?', {
        disabled: (e.flags & 0x01) !== 0,
        colour: e.colour,
        hasSubmenu,
        onHover: hasSubmenu ? () => this._openSubmenu(e, sx + w - 4, sy + y - 2) : null,
        onClick: () => this._send(e.responseId),
      });
      row.setPosition(PAD, y);
      this.add(row);
      y += ROW_H + 2;
    }
    // Auto-close when the user clicks anywhere outside (handled by
    // UIManager when isModal=false; we set a short auto-close timer
    // as a defensive fallback).
    this._autoCloseAt = performance.now() + 8000;
  }
  get type() { return 'popup-menu'; }
  _send(responseId) {
    try { net.send(buildPopupMenuChoice(this.serial, responseId)); }
    catch { /* socket transient */ }
    this._closeSubmenu();
    this.close();
  }
  _openSubmenu(parentEntry, sx, sy) {
    // Close any sibling submenu that's already open.
    this._closeSubmenu();
    const children = parentEntry.children
      ?? (parentEntry.subEntries ?? []);
    if (!children.length) return;
    const sub = new PopupMenuGump({ serial: this.serial, entries: children }, sx, sy);
    sub._parentMenu = this;
    this._submenu = sub;
    // Push through the gump manager so it layers correctly.
    try {
      uiManagerInstance.get()?.addGump?.(sub);
    } catch { /* fallback: caller mounts via add(sub) */ }
  }
  _closeSubmenu() {
    if (this._submenu) {
      try { this._submenu.close(); } catch { /* ignore */ }
      this._submenu = null;
    }
  }
  close() {
    this._closeSubmenu();
    super.close?.();
  }
  tick(_dt, now = performance.now()) {
    if (this._autoCloseAt && now > this._autoCloseAt) this.close();
  }
}
