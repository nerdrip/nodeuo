// CounterBarGump — pinned strip of "regs counter" slots. Mirrors CUO
// `Game/UI/Gumps/CounterBarGump.cs`. Each slot binds to an item graphic
// (drag from inventory → drop on slot) and shows the running count of
// that graphic in the player's backpack.
//
// We compute the count by scanning `world.items` for items whose `parent`
// is the player's backpack serial and whose `itemId` matches. Updates on
// every container content event.
//
// Persistence: slots[] is saved to the per-character profile.

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Label } from '../controls/label.js';
import { ItemPic } from '../controls/item-pic.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { profile } from '../../managers/profile-manager.js';
import { dragDrop } from '../../managers/drag-drop.js';

// CUO native slot size is 44×44 — bumping from 36 so the count label
// fits comfortably under three-digit counts ("999 ar" style) without
// clipping into the neighbouring slot. PAD widened a touch so the
// bar has room to breathe.
const SLOT = 44;
const COLS = 10;
const PAD  = 6;
const COUNTER_KEY_STRIDE = 0x10000;

function counterKey(itemId, hue = 0) {
  return ((hue & 0xffff) * COUNTER_KEY_STRIDE) + (itemId & 0xffff);
}

function itemIdFromCounterKey(key) {
  return key & 0xffff;
}

function hueFromCounterKey(key) {
  return Math.floor(key / COUNTER_KEY_STRIDE) & 0xffff;
}

class CounterSlot extends Control {
  constructor(idx, onSet) {
    super();
    this.slotIdx = idx;
    this.width = SLOT;
    this.height = SLOT;
    this.acceptMouseInput = true;
    this._onSet = onSet;
    this._bound = null;     // { itemId, hue }
    this._boundKey = 0;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    // Count label sits as a small "badge" in the bottom-right corner
    // of the slot — cream + stroke makes it readable against any item
    // sprite underneath. Anchored from the bottom-right corner so
    // multi-digit counts grow to the LEFT and don't bleed into the
    // adjacent slot.
    this._countLbl = new Label('', { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._countLbl.setPosition(3, SLOT - 14);
    this._countLbl.acceptMouseInput = false;
    this.add(this._countLbl);
  }
  bind(itemId, hue) {
    this._bound = itemId ? { itemId, hue: hue || 0 } : null;
    this._boundKey = this._bound ? counterKey(this._bound.itemId, this._bound.hue) : 0;
    if (this._pic) { this._pic.dispose(); this._pic = null; }
    if (this._bound) {
      this._pic = new ItemPic(this._bound.itemId, { hue: this._bound.hue });
      this._pic.setPosition(2, 2);
      this._pic.acceptMouseInput = false;
      this.add(this._pic);
    }
  }
  bound() { return this._bound; }
  boundKey() { return this._boundKey; }
  setCount(n) { this._countLbl.setText(n > 0 ? String(n) : ''); }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, SLOT, SLOT)
      .fill({ color: hover ? 0x21283a : 0x161c2a, alpha: 0.85 })
      .stroke({ width: 1, color: hover ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
  onClick(e) {
    if (e?.button === 2) { this.bind(null); this._onSet?.(this.slotIdx, null); return; }
    // Bind from currently-held item (drag-drop manager).
    const held = dragDrop.held;
    if (held && held.itemId) {
      this.bind(held.itemId, held.hue || 0);
      this._onSet?.(this.slotIdx, this._bound);
      // Return the item to wherever it came from — counter binding
      // doesn't consume the held item.
      try { dragDrop.reject(); } catch { /* noop */ }
    }
  }
}

export class CounterBarGump extends Gump {
  constructor(x = 8, y = 32) {
    super();
    // Pinned hotbar — RMB on a counter slot must NOT close the bar,
    // otherwise the user loses their entire ammo/reagent counter setup
    // on every accidental right-click while playing. The bar is closed
    // via the top-bar Counter toggle instead.
    this.canCloseWithRMB = false;
    const w = COLS * (SLOT + PAD) + PAD;
    const h = SLOT + PAD * 2;
    this.setPosition(x, y);
    this.setSize(w, h);
    // Background (drag handle).
    const bgCtrl = new Control();
    bgCtrl.width = w; bgCtrl.height = h;
    bgCtrl.acceptMouseInput = true;
    bgCtrl.isDragHandle = true;
    const bg = new Graphics();
    bg.rect(0, 0, w, h)
      .fill({ color: 0x0d1320, alpha: 0.85 })
      .stroke({ width: 1, color: 0x6a4a18 });
    bgCtrl.node.addChild(bg);
    this.add(bgCtrl);

    /** @type {CounterSlot[]} */
    this._slots = [];
    this._refreshRaf = 0;
    this._counterCounts = new Map();
    this._autoBoundKeys = new Set();
    this._autoCandidates = [];
    const saved = profile.loadGumpState?.('counterbar') ?? {};
    const savedSlots = Array.isArray(saved.slots) ? saved.slots : [];
    for (let i = 0; i < COLS; i++) {
      const slot = new CounterSlot(i, (idx, info) => this._persist(idx, info));
      slot.setPosition(PAD + i * (SLOT + PAD), PAD);
      this.add(slot);
      this._slots.push(slot);
      const ss = savedSlots[i];
      if (ss && ss.itemId) slot.bind(ss.itemId, ss.hue || 0);
    }

    this._unsubs = [
      bus.on('container:contents',    () => this._scheduleRefresh()),
      bus.on('container:item-update', () => this._scheduleRefresh()),
      bus.on('entity:removed',        () => this._scheduleRefresh()),
    ];
    this._refresh();
  }

  get type() { return 'counterbar'; }
  dispose() {
    for (const u of this._unsubs) u();
    if (this._refreshRaf) {
      const cancel = typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame
        : clearTimeout;
      cancel(this._refreshRaf);
      this._refreshRaf = 0;
    }
    super.dispose();
  }

  _scheduleRefresh() {
    if (this._refreshRaf) return;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._refreshRaf = raf(() => {
      this._refreshRaf = 0;
      this._refresh();
    });
  }

  _persist(_idx, _info) {
    const slots = this._slots.map((s) => s.bound());
    try { profile.saveGumpState?.('counterbar', { slots }); } catch { /* noop */ }
  }

  _refresh() {
    if (!world.player) return;
    // Find the player's backpack serial.
    const bp = world.player.equipment?.get?.(21)?.serial; // Layer 21 = Backpack
    if (!bp) return;
    /** @type {Map<number, number>} */
    const counts = this._counterCounts;
    counts.clear();
    const addCount = (it) => {
      const key = counterKey(it.itemId, it.hue || 0);
      counts.set(key, (counts.get(key) || 0) + (it.amount || 1));
    };
    if (world.forEachDescendant) {
      world.forEachDescendant(bp >>> 0, addCount);
    } else if (world.descendantsOf) {
      for (const it of world.descendantsOf(bp >>> 0)) addCount(it);
    } else {
      // Walk every sub-container under the backpack so reagents/ammo in
      // pouches still register. Mirrors CUO `CounterBarGump.cs::CalculateAmount`
      // which recurses through `Backpack.FindItemsByGraphic`.
      const containerSerials = new Set([bp >>> 0]);
      let added = true;
      while (added) {
        added = false;
        for (const it of world.items.values()) {
          if (!containerSerials.has(it.parent >>> 0)) continue;
          // Treat any container-shaped item (has its own contents) as a
          // potential sub-container. We don't know item kind in advance,
          // so add every item — non-containers simply won't have children.
          if (!containerSerials.has(it.serial >>> 0)) {
            containerSerials.add(it.serial >>> 0);
            added = true;
          }
        }
      }
      for (const it of world.items.values()) {
        if (!containerSerials.has(it.parent >>> 0)) continue;
        addCount(it);
      }
    }
    for (const slot of this._slots) {
      const key = slot.boundKey();
      slot.setCount(key ? (counts.get(key) || 0) : 0);
    }
    // Auto-count: populate empty slots with the most-common backpack
    // stacks not already bound. Mirrors CUO `CounterBarGump.cs::AutoCount`
    // (added late in 0.1.10) — fires once per content refresh.
    if (profile.get('counters.autoCount')) this._autoBind(counts);
  }

  _autoBind(counts) {
    // Existing slot bindings to skip.
    const bound = this._autoBoundKeys;
    bound.clear();
    for (const slot of this._slots) {
      const key = slot.boundKey();
      if (key) bound.add(key);
    }
    // Sort candidates by count desc so the biggest stacks fill first.
    const cand = this._autoCandidates;
    cand.length = 0;
    for (const entry of counts.entries()) {
      if (!bound.has(entry[0])) cand.push(entry);
    }
    cand.sort((a, b) => b[1] - a[1]);
    let ci = 0;
    for (const slot of this._slots) {
      if (slot.boundKey()) continue;
      if (ci >= cand.length) break;
      const key = cand[ci++][0];
      slot.bind(itemIdFromCounterKey(key), hueFromCounterKey(key));
      this._persist(slot.slotIdx, slot.bound());
    }
  }
}
