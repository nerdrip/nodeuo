// Opcode metadata for UO client -> server traffic.
//
// The size table below is derived from ServUO's PacketHandlers.cs `Register`
// calls (pub57 era, 7.0.x client). Entries equal to `VAR` mean the packet is
// variable-length: total size is encoded as a big-endian uint16 at bytes 1..2
// immediately following the opcode.
//
// `false` in ServUO's `ingame` arg means the handler runs before full game
// login (login/seed handshake); we keep that flag here so the NetState can
// gate handlers accordingly.

export const VAR = 0;

/**
 * @typedef {Object} OpcodeInfo
 * @property {number} opcode
 * @property {number} size   total packet size including opcode byte; 0 = variable
 * @property {boolean} ingame true if the handler expects the client to be fully logged in
 * @property {string} name   descriptive name (same as ServUO handler method)
 */

/** @type {Record<number, OpcodeInfo>} */
export const INCOMING_OPCODES = Object.freeze({
  0x00: { opcode: 0x00, size: 104, ingame: false, name: 'CreateCharacter' },
  0x01: { opcode: 0x01, size: 5,   ingame: false, name: 'Disconnect' },
  0x02: { opcode: 0x02, size: 7,   ingame: true,  name: 'MovementReq' },
  0x03: { opcode: 0x03, size: VAR, ingame: true,  name: 'AsciiSpeech' },
  0x04: { opcode: 0x04, size: 2,   ingame: true,  name: 'GodModeRequest' },
  0x05: { opcode: 0x05, size: 5,   ingame: true,  name: 'AttackReq' },
  0x06: { opcode: 0x06, size: 5,   ingame: true,  name: 'UseReq' },
  0x07: { opcode: 0x07, size: 7,   ingame: true,  name: 'LiftReq' },
  // Post-6.0.1.7 client adds a `gridLocation` byte between z and destSerial,
  // so the packet is 15 bytes (was 14 in pre-6017 layout). ServUO registers
  // both via Register6017(0x08, 15, ...). The default is modern 15 bytes;
  // old clients can opt into 14-byte framing through frameIncoming options.
  0x08: { opcode: 0x08, size: 15,  ingame: true,  name: 'DropReq' },
  0x09: { opcode: 0x09, size: 5,   ingame: true,  name: 'LookReq' },
  0x0A: { opcode: 0x0A, size: 11,  ingame: true,  name: 'Edit' },
  0x12: { opcode: 0x12, size: VAR, ingame: true,  name: 'TextCommand' },
  0x13: { opcode: 0x13, size: 10,  ingame: true,  name: 'EquipReq' },
  0x14: { opcode: 0x14, size: 6,   ingame: true,  name: 'ChangeZ' },
  0x22: { opcode: 0x22, size: 3,   ingame: true,  name: 'Resynchronize' },
  0x2C: { opcode: 0x2C, size: 2,   ingame: true,  name: 'DeathStatusResponse' },
  0x34: { opcode: 0x34, size: 10,  ingame: true,  name: 'MobileQuery' },
  0x3A: { opcode: 0x3A, size: VAR, ingame: true,  name: 'ChangeSkillLock' },
  0x3B: { opcode: 0x3B, size: VAR, ingame: true,  name: 'VendorBuyReply' },
  0x47: { opcode: 0x47, size: 11,  ingame: true,  name: 'NewTerrain' },
  0x48: { opcode: 0x48, size: 73,  ingame: true,  name: 'NewAnimData' },
  0x58: { opcode: 0x58, size: 106, ingame: true,  name: 'NewRegion' },
  0x5D: { opcode: 0x5D, size: 73,  ingame: false, name: 'PlayCharacter' },
  0x61: { opcode: 0x61, size: 9,   ingame: true,  name: 'DeleteStatic' },
  // ServUO registers these from scripts rather than the core
  // PacketHandlers table. They still have to be known by our framer before
  // net/handlers.js can dispatch the already-implemented handlers.
  0x66: { opcode: 0x66, size: VAR, ingame: true,  name: 'BookPageData' },
  0x6C: { opcode: 0x6C, size: 19,  ingame: true,  name: 'TargetResponse' },
  0x6F: { opcode: 0x6F, size: VAR, ingame: true,  name: 'SecureTrade' },
  0x71: { opcode: 0x71, size: VAR, ingame: true,  name: 'BulletinBoardRequest' },
  0x72: { opcode: 0x72, size: 5,   ingame: true,  name: 'SetWarMode' },
  0x73: { opcode: 0x73, size: 2,   ingame: false, name: 'PingReq' },
  0x75: { opcode: 0x75, size: 35,  ingame: true,  name: 'RenameRequest' },
  0x79: { opcode: 0x79, size: 9,   ingame: true,  name: 'ResourceQuery' },
  0x7D: { opcode: 0x7D, size: 13,  ingame: true,  name: 'MenuResponse' },
  0x7E: { opcode: 0x7E, size: 2,   ingame: true,  name: 'GodviewQuery' },
  0x80: { opcode: 0x80, size: 62,  ingame: false, name: 'AccountLogin' },
  0x83: { opcode: 0x83, size: 39,  ingame: false, name: 'DeleteCharacter' },
  0x8D: { opcode: 0x8D, size: VAR, ingame: false, name: 'ECCreateCharacter' },
  0x91: { opcode: 0x91, size: 65,  ingame: false, name: 'GameLogin' },
  0x95: { opcode: 0x95, size: 9,   ingame: true,  name: 'HuePickerResponse' },
  0x96: { opcode: 0x96, size: VAR, ingame: true,  name: 'GameCentralMoniter' },
  0x98: { opcode: 0x98, size: VAR, ingame: true,  name: 'MobileNameRequest' },
  0x9A: { opcode: 0x9A, size: VAR, ingame: true,  name: 'AsciiPromptResponse' },
  0x9B: { opcode: 0x9B, size: 258, ingame: true,  name: 'HelpRequest' },
  0x9D: { opcode: 0x9D, size: 51,  ingame: true,  name: 'GMSingle' },
  0x9F: { opcode: 0x9F, size: VAR, ingame: true,  name: 'VendorSellReply' },
  0xA0: { opcode: 0xA0, size: 3,   ingame: false, name: 'PlayServer' },
  0xA4: { opcode: 0xA4, size: 149, ingame: false, name: 'SystemInfo' },
  0xA7: { opcode: 0xA7, size: 4,   ingame: true,  name: 'RequestScrollWindow' },
  0xAD: { opcode: 0xAD, size: VAR, ingame: true,  name: 'UnicodeSpeech' },
  0xB1: { opcode: 0xB1, size: VAR, ingame: true,  name: 'DisplayGumpResponse' },
  0xB6: { opcode: 0xB6, size: 9,   ingame: true,  name: 'ObjectHelpRequest' },
  0xB8: { opcode: 0xB8, size: VAR, ingame: true,  name: 'ProfileReq' },
  0xBB: { opcode: 0xBB, size: 9,   ingame: false, name: 'AccountID' },
  0xBD: { opcode: 0xBD, size: VAR, ingame: true,  name: 'ClientVersion' },
  0xBE: { opcode: 0xBE, size: VAR, ingame: true,  name: 'AssistVersion' },
  0xBF: { opcode: 0xBF, size: VAR, ingame: true,  name: 'ExtendedCommand' },
  0xC2: { opcode: 0xC2, size: VAR, ingame: true,  name: 'UnicodePromptResponse' },
  0xC8: { opcode: 0xC8, size: 2,   ingame: true,  name: 'SetUpdateRange' },
  0xC9: { opcode: 0xC9, size: 6,   ingame: true,  name: 'TripTime' },
  0xCA: { opcode: 0xCA, size: 6,   ingame: true,  name: 'UTripTime' },
  0xCF: { opcode: 0xCF, size: VAR, ingame: false, name: 'AccountLoginCF' },
  0xD0: { opcode: 0xD0, size: VAR, ingame: true,  name: 'ConfigurationFile' },
  0xD1: { opcode: 0xD1, size: 2,   ingame: true,  name: 'LogoutReq' },
  0xD4: { opcode: 0xD4, size: VAR, ingame: true,  name: 'BookHeaderChange' },
  0xD6: { opcode: 0xD6, size: VAR, ingame: true,  name: 'BatchQueryProperties' },
  0xD7: { opcode: 0xD7, size: VAR, ingame: true,  name: 'EncodedCommand' },
  0xE1: { opcode: 0xE1, size: VAR, ingame: false, name: 'ClientType' },
  0xEC: { opcode: 0xEC, size: VAR, ingame: false, name: 'EquipMacro' },
  0xED: { opcode: 0xED, size: VAR, ingame: false, name: 'UnequipMacro' },
  0xEF: { opcode: 0xEF, size: 21,  ingame: false, name: 'LoginServerSeed' },
  // 0xF0 — Krrios / Razor / UOSteam assist API. Variable-length sub-op
  // protocol (sub 0x00 = world-map state request, 0x01 = response, etc.).
  // ServUO doesn't ship a handler — we register the opcode so the framer
  // doesn't drop the connection on assist-aware clients. Net handler is
  // a no-op (see net/handlers.js).
  0xF0: { opcode: 0xF0, size: VAR, ingame: true,  name: 'KrriosClientSpecial' },
  0xF4: { opcode: 0xF4, size: VAR, ingame: false, name: 'CrashReport' },
  0xF8: { opcode: 0xF8, size: 106, ingame: false, name: 'CreateCharacter70160' },
  0xFA: { opcode: 0xFA, size: 1,   ingame: true,  name: 'UOStoreRequest' },
  0xFB: { opcode: 0xFB, size: 2,   ingame: false, name: 'PublicHouseContent' },
});

/**
 * Look up the size of an opcode. Returns undefined if the opcode is unknown
 * (caller should disconnect the client — unknown opcodes cannot be framed).
 * @param {number} opcode
 * @returns {OpcodeInfo | undefined}
 */
export function opcodeInfo(opcode) {
  return INCOMING_OPCODES[opcode];
}

/**
 * Split an arbitrary-length byte stream (typically the buffered contents of a
 * UO TCP connection, or here: concatenated WebSocket binary frames) into
 * framed packets.
 *
 * Call with whatever bytes are available so far. Returns an object with:
 *   - `packets`: array of `Uint8Array` slices, each being one complete packet
 *                including its leading opcode byte.
 *   - `consumed`: number of bytes successfully framed off the front of `input`.
 *
 * The caller keeps the unconsumed tail for the next call.
 *
 * Throws on malformed input. The error carries the complete packet prefix in
 * `packets` and its byte count in `consumed`, allowing a stream owner to
 * dispatch packets that preceded the malformed tail before discarding that
 * tail. This is important for movement: `[MovementReq][bad byte]` must not
 * lose the valid request (and therefore its ACK).
 *
 * @param {Uint8Array} input
 * @param {{ dropReqSize?: 14 | 15, maxPackets?: number }} [options]
 */
export function frameIncoming(input, options = {}) {
  const packets = [];
  let offset = 0;
  const maxPackets = Number.isFinite(options.maxPackets)
    ? Math.max(1, Math.trunc(options.maxPackets))
    : Number.POSITIVE_INFINITY;
  while (offset < input.length) {
    if (packets.length >= maxPackets) {
      return { packets, consumed: offset, limited: true };
    }
    const opcode = input[offset];
    const info = INCOMING_OPCODES[opcode];
    if (!info) {
      // Stamp the actual offset onto the error so the net-state diagnostic
      // logs the right context window — searching the buffer for the first
      // matching opcode byte (the prior heuristic) lied whenever the
      // unknown byte happened to appear repeatedly inside other packets.
      const err = new Error(`Unknown incoming opcode 0x${opcode.toString(16).toUpperCase().padStart(2, '0')} at offset ${offset}`);
      // @ts-ignore — diagnostic/recovery fields consumed by NetState.
      err.offset = offset;
      // @ts-ignore
      err.consumed = offset;
      // @ts-ignore
      err.packets = packets;
      throw err;
    }
    let size = (opcode === 0x08 && options.dropReqSize === 14) ? 14 : info.size;
    if (size === VAR) {
      if (input.length - offset < 3) break; // need opcode + 2-byte length
      size = (input[offset + 1] << 8) | input[offset + 2];
      if (size < 3) {
        const err = new Error(`Variable packet 0x${opcode.toString(16)} has invalid size ${size} at offset ${offset}`);
        // @ts-ignore — diagnostic/recovery fields consumed by NetState.
        err.offset = offset;
        // @ts-ignore
        err.consumed = offset;
        // @ts-ignore
        err.packets = packets;
        throw err;
      }
    }
    if (input.length - offset < size) break; // incomplete — wait for more bytes
    packets.push(input.subarray(offset, offset + size));
    offset += size;
  }
  return { packets, consumed: offset, limited: false };
}
