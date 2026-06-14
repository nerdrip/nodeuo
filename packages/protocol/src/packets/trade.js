// Secure trade (0x6F) — player-to-player item exchange.
//
// Subcommand table (first byte after u16 length):
//   0x00 OpenWindow            u32 containerSerial, u32 otherSerial, u32 ourSerial, u8 hasName, ASCII name
//   0x01 CloseWindow           u32 serial
//   0x02 CheckBox              u32 serial, u32 acceptedByFirst (0/1), u32 acceptedBySecond
//   0x03 UpdateGold            u32 serial, u32 gold, u32 platinum   (modern clients)
//   0x04 UpdateLedger          u32 serial, u32 gold, u32 platinum
//
// Trade windows are containers, so the usual 0x3C/0x24/0x25 packets drive
// the inventory preview — this opcode just opens/closes/confirms them.

import { PacketWriter } from '../buffer.js';

function beginTrade(sub, cap = 24) {
  const w = new PacketWriter(cap);
  w.writeU8(0x6F);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU8(sub & 0xff);
  return { w, lenPos };
}

function finishTrade(ctx) {
  ctx.w.setU16At(ctx.lenPos, ctx.w.length);
  return ctx.w.bytes();
}

/**
 * 0x6F 0x00 Open secure-trade window.
 *
 * @param {Object} p
 * @param {number} p.containerSerial  the server-side trade container
 * @param {number} p.otherSerial      partner mobile
 * @param {number} p.ourSerial        viewer mobile
 * @param {string} [p.partnerName]
 */
export function tradeOpen({ containerSerial, otherSerial, ourSerial, partnerName = '' }) {
  const ctx = beginTrade(0x00, 64);
  ctx.w.writeU32(containerSerial >>> 0);
  ctx.w.writeU32(otherSerial >>> 0);
  ctx.w.writeU32(ourSerial >>> 0);
  const bytes = new TextEncoder().encode(partnerName);
  ctx.w.writeU8(bytes.length > 0 ? 1 : 0);
  for (const b of bytes) ctx.w.writeU8(b);
  ctx.w.writeU8(0);
  return finishTrade(ctx);
}

/**
 * 0x6F 0x01 Close window for the given trade container.
 * @param {number} containerSerial
 */
export function tradeClose(containerSerial) {
  const ctx = beginTrade(0x01, 8);
  ctx.w.writeU32(containerSerial >>> 0);
  return finishTrade(ctx);
}

/**
 * 0x6F 0x02 Update checkbox state (accepted by first / second).
 *
 * @param {Object} p
 * @param {number} p.containerSerial
 * @param {boolean} p.first
 * @param {boolean} p.second
 */
export function tradeCheck({ containerSerial, first, second }) {
  const ctx = beginTrade(0x02, 16);
  ctx.w.writeU32(containerSerial >>> 0);
  ctx.w.writeU32(first ? 1 : 0);
  ctx.w.writeU32(second ? 1 : 0);
  return finishTrade(ctx);
}

/**
 * 0x6F 0x03 Update gold / platinum for a side of the trade.
 *
 * @param {Object} p
 * @param {number} p.containerSerial
 * @param {number} p.gold
 * @param {number} p.platinum
 */
export function tradeUpdateGold({ containerSerial, gold, platinum }) {
  const ctx = beginTrade(0x03, 16);
  ctx.w.writeU32(containerSerial >>> 0);
  ctx.w.writeU32(gold >>> 0);
  ctx.w.writeU32(platinum >>> 0);
  return finishTrade(ctx);
}

/**
 * Parse client 0x6F reply (close or check).
 * @param {Uint8Array} pkt
 */
export function readTradeCommand(pkt) {
  if (pkt[0] !== 0x6F) throw new Error('not 0x6F trade');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const sub = dv.getUint8(3);
  const containerSerial = dv.getUint32(4);
  if (sub === 0x01) return { kind: 'close', containerSerial };
  if (sub === 0x02) {
    return {
      kind: 'check',
      containerSerial,
      first: dv.getUint32(8) !== 0,
      second: dv.getUint32(12) !== 0,
    };
  }
  return { kind: 'unknown', containerSerial };
}
