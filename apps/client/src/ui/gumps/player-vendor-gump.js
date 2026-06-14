// PlayerVendorGump — browse a player vendor's stock + buy lines.
// Mirrors ServUO PlayerVendorBuyGump. Server side ships an inventory
// snapshot via system-message lines; this gump renders them in the
// CUO style and emits `[pv buy <vendor> <slot>` chat commands so the
// existing command pipeline drives the purchase.
//
// Open with `playerVendorGump.show(vendor)` — `vendor` carries
// `{ serial, shopName, items: [{serial,name,price,amount}] }`.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';

const ROW_H = 22;
const COLS = { name: 14, amt: 220, price: 270 };

class StockRow extends Control {
  constructor({ entry, onBuy }) {
    super();
    this.width = 320;
    this.height = ROW_H;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._gfx.rect(0, 0, this.width, this.height).fill({ color: 0x1a1612 });

    this._name  = new Label('', { fontSize: 11, hue: 0xfff0c0 });
    this._name.setPosition(COLS.name, 5);
    this._name.acceptMouseInput = false;
    this.add(this._name);

    this._amt   = new Label('', { fontSize: 11, hue: 0xc0b890 });
    this._amt.setPosition(COLS.amt, 5);
    this._amt.acceptMouseInput = false;
    this.add(this._amt);

    this._price = new Label('', { fontSize: 11, hue: 0xffd06a });
    this._price.setPosition(COLS.price, 5);
    this._price.acceptMouseInput = false;
    this.add(this._price);

    const btn = new Button({
      label: 'Buy', width: 30, height: 16,
    });
    btn.setPosition(this.width - 36, 3);
    this._btn = btn;
    this.add(btn);
    this.update(entry, onBuy);
  }

  update(entry, onBuy) {
    this._entry = entry;
    this._name.setText(entry.name ?? '(item)');
    this._amt.setText(`x${entry.amount ?? 1}`);
    this._price.setText(`${entry.price}gp`);
    this._btn.onClick = () => onBuy?.(entry);
    this.visible = true;
    this.node.visible = true;
  }
}

export class PlayerVendorGump extends WindowGump {
  constructor() {
    super({ title: 'Player Vendor', width: 360, height: 360, x: 240, y: 100 });
    this._vendor = null;
    this._rows = [];

    this._title = new Label('(closed)', { fontSize: 13, hue: 0xfff0c0, stroke: true });
    this._title.setPosition(14, 28);
    this.add(this._title);

    this._scroll = new ScrollArea({ width: 332, height: 280 });
    this._scroll.setPosition(14, 50);
    this.add(this._scroll);

    this._closeBtn = new Button({ label: 'Close', width: 60, height: 18 });
    this._closeBtn.setPosition(280, 332);
    this._closeBtn.onClick = () => this.close?.();
    this.add(this._closeBtn);
  }

  /** Open with a vendor snapshot. `vendor.items` is the stock list. */
  show(vendor) {
    this._vendor = vendor;
    this._title.setText?.(vendor.shopName ?? 'Player Vendor');
    let y = 0;
    let used = 0;
    for (const e of vendor.items ?? []) {
      let row = this._rows[used];
      if (!row) {
        row = new StockRow({ entry: e, onBuy: (entry) => this._buy(entry) });
        this._rows[used] = row;
        this._scroll.add(row);
      }
      row.update(e, (entry) => this._buy(entry));
      row.setPosition(0, y);
      y += ROW_H + 2;
      used++;
    }
    for (let i = used; i < this._rows.length; i++) {
      this._rows[i].visible = false;
      this._rows[i].node.visible = false;
    }
    this._scroll.setContentHeight(y);
  }

  _buy(entry) {
    if (!this._vendor) return;
    // Round-trip via [pv-buy chat command (server-side handler runs the
    // `playerVendor.buyItem` flow). We surface the user-visible feedback
    // by sending the command and letting the server reply via system
    // message.
    const line = `[pv-buy 0x${this._vendor.serial.toString(16)} 0x${entry.serial.toString(16)}]`;
    try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ }
  }

  get type() { return 'player-vendor'; }
}

// Tiny helper: emit a chat-bar speech packet matching our command
// pipeline. We don't have a ready buildSpeech() here so we craft the
// bytes inline (UO 0xAD AsciiSpeech). Keep this colocated so we don't
// pull a new outgoing-table entry just for one button.
function buildSpeechCmd(text) {
  // 0xAD AsciiSpeech (ASCII variant): id=0xAD, size, type, hue, font, lang, text\0
  const enc = new TextEncoder();
  const body = enc.encode(text + '\0');
  const buf = new Uint8Array(8 + 4 + body.length);
  let o = 0;
  buf[o++] = 0xAD;                                        // packet id
  buf[o++] = 0x00; buf[o++] = (12 + body.length) & 0xff;  // size
  buf[o++] = 0;                                           // type=normal
  buf[o++] = 0; buf[o++] = 0;                             // hue
  buf[o++] = 0; buf[o++] = 0;                             // font
  buf[o++] = 0x45; buf[o++] = 0x4E; buf[o++] = 0x55; buf[o++] = 0;  // 'ENU\0'
  buf.set(body, o);
  return buf;
}

export const playerVendorGump = new PlayerVendorGump();
