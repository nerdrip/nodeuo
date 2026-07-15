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
import { TextInput } from '../controls/text-input.js';
import { net } from '../../net/net-client.js';
import { buildBuyRequest, buildSellRequest } from '../../net/outgoing.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { calculateVirtualWindow } from '../../shared/virtual-list.js';
import { tooltips } from '../../managers/tooltip-manager.js';

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
const VENDOR_FAVORITES_KEY = 'uo.vendor.favorites.v1';
const VENDOR_HISTORY_KEY = 'uo.vendor.price-history.v1';

function readStored(key, fallback) {
  try { return JSON.parse(globalThis.localStorage?.getItem?.(key) ?? 'null') ?? fallback; }
  catch { return fallback; }
}
function writeStored(key, value) {
  try { globalThis.localStorage?.setItem?.(key, JSON.stringify(value)); } catch { /* advisory */ }
}

class ShopRow extends Control {
  constructor(line, paneWidth, onClick, onRightClick, onMax = null) {
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
    this.update(line, onClick, onRightClick, onMax);
  }
  update(line, onClick, onRightClick, onMax = null) {
    this.line = line;
    if (line.itemId !== undefined) {
      this._pic.node.visible = true;
      this._pic.setItemId(line.itemId);
      this._pic.setHue(line.hue || 0);
    } else {
      this._pic.node.visible = false;
    }
    this._desc.setText(line.description ?? line.name ?? '?');
    const history = Array.isArray(line.priceHistory) ? line.priceHistory : [];
    const prices = history.map((entry) => entry.price | 0);
    const range = prices.length > 1 ? ` · ${Math.min(...prices)}–${Math.max(...prices)}` : '';
    this._price.setText(`${line.price | 0}gp${range}`);
    this._onClick = onClick;
    this._onRightClick = onRightClick;
    this._onMax = onMax;
    this._hoverTint.visible = false;
    this.visible = true;
    this.node.visible = true;
  }
  setQty(qty) {
    const base = this.line.description ?? this.line.name ?? '?';
    if (qty > 1) this._desc.setText(`${base} ×${qty}`);
    else         this._desc.setText(base);
  }
  onMouseEnter(e) {
    this._hoverTint.visible = true;
    if (this.line?.serial) {
      tooltips.showImmediate?.(
        this.line.serial,
        e?.global?.x ?? 0,
        e?.global?.y ?? 0,
        this.line.description ?? this.line.name ?? 'item',
      );
    }
  }
  onMouseLeave() { this._hoverTint.visible = false; tooltips.scheduleHide?.(280); }
  onMouseDown(button, _lx, _ly, event) {
    if (button === 2) this._onRightClick?.(event);
    else              this._onClick?.(event);
  }
  onDoubleClick() { this._onMax?.(); }
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
    this._stockRows = [];
    this._stockRowPool = [];
    this._unsubs = [];
    this._favoriteIds = new Set(readStored(VENDOR_FAVORITES_KEY, []).map(Number));
    this._priceHistory = readStored(VENDOR_HISTORY_KEY, {});
    this._favoritesOnly = false;
    for (const line of items) {
      const id = line.itemId | 0;
      if (!id || !Number.isFinite(line.price)) continue;
      const history = Array.isArray(this._priceHistory[id]) ? this._priceHistory[id] : [];
      this._priceHistory[id] = [...history, { price: line.price | 0, at: Date.now() }].slice(-20);
      line.priceHistory = this._priceHistory[id];
    }
    writeStored(VENDOR_HISTORY_KEY, this._priceHistory);

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
    this._unsubs.push(bus.on('shop:close', ({ serial } = {}) => {
      if (!serial || (serial >>> 0) === this.vendor) this.close();
    }));
    this._unsubs.push(bus.on('message:journal', ({ text } = {}) => this._onTransactionMessage(text)));
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

    this._search = new TextInput({
      width: 142, height: 20, placeholder: 'Filter…', fontSize: 11,
    });
    this._search.setPosition(92, 25);
    this._search.onChange = () => this._renderStock();
    this.add(this._search);

    const favorites = new Button({
      normalGumpId: 0, pressedGumpId: 0, width: 42, height: 20,
      label: '★ All', flat: true, action: ButtonAction.Activate,
    });
    favorites.setPosition(238, 25);
    favorites.onClick = () => {
      this._favoritesOnly = !this._favoritesOnly;
      favorites.setLabel(this._favoritesOnly ? '★ Only' : '★ All');
      this._renderStock();
    };
    this.add(favorites);

    this._qtyInput = new TextInput({ width: 42, height: 20, value: '1', maxLength: 4, fontSize: 11 });
    this._qtyInput.setPosition(LEFT_W + GAP + 106, 25);
    this._qtyInput.onSubmit = () => this._applySelectedQuantity();
    this.add(this._qtyInput);
    const max = new Button({
      normalGumpId: 0, pressedGumpId: 0, width: 42, height: 20,
      label: 'Max', flat: true, action: ButtonAction.Activate,
    });
    max.setPosition(LEFT_W + GAP + 152, 25);
    max.onClick = () => this._applySelectedQuantity(true);
    this.add(max);
  }

  _buildPanes() {
    // ---- LEFT — vendor stock ------------------------------------------
    this._left = new ScrollArea({ width: LEFT_INNER_W, height: LEFT_INNER_H });
    this._left.setPosition(LEFT_INNER_X, LEFT_INNER_Y);
    this.add(this._left);
    this._left.onScroll = () => this._renderStock();
    this._renderStock();

    // ---- RIGHT — basket ----------------------------------------------
    this._right = new ScrollArea({ width: RIGHT_INNER_W, height: RIGHT_INNER_H });
    this._right.setPosition(LEFT_W + GAP + RIGHT_INNER_X, RIGHT_INNER_Y);
    this.add(this._right);
    this._refreshBasket();
  }

  _lineKey(line) {
    return line.serial != null
      ? `s:${line.serial >>> 0}`
      : `i:${line.itemId ?? 0}:${line.hue ?? 0}:${line.description ?? line.name ?? ''}:${line.price ?? 0}`;
  }

  _renderStock() {
    if (!this._left || this._left.node?.destroyed) return;
    for (const row of this._stockRows) {
      row.node.visible = false;
      this._stockRowPool.push(row);
    }
    this._stockRows.length = 0;
    const query = this._search?.value?.trim().toLocaleLowerCase() ?? '';
    const items = this.items.filter((line) => {
      const name = String(line.description ?? line.name ?? '').toLocaleLowerCase();
      const validSell = !this.isSell || !!line.serial;
      const favorite = this._favoriteIds.has(line.itemId | 0);
      return validSell && (!this._favoritesOnly || favorite) && (!query || name.includes(query));
    }).sort((a, b) => Number(this._favoriteIds.has(b.itemId | 0)) - Number(this._favoriteIds.has(a.itemId | 0)));
    const window = calculateVirtualWindow({
      scrollY: this._left.scrollY,
      viewportSize: LEFT_INNER_H,
      itemSize: ROW_H + 2,
      itemCount: items.length,
      overscan: 2,
    });
    this._left.beginBulkUpdate();
    for (let index = window.start; index < window.end; index++) {
      const it = items[index];
      const row = this._stockRowPool.pop() ?? new ShopRow(it, LEFT_INNER_W);
      row.update(it,
        (e) => this._addToBasket(it, e?.shift ? 5 : 1),
        () => this._toggleFavorite(it),
        () => this._setBasketQuantity(it, it.amount ?? 1));
      row.setPosition(0, index * (ROW_H + 2));
      if (!row.parent) this._left.add(row);
      this._stockRows.push(row);
    }
    this._left.endBulkUpdate();
    this._left.setContentHeight(items.length * (ROW_H + 2));
  }

  _toggleFavorite(line) {
    const id = line.itemId | 0;
    if (!id) return;
    if (this._favoriteIds.has(id)) this._favoriteIds.delete(id);
    else this._favoriteIds.add(id);
    writeStored(VENDOR_FAVORITES_KEY, [...this._favoriteIds]);
    this._renderStock();
  }

  _setBasketQuantity(line, quantity) {
    const available = Math.max(0, Number(line.amount ?? 1) | 0);
    const qty = Math.max(0, Math.min(available, quantity | 0));
    const key = this._lineKey(line);
    if (qty <= 0) this._basket.delete(key);
    else this._basket.set(key, { line, qty });
    this._selectedBasketKey = key;
    this._qtyInput?.setValue?.(String(Math.max(1, qty)), { silent: true });
    this._refreshBasket();
  }

  _applySelectedQuantity(max = false) {
    const entry = this._basket.get(this._selectedBasketKey);
    if (!entry) return;
    const qty = max ? (entry.line.amount ?? 1) : Number.parseInt(this._qtyInput.value, 10);
    this._setBasketQuantity(entry.line, Number.isFinite(qty) ? qty : entry.qty);
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
      return b;
    };
    mkBtn('Clear',  LEFT_W + GAP + 20, () => { this._basket.clear(); this._refreshBasket(); });
    this._acceptButton = mkBtn('Accept', LEFT_W + GAP + RIGHT_W - 100, () => this._submit());

    // Total label — gold colour, centered between the buttons. Updated
    // by _refreshBasket so it tracks the running cart cost.
    this._totalLabel = new Label('Total: 0gp', {
      fontSize: 13, hue: 0xffe070, stroke: true,
    });
    this._totalLabel.setPosition(LEFT_W + GAP + (RIGHT_W >> 1) - 40, y + 2);
    this._totalLabel.acceptMouseInput = false;
    this.add(this._totalLabel);
    this._resultLabel = new Label('', { fontSize: 9, hue: 0xb8d7a8, maxWidth: RIGHT_W - 40 });
    this._resultLabel.setPosition(LEFT_W + GAP + 20, y + 28);
    this.add(this._resultLabel);
  }

  _addToBasket(line, qty) {
    const key = this._lineKey(line);
    const available = Math.max(0, Number(line.amount ?? 1) | 0);
    if (available <= 0) return;
    const cur = this._basket.get(key);
    const next = Math.max(0, Math.min(available, (cur?.qty ?? 0) + Math.max(1, qty | 0)));
    if (cur) cur.qty = next;
    else     this._basket.set(key, { line, qty: next });
    this._selectedBasketKey = key;
    this._qtyInput?.setValue?.(String(next), { silent: true });
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
        row = this._basketRowPool.pop() ?? new ShopRow(entry.line, RIGHT_INNER_W);
        this._basketRows.set(key, row);
        if (!row.parent) this._right.add(row);
      }
      row.update(entry.line,
        () => {
          this._selectedBasketKey = key;
          this._qtyInput?.setValue?.(String(entry.qty), { silent: true });
        },
        () => this._removeFromBasket(key, true),
        () => this._setBasketQuantity(entry.line, entry.line.amount ?? 1));
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
    if (this._totalLabel) {
      const gold = world.player?.gold;
      this._totalLabel.setText(`Total: ${total}gp${Number.isFinite(gold) ? ` / ${gold}gp` : ''}`);
      this._totalLabel.setHue?.(Number.isFinite(gold) && total > gold ? 0xff806c : 0xffe070);
    }
  }

  _submit() {
    const picks = [];
    for (const { line, qty } of this._basket.values()) {
      if (line.serial) picks.push({ serial: line.serial, amount: qty });
    }
    if (picks.length === 0) { this._resultLabel?.setText?.('Select at least one item.'); return; }
    try {
      const pkt = this.isSell
        ? buildSellRequest(this.vendor, picks)
        : buildBuyRequest (this.vendor, picks);
      net.send(pkt);
      this._submitting = true;
      this._acceptButton.enabled = false;
      this._acceptButton.acceptMouseInput = false;
      this._acceptButton.node.alpha = 0.55;
      this._resultLabel?.setText?.('Waiting for the server…');
    } catch (e) { console.error('[shop] submit failed', e); }
  }

  _onTransactionMessage(text) {
    if (!this._submitting || typeof text !== 'string') return;
    const lower = text.toLowerCase();
    const relevant = lower.includes('goods are yours') || lower.includes('out of stock')
      || lower.includes('you need ') || lower.includes('you receive ')
      || lower.includes('granted free');
    if (!relevant) return;
    this._resultLabel?.setText?.(text.replace(/^\[system\]\s*/i, ''));
    const success = lower.includes('goods are yours') || lower.includes('granted free') || lower.includes('you receive ');
    if (success) {
      for (const { line, qty } of this._basket.values()) {
        line.amount = Math.max(0, (line.amount ?? 1) - qty);
      }
      this.items = this.items.filter((line) => (line.amount ?? 1) > 0);
      this._basket.clear();
      this._refreshBasket();
      this._renderStock();
    }
    if (!lower.includes('out of stock')) {
      this._submitting = false;
      this._acceptButton.enabled = true;
      this._acceptButton.acceptMouseInput = true;
      this._acceptButton.node.alpha = 1;
    }
  }

  dispose() {
    for (const u of this._unsubs ?? []) u?.();
    this._stockRows.length = 0;
    for (const row of this._stockRowPool) row.dispose?.();
    this._stockRowPool.length = 0;
    this._basketRows.clear();
    this._basketRowPool.length = 0;
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
