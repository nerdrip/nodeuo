// MenuGump — server-driven gray choice list. Mirrors ClassicUO
// `Game/UI/Gumps/MenuGump.cs`. Triggered by 0x7C OpenMenu and replied
// to with 0x7D MenuResponse via outgoing.buildMenuResponse.
//
// One menu open at a time; a new 0x7C while one is live closes the
// old gump first.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Control } from '../control.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import { buildMenuResponse } from '../../net/outgoing.js';

class MenuRow extends Control {
  constructor({ label, width = 280, height = 18, onClick }) {
    super();
    this.width = width; this.height = height;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Label(label || '(blank)', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    this._txt.setPosition(8, 2);
    this.add(this._txt);
    this.acceptMouseInput = true;
    this._onClick = onClick;
    this._draw();
  }
  _draw(hover = false) {
    this._gfx.clear();
    this._gfx.rect(0, 0, this.width, this.height)
             .fill({ color: hover ? 0x40342a : 0x261a14 })
             .stroke({ width: 1, color: 0x4a3818 });
  }
  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
  onMouseDown()  { this._onClick?.(); }
}

class MenuGump extends WindowGump {
  constructor({ dialogId, menuId, title, items }) {
    const h = 36 + items.length * 20 + 12;
    super({
      title: title || 'Menu',
      width: 320, height: h,
      x: Math.max(0, (window.innerWidth  - 320) / 2),
      y: Math.max(0, (window.innerHeight -   h) / 2),
    });
    this.dialogId = dialogId;
    this.menuId   = menuId;
    let y = 32;
    items.forEach((it, idx) => {
      const row = new MenuRow({
        label: it.label,
        onClick: () => this._pick(idx + 1, it.itemId | 0, it.hue | 0),
      });
      row.setPosition(16, y);
      this.add(row);
      y += 20;
    });
  }

  get type() { return 'menu'; }

  _pick(index, itemGfx, itemHue) {
    try { net.send(buildMenuResponse(this.dialogId, this.menuId, index, itemGfx, itemHue)); }
    catch (e) { console.warn('[menu] response failed', e); }
    this.close();
  }
}

let _live = null;
export function installMenuGumpListener() {
  bus.on('menu:open', (data) => {
    if (_live) { try { _live.close(); } catch { /* already gone */ } _live = null; }
    if (!data?.items?.length) return;
    const ui = uiManagerInstance.get();
    if (!ui) return;
    _live = new MenuGump(data);
    ui.add(_live);
    _live._onCloseSelf = () => { _live = null; };
  });
}
