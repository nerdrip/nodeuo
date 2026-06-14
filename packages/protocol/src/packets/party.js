// Party system — ServUO `Engines/PartySystem/` + 0xBF subcommand 0x06.
//
// 0xBF 0x06 has its own mini-router:
//   0x01  Add a member (server ← client ⇔ server → client "invited")
//   0x02  Remove member (kick / leave)
//   0x03  Private tell to one member
//   0x04  Tell everyone in the party
//   0x06  Loot permission toggle
//   0x07  Invited — server asks target to accept/decline
//   0x08  Accept invitation (client → server only, triggers 0x01 broadcast)
//   0x09  Decline invitation
//
// We implement the wire encoding here; server state lives in
// `apps/server/src/party.js`.

import { PacketWriter } from '../buffer.js';

/**
 * Helper: begin a 0xBF 0x06 party subpacket.
 * @param {number} kind
 */
function beginParty(kind) {
  const w = new PacketWriter(16);
  w.writeU8(0xBF);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(0x0006);
  w.writeU8(kind & 0xff);
  return { w, lenPos };
}

function finishParty(ctx) {
  ctx.w.setU16At(ctx.lenPos, ctx.w.length);
  return ctx.w.bytes();
}

/**
 * 0xBF 0x06 0x01 — "party list" broadcast. Tells the client who is in the
 * party so they can render the roster.
 *
 * @param {number[]} memberSerials
 */
export function partyList(memberSerials) {
  const ctx = beginParty(0x01);
  ctx.w.writeU8(memberSerials.length & 0xff);
  for (const s of memberSerials) ctx.w.writeU32(s >>> 0);
  return finishParty(ctx);
}

/**
 * 0xBF 0x06 0x02 — member removed. Payload is the full (possibly empty)
 * roster _after_ removal, prefixed with the removed serial.
 *
 * @param {number} removed
 * @param {number[]} remaining
 */
export function partyRemove(removed, remaining) {
  const ctx = beginParty(0x02);
  ctx.w.writeU8(remaining.length & 0xff);
  ctx.w.writeU32(removed >>> 0);
  for (const s of remaining) ctx.w.writeU32(s >>> 0);
  return finishParty(ctx);
}

/**
 * 0xBF 0x06 0x03/0x04 — party speech relayed to recipients.
 * `from` is the speaker's serial; the client shows it overhead.
 *
 * @param {number} from
 * @param {string} text
 * @param {boolean} [toAll]  true = 0x04 party-wide, false = 0x03 private
 */
export function partyMessage(from, text, toAll = true) {
  const ctx = beginParty(toAll ? 0x04 : 0x03);
  ctx.w.writeU32(from >>> 0);
  // UTF-16 big-endian, null-terminated.
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) & 0xFFFF;
    ctx.w.writeU8((c >> 8) & 0xff);
    ctx.w.writeU8(c & 0xff);
  }
  ctx.w.writeU8(0); ctx.w.writeU8(0);
  return finishParty(ctx);
}

/**
 * 0xBF 0x06 0x07 — "you've been invited". Payload is the leader's serial.
 * @param {number} leaderSerial
 */
export function partyInvitation(leaderSerial) {
  const ctx = beginParty(0x07);
  ctx.w.writeU32(leaderSerial >>> 0);
  return finishParty(ctx);
}

/**
 * Parse an incoming 0xBF 0x06 subpacket from the client and normalize it.
 *
 * @param {Uint8Array} pkt
 */
export function readPartyCommand(pkt) {
  // pkt[0]=0xBF, pkt[1..2]=len, pkt[3..4]=0x0006, pkt[5]=kind
  if (pkt[0] !== 0xBF) throw new Error('not 0xBF');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const kind = dv.getUint8(5);
  if (kind === 0x01) {
    // Client sends target serial of whom to add.
    return { kind: 'add', target: dv.getUint32(6) };
  }
  if (kind === 0x02) {
    return { kind: 'remove', target: dv.getUint32(6) };
  }
  if (kind === 0x03) {
    // Private tell: target + unicode text.
    const target = dv.getUint32(6);
    return { kind: 'tell', target, text: readBigU16Text(dv, 10) };
  }
  if (kind === 0x04) {
    return { kind: 'tellAll', text: readBigU16Text(dv, 6) };
  }
  if (kind === 0x06) {
    return { kind: 'canLoot', canLoot: dv.getUint8(6) !== 0 };
  }
  if (kind === 0x08) return { kind: 'accept', leader: dv.getUint32(6) };
  if (kind === 0x09) return { kind: 'decline', leader: dv.getUint32(6) };
  return { kind: 'unknown' };
}

function readBigU16Text(dv, offset) {
  let s = '';
  let o = offset;
  while (o + 1 < dv.byteLength) {
    const hi = dv.getUint8(o); o += 1;
    const lo = dv.getUint8(o); o += 1;
    if (hi === 0 && lo === 0) break;
    s += String.fromCharCode((hi << 8) | lo);
  }
  return s;
}
