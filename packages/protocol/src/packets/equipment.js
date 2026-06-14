// Equipment / layer packets.
//
// Paperdoll layers — verified against ServUO `Server/Item.cs` enum Layer
// AND ClassicUO `Game/Data/Layers.cs`. Both use the same numeric values,
// only their string names differ slightly (we keep the ServUO names since
// our server-side code is ported from ServUO):
//
//   OneHanded=1, TwoHanded=2, Shoes=3, Pants=4, Shirt=5, Helm=6, Gloves=7,
//   Ring=8, Talisman=9, Neck=10, Hair=11, Waist=12, InnerTorso=13,
//   Bracelet=14, Face=15, FacialHair=16, MiddleTorso=17, Earrings=18,
//   Arms=19, Cloak=20, Backpack=21, OuterTorso=22, OuterLegs=23,
//   InnerLegs=24, Mount=25, ShopBuy=26, ShopResale=27, ShopSell=28, Bank=29.
//
// Wire packets:
//   0x13 WearItem (C->S) — client asks to equip a held item onto `targetSerial`
//                          at `layer`.
//   0x2E EquipUpdate (S->C) — server tells all viewers about a newly worn item.
//   0x29 DropAck (S->C) — legacy ack; already in pickup.js.

import { PacketWriter } from '../buffer.js';

export const Layer = Object.freeze({
  OneHanded: 1, TwoHanded: 2, Shoes: 3, Pants: 4, Shirt: 5, Helm: 6, Gloves: 7,
  Ring: 8, Talisman: 9, Neck: 10, Hair: 11, Waist: 12, InnerTorso: 13,
  Bracelet: 14, Face: 15, FacialHair: 16, MiddleTorso: 17, Earrings: 18,
  Arms: 19, Cloak: 20, Backpack: 21, OuterTorso: 22, OuterLegs: 23,
  InnerLegs: 24, Mount: 25,
});

/**
 * 0x2E EquipUpdate — 15 bytes fixed.
 *
 * @param {Object} p
 * @param {number} p.serial   the item being equipped
 * @param {number} p.itemId   graphic
 * @param {number} p.layer
 * @param {number} p.parent   mobile serial wearing the item
 * @param {number} [p.hue]
 */
export function equipUpdate({ serial, itemId, layer, parent, hue = 0 }) {
  const w = new PacketWriter(15);
  w.writeU8(0x2E);
  w.writeU8(0xFF); // skipped byte
  w.writeU8(0x00); // skipped byte
  // The classic 0x2E layout. ServUO writes it as:
  //   u8 0x2E
  //   u32 itemSerial
  //   u16 itemId
  //   u8 0x00 (layer prefix)
  //   u8 layer
  //   u32 mobileSerial
  //   u16 hue
  // We need to match that exactly; rewrite writer to correct offsets.
  const buf = new PacketWriter(15);
  buf.writeU8(0x2E);
  buf.writeU32(serial >>> 0);
  buf.writeU16(itemId & 0xFFFF);
  buf.writeU8(0);
  buf.writeU8(layer & 0xff);
  buf.writeU32(parent >>> 0);
  buf.writeU16(hue & 0xFFFF);
  // `w` above was scaffolding; discard in favour of `buf`.
  void w;
  return buf.bytes();
}

/**
 * Parse a 0x13 WearItem request from the client.
 *
 * Layout: u8 0x13; u32 itemSerial; u8 layer; u32 mobileSerial  (10 bytes).
 *
 * @param {Uint8Array} pkt
 */
export function readWearItem(pkt) {
  if (pkt.length < 10 || pkt[0] !== 0x13) throw new Error('not a 0x13 wear item');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  return {
    itemSerial: dv.getUint32(1),
    layer: dv.getUint8(5),
    mobileSerial: dv.getUint32(6),
  };
}
