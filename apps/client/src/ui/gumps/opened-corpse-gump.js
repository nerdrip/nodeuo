// OpenedCorpseGump — corpse loot view with action filters. Mirrors
// ClassicUO `Game/UI/Gumps/OpenedCorpseGump.cs`. We keep the standard
// GridLootGump for normal "click each item" flow; this variant adds a
// row of filter buttons that bulk-lift subsets of the corpse contents:
//
//   - [Loot All]   — every item, in the order the server sent them
//   - [Loot Mine]  — items whose `_lootable` flag is set (server attaches
//                    this for the corpse's owner / killer-credit player);
//                    falls back to "everything except corpse skin /
//                    bones" when the server didn't tag ownership.
//   - [Loot Coins] — gold (0x0EED), silver (0x14EF), bank check (0x14F0)
//   - [Lift Reagents] — the 8 magery reagents (0x0F7A..0x0F8D)
//
// Opens via `bus.emit('macro:gump', { kind: 'corpse-filter' })` — the
// scene's existing macro-gump dispatch is wired below in game-scene.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildLiftReq, buildDropReq } from '../../net/outgoing.js';
import { dragDrop } from '../../managers/drag-drop.js';

const PAD = 8;
const SLOT = 36;
const COLS = 6;
const ROWS = 5;
const HEADER_H = 30;
const BUTTON_ROW_H = 22;

// Item-id sets used by the filter buttons. Drawn from ServUO
// constants (Item ID 0x0EED gold pile / 0x14EF silver pile /
// 0x14F0 bank check / reagent run 0x0F7A..0x0F8D).
const COIN_IDS = new Set([0x0EED, 0x0EEC, 0x0EEB, 0x14EF, 0x14F0, 0x14F1]);
const REAGENT_IDS = new Set([
  0x0F7A, 0x0F7B, 0x0F84, 0x0F85, 0x0F86, 0x0F88, 0x0F8D, 0x0F8C, // Magery
  0x0F78, 0x0F7D, 0x0F8F, 0x0F8E, 0x0F8A,                         // Necro
]);
const CORPSE_PARTS = new Set([0x213D, 0x213E, 0x213F, 0x2140, 0x2141]); // bones / skin

class CorpseSlot extends Control {
  constructor() {
    super();
    this.width = SLOT; this.height = SLOT;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._drawFrame(false);
    this.item = null;
  }
  _drawFrame(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, SLOT, SLOT)
      .fill({ color: hover ? 0x322a14 : 0x1a1408, alpha: 0.85 })
      .stroke({ width: 1, color: 0x6a4a18 });
  }
  setItem(it) {
    this.item = it;
    if (this._pic) { try { this._pic.dispose?.(); } catch { /* ignore */ } this._pic = null; }
    if (this._amount) { try { this._amount.dispose?.(); } catch { /* ignore */ } this._amount = null; }
    if (!it) return;
    this._pic = new ItemPic(it.itemId, { hue: it.hue || 0 });
    this._pic.setPosition(2, 2);
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    if ((it.amount | 0) > 1) {
      this._amount = new Label(String(it.amount | 0),
                               { fontSize: 10, hue: 0xfff0c0, stroke: true });
      this._amount.setPosition(2, SLOT - 12);
      this._amount.acceptMouseInput = false;
      this.add(this._amount);
    }
  }
  onMouseEnter() { this._drawFrame(true); }
  onMouseLeave() { this._drawFrame(false); }
  onClick(btn) {
    if (btn !== 0 || !this.item || dragDrop.isHolding()) return;
    dragDrop.tryLift({
      serial: this.item.serial, itemId: this.item.itemId,
      hue: this.item.hue, amount: this.item.amount,
    });
  }
}

class FilterButton extends Control {
  constructor(label, onClick) {
    super();
    this.width = 84; this.height = 18;
    this.acceptMouseInput = true;
    this._bg = new Graphics();
    this._bg.rect(0, 0, this.width, this.height)
      .fill({ color: 0x281c10, alpha: 0.92 })
      .stroke({ width: 1, color: 0x6a4a18 });
    this.node.addChild(this._bg);
    this._lbl = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._lbl.setPosition(8, 3);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
  }
  onMouseEnter() { this._lbl.setHue?.(0xffd060); }
  onMouseLeave() { this._lbl.setHue?.(0xfff0c0); }
  onClick(btn) { if (btn === 0) this._onClick?.(); }
}

export class OpenedCorpseGump extends WindowGump {
  /** @param {number} corpseSerial */
  constructor(corpseSerial) {
    super({
      title: 'Corpse (filter)',
      width: PAD * 2 + COLS * SLOT + 4,
      height: HEADER_H + PAD * 2 + ROWS * SLOT + BUTTON_ROW_H + 8,
      x: 280, y: 200,
    });
    this.corpseSerial = corpseSerial >>> 0;
    /** @type {CorpseSlot[]} */
    this._slots = [];
    /** @type {Map<number, CorpseSlot>} */
    this._byItem = new Map();

    // Grid of corpse contents.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const s = new CorpseSlot();
        s.setPosition(PAD + c * SLOT, HEADER_H + PAD + r * SLOT);
        this.add(s);
        this._slots.push(s);
      }
    }

    // Filter buttons across the bottom.
    const buttonsY = HEADER_H + PAD + ROWS * SLOT + 4;
    const mkBtn = (label, x, onClick) => {
      const b = new FilterButton(label, onClick);
      b.setPosition(x, buttonsY);
      this.add(b);
    };
    mkBtn('Loot All',  PAD,                () => this._lift((it) => !!it));
    mkBtn('Loot Mine', PAD + 88,           () => this._lift((it) => !!it._lootable
      || (!CORPSE_PARTS.has(it.itemId | 0))));
    mkBtn('Coins',     PAD + 88 * 2,       () => this._lift((it) => COIN_IDS.has(it.itemId | 0)));
    mkBtn('Reagents',  PAD + 88 * 3 - 32,  () => this._lift((it) => REAGENT_IDS.has(it.itemId | 0)));

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
      bus.on('container:item-update', (info) => {
        if ((info.parent >>> 0) !== this.corpseSerial) return;
        const existing = this._byItem.get(info.serial >>> 0);
        if (existing) { existing.setItem(info); return; }
        const free = this._slots.find((s) => !s.item);
        if (!free) return;
        free.setItem(info);
        this._byItem.set(info.serial >>> 0, free);
      }),
    ];
  }

  get type() { return `corpse-filter:${this.corpseSerial}`; }
  get positionKey() { return 'corpse-filter'; }
  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  /** Lift every slot's item for which `predicate(item)` is truthy and
   *  drop it into the player's backpack. Throttled to 150 ms / item to
   *  match ServUO's anti-grab pacing. */
  async _lift(predicate) {
    const pack = world.player?.equipment?.get?.(21);
    if (!pack) return;
    for (const slot of this._slots) {
      const it = slot.item;
      if (!it || !predicate(it)) continue;
      if (dragDrop.isHolding()) await new Promise((r) => setTimeout(r, 200));
      try {
        net.send(buildLiftReq(it.serial, it.amount ?? 1));
        // Drop into pack at the container's auto-slot (0xFFFF/0xFFFF).
        net.send(buildDropReq(it.serial, 0xFFFF, 0xFFFF, 0, 0, pack.serial >>> 0));
      } catch { /* socket transient */ }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
