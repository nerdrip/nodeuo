// TradingGump — secure trade window for two players. Mirrors ClassicUO
// `Game/UI/Gumps/TradingGump.cs`.
//
// Flow:
//   - Server opens trade with 0x6F action 0x00 carrying our & their
//     container serials + partner name.
//   - Either side drops items into their pane (server: 0x07/0x08).
//   - Either side toggles "I accept" → 0x6F action 0x02 with our flag.
//   - When both flags are 1, server commits the trade and sends
//     0x6F action 0x01 (close).
//
// We keep the gump LIGHT-WEIGHT: two scrollable lists of items currently
// in the player's / partner's pane, gold/platinum entries (read-only here;
// the player drops gold by physical drag), and two checkboxes for the
// accept toggles.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Checkbox } from '../controls/checkbox.js';
import { ItemPic } from '../controls/item-pic.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { net } from '../../net/net-client.js';
import { buildSecureTrade } from '../../net/outgoing.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { Control } from '../control.js';

const PANE_W = 200;
const PANE_H = 240;
const ROW_H  = 36;

class TradeRow extends Control {
  constructor(item) {
    super();
    this.width = PANE_W - 16;
    this.height = ROW_H;
    this.acceptMouseInput = false;
    this._frame = new Graphics();
    this._frame.rect(0, 0, this.width, this.height)
      .fill({ color: 0x161c2a, alpha: 0.85 })
      .stroke({ width: 1, color: 0x6a4a18 });
    this.node.addChild(this._frame);
    this._pic = new ItemPic(item.itemId || 0, { hue: item.hue || 0 });
    this._pic.setPosition(2, 2);
    this.add(this._pic);
    this._lbl = new Label('', {
      fontSize: 11, hue: 0xfff0c0, stroke: false,
    });
    this._lbl.setPosition(40, 6);
    this.add(this._lbl);
    this._amount = new Label('', { fontSize: 10, hue: 0xc0b890 });
    this._amount.setPosition(40, 20);
    this.add(this._amount);
    this.update(item);
  }

  update(item) {
    this.item = item;
    if (item.itemId) {
      this._pic.node.visible = true;
      this._pic.setItemId(item.itemId);
      this._pic.setHue(item.hue || 0);
    } else {
      this._pic.node.visible = false;
    }
    this._lbl.setText(item.name || `Item #${item.itemId?.toString(16) ?? '?'}`);
    if (item.amount > 1) {
      this._amount.node.visible = true;
      this._amount.setText(`×${item.amount}`);
    } else {
      this._amount.node.visible = false;
    }
    this.visible = true;
    this.node.visible = true;
  }
}

export class TradingGump extends WindowGump {
  /** @param {{ containerSerial:number, otherSerial:number, ourSerial:number, partnerName?:string }} info */
  constructor(info) {
    super({
      title: `Trade with ${info.partnerName || 'Partner'}`,
      width: PANE_W * 2 + 24, height: PANE_H + 80, x: 80, y: 80,
    });
    this.containerSerial = info.containerSerial >>> 0;
    this.otherSerial     = info.otherSerial     >>> 0;
    this.ourSerial       = info.ourSerial       >>> 0;
    this.ourAccept   = false;
    this.otherAccept = false;
    this.ourGold     = 0;
    this.otherGold   = 0;
    this._ourRows = new Map();
    this._theirRows = new Map();
    this._ourRowPool = [];
    this._theirRowPool = [];
    this._renderSeen = new Set();
    this._buildPanes();
    this._buildFooter();
    this._unsubs = [
      bus.on('trade:event',         (e) => this._onEvent(e)),
      bus.on('container:contents',  (e) => this._onContents(e)),
      bus.on('container:item-update', (e) => this._onItem(e)),
    ];
  }

  get type() { return 'trading'; }
  dispose() {
    for (const u of this._unsubs) u();
    for (const row of this._ourRows.values()) row.dispose?.();
    for (const row of this._theirRows.values()) row.dispose?.();
    for (const row of this._ourRowPool) row.dispose?.();
    for (const row of this._theirRowPool) row.dispose?.();
    this._ourRows.clear(); this._theirRows.clear();
    this._ourRowPool.length = 0; this._theirRowPool.length = 0;
    super.dispose();
  }

  _buildPanes() {
    const youHdr = new Label('YOU', { fontSize: 12, hue: 0xfff0c0 });
    youHdr.setPosition(8, 28);
    this.add(youHdr);
    const themHdr = new Label('THEM', { fontSize: 12, hue: 0xfff0c0 });
    themHdr.setPosition(PANE_W + 16, 28);
    this.add(themHdr);

    this._ourPane = new ScrollArea({ width: PANE_W, height: PANE_H });
    this.addContent(this._ourPane, 8, 44);

    this._theirPane = new ScrollArea({ width: PANE_W, height: PANE_H });
    this.addContent(this._theirPane, PANE_W + 16, 44);
  }

  _buildFooter() {
    this._ourCheck = new Checkbox({ label: 'I accept', checked: false });
    this._ourCheck.setPosition(8, PANE_H + 50);
    this._ourCheck.onToggle = (v) => this._sendAccept(v);
    this.add(this._ourCheck);

    this._theirState = new Label('Partner: WAITING', { fontSize: 11, hue: 0xc0a070 });
    this._theirState.setPosition(PANE_W + 16, PANE_H + 52);
    this.add(this._theirState);

    const cancel = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 80, height: 22, label: 'Cancel',
    });
    cancel.setPosition(PANE_W * 2 - 80, PANE_H + 50);
    cancel.onClick = () => this._cancel();
    this.add(cancel);
  }

  _sendAccept(accept) {
    this.ourAccept = !!accept;
    try { net.send(buildSecureTrade({ action: 0x02, serial: this.containerSerial, accept })); }
    catch { /* socket transient */ }
  }

  _cancel() {
    try { net.send(buildSecureTrade({ action: 0x01, serial: this.containerSerial })); }
    catch { /* noop */ }
    this.close();
  }

  _onEvent(e) {
    if (e.containerSerial !== this.containerSerial) return;
    if (e.action === 0x01) { this.close(); return; }
    if (e.action === 0x02) {
      this.otherAccept = !!e.otherAccept;
      this.ourAccept   = !!e.ourAccept;
      this._theirState.setText(`Partner: ${this.otherAccept ? 'ACCEPTED' : 'WAITING'}`);
    }
    if (e.action === 0x03) {
      this.ourGold = e.ourGold | 0;
      this.otherGold = e.otherGold | 0;
      this._renderGold();
    }
  }

  _onContents({ containerSerial, items }) {
    if ((containerSerial >>> 0) === this.ourSerial) {
      this._renderPane(this._ourPane, items, this._ourRows, this._ourRowPool);
    } else if ((containerSerial >>> 0) === this.otherSerial) {
      this._renderPane(this._theirPane, items, this._theirRows, this._theirRowPool);
    }
  }
  _onItem(it) {
    // Drop-add into our pane: re-fetch contents from world.items snapshot.
    if (it.parent === this.ourSerial) {
      this._refreshFromWorld(this._ourPane, this.ourSerial, this._ourRows, this._ourRowPool);
    }
    if (it.parent === this.otherSerial) {
      this._refreshFromWorld(this._theirPane, this.otherSerial, this._theirRows, this._theirRowPool);
    }
  }

  _refreshFromWorld(pane, parentSerial, rows, pool) {
    /** @type {any[]} */
    const items = [];
    const iter = world.childrenOf ? world.childrenOf(parentSerial) : world.items.values();
    for (const it of iter) {
      if (it.parent === parentSerial) items.push(it);
    }
    this._renderPane(pane, items, rows, pool);
  }

  _renderPane(pane, items, rows, pool) {
    const seen = this._renderSeen;
    seen.clear();
    let y = 0;
    for (const it of items) {
      const serial = it.serial >>> 0;
      seen.add(serial);
      let row = rows.get(serial);
      if (!row) {
        row = pool.pop() ?? new TradeRow(it);
        rows.set(serial, row);
        if (!row.parent) pane.add(row);
      }
      row.update(it);
      row.setPosition(2, y);
      y += ROW_H + 2;
    }
    for (const [serial, row] of rows) {
      if (seen.has(serial)) continue;
      row.visible = false;
      row.node.visible = false;
      rows.delete(serial);
      pool.push(row);
    }
    seen.clear();
    pane.setContentHeight?.(y);
  }

  _renderGold() {
    // Audit #43 client P2 #13 — was: `this.add(new Label(...))` per
    // update → labels stacked up to 6+ overlapping "Gold: 0" lines.
    // Now: cache the labels and call `setText` on existing instances.
    if (!this._ourGoldLbl) {
      this._ourGoldLbl = new Label(`Gold: ${this.ourGold}`, { fontSize: 11, hue: 0xffe080 });
      this._ourGoldLbl.setPosition(80, 28);
      this.add(this._ourGoldLbl);
    } else {
      this._ourGoldLbl.setText(`Gold: ${this.ourGold}`);
    }
    if (!this._theirGoldLbl) {
      this._theirGoldLbl = new Label(`Gold: ${this.otherGold}`, { fontSize: 11, hue: 0xffe080 });
      this._theirGoldLbl.setPosition(PANE_W + 88, 28);
      this.add(this._theirGoldLbl);
    } else {
      this._theirGoldLbl.setText(`Gold: ${this.otherGold}`);
    }
    // Audit #43 client P2 #14 — surface platinum too (decoded but
    // previously ignored).
    const plat = (this.ourPlatinum | 0);
    const theirPlat = (this.otherPlatinum | 0);
    if (plat || theirPlat) {
      if (!this._ourPlatLbl) {
        this._ourPlatLbl = new Label(`Plat: ${plat}`, { fontSize: 11, hue: 0xa0c0ff });
        this._ourPlatLbl.setPosition(180, 28);
        this.add(this._ourPlatLbl);
      } else this._ourPlatLbl.setText(`Plat: ${plat}`);
      if (!this._theirPlatLbl) {
        this._theirPlatLbl = new Label(`Plat: ${theirPlat}`, { fontSize: 11, hue: 0xa0c0ff });
        this._theirPlatLbl.setPosition(PANE_W + 188, 28);
        this.add(this._theirPlatLbl);
      } else this._theirPlatLbl.setText(`Plat: ${theirPlat}`);
    }
  }
}
