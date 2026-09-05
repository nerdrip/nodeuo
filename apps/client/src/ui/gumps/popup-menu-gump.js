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
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
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
    this._labels = this.entries.map((e) => e.label || assets.cl(e.cliloc, '') || `#${e.cliloc}`);
    const petCommands = new Set([3006107, 3006108, 3006111, 3006114, 3006118]);
    if (this.entries.filter((entry) => petCommands.has(entry.cliloc)).length >= 3) {
      this._buildPetRadial(sx, sy);
      return;
    }
    const widest = Math.max(80, ...this._labels.map((s) => s.length * 7 + 24));
    const w = Math.min(280, widest);
    const h = this.entries.length * (ROW_H + 2) + PAD * 2;
    this.setPosition(sx, sy);
    this.setSize(w, h);
    // 0x0910 is a fixed illustration in this client data, not a nine-slice.
    // Stretching it behind a two-row context menu produced the noisy strip
    // visible in the screenshot. Paint stable CUO-style leather/parchment
    // chrome instead; rows remain proper Controls above it.
    this._bg = new Graphics()
      .roundRect(0, 0, w, h, 3).fill({ color: 0x17120d, alpha: 0.97 })
      .roundRect(1, 1, w - 2, h - 2, 3).stroke({ width: 2, color: 0x80602a })
      .roundRect(4, 4, w - 8, h - 8, 2).stroke({ width: 1, color: 0xc09a55, alpha: 0.55 });
    this.node.addChild(this._bg);
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
        onClick: () => this._send(e),
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
  _buildPetRadial(sx, sy) {
    const size = 260, cx = size / 2, cy = size / 2;
    this.setPosition(sx - cx, sy - cy); this.setSize(size, size);
    this._submenu = null;
    this._bg = new Graphics()
      .circle(cx, cy, 68).fill({ color: 0x17120d, alpha: 0.94 })
      .circle(cx, cy, 68).stroke({ width: 2, color: 0xc09a55, alpha: 0.85 })
      .circle(cx, cy, 24).fill({ color: 0x3b2b16, alpha: 1 })
      .circle(cx, cy, 24).stroke({ width: 1, color: 0xffd36a, alpha: 0.9 });
    this.node.addChild(this._bg);
    const center = new Label('PET', { fontSize: 10, hue: 0xffd36a });
    center.setPosition(cx - 10, cy - 6); this.add(center);
    const count = this.entries.length;
    for (let i = 0; i < count; i++) {
      const entry = this.entries[i];
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / count);
      const width = 106;
      const row = new MenuRow(width, this._labels[i] || '?', {
        disabled: (entry.flags & 0x01) !== 0, colour: entry.colour,
        onClick: () => this._send(entry),
      });
      row.setPosition(cx + Math.cos(angle) * 94 - width / 2, cy + Math.sin(angle) * 94 - ROW_H / 2);
      this.add(row);
    }
    this._autoCloseAt = performance.now() + 8000;
  }
  get type() { return 'popup-menu'; }
  _send(entry) {
    try {
      if (typeof entry?.onClick === 'function') {
        Promise.resolve(entry.onClick()).catch((error) => {
          bus.emit('chat:system', { text: `Interaction failed: ${error?.message ?? error}` });
        });
      } else net.send(buildPopupMenuChoice(this.serial, entry?.responseId));
    } catch { /* socket transient */ }
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
