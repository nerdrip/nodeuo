// GridLootGump — alternative corpse-loot view that lays the corpse's
// contents out on a regular grid (instead of free-form). CUO offers
// this as a player-pref switch; many farmers prefer the grid for fast
// "Loot All" macros. Mirrors `Game/UI/Gumps/GridLootGump.cs`.
//
// We borrow the existing ContainerGump behaviour by simply being an
// alternative renderer over the same `container:contents` events.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { bus } from '../../core/event-bus.js';
import { dragDrop } from '../../managers/drag-drop.js';
import { world } from '../../world/world.js';

const SLOT = 44;
const COLS = 5;
const PAD  = 8;
const HEADER_H = 28;

class LootSlot extends Control {
  constructor() {
    super();
    this.acceptMouseInput = true;
    this.width = SLOT; this.height = SLOT;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this.item = null;
    this._draw(false);
  }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, SLOT, SLOT)
      .fill({ color: 0x101418, alpha: 0.85 })
      .stroke({ width: 2, color: hover ? 0xfff0a0 : 0x6e5520, alpha: 1 });
  }
  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
  setItem(item) {
    if (this._tile) { this._tile.dispose(); this._tile = null; }
    if (this._lbl)  { this._lbl.dispose();  this._lbl = null; }
    this.item = item;
    if (!item) return;
    const p = new ItemPic(item.itemId, { hue: item.hue });
    p.setPosition(2, 2);
    p.acceptMouseInput = false;
    this.add(p); this._tile = p;
    if ((item.amount ?? 1) > 1) {
      const lbl = new Label(`×${item.amount}`, { fontSize: 9, hue: 0xffe0a0, stroke: true });
      lbl.setPosition(2, SLOT - 12);
      lbl.acceptMouseInput = false;
      this.add(lbl); this._lbl = lbl;
    }
  }
}

export class GridLootGump extends WindowGump {
  constructor(corpseSerial) {
    const rows = 4;
    super({
      title: 'Corpse',
      width:  PAD * 2 + COLS * SLOT + 80,
      height: HEADER_H + PAD * 2 + rows * SLOT + 30,
      x: 280, y: 200,
    });
    this.corpseSerial = corpseSerial >>> 0;
    /** @type {LootSlot[]} */
    this._slots = [];
    /** @type {Map<number, LootSlot>} */
    this._byItem = new Map();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const slot = new LootSlot();
        slot.setPosition(PAD + c * SLOT, HEADER_H + PAD + r * SLOT);
        slot.onClick = (btn) => {
          if (btn !== 0 || !slot.item || dragDrop.isHolding()) return;
          dragDrop.tryLift({
            serial: slot.item.serial, itemId: slot.item.itemId,
            hue: slot.item.hue, amount: slot.item.amount,
          });
        };
        this.add(slot);
        this._slots.push(slot);
      }
    }

    // "Loot All" button: lift each slot and immediately drop into our
    // backpack. CUO ratelimits to 1 per ~150ms; we mirror that.
    const lootAll = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 80, height: 22,
      label: 'Loot All', action: ButtonAction.Activate,
    });
    lootAll.setPosition(PAD * 2 + COLS * SLOT + 2, HEADER_H + 8);
    lootAll.onClick = () => this._lootAll();
    this.add(lootAll);

    this._unsubs = [
      bus.on('container:contents', (info) => {
        if (info.containerSerial !== this.corpseSerial) return;
        for (const s of this._slots) s.setItem(null);
        this._byItem.clear();
        info.items.slice(0, this._slots.length).forEach((it, i) => {
          this._slots[i].setItem(it);
          this._byItem.set(it.serial >>> 0, this._slots[i]);
        });
      }),
      bus.on('entity:removed', ({ serial }) => {
        const s = this._byItem.get(serial >>> 0);
        if (s) { s.setItem(null); this._byItem.delete(serial >>> 0); }
      }),
      // Audit #36 P1 #4 — refresh when an item is added/moved inside
      // the open corpse mid-view. CUO `GridLootGump.UpdateContents`
      // re-walks the corpse's items on every change (paragon delayed
      // loot, decay-merge of stacking piles). Was: only listened for
      // `container:contents` (initial open) and `entity:removed`, so
      // items added after the gump opened never appeared.
      bus.on('container:item-update', (info) => {
        if ((info.parent >>> 0) !== this.corpseSerial) return;
        // Find first empty slot OR reuse the slot already keyed to
        // this item's serial.
        const existing = this._byItem.get(info.serial >>> 0);
        if (existing) {
          existing.setItem(info);
          return;
        }
        const free = this._slots.find((s) => !s.item);
        if (!free) return;            // grid full
        free.setItem(info);
        this._byItem.set(info.serial >>> 0, free);
      }),
    ];
  }

  get type() { return `grid-loot:${this.corpseSerial}`; }
  get positionKey() { return 'grid-loot'; }

  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  async _lootAll() {
    const pack = world.player?.equipment?.get?.(21);
    if (!pack) return;
    for (const slot of this._slots) {
      if (!slot.item) continue;
      if (dragDrop.isHolding()) await new Promise((r) => setTimeout(r, 200));
      dragDrop.tryLift({
        serial: slot.item.serial, itemId: slot.item.itemId,
        hue: slot.item.hue, amount: slot.item.amount,
      });
      await new Promise((r) => setTimeout(r, 150));
      dragDrop.dropToContainer(pack.serial, 0, 0, 0);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
