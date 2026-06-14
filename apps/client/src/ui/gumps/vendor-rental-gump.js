// VendorRentalGump + VendorInventoryGump — rent a player-vendor plot,
// configure terms, and manage the vendor's stock with native drag-out
// from the inventory grid. Mirrors ServUO `Gumps/VendorRentalGumps.cs`
// + `Gumps/VendorInventoryGump.cs`. Both share a chat dispatch surface
// (`[pv` family) so existing server-side commands wire them up.
//
// Drag-out semantics: clicking + dragging an inventory row dispatches
// `[pv pull <itemHex>` which the server handles via `pullStock` —
// the item reappears in the owner's pack on the server reply.

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';

function buildSpeechCmd(text) {
  const enc = new TextEncoder();
  const body = enc.encode(text + '\0');
  const buf = new Uint8Array(12 + body.length);
  let o = 0;
  buf[o++] = 0xAD;
  buf[o++] = 0x00; buf[o++] = (12 + body.length) & 0xff;
  buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0x45; buf[o++] = 0x4E; buf[o++] = 0x55; buf[o++] = 0;
  buf.set(body, o);
  return buf;
}

// =====================================================================
//  RENTAL — choose shop name, pay deposit, place vendor
// =====================================================================
export class VendorRentalGump extends WindowGump {
  constructor() {
    super({ title: 'Vendor Rental', width: 380, height: 260, x: 200, y: 100 });

    const lbl = (text, x, y) => {
      const l = new Label(text, { fontSize: 11, hue: 0xc0b890 });
      l.setPosition(x, y); this.add(l);
    };
    lbl('Hire a player vendor at your feet.', 14, 30);
    lbl('Daily upkeep: 60gp per item listed.', 14, 48);
    lbl('Initial deposit: 1000gp (locks vendor for 7 days).', 14, 66);

    // Field — shop name (we don't have inline text input bound to chat
    // command; use `window.prompt` like Admin / Sigils gumps).
    const place = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 22, label: 'Hire Vendor', action: ButtonAction.Activate,
    });
    place.setPosition(140, 100); this.add(place);
    place.onClick = () => {

      const name = (typeof window !== 'undefined' ? window.prompt('Shop name:') : '');
      if (!name) return;
      this._issue(`[pv place ${name.trim()}`);
      this.close();
    };

    const reclaim = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 22, label: 'Reclaim', action: ButtonAction.Activate,
    });
    reclaim.setPosition(140, 130); this.add(reclaim);
    reclaim.onClick = () => { this._issue('[pv reclaim'); this.close(); };

    const deposit = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 100, height: 22, label: 'Deposit', action: ButtonAction.Activate,
    });
    deposit.setPosition(140, 160); this.add(deposit);
    deposit.onClick = () => {

      const amt = (typeof window !== 'undefined' ? window.prompt('Amount of gold:') : '');
      const n = parseInt(amt, 10) || 0;
      if (n <= 0) return;
      this._issue(`[pv deposit ${n}`);
    };

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(300, 220); this.add(close);
    close.onClick = () => this.close();
  }
  get type() { return 'vendor-rental'; }
  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}

// =====================================================================
//  INVENTORY — owner-only, lists vendor stock, drag-out per-row
// =====================================================================
const ROW_H = 22;

class StockRow extends Control {
  constructor({ entry, onPull, onPriceChange }) {
    super();
    this.width = 360; this.height = ROW_H;
    this._entry = entry;

    const bg = new Graphics();
    bg.rect(0, 0, this.width, this.height)
      .fill({ color: 0x1a1612 });
    this.node.addChild(bg);

    this._lbl = new Label(`${entry.name ?? '(item)'} ×${entry.amount ?? 1}`,
      { fontSize: 11, hue: 0xfff0c0 });
    this._lbl.setPosition(8, 5); this.add(this._lbl);

    this._price = new Label(`${entry.price | 0}gp`, { fontSize: 11, hue: 0xffd06a });
    this._price.setPosition(180, 5); this.add(this._price);

    const pull = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 50, height: 16, label: 'Pull', action: ButtonAction.None,
    });
    pull.setPosition(this.width - 110, 3); this.add(pull);
    pull.onClick = () => onPull?.(entry);

    const repr = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 50, height: 16, label: 'Price', action: ButtonAction.None,
    });
    repr.setPosition(this.width - 56, 3); this.add(repr);
    repr.onClick = () => onPriceChange?.(entry);
  }
}

export class VendorInventoryGump extends WindowGump {
  constructor() {
    super({ title: 'Vendor Inventory', width: 400, height: 420, x: 240, y: 110 });
    this._entries = [];
    this._rows = [];

    this._title = new Label('(no vendor)', { fontSize: 13, hue: 0xfff0c0, stroke: true });
    this._title.setPosition(14, 28); this.add(this._title);

    this._scroll = new ScrollArea({ width: 372, height: 320 });
    this.addContent(this._scroll, 14, 50);

    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 70, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(14, 380); this.add(refresh);
    refresh.onClick = () => this._issue('[pv list');

    const close = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 60, height: 22, label: 'Close', action: ButtonAction.Activate,
    });
    close.setPosition(320, 380); this.add(close);
    close.onClick = () => this.close();

    // Scrape `[pv list` system messages → render rows. Server prints:
    //   "Vendor "name" — bank Xgp, items N."
    //   "  • [hex] item ×amt — Pgp"
    this._unsub = bus.on('chat:system', (m) => this._consume(m?.text ?? String(m)));
    this._issue('[pv list');
  }
  get type() { return 'vendor-inventory'; }
  dispose() { this._unsub?.(); super.dispose?.(); }

  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }

  _consume(text) {
    if (!text) return;
    const titleMatch = text.match(/^Vendor "([^"]+)" — bank (\d+)gp, items (\d+)\.$/);
    if (titleMatch) {
      this._title.setText?.(`${titleMatch[1]}  •  bank ${titleMatch[2]}gp  •  ${titleMatch[3]} item(s)`);
      this._clearRows();
      this._entries = [];
      return;
    }
    const rowMatch = text.match(/^\s+•\s+\[([0-9a-f]+)\]\s+(.+?)\s+×(\d+)\s+—\s+(\d+)gp$/);
    if (rowMatch) {
      const entry = {
        serial: parseInt(rowMatch[1], 16) >>> 0,
        name: rowMatch[2],
        amount: parseInt(rowMatch[3], 10),
        price: parseInt(rowMatch[4], 10),
      };
      this._entries.push(entry);
      this._appendRow(entry);
    }
  }

  _clearRows() {
    for (const r of this._rows) r.dispose?.();
    this._rows = [];
    this._scroll.clear?.();
  }
  _appendRow(entry) {
    const row = new StockRow({
      entry,
      onPull: (e) => this._issue(`[pv pull ${e.serial.toString(16)}`),
      onPriceChange: (e) => {

        const p = (typeof window !== 'undefined' ? window.prompt(`New price for ${e.name}:`) : '');
        const n = parseInt(p, 10) || 0;
        if (n > 0) this._issue(`[pv stock ${e.serial.toString(16)} ${n}`);
      },
    });
    row.setPosition(0, this._rows.length * (ROW_H + 2));
    this._scroll.add?.(row);
    this._rows.push(row);
    this._scroll.setContentHeight?.(this._rows.length * (ROW_H + 2));
  }
}

export const vendorRentalGump = new VendorRentalGump();
export const vendorInventoryGump = new VendorInventoryGump();
