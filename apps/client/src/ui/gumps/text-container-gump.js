// TextContainerGump — text-list alt view for any open container.
// Mirrors ClassicUO `Game/UI/Gumps/ContainerGumpAltText.cs`. Where the
// classic ContainerGump renders item sprites at their server-supplied
// grid coords, this variant lists items as one-line entries — easier
// to scan for accessibility and screen-reader users, and useful for
// inspecting a corpse on a small viewport.
//
// Each row: `<icon> <name> ×<amount> (<hue>)`. Click to single-pick,
// right-click to lift via dragDrop. Updates live via the same
// container:contents / container:item-update / entity:removed bus
// events as the regular gump so the two views stay in sync.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { Control } from '../control.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildLiftReq, buildDropReq } from '../../net/outgoing.js';
import { dragDrop } from '../../managers/drag-drop.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { assets } from '../../assets/asset-manager.js';

const ROW_H = 22;
const PAD = 8;

class ItemRow extends Control {
  constructor(item, onLift) {
    super();
    this.width = 320; this.height = ROW_H;
    this.acceptMouseInput = true;
    this._onLift = onLift;

    // Icon column (24×22).
    this._icon = new ItemPic(item.itemId, { hue: item.hue || 0 });
    this._icon.acceptMouseInput = false;
    this._icon.setPosition(2, 2);
    this.add(this._icon);

    this._lbl = new Label('', { fontSize: 11, hue: 0xfff0c0, stroke: false });
    this._lbl.acceptMouseInput = false;
    this._lbl.setPosition(30, 4);
    this.add(this._lbl);
    this.update(item);
  }
  _tooltipName(serial) {
    const lines = tooltips?._cache?.get?.(serial >>> 0);
    if (!lines?.length) return null;
    const first = lines[0];
    const raw = typeof first === 'string' ? first
              : (first?.args ?? first?.text ?? '');
    const txt = String(raw).split('\t')[0].trim();
    return txt || null;
  }
  _tiledataName(itemId) {
    const t = assets?.tiledata?.statics?.[itemId | 0]
           ?? assets?.tiledata?.statics?.[(itemId | 0) + 0x4000];
    return t?.name || null;
  }
  update(item) {
    this._item = item;
    this._icon.setItemId(item.itemId);
    this._icon.setHue(item.hue || 0);
    // Resolve a human name. First preference: cached OPL line; fallback
    // to tiledata.statics name; last resort the hex itemId.
    let displayName = this._tooltipName(item.serial) ?? this._tiledataName(item.itemId);
    if (!displayName) displayName = `0x${(item.itemId | 0).toString(16).padStart(4, '0')}`;
    const amount = (item.amount | 0) > 1 ? ` ×${item.amount}` : '';
    const hueSuffix = item.hue ? `  (hue ${item.hue})` : '';
    this._lbl.setText(`${displayName}${amount}${hueSuffix}`);
    this.visible = true;
    this.node.visible = true;
  }
  onMouseEnter() { this._lbl.setHue?.(0xffd060); }
  onMouseLeave() { this._lbl.setHue?.(0xfff0c0); }
  onClick(btn) {
    if (btn === 2) { this._onLift?.(this._item); return; }
    // Left-click lifts a single unit (like the icon click in the
    // regular ContainerGump).
    if (dragDrop.isHolding()) return;
    dragDrop.tryLift({
      serial: this._item.serial, itemId: this._item.itemId,
      hue: this._item.hue, amount: this._item.amount,
    });
  }
}

export class TextContainerGump extends WindowGump {
  /** @param {number} containerSerial */
  constructor(containerSerial) {
    super({
      title: 'Container (text)',
      width: 340, height: 360,
      x: 240, y: 200,
    });
    this.containerSerial = containerSerial >>> 0;
    /** @type {Map<number, ItemRow>} */
    this._rows = new Map();
    this._rowPool = [];
    this._seenScratch = new Set();

    this._scroll = new ScrollArea({ width: 320, height: 320 });
    this.addContent(this._scroll, PAD, 30);

    this._unsubs = [
      bus.on('container:contents', (info) => {
        if ((info.containerSerial >>> 0) !== this.containerSerial) return;
        this._rebuildFrom(info.items ?? []);
      }),
      bus.on('container:item-update', (info) => {
        if ((info.parent >>> 0) !== this.containerSerial) return;
        this._addOrUpdate(info);
      }),
      bus.on('entity:removed', ({ serial }) => {
        const r = this._rows.get(serial >>> 0);
        if (!r) return;
        this._releaseRow(r);
        this._rows.delete(serial >>> 0);
        this._relayout();
      }),
    ];

    // Pre-fill from already-known children, since the container open
    // event fires BEFORE we wire the listener if the player opens the
    // same corpse twice in a row.
    if (world.childrenOf) {
      const initial = [];
      for (const it of world.childrenOf(this.containerSerial)) initial.push(it);
      if (initial.length) this._rebuildFrom(initial);
    }
  }

  get type() { return `text-container:${this.containerSerial}`; }
  get positionKey() { return 'text-container'; }
  dispose() {
    for (const u of this._unsubs) u();
    for (const row of this._rows.values()) row.dispose?.();
    for (const row of this._rowPool) row.dispose?.();
    this._rows.clear();
    this._rowPool.length = 0;
    super.dispose();
  }

  _rebuildFrom(items) {
    const seen = this._seenScratch;
    seen.clear();
    for (const it of items) {
      seen.add(it.serial >>> 0);
      this._addOrUpdate(it, /* deferRelayout */ true);
    }
    for (const [serial, row] of this._rows) {
      if (seen.has(serial)) continue;
      this._releaseRow(row);
      this._rows.delete(serial);
    }
    seen.clear();
    this._relayout();
  }

  _addOrUpdate(item, deferRelayout = false) {
    let row = this._rows.get(item.serial >>> 0);
    if (row) {
      row.update(item);
    } else {
      row = this._rowPool.pop() ?? new ItemRow(item, (it) => this._liftOne(it));
      row.update(item);
      if (!row.parent) this._scroll.add(row);
      this._rows.set(item.serial >>> 0, row);
    }
    if (!deferRelayout) this._relayout();
  }

  _releaseRow(row) {
    row.visible = false;
    row.node.visible = false;
    this._rowPool.push(row);
  }

  _relayout() {
    let y = 0;
    for (const row of this._rows.values()) {
      row.setPosition(0, y);
      y += ROW_H;
    }
    this._scroll.setContentHeight?.(y);
  }

  /** Right-click on a row lifts the item and drops it into the player's
   *  backpack — equivalent to a "Loot This" entry on the context menu. */
  _liftOne(it) {
    const pack = world.player?.equipment?.get?.(21);
    if (!pack) return;
    try {
      net.send(buildLiftReq(it.serial, it.amount ?? 1));
      net.send(buildDropReq(it.serial, 0xFFFF, 0xFFFF, 0, 0, pack.serial >>> 0));
    } catch { /* socket transient */ }
  }
}
