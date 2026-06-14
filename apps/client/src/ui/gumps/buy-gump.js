// BuyShopGump / SellShopGump — dual-pane vendor UI. Mirrors ClassicUO
// `Game/UI/Gumps/ShopGump.cs` 1:1 by mounting the canonical UO shop
// frame sprites instead of the generic parchment 9-patch:
//
//   • 0x0870 — buy left pane (vendor stock)          283 × 307
//   • 0x0871 — buy right pane (basket + total)        283 × 248
//   • 0x0872 — sell left pane                         283 × 307
//   • 0x0873 — sell right pane                        283 × 248
//
// The frame art ships with a built-in scroll-gutter strip on the right
// edge, a title slot at the top, a paged "→" / "←" pager at the bottom,
// and a tooled wood border around the inner content area. We anchor
// item rows inside the visible scroll area; everything outside is the
// authored chrome.
//
// Mouse interactions (same as before):
//   • Left click on a left-pane row     → +1 to basket (shift = +5)
//   • Left click on a right-pane row    → −1 from basket
//   • Right click on a right-pane row   → remove all
//
// On Accept we send 0x3B BuyRequest (or 0x9F SellRequest for the sell
// variant) with the basket. Server replies with 0x3C container update
// (stock removed) + 0xCB GoldRewardPacket (gold delta).

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { GumpPic } from '../controls/gump-pic.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';
import { buildBuyRequest, buildSellRequest } from '../../net/outgoing.js';
import { bus } from '../../core/event-bus.js';

// CUO ShopGump frame dimensions. Both panes are 283 wide but the right
// (basket) pane is 248 tall vs the left's 307 — the difference accounts
// for the basket's compact size + total row at the bottom.
const LEFT_W  = 283;
const LEFT_H  = 307;
const RIGHT_W = 283;
const RIGHT_H = 248;
const GAP     = 8;

// Inner scroll-area bounds inside each frame sprite. Numbers eye-balled
// from the gump art: top border + title strip ~52 px, side borders ~22
// px, bottom border + pager ~50 px on left, ~80 px on right (room for
// total + buttons baked into the panel).
const LEFT_INNER_X  = 24;
const LEFT_INNER_Y  = 60;
const LEFT_INNER_W  = LEFT_W  - 60;     // leaves room for the scrollbar
const LEFT_INNER_H  = LEFT_H  - 100;

const RIGHT_INNER_X = 24;
const RIGHT_INNER_Y = 60;
const RIGHT_INNER_W = RIGHT_W - 60;
const RIGHT_INNER_H = RIGHT_H - 110;

const ROW_H = 36;

class ShopRow extends Control {
  constructor(line, paneWidth, onClick, onRightClick) {
    super();
    this.line = line;
    this.width = paneWidth;
    this.height = ROW_H;
    this.acceptMouseInput = true;
    // Single-pixel divider so adjacent rows read as separate entries
    // against the wooden inner panel. Modest alpha so it doesn't fight
    // with the carved-wood texture of the frame.
    this._sep = new Graphics();
    this._sep.rect(0, ROW_H - 1, this.width, 1).fill({ color: 0x4a3818, alpha: 0.65 });
    this.node.addChild(this._sep);
    // Hover tint — same warm parchment glow CUO uses on hover.
    this._hoverTint = new Graphics();
    this._hoverTint
      .roundRect(0, 0, this.width, this.height - 1, 2)
      .fill({ color: 0xc89060, alpha: 0.18 });
    this._hoverTint.visible = false;
    this.node.addChild(this._hoverTint);
    this._pic = new ItemPic(line.itemId ?? 0, { hue: line.hue || 0 });
    this._pic.setPosition(2, 2);
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    // Item description — cream stroke for legibility against the
    // dark-wood panel. Truncated softly via Label's natural overflow.
    this._desc = new Label('', {
      fontSize: 11, hue: 0xfff0c0, stroke: true,
    });
    this._desc.setPosition(40, 4);
    this._desc.acceptMouseInput = false;
    this.add(this._desc);
    // Price in gold-coin yellow to stand out next to the description.
    this._price = new Label('', {
      fontSize: 10, hue: 0xffe070, stroke: true,
    });
    this._price.setPosition(40, 20);
    this._price.acceptMouseInput = false;
    this.add(this._price);
    this.update(line, onClick, onRightClick);
  }
  update(line, onClick, onRightClick) {
    this.line = line;
    if (line.itemId !== undefined) {
      this._pic.node.visible = true;
      this._pic.setItemId(line.itemId);
      this._pic.setHue(line.hue || 0);
    } else {
      this._pic.node.visible = false;
    }
    this._desc.setText(line.description ?? line.name ?? '?');
    this._price.setText(`${line.price | 0}gp`);
    this._onClick = onClick;
    this._onRightClick = onRightClick;
    this._hoverTint.visible = false;
    this.visible = true;
    this.node.visible = true;
  }
  setQty(qty) {
    const base = this.line.description ?? this.line.name ?? '?';
    if (qty > 1) this._desc.setText(`${base} ×${qty}`);
    else         this._desc.setText(base);
  }
  onMouseEnter() { this._hoverTint.visible = true; }
  onMouseLeave() { this._hoverTint.visible = false; }
  onMouseDown(button, e) {
    if (button === 2) this._onRightClick?.(e);
    else              this._onClick?.(e);
  }
}

class BaseShopGump extends Gump {
  constructor({ title, vendor, items, isSell }) {
    super();
    this.title = title;
    this.vendor = vendor >>> 0;
    this.items = items;
    this.isSell = isSell;
    this._basket = new Map();
    this._basketRows = new Map();
    this._basketRowPool = [];
    this._basketSeen = new Set();
    this._unsubs = [];

    this.canMove = true;
    this.canClose = true;
    this.canCloseWithEsc = true;
    this.canCloseWithRMB = true;
    this.setSize(LEFT_W + GAP + RIGHT_W, LEFT_H);
    this.setPosition(80, 80);

    this._buildFrames();
    this._buildHeader();
    this._buildPanes();
    this._buildButtons();
  }

  get type() { return this.isSell ? 'sell-shop' : 'buy-shop'; }
  get positionKey() { return this.type; }

  /** Mount the canonical CUO frame sprites. Sell variant uses 0x0872 /
   *  0x0873 instead — the art is the same wooden chrome with subtle
   *  hue / title-strip differences. Both panes are draggable via their
   *  top borders. */
  _buildFrames() {
    const leftBg  = this.isSell ? 0x0872 : 0x0870;
    const rightBg = this.isSell ? 0x0873 : 0x0871;
    this._leftFrame = new GumpPic(leftBg, { width: LEFT_W, height: LEFT_H });
    this._leftFrame.acceptMouseInput = true;
    this._leftFrame.isDragHandle = true;
    this._leftFrame.setPosition(0, 0);
    this.add(this._leftFrame);
    this._rightFrame = new GumpPic(rightBg, { width: RIGHT_W, height: RIGHT_H });
    this._rightFrame.acceptMouseInput = true;
    this._rightFrame.isDragHandle = true;
    // Right pane sits at the right of the left pane, vertically aligned
    // to the top so the title strips line up.
    this._rightFrame.setPosition(LEFT_W + GAP, 0);
    this.add(this._rightFrame);
  }

  /** Pane titles sit in the carved title strip baked into the frame
   *  art. CUO uses two label strings: "Buy" / "Total" on the left+right
   *  for the buy variant, "Sell" / "Total" for the sell variant. */
  _buildHeader() {
    const leftTitle = new Label(this.title ?? (this.isSell ? 'Sell' : 'Buy'), {
      fontSize: 12, hue: 0xfff0c0, stroke: true,
    });
    leftTitle.setPosition(28, 30);
    leftTitle.acceptMouseInput = false;
    this.add(leftTitle);
    const rightTitle = new Label('Basket', {
      fontSize: 12, hue: 0xfff0c0, stroke: true,
    });
    rightTitle.setPosition(LEFT_W + GAP + 28, 30);
    rightTitle.acceptMouseInput = false;
    this.add(rightTitle);
  }

  _buildPanes() {
    // ---- LEFT — vendor stock ------------------------------------------
    this._left = new ScrollArea({ width: LEFT_INNER_W, height: LEFT_INNER_H });
    this._left.setPosition(LEFT_INNER_X, LEFT_INNER_Y);
    this.add(this._left);
    let ly = 0;
    for (const it of this.items) {
      const key = it.serial ?? `${it.description}:${it.price}`;
      const row = new ShopRow(it, LEFT_INNER_W,
        (e) => this._addToBasket(it, e?.shift ? Math.min(it.amount ?? 10, 5) : 1),
        () => this._removeFromBasket(key, true));
      row.setPosition(0, ly);
      this._left.add(row);
      ly += ROW_H + 2;
    }
    this._left.setContentHeight(ly);

    // ---- RIGHT — basket ----------------------------------------------
    this._right = new ScrollArea({ width: RIGHT_INNER_W, height: RIGHT_INNER_H });
    this._right.setPosition(LEFT_W + GAP + RIGHT_INNER_X, RIGHT_INNER_Y);
    this.add(this._right);
    this._refreshBasket();
  }

  _buildButtons() {
    // Clear / Accept sit at the bottom of the RIGHT pane (right pane is
    // shorter than left → buttons land below its bottom border, above
    // the left pane's pager). CUO uses gump 0x0FA8 / 0x0FAA (red brass
    // buttons) for vendor shops.
    const y = RIGHT_H + 4;
    const mkBtn = (label, x, fn) => {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        buttonId: 0, action: ButtonAction.Activate,
        width: 80, height: 22, label,
      });
      b.setPosition(x, y);
      b.onClick = fn;
      this.add(b);
    };
    mkBtn('Clear',  LEFT_W + GAP + 20, () => { this._basket.clear(); this._refreshBasket(); });
    mkBtn('Accept', LEFT_W + GAP + RIGHT_W - 100, () => this._submit());

    // Total label — gold colour, centered between the buttons. Updated
    // by _refreshBasket so it tracks the running cart cost.
    this._totalLabel = new Label('Total: 0gp', {
      fontSize: 13, hue: 0xffe070, stroke: true,
    });
    this._totalLabel.setPosition(LEFT_W + GAP + (RIGHT_W >> 1) - 40, y + 2);
    this._totalLabel.acceptMouseInput = false;
    this.add(this._totalLabel);
  }

  _addToBasket(line, qty) {
    const key = line.serial ?? `${line.description}:${line.price}`;
    const cur = this._basket.get(key);
    if (cur) cur.qty += qty;
    else     this._basket.set(key, { line, qty });
    this._refreshBasket();
  }

  _removeFromBasket(key, all) {
    const cur = this._basket.get(key);
    if (!cur) return;
    if (all || cur.qty <= 1) this._basket.delete(key);
    else                     cur.qty--;
    this._refreshBasket();
  }

  _refreshBasket() {
    const seen = this._basketSeen;
    seen.clear();
    let total = 0;
    let y = 0;
    for (const [key, entry] of this._basket) {
      seen.add(key);
      total += entry.qty * (entry.line.price | 0);
      let row = this._basketRows.get(key);
      if (!row) {
        row = this._basketRowPool.pop() ?? new ShopRow(entry.line, RIGHT_INNER_W,
          () => this._removeFromBasket(key, false),
          () => this._removeFromBasket(key, true));
        this._basketRows.set(key, row);
        if (!row.parent) this._right.add(row);
      }
      row.update(entry.line,
        () => this._removeFromBasket(key, false),
        () => this._removeFromBasket(key, true));
      row.setQty(entry.qty);
      row.setPosition(0, y);
      y += ROW_H + 2;
    }
    for (const [key, row] of this._basketRows) {
      if (seen.has(key)) continue;
      row.visible = false;
      row.node.visible = false;
      this._basketRows.delete(key);
      this._basketRowPool.push(row);
    }
    seen.clear();
    this._right.setContentHeight(y);
    if (this._totalLabel) this._totalLabel.setText(`Total: ${total}gp`);
  }

  _submit() {
    const picks = [];
    for (const { line, qty } of this._basket.values()) {
      if (line.serial) picks.push({ serial: line.serial, amount: qty });
    }
    if (picks.length === 0) { this.close(); return; }
    try {
      const pkt = this.isSell
        ? buildSellRequest(this.vendor, picks)
        : buildBuyRequest (this.vendor, picks);
      net.send(pkt);
    } catch (e) { console.error('[shop] submit failed', e); }
    this.close();
  }

  dispose() {
    for (const u of this._unsubs ?? []) u?.();
    super.dispose();
  }
}

export class BuyShopGump extends BaseShopGump {
  constructor(info) { super({ title: 'Buy', isSell: false, ...info }); }
}
export class SellShopGump extends BaseShopGump {
  constructor(info) {
    super({ title: 'Sell', isSell: true, ...info });
    // Subscribe to the global drag-drop bus: when the held item gets
    // dropped over THIS sell-shop window, append it to the basket. The
    // CUO behaviour: drop a stack from your pack on the sell pane →
    // basket entry with the vendor's quoted buy-back price.
    const unsub = bus.on('drag:dropped-on-sell', ({ item, sellGump }) => {
      if (sellGump !== this) return;
      this._addToBasket({
        serial: item.serial, name: item.name ?? 'item',
        amount: item.amount ?? 1, price: item.sellPrice ?? 0,
      }, item.amount ?? 1);
    });
    if (typeof unsub === 'function') this._unsubs.push(unsub);
  }
  /** Test whether `(sx, sy)` falls inside the right (basket) pane. The
   *  drag-drop manager calls this to decide which gump owns the drop. */
  hitsSellPane(sx, sy) {
    const rx = (this.x | 0) + LEFT_W + GAP;
    const ry = (this.y | 0);
    return sx >= rx && sx < rx + RIGHT_W && sy >= ry && sy < ry + RIGHT_H;
  }
}
