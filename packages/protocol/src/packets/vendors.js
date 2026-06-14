// NPC vendor (shopkeeper) packets.
//
// Flow:
//   1. Client double-clicks vendor → server sends 0x3C VendorBuyContents (item list)
//      + 0x74 OpenBuyWindow (prices + names for each item).
//   2. Client picks stack → sends 0x3B BuyRequest with (vendor serial, flag, items[]).
//   3. Server adjusts gold + inventory, replies with standard containerContentUpdate
//      for the purchased items landing in player's backpack.
//
// Sell:
//   1. Server sends 0x9E SellList (items the vendor will buy back).
//   2. Client replies with 0x9F SellResponse listing serial + amount.
//
// ServUO: Server/Mobiles/Vendor.cs, Server/Network/Packets.cs `VendorBuyContent`,
// `DisplayBuyList`, `VendorSellList`.
//
// For v1 we implement a simplified but wire-correct emitter/parser set.

import { PacketWriter } from '../buffer.js';

/**
 * 0x74 OpenBuyWindow — names + prices for a vendor's stock.
 *
 * @param {Object} p
 * @param {number} p.vendorSerial         the container displaying the items
 * @param {{price:number, description:string}[]} p.entries
 */
export function openBuyWindow({ vendorSerial, entries }) {
  const w = new PacketWriter(64);
  w.writeU8(0x74);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(vendorSerial >>> 0);
  w.writeU8(entries.length & 0xff);
  for (const e of entries) {
    w.writeU32(e.price >>> 0);
    const desc = String(e.description ?? '');
    const bytes = new TextEncoder().encode(desc);
    const n = Math.min(bytes.length, 254);
    w.writeU8(n + 1);
    for (let i = 0; i < n; i++) w.writeU8(bytes[i]);
    w.writeU8(0);
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0x9E VendorSellList — items the vendor will buy from the player.
 *
 * @param {Object} p
 * @param {number} p.vendorSerial
 * @param {{serial:number, itemId:number, hue:number, amount:number, price:number, name:string}[]} p.entries
 */
export function vendorSellList({ vendorSerial, entries }) {
  const w = new PacketWriter(128);
  w.writeU8(0x9E);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(vendorSerial >>> 0);
  w.writeU16(entries.length & 0xFFFF);
  for (const e of entries) {
    w.writeU32(e.serial >>> 0);
    w.writeU16(e.itemId & 0xFFFF);
    w.writeU16(e.hue & 0xFFFF);
    w.writeU16(e.amount & 0xFFFF);
    w.writeU16(e.price & 0xFFFF);
    const bytes = new TextEncoder().encode(e.name ?? '');
    const n = Math.min(bytes.length, 255);
    w.writeU16(n);
    for (let i = 0; i < n; i++) w.writeU8(bytes[i]);
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse 0x3B VendorBuyReply (client → server).
 *
 * Layout:
 *   u8 0x3B
 *   u16 length
 *   u32 vendorSerial
 *   u8 flag        (0x00 = cancel; 0x02 = purchase)
 *   repeated per item (when flag=0x02):
 *     u8 layer     (always 0x1A)
 *     u32 itemSerial
 *     u16 amount
 *
 * @param {Uint8Array} pkt
 */
export function readBuyRequest(pkt) {
  if (pkt[0] !== 0x3B) throw new Error('not a 0x3B buy request');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const len = dv.getUint16(1);
  const vendorSerial = dv.getUint32(3);
  const flag = dv.getUint8(7);
  /** @type {{serial:number, amount:number}[]} */
  const items = [];
  if (flag === 0x02) {
    let o = 8;
    while (o + 7 <= len) {
      o += 1; // layer (0x1A)
      const serial = dv.getUint32(o); o += 4;
      const amount = dv.getUint16(o); o += 2;
      items.push({ serial, amount });
    }
  }
  return { vendorSerial, flag, items };
}

/**
 * Parse 0x9F VendorSellReply (client → server).
 *
 * Layout:
 *   u8 0x9F
 *   u16 length
 *   u32 vendorSerial
 *   u16 itemCount
 *   per item:
 *     u32 itemSerial
 *     u16 amount
 *
 * @param {Uint8Array} pkt
 */
export function readSellReply(pkt) {
  if (pkt[0] !== 0x9F) throw new Error('not a 0x9F sell reply');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const vendorSerial = dv.getUint32(3);
  const count = dv.getUint16(7);
  /** @type {{serial:number, amount:number}[]} */
  const items = [];
  let o = 9;
  for (let i = 0; i < count; i++) {
    items.push({ serial: dv.getUint32(o), amount: dv.getUint16(o + 4) });
    o += 6;
  }
  return { vendorSerial, items };
}
