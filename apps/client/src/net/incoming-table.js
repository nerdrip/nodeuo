// Server-to-client opcode size table.
//
// `@uo/protocol`'s `INCOMING_OPCODES` covers client→server (server's
// perspective). For framing the byte stream we receive from the server we
// need the opposite direction. Sizes are taken from ClassicUO's
// PacketsTable (Network/PacketsTable.cs in the templates) — pub57 era.
//
// `0` (= VAR) means the packet has a u16 length field at bytes 1..2 BE.

export const VAR = 0;

/** @type {Record<number, { size: number, name: string }>} */
export const SERVER_OPCODES = Object.freeze({
  // CUO `PacketHandlers.ClientTalk` consumes the variable body and
  // no-ops known control subtypes (0x78/0x3C/0x25/0x2E). The important
  // part for us is framing it correctly so a rare server-side talk
  // control packet cannot desync the rest of the stream.
  0x03: { size: VAR, name: 'ClientTalk' },
  0x0B: { size: 7,   name: 'Damage' },
  0x11: { size: VAR, name: 'MobileStatus' },
  0x17: { size: VAR, name: 'HealthbarUpdate' },
  0x1A: { size: VAR, name: 'WorldItem' },
  0x1B: { size: 37,  name: 'LoginConfirm' },
  0x1C: { size: VAR, name: 'AsciiMessage' },
  0x1D: { size: 5,   name: 'RemoveEntity' },
  0x20: { size: 19,  name: 'MobileUpdate' },
  0x21: { size: 8,   name: 'MovementRej' },
  0x22: { size: 3,   name: 'MovementAck' },
  0x23: { size: 26,  name: 'DragAnimation' },
  0x24: { size: 9,   name: 'OpenContainer' }, // Pre-7.0.9: 7. Modern: 9 (extra u16).
  0x25: { size: 21,  name: 'ContainerContentUpdate' }, // Pre-6017: 20.
  0x27: { size: 2,   name: 'PickUpRejected' },
  // ServUO ships the 2-byte form (op + result). Pre-SA clients
  // accepted 1 byte; modern shards always send 2 — `dropAck()` writer
  // is `op + u8 status` (packets/pickup.js:10). With size=1 the
  // framer mis-aligned the next packet by one byte and then choked on
  // the unknown 0x00/0x01 status byte sitting where the next opcode
  // should be. Same for 0x01/0x00 errors after CharCreate flow.
  0x28: { size: 5,   name: 'DragCancel' },
  0x29: { size: 2,   name: 'DropApproved' },
  0x2C: { size: 2,   name: 'DeathAnimation' },
  0x2D: { size: 17,  name: 'MobileAttributes' },
  0x2E: { size: 15,  name: 'EquipUpdate' },
  0x2F: { size: 10,  name: 'Swing' },
  0x3A: { size: VAR, name: 'SkillsList' },
  0x3C: { size: VAR, name: 'ContainerContents' }, // Pre-6017 has shorter entries.
  0x4E: { size: 6,   name: 'PersonalLight' },
  0x4F: { size: 2,   name: 'OverallLight' },
  0x53: { size: 2,   name: 'ConnectionError' },
  0x54: { size: 12,  name: 'PlaySoundEffect' },
  0x55: { size: 1,   name: 'LoginComplete' },
  0x56: { size: 11,  name: 'MapData' },
  0x5B: { size: 4,   name: 'TimeChange' },
  // 0x61 DeleteObject (legacy, pre-AOS) — CUO `PacketsTable.cs` declares
  // size = 9. Modern ServUO uses 0x1D RemoveEntity instead, but a few
  // server-internal events (bulk decoration createworld broadcasts,
  // mass mob despawn) occasionally still emit the legacy form. Without
  // this entry the framer hit "unknown opcode 0x61" and skipped 1 byte
  // per packet, then mis-parsed the following bytes as opcodes too —
  // user report 2026-05-17: opening paperdoll right after createworld
  // froze the client because the 9-byte 0x61 stream was interpreted
  // byte-by-byte as a cascade of unknown opcodes (0x8c, 0x06, 0x40,
  // 0x1e, …). Stub it as a known-size skip; the body is ignored.
  0x61: { size: 9,   name: 'DeleteObjectLegacy' },
  0x65: { size: 4,   name: 'Weather' },
  0x66: { size: VAR, name: 'BookData' },
  // 0x6B GodModeRequest — strictly client→server in ServUO (7B, password
  // toggle for the deprecated god-mode toggle). Server should never
  // emit it, but if our framer ever sees it (mid-stream desync from a
  // mis-sized earlier packet) declare a known size so the framer
  // can skip past 7 bytes cleanly instead of single-byte-resync logging.
  0x6B: { size: 7,   name: 'GodModeRequest' },
  0x6C: { size: 19,  name: 'TargetCursor' },
  0x6D: { size: 3,   name: 'PlayMusic' },
  0x6E: { size: 14,  name: 'CharacterAnimation' },
  0x6F: { size: VAR, name: 'SecureTrade' },
  0x70: { size: 28,  name: 'GraphicEffect' },
  0x71: { size: VAR, name: 'BulletinBoard' },
  // 0xDA Mahjong — table state push.
  0xDA: { size: VAR, name: 'Mahjong' },
  0x72: { size: 5,   name: 'WarMode' },
  0x73: { size: 2,   name: 'Ping' },
  0x74: { size: VAR, name: 'OpenBuyWindow' },
  0x76: { size: 16,  name: 'NewSubServer' },
  0x77: { size: 17,  name: 'MobileMoving' },
  0x78: { size: VAR, name: 'MobileIncoming' },
  0x7C: { size: VAR, name: 'OpenMenu' },
  0x82: { size: 2,   name: 'LoginRejection' },
  0x88: { size: 66,  name: 'OpenPaperdoll' },
  0x89: { size: VAR, name: 'CorpseEquipment' },
  0x8C: { size: 11,  name: 'PlayServerAck' },
  0x90: { size: 19,  name: 'MapMessage' },
  0x93: { size: 99,  name: 'OpenBook' },
  0x95: { size: 9,   name: 'DyeData' },
  0x97: { size: 2,   name: 'MovePlayer' },
  0x98: { size: VAR, name: 'AllNamesAck' },
  0x99: { size: 30,  name: 'MultiPlacement' },
  0x9A: { size: VAR, name: 'AsciiPrompt' },
  0x9E: { size: VAR, name: 'SellList' },
  0xA1: { size: 9,   name: 'UpdateHealth' },
  0xA2: { size: 9,   name: 'UpdateMana' },
  0xA3: { size: 9,   name: 'UpdateStamina' },
  0xA5: { size: VAR, name: 'OpenUrl' },
  0xA6: { size: VAR, name: 'TipWindow' },
  0xA8: { size: VAR, name: 'ServerListReceived' },
  0xA9: { size: VAR, name: 'ReceiveCharacterList' },
  0xAA: { size: 5,   name: 'AttackCharacter' },
  0xAB: { size: VAR, name: 'TextEntryDialog' },
  0xAE: { size: VAR, name: 'UnicodeMessage' },
  0xAF: { size: 13,  name: 'DisplayDeathAction' },
  0xB0: { size: VAR, name: 'OpenGump' },
  0xB7: { size: VAR, name: 'HelpResponse' },
  0xB8: { size: VAR, name: 'CharacterProfile' },
  // 0xB2 ChatMessage — server-side chat conference broadcast.
  // Variable-length: opcode + u16 length + u16 commandType +
  // u16 langCode (4 bytes) + u16-prefixed unicode payload.
  0xB2: { size: VAR, name: 'ChatMessage' },
  // 0xBB UltimaMessenger — mail/messenger system.
  0xBB: { size: 9,   name: 'UltimaMessenger' },
  0xB9: { size: 5,   name: 'EnableLockedFeatures' }, // ServUO sends 5; pre-6.0.14 was 3.
  // Audit #46 P1#6 — CUO `PacketsTable.cs:362` declares 0xBA = 10
  // for clients ≥7.0.9.0 (modern ServUO emits 10B with extra u32 serial
  // = quest arrow target). Pre-AOS form was 6B. Framer was eating 6B
  // and misaligning every subsequent packet by 4B → resync.
  0xBA: { size: 10,  name: 'DisplayQuestArrow' },
  0xBC: { size: 3,   name: 'Season' },
  0xBF: { size: VAR, name: 'ExtendedCommand' },
  0xC0: { size: 36,  name: 'GraphicEffectHued' },
  0xC1: { size: VAR, name: 'DisplayClilocString' },
  0xC2: { size: VAR, name: 'UnicodePrompt' },
  0xC4: { size: 6,   name: 'Semivisible' },
  0xC7: { size: 49,  name: 'GraphicEffectExt' },
  0xC8: { size: 2,   name: 'ClientViewRange' },
  0xCB: { size: 7,   name: 'GoldRewardPacket' },
  0xCC: { size: VAR, name: 'DisplayClilocStringAffix' },
  // CUO PacketsTable: 0x19 = 25 bytes. We had 17 which corresponds
  // to the legacy MobileMoving variant (different opcode entirely).
  // 0xD2 is `UpdateObject` and ships 25 bytes in modern protocol.
  0xD2: { size: 25,  name: 'UpdateObject' },
  // 0xD3 is variable-length per ServUO `Packets.cs::UnkD3` (uses
  // `EnsureCapacity(256)` and the standard u16 size header). Earlier
  // value 26 caused the framer to swallow extra bytes whenever the
  // server emitted a long D3, mis-aligning every subsequent packet
  // until the connection got dropped.
  0xD3: { size: VAR, name: 'CharacterMoveAnim' },
  0xD4: { size: VAR, name: 'OpenBookNew' },
  0xD6: { size: VAR, name: 'MegaCliloc' },
  0xD7: { size: VAR, name: 'GenericAOSCommands' },
  0xD8: { size: VAR, name: 'CustomHouse' },
  // Audit #39 client P3 #14 — CUO `PacketsTable.cs:229` declares 0xD9
  // (SpyOnClient) at fixed 268 B. We had no entry → the framer hit the
  // "unknown opcode, dropping stream" path and we lost the WebSocket.
  // ServUO sends this on certain admin / anti-cheat probes; CUO just
  // discards the body, so do the same.
  0xD9: { size: 268, name: 'SpyOnClient' },
  0xDC: { size: 9,   name: 'OPLInfo' },
  0xDD: { size: VAR, name: 'OpenCompressedGump' },
  0xDE: { size: VAR, name: 'UpdateMobileStatus' },
  0xDF: { size: VAR, name: 'BuffDebuff' },
  0xE2: { size: 10,  name: 'NewCharacterAnimation' },
  0xE3: { size: VAR, name: 'KREncryptionResponse' },
  0xE5: { size: VAR, name: 'WaypointMessage' },
  // Audit #43 client P1 #10 — handler was bound at handlers.js but the
  // table had no entry → framer hit the unknown-opcode resync path on
  // every waypoint removal and ate following bytes. ServUO emits fixed
  // 5B (op + u32 serial).
  0xE6: { size: 5,   name: 'RemoveWaypoint' },
  0xF0: { size: VAR, name: 'Krrios' },
  0xF1: { size: 9,   name: 'FreeshardListR' },
  0xF3: { size: 26,  name: 'WorldItemSA' },
  0xF5: { size: 21,  name: 'NewMapMessage' },
  0xF6: { size: VAR, name: 'BoatMoving' },
  0xF7: { size: VAR, name: 'PacketList' },
  // ---- Audit fill-ins (ServUO `Server/Network/Packets.cs` outgoing list).
  // Sizes from CUO `PacketsTable.cs`. Without these the framer used to
  // disconnect the moment ServUO emitted any of them; with the resync
  // path it would only spam warnings. Either way: better to know.
  // Pre-AOS health update format — ServUO emits this for older clients;
  // post-7.0 uses the 9-byte 0xA1/A2/A3 trio. CUO PacketsTable: 8.
  0x1F: { size: 8,   name: 'OldHealthUpdate' },
  0x15: { size: 9,   name: 'CharacterLocale' },
  // Audit #43 client P1 #16 — CUO `PacketsTable.cs` declares 0x16 as
  // VAR for clients ≥ CV_500A (modern ServUO emits the same VAR layout
  // as 0x17). Was: hardcoded size=1 → framer ate following bytes when
  // ServUO emitted 0x16 with a body → all subsequent packets lost.
  0x16: { size: VAR, name: 'HealthbarPoison' },
  0x2B: { size: 2,   name: 'PathfindMessage' },
  0x38: { size: 7,   name: 'Pathfind' },
  // Audit #46 P1#5 — 0x3B is `CloseVendorInterface` (u32 serial), NOT
  // BuyList (that's 0x74). Vendor-close from server was silently
  // dropped → ShopGump never closed remotely.
  0x3B: { size: VAR, name: 'CloseVendor' },
  0x7B: { size: 2,   name: 'NewSeason' },
  0x81: { size: VAR, name: 'CharListPlay' },
  0x85: { size: 2,   name: 'DeleteCharacterAck' },
  0x86: { size: VAR, name: 'ResendCharacterList' },
  0x8B: { size: VAR, name: 'UltimaMessenger' },
  0xBD: { size: VAR, name: 'ClientVersionRequest' },
  0xBE: { size: VAR, name: 'AssistVersion' },
  0xC3: { size: VAR, name: 'ParticleEffect' },
  0xC6: { size: 1,   name: 'NoticeBoard' },
  0xC9: { size: 6,   name: 'HuedEffect' },
  0xCA: { size: 6,   name: 'HighlightUI' },
  0xD1: { size: 2,   name: 'LogoutAck' },
  // Audit #46 P3 rare-opcode stubs — CUO no-ops these but its table
  // declares sizes so the framer can skip past them cleanly without
  // hitting the resync path. Without entries we WARN on every emit.
  0xFD: { size: 2,   name: 'LoginDelay' },
  0x32: { size: 2,   name: 'Unknown32' },
  0xDB: { size: VAR, name: 'CharacterTransferLog' },
  0xD0: { size: VAR, name: 'ConfigurationFile' },
});

/**
 * Frame an arbitrary byte stream from the server into discrete packets.
 *
 * Resilience: if we encounter an unknown opcode mid-stream we log a
 * warning and try to RESYNC by skipping forward one byte at a time
 * until we find a recognised opcode. Without this every protocol
 * version mismatch (a single packet whose size differs from CUO's
 * canonical table) cascades through every later packet and forces a
 * disconnect — which is exactly what was happening when the user
 * double-clicked their backpack.
 *
 * @param {Uint8Array} input
 * @returns {{ packets: Uint8Array[], consumed: number, warnings:string[] }}
 */
export function frameServerStream(input) {
  const packets = [];
  const warnings = [];
  let offset = 0;
  while (offset < input.length) {
    const opcode = input[offset];
    const info = SERVER_OPCODES[opcode];
    if (!info) {
      // Unknown opcode — try to resync. Walk forward until we find a
      // known opcode. Worst case we skip the rest of the buffer.
      const skipFrom = offset;
      while (offset < input.length && !SERVER_OPCODES[input[offset]]) offset++;
      const skipped = offset - skipFrom;
      // Hex window: 4 bytes preceding + the dropped run. Helps diagnose
      // which prior packet over-read its declared length and dragged
      // the parser into the next frame's body.
      const winStart = Math.max(0, skipFrom - 4);
      const window = Array.from(input.subarray(winStart, offset))
        .map((b, i) => ((winStart + i === skipFrom ? '[' : '') +
                        b.toString(16).padStart(2, '0') +
                        (winStart + i === offset - 1 && skipped > 0 ? ']' : '')))
        .join(' ');
      warnings.push(
        `resync: dropped ${skipped} bytes starting with 0x${opcode.toString(16).padStart(2, '0')} at byte ${skipFrom}; context: ${window}`,
      );
      if (offset >= input.length) break;
      continue;
    }
    let size = info.size;
    if (size === VAR) {
      if (input.length - offset < 3) break; // need length field
      size = (input[offset + 1] << 8) | input[offset + 2];
      if (size < 3) {
        // Bad VAR length — same resync trick as above.
        warnings.push(`resync: bad VAR size ${size} for 0x${opcode.toString(16)} at byte ${offset}`);
        offset++;
        continue;
      }
    }
    if (input.length - offset < size) break;
    packets.push(input.subarray(offset, offset + size));
    offset += size;
  }
  return { packets, consumed: offset, warnings };
}
