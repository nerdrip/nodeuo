// 0x6C Target request (server->client) / Target response (client->server).
// 0x88 OpenPaperdoll (server->client).
// 0x54 PlaySound (server->client).
// 0x3A SendSkills (server->client), variable-length list of skills.

import { PacketWriter } from '../buffer.js';

// ---- 0x6C Target --------------------------------------------------------

export const TargetKind = Object.freeze({
  Object: 0,  // pick an entity
  Location: 1, // pick a ground tile
});

export const TargetFlag = Object.freeze({
  None: 0, Harmful: 1, Helpful: 2, Cancel: 3,
});

/**
 * 0x6C — 19 bytes fixed. Server asks client for a target.
 *
 * @param {Object} p
 * @param {number} p.id           correlation id; echoed by client's response.
 * @param {number} [p.kind]       TargetKind.Object|Location
 * @param {number} [p.flags]      TargetFlag.*
 */
export function targetRequest({ id, kind = TargetKind.Object, flags = TargetFlag.None }) {
  const w = new PacketWriter(19);
  w.writeU8(0x6C);
  w.writeU8(kind & 0xff);
  w.writeU32(id >>> 0);
  w.writeU8(flags & 0xff);
  w.writeU32(0); // target serial (unused in request)
  w.writeU16(0); w.writeU16(0); w.writeU16(0); // x,y,z (unused)
  w.writeU16(0); // graphic (unused)
  return w.bytes();
}

/**
 * 0x99 — 30 bytes fixed. Server asks the client to place a multi
 * (house / boat / custom). Client enters "multi placement" mode with a
 * semi-transparent ghost preview that snaps to the world tile under
 * the cursor. On click it sends a 0x6C reply with the chosen tile.
 *
 * Mirrors ClassicUO `Network/PacketHandlers.cs` ReceiveMultiPlacement.
 *
 * @param {Object} p
 * @param {number} p.id            correlation id (echoed back in 0x6C)
 * @param {number} p.multiId       UO multi id from MultiCollection.uop
 * @param {number} [p.offsetX]     pre-offset applied to the click point
 * @param {number} [p.offsetY]
 * @param {number} [p.offsetZ]
 * @param {number} [p.hue]         hue applied to every tile of the ghost
 * @param {boolean} [p.allowGround=true]
 */
export function multiPlacementRequest({ id, multiId, offsetX = 0, offsetY = 0, offsetZ = 0, hue = 0, allowGround = true }) {
  // ServUO `Network/Packets.cs:2746-2762 MultiTargetReqHS` writes:
  //   byte 1     allowGround
  //   bytes 2-5  cursorId (u32)
  //   byte 6     flags (u8)
  //   bytes 7-17 padding
  //   bytes 18-19 multiId (i16)
  //   bytes 20-21 offsetX (i16)
  //   bytes 22-23 offsetY (i16)
  //   bytes 24-25 offsetZ (i16)
  // The client (post-audit #41) reads from those exact offsets per CUO
  // `PacketHandlers.MultiPlacement`. Was: we wrote multiId at byte 6
  // and padded the tail, so the client's Seek(18) read zero and the
  // ghost preview never showed. (Hue/AllowGround were already correct.)
  const w = new PacketWriter(30);
  w.writeU8(0x99);
  w.writeU8(allowGround ? 1 : 0);
  w.writeU32(id >>> 0);
  w.writeU8(0);                          // flags (unused)
  // Padding to byte 18: we have written 7 bytes so far, need 11 more
  // before MultiID.
  for (let i = 0; i < 11; i++) w.writeU8(0);
  w.writeU16((multiId | 0) & 0xffff);
  w.writeI16(offsetX | 0);
  w.writeI16(offsetY | 0);
  w.writeI16(offsetZ | 0);
  // Hue isn't in ServUO's HS layout — clamped to 0 to match wire.
  // Trailing 4 bytes round out to 30. Tolerated by CUO (it reads only
  // up to OffsetZ in the canonical handler).
  void hue;
  while (w.length < 30) w.writeU8(0);
  return w.bytes();
}

/** Response parser for the client's 0x6C reply.
 *  @param {Uint8Array} pkt  raw packet including opcode byte.
 */
export function readTargetResponse(pkt) {
  if (pkt.length < 19 || pkt[0] !== 0x6C) {
    throw new Error('not a 0x6C target response');
  }
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  // Audit #41 client P1 #4 — verified against ServUO source
  // (`PacketHandlers.cs:1244 z = pvSrc.ReadInt16()`). The earlier
  // padding+sbyte parse was wrong both directions: server read +255
  // when client sent z=-1. Both ends now use sign-extended i16.
  return {
    kind: dv.getUint8(1),
    id: dv.getUint32(2),
    flags: dv.getUint8(6),
    serial: dv.getUint32(7),
    x: dv.getUint16(11),
    y: dv.getUint16(13),
    z: dv.getInt16(15),
    graphic: dv.getUint16(17),
  };
}

// ---- 0x88 OpenPaperdoll -------------------------------------------------

/**
 * @param {Object} p
 * @param {number} p.serial
 * @param {string} [p.title]    60 ASCII chars; trailing bytes zero-padded.
 * @param {number} [p.flags]    bit 1 = can lift, bit 2 = warmode, etc.
 */
export function openPaperdoll({ serial, title = '', flags = 0 }) {
  const w = new PacketWriter(66);
  w.writeU8(0x88);
  w.writeU32(serial);
  w.writeAsciiFixed(title, 60);
  w.writeU8(flags & 0xff);
  return w.bytes();
}

// ---- 0x54 PlaySound -----------------------------------------------------

/**
 * @param {Object} p
 * @param {number} p.soundId
 * @param {number} [p.mode]     0 = once, 1 = repeating
 * @param {number} [p.volume]
 * @param {number} [p.x]
 * @param {number} [p.y]
 * @param {number} [p.z]
 */
export function playSound({ soundId, mode = 0, volume = 0, x = 0, y = 0, z = 0 }) {
  const w = new PacketWriter(12);
  w.writeU8(0x54);
  w.writeU8(mode & 0xff);
  w.writeU16(soundId & 0xFFFF);
  w.writeU16(volume & 0xFFFF);
  w.writeU16(x & 0xFFFF);
  w.writeU16(y & 0xFFFF);
  w.writeI16(z);
  return w.bytes();
}

// ---- 0x3A SendSkills ----------------------------------------------------

/**
 * Send one or more skills to the client. Variable-length.
 *
 * Format per skill entry (8 bytes):
 *   u16 id     (1-based)
 *   u16 value  (current × 10)
 *   u16 base   (base × 10)
 *   u8  lock   (0 up, 1 down, 2 locked)
 *   u16 cap    (× 10)
 *
 * A terminator of u16 0x0000 closes the list. `type` in the header byte
 * after length controls whether cap is included (0xDF = full, 0xFF =
 * per-skill update, 0x00 = legacy no-cap).
 *
 * @param {Object} p
 * @param {Array<{id:number, value:number, base?:number, lock?:number, cap?:number}>} p.skills
 * @param {number} [p.type]   0xDF = full list with caps (default)
 */
export function sendSkills({ skills, type = 0xDF }) {
  const w = new PacketWriter(8 + skills.length * 9);
  w.writeU8(0x3A);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU8(type & 0xff);
  // UO 0x3A type semantics:
  //   0x00 = full snapshot, no caps
  //   0x02 = full snapshot, with caps     (post-AOS)
  //   0xDF = single skill, with caps      (terminator-bearing)
  //   0xFF = single skill, no caps
  // Cap byte present iff `withCaps` (matches the client decoder which
  // sets entrySize 9 for 0x02/0xDF, 7 for 0x00/0xFF). The original
  // gate only checked 0xDF/0xFF so server-side `type:0x02` wrote 7
  // bytes/entry while the client decoded 9 → misaligned skill values
  // + truncated tail. Fix: send caps for 0x02 + 0xDF, NOT for 0xFF.
  const withCaps = type === 0x02 || type === 0xDF;
  for (const s of skills) {
    w.writeU16(s.id & 0xFFFF);
    w.writeU16(Math.round(s.value * 10) & 0xFFFF);
    w.writeU16(Math.round((s.base ?? s.value) * 10) & 0xFFFF);
    w.writeU8((s.lock ?? 0) & 0xff);
    if (withCaps) {
      w.writeU16(Math.round((s.cap ?? 100) * 10) & 0xFFFF);
    }
  }
  w.writeU16(0); // terminator
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
