// DragDropManager — owns the "currently held item" state. Mirrors
// ClassicUO's GameCursor.ItemHold pattern.
//
// Lift flow:
//   1. user mouse-downs on an item in a container/world
//   2. ContainerGump (or world picker) calls dragDrop.tryLift(item, amount)
//   3. that sends 0x07 LiftReq + sets `held = item` optimistically
//   4. server replies 0x29 DropApproved (success) or 0x27 PickUpRejected
//
// Drop flow:
//   1. user mouse-ups over a target (gump, paperdoll slot, ground)
//   2. that target calls dragDrop.dropTo*(...)
//   3. it sends 0x08/0x13 with appropriate args + clears `held`

import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { buildLiftReq, buildDropReq, buildEquipReq } from '../net/outgoing.js';
import { world } from '../world/world.js';
import { assets } from '../assets/asset-manager.js';

const PICKUP_REJECT_REASONS = {
  0: 'You cannot pick that up.',
  1: 'That is too far away.',
  2: 'That cannot be reached.',
  3: 'That object is too heavy.',
  4: 'That is locked down.',
  5: 'You already have something in your hands.',
  6: 'You cannot pick that up.',
  7: 'That is in someone else\'s pack.',
};

class DragDrop {
  constructor() {
    /** @type {{serial:number,itemId:number,hue:number,amount:number} | null} */
    this.held = null;
    // Auto-rollback on server reject (0x27 PickUpRejected).
    bus.on('drag:rejected-by-server', ({ reason }) => {
      if (!this.held) return;
      const item = this.held;
      this.held = null;
      const text = PICKUP_REJECT_REASONS[reason] ?? `Pick-up refused (code ${reason}).`;
      bus.emit('chat:system', { text });
      bus.emit('drag:rejected', item);
    });
    // Server-initiated drag cancel (0x28 DragCancel). Client perf round 2
    // #1: net handler emits this event, but nothing was listening — the
    // cursor sprite + this.held stayed in "carrying" state after a lift
    // desync, then re-sent a stale drop later. Mirror the reject flow.
    bus.on('drag:cancel-by-server', () => {
      if (!this.held) return;
      const item = this.held;
      this.held = null;
      bus.emit('drag:rejected', item);
    });
    // Client audit #6 #4 — clear on disconnect so a stale `held` from
    // the previous session doesn't emit a phantom 0x08 to the new server.
    bus.on('net:close', () => {
      if (this.held) {
        this.held = null;
        bus.emit('drag:rejected', null);
      }
    });
  }

  /** Send 0x07 + set local held state optimistically. `layer` is
   *  optional — callers that already know the canonical wear-slot
   *  (containers reading tiledata, paperdoll re-equip) pass it so the
   *  paperdoll's drop handler can resolve it without a round trip
   *  through tiledata or world.items. */
  tryLift({ serial, itemId, hue = 0, amount = 1, layer = 0 }) {
    if (this.held) return false;
    this.held = { serial: serial >>> 0, itemId, hue, amount, layer: layer | 0 };
    this.liftedAt = performance.now();
    net.send(buildLiftReq(serial, amount));
    bus.emit('drag:lifted', this.held);
    return true;
  }

  /** Same as `isHolding` plus a debounce: returns false for ~120 ms
   *  after a fresh lift so the SAME mousedown→mouseup that started
   *  the drag doesn't immediately fire a drop on the source slot.
   *  CUO uses click-to-lift / click-to-drop semantics; without a
   *  debounce the user's lift action would always self-cancel. */
  canDrop() {
    if (!this.held) return false;
    return performance.now() - (this.liftedAt ?? 0) > 120;
  }

  /** Server replied 0x27 — restore the item visually. We just clear local
   *  state; ContainerGump / World will re-receive the item via the regular
   *  0x25 update broadcast. */
  reject() {
    const item = this.held;
    this.held = null;
    bus.emit('drag:rejected', item);
  }

  /** Drop into a container (or onto another item that auto-stacks). */
  dropToContainer(containerSerial, x, y, gridLocation = 0) {
    if (!this.held) return;
    const item = this.held;
    this.held = null;
    net.send(buildDropReq(item.serial, x, y, 0, gridLocation, containerSerial));
    bus.emit('drag:dropped', { ...item, container: containerSerial >>> 0, x, y });
  }

  /** Drop onto the ground at (x, y, z). serial 0xFFFFFFFF = world. */
  dropToGround(x, y, z) {
    if (!this.held) return;
    const item = this.held;
    this.held = null;
    net.send(buildDropReq(item.serial, x, y, z, 0, 0xFFFFFFFF));
    bus.emit('drag:dropped', { ...item, container: 0xFFFFFFFF, x, y, z });
  }

  /** Equip onto `mobileSerial` (usually `world.player.serial`) at the
   *  given UO Layer enum value (e.g. 1 = right-hand, 21 = backpack). */
  dropToEquip(mobileSerial, layer) {
    if (!this.held) return;
    const item = this.held;
    // Equipping an item already carried in the backpack does not increase
    // total carried weight. The previous client-side check added its weight
    // a second time and blocked spellbooks/clothing whenever the status
    // packet reported a near-full pack. Strength/equip requirements remain
    // authoritative on the server, which returns the normal bounce reason.
    this.held = null;
    net.send(buildEquipReq(item.serial, layer, mobileSerial));
    bus.emit('drag:equipped', { ...item, mobile: mobileSerial >>> 0, layer });
  }

  /** Audit rev.4 P2 — local weight check. Returns true if the wearer's
   *  current `weight` + item weight stays under `weightMax`. Falls
   *  back to "allow" when any data point is missing so we don't block
   *  legitimate equips just because the client hasn't received a 0x11
   *  ExtendedStats yet. Only enforced for the local player; other
   *  mobiles defer entirely to the server. */
  _validateWeight(item, mobileSerial, _layer) {
    const p = world.player;
    if (!p) return true;
    if ((mobileSerial >>> 0) !== (p.serial >>> 0)) return true;
    if (p.weightMax == null || p.weight == null) return true;
    const itemW = item.weight ?? this._weightFor(item.itemId) ?? 1;
    const next = (p.weight | 0) + itemW;
    return next <= (p.weightMax | 0);
  }

  /** Resolve a static weight from `assets.tiledata`. Returns null when
   *  unknown. */
  _weightFor(itemId) {
    try {
      const stat = assets?.tiledata?.statics?.[itemId | 0];
      const w = stat?.weight | 0;
      return Number.isFinite(w) ? w : null;
    } catch { return null; }
  }

  isHolding() { return this.held !== null; }
}

export const dragDrop = new DragDrop();
