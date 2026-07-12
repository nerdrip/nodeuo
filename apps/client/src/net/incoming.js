// Server→client packet decoders. Each function takes the framed
// `Uint8Array` (including opcode byte + length field for VAR packets)
// and returns a plain object ready for the consumer.
//
// Mirrors ClassicUO's PacketHandlers.cs lookup table.

import { PacketReader } from '@uo/protocol';

const _packetReader = new PacketReader(new Uint8Array(0));
function packetReader(pkt, offset = 0, length = pkt.length - offset) {
  return _packetReader.reset(pkt, offset, length);
}

/** 0x03 ClientTalk (VAR). Server-side legacy talk control packet.
 *  ClassicUO only consumes/no-ops known control subtypes; expose the
 *  body for diagnostics while keeping the main stream aligned. */
export function decodeClientTalk(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const subtype = r.remaining > 0 ? r.readU8() : null;
  return { subtype, payload: pkt.subarray(subtype == null ? 3 : 4) };
}

/** 0x82 LoginRejection (2B). reason byte. */
export function decodeLoginRejection(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  return { reason: r.readU8() };
}

/** 0x53 ConnectionError (2B). reason byte. */
export function decodeConnectionError(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  return { reason: r.readU8() };
}

/** 0xA8 ServerListReceived (VAR). */
export function decodeServerList(pkt) {
  const r = packetReader(pkt);
  r.readU8();      // op
  r.readU16();     // length
  r.readU8();      // system info flag
  const count = r.readU16();
  const servers = [];
  for (let i = 0; i < count; i++) {
    const index = r.readU16();
    const name = r.readAsciiFixed(32);
    const fullPercent = r.readU8();
    const timeZone = r.readI8();
    // Server address: u32 *little-endian* on the wire (the only LE field
    // in UO; ServUO writes it via `Endian.Reverse` to flip back to BE for
    // the client). Our PacketReader always reads BE, so we read 4 bytes
    // and reverse them.
    const b0 = r.readU8(), b1 = r.readU8(), b2 = r.readU8(), b3 = r.readU8();
    const ip = `${b3}.${b2}.${b1}.${b0}`;
    servers.push({ index, name, fullPercent, timeZone, ip });
  }
  return { servers };
}

/** 0x8C PlayServerAck (11B). */
export function decodePlayServerAck(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  // address: u32 BE in ServUO playServerAck builder.
  const ipBE = r.readU32();
  const port = r.readU16();
  const authKey = r.readU32();
  const ip = `${(ipBE >>> 24) & 0xff}.${(ipBE >>> 16) & 0xff}.${(ipBE >>> 8) & 0xff}.${ipBE & 0xff}`;
  return { ip, port, authKey };
}

/** 0xA9 ReceiveCharacterList (VAR). */
export function decodeCharacterList(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const charCount = r.readU8();
  const characters = [];
  for (let i = 0; i < charCount; i++) {
    const name = r.readAsciiFixed(30);
    const password = r.readAsciiFixed(30); // unused
    characters.push({ name, password });
  }
  const cityCount = r.readU8();
  const cities = [];
  for (let i = 0; i < cityCount; i++) {
    const cityIndex = r.readU8();
    const cityName = r.readAsciiFixed(32);
    const cityArea = r.readAsciiFixed(32);
    const x = r.readI32();
    const y = r.readI32();
    const z = r.readI32();
    const map = r.readI32();
    const cliloc = r.readI32();
    r.readU32(); // unknown
    cities.push({ index: cityIndex, name: cityName, area: cityArea, x, y, z, map, cliloc });
  }
  const flags = r.readU32();
  // Audit #46 P2 — derive available slot count from CUO/ServUO
  // CharacterListFlags bits (Server/Network/Packets.cs::CharacterList):
  //   0x0080 OneCharSlot       → 1
  //   0x0100 SixCharacterSlots → 6
  //   0x0800 SevenCharSlots    → 7
  //   default                  → 5
  let slotCount = 5;
  if (flags & 0x0800) slotCount = 7;
  else if (flags & 0x0100) slotCount = 6;
  else if (flags & 0x0080) slotCount = 1;
  return { characters, cities, flags, slotCount };
}

/** 0x1B LoginConfirm (37B). Layout matches packets/login-confirm.js. */
export function decodeLoginConfirm(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  r.readU32();           // unknown (0)
  const body = r.readU16();
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI16();
  const direction = r.readU8();
  r.readU8();            // unknown (0)
  r.readI32();           // unknown (-1)
  r.readU16();           // unknown (0)
  r.readU16();           // unknown (0)
  const mapWidth = r.readU16();
  const mapHeight = r.readU16();
  r.readU16();           // unknown (0)
  r.readU32();           // unknown (0)
  return { serial, body, x, y, z, direction, mapWidth, mapHeight };
}

/** 0x55 LoginComplete (1B). */
export function decodeLoginComplete() {
  return {};
}

/** 0x77 MobileMoving (17B). */
export function decodeMobileMoving(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const body = r.readU16();
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI8();
  const direction = r.readU8();
  const hue = r.readU16();
  const flags = r.readU8();
  const notoriety = r.readU8();
  return { serial, body, x, y, z, direction, hue, flags, notoriety };
}

/** 0x78 MobileIncoming (VAR). */
export function decodeMobileIncoming(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const body = r.readU16();
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI8();
  const direction = r.readU8();
  const hue = r.readU16();
  const flags = r.readU8();
  const notoriety = r.readU8();
  /** @type {{serial:number,itemId:number,layer:number,hue:number}[]} */
  const equipment = [];
  while (r.remaining > 4) {
    const eqSerial = r.readU32();
    if (eqSerial === 0) break;
    const itemId = r.readU16();
    const layer = r.readU8();
    let eqHue = 0;
    if (itemId & 0x8000) eqHue = r.readU16();
    equipment.push({ serial: eqSerial, itemId: itemId & 0x7FFF, layer, hue: eqHue });
  }
  return { serial, body, x, y, z, direction, hue, flags, notoriety, equipment };
}

/** 0x20 MobileUpdate (19B). */
export function decodeMobileUpdate(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const body = r.readU16();
  r.readU8(); // unused
  const hue = r.readU16();
  const flags = r.readU8();
  const x = r.readU16();
  const y = r.readU16();
  r.readU16(); // unused
  const direction = r.readU8();
  const z = r.readI8();
  return { serial, body, hue, flags, x, y, z, direction };
}

/** 0xBF ExtendedCommand (VAR) — partial decode (returns subop + raw payload). */
export function decodeExtendedCommand(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const subop = r.readU16();
  const payload = pkt.subarray(5);
  return { subop, payload };
}

/** 0xBF 0x14 DisplayContextMenu — decoded after the parent dispatcher
 *  has stripped the `op + len + subop` header. Mirrors ServUO's
 *  `Server/Network/Packets.cs::DisplayContextMenu` writer.
 *
 *  Layout (enhanced "v2" form, used by 7.0.x clients):
 *    u16 version (2)
 *    u32 targetSerial
 *    u8  entryCount
 *    entryCount × {
 *      u16 responseId
 *      u16 clilocOffset    (cliloc - 3000000)
 *      u16 flags           (bit 0x01=disabled, 0x20=coloured)
 *      [u16 colour]        ← only when flags & 0x20
 *    }
 */
export function decodeContextMenu(payload) {
  if (!payload || payload.length < 7) return { serial: 0, entries: [] };
  let p = 0;
  const ver = (payload[p] << 8) | payload[p + 1]; p += 2;
  const serial = ((payload[p] << 24) | (payload[p + 1] << 16) | (payload[p + 2] << 8) | payload[p + 3]) >>> 0; p += 4;
  const count = payload[p]; p += 1;
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (p + 6 > payload.length) break;
    const responseId = (payload[p] << 8) | payload[p + 1]; p += 2;
    const cliOff     = (payload[p] << 8) | payload[p + 1]; p += 2;
    const flags      = (payload[p] << 8) | payload[p + 1]; p += 2;
    let colour = 0;
    if ((flags & 0x20) !== 0 && p + 2 <= payload.length) {
      colour = (payload[p] << 8) | payload[p + 1]; p += 2;
    }
    entries.push({ responseId, cliloc: 3000000 + cliOff, flags, colour });
  }
  return { version: ver, serial, entries };
}

/** 0x6D PlayMusic (3B). Audit #42 client P1 #5 — CUO `PacketHandlers.cs:
 *  2211-2233` recognises the 3-byte stop-music form `0x6D 0x1F 0xFF`.
 *  Without this branch the decoder returned musicId=0x1FFF and the
 *  audio manager tried to play a non-existent track + stashed it as
 *  `world.lastMusicId` (so season-triggered replays kept stomping the
 *  bogus id). Also map the standard 0xFFFF sentinel to stop. */
export function decodePlayMusic(pkt) {
  const cmd = pkt[1];
  const idx = pkt[2];
  if (cmd === 0x1F && idx === 0xFF) return { musicId: 0xFFFF, stop: true };
  const musicId = (cmd << 8) | idx;
  if (musicId === 0xFFFF) return { musicId, stop: true };
  return { musicId };
}

/** 0xF5 NewMapMessage (21B). Server pushes treasure-map / cartography
 *  pin updates: serial, gump itemId + start/end rect + map id. The
 *  treasure-map gump (apps/client/src/ui/gumps/) reads this to draw
 *  pins on the parchment.
 *
 *  Layout: op(1) serial(4) gumpItemId(2) x1(2) y1(2) x2(2) y2(2)
 *          width(2) height(2) facet(1) — total 21 bytes.
 */
export function decodeNewMapMessage(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const gumpItemId = r.readU16();
  const x1 = r.readU16(); const y1 = r.readU16();
  const x2 = r.readU16(); const y2 = r.readU16();
  const width = r.readU16(); const height = r.readU16();
  const facet = r.remaining > 0 ? r.readU8() : 0;
  return { serial, gumpItemId, x1, y1, x2, y2, width, height, facet };
}

/** 0xF0 Krrios — multi-purpose Krrios-protocol envelope (party
 *  positions, loot reservation, guild messages). The first u16
 *  after the length is the sub-command; common variants:
 *    0x00 client info   0x01 add member       0x02 remove member
 *    0x03 update party position (per-mob coords)
 *  We do a minimal decode: capture sub + body bytes for downstream
 *  handlers to interpret. The 0xF0 protocol is opaque enough that
 *  full per-sub parsing is not worth the maintenance burden when no
 *  hard CUO behavior depends on it. */
export function decodeKrrios(pkt) {
  const r = packetReader(pkt);
  r.readU8();          // op
  const len = r.readU16();
  const type = r.remaining >= 1 ? r.readU8() : 0;
  // Pass the rest of the body through; caller can re-decode if it
  // wires support for a specific sub-command later.
  const body = pkt.subarray(4, len);
  return { type, body, length: len };
}

/** 0xF3 WorldItemSA (26B) — modern world item layout used by ServUO.
 *
 *   u8  op
 *   u16 unknown (0)
 *   u8  type        0=normal, 1=corpse, 2=multi
 *   u32 serial
 *   u16 graphic
 *   u8  facing
 *   u16 amount
 *   u16 amount      (duplicated for legacy)
 *   u16 x
 *   u16 y
 *   i8  z
 *   u8  light
 *   u16 hue
 *   u8  flags
 */
export function decodeWorldItemSA(pkt) {
  // Canonical 26-byte layout (CUO `PacketHandlers.UpdateItemSA`):
  //   op + u16 unk + u8 dataType + u32 serial + u16 graphic
  //   + u8 graphicInc + u16 amount + u16 amount2 + u16 x + u16 y
  //   + i8 z + u8 direction + u16 hue + u8 flags + u16 unk2
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();                  // unk1 = 0x0001
  const type      = r.readU8();
  const serial    = r.readU32();
  const graphic   = r.readU16();
  /* const gfxInc = */ r.readU8();
  const amount    = r.readU16();
  r.readU16();                  // amount2 (== amount)
  const x         = r.readU16();
  const y         = r.readU16();
  const z         = r.readI8();
  const facing    = r.readU8();
  const hue       = r.readU16();
  const flags     = r.readU8();
  /* r.readU16(); */            // unk2 — ignored
  return { type, serial, graphic, facing, amount, x, y, z, hue, flags };
}

/** 0x1A WorldItem (legacy variable layout). Audit #42 client P1 #3 —
 *  full re-spec per CUO `PacketHandlers.cs:779-855`:
 *    serial(u32) [+amount(u16) if serial&0x80000000]
 *    graphic(u16) [+graphicInc(u8) if graphic&0x8000]
 *    x(u16) [+dir(u8) if x&0x8000]
 *    y(u16) [+hue(u16) if y&0x8000] [+flags(u8) if y&0x4000]
 *  Was: `y &= 0x3FFF` BEFORE testing 0x4000 (flag check always false);
 *  `flags` read unconditionally → shifted bytes by 1 when flag was off;
 *  `graphicInc` never consumed; multi-vs-item decided by serial top bit
 *  instead of CUO's `graphic >= 0x4000` (type 2 = multi). */
export function decodeWorldItem(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  let serial = r.readU32();
  const hasAmount = (serial & 0x80000000) !== 0;
  serial &= 0x7FFFFFFF;
  let graphic = r.readU16();
  const hasGraphicInc = (graphic & 0x8000) !== 0;
  graphic &= 0x7FFF;
  let amount = 1;
  if (hasAmount) amount = r.readU16();
  if (hasGraphicInc) {
    const graphicInc = r.readU8();
    graphic = (graphic + graphicInc) & 0x7FFF;
  }
  let x = r.readU16();
  const useDir = (x & 0x8000) !== 0;
  x &= 0x7FFF;
  let y = r.readU16();
  const useHue   = (y & 0x8000) !== 0;
  const useFlags = (y & 0x4000) !== 0;
  y &= 0x3FFF;
  let direction = 0;
  if (useDir) direction = r.readU8();
  const z = r.readI8();
  let hue = 0;
  if (useHue) hue = r.readU16();
  let flags = 0;
  if (useFlags) flags = r.readU8();
  // CUO marks `type=2` (multi) when `graphic >= 0x4000`, not by serial.
  const type = (graphic >= 0x4000) ? 2 : 0;
  // Corpse detection (audit #34 P1) — graphic 0x2006 is the corpse art.
  return { type, serial, graphic, direction, amount, x, y, z, hue, flags };
}

/** 0xD6 MegaCliloc (VAR) — tooltip with cliloc id list + arg blocks. */
export function decodeMegaCliloc(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  r.readU16();        // type (1 = item, 2 = mobile)
  const serial = r.readU32();
  r.readU16();        // unknown
  const revision = r.readU32();   // tooltip-revision (lookup hash)
  /** @type {{cliloc:number,args:string}[]} */
  const lines = [];
  while (r.remaining >= 6) {
    const cliloc = r.readU32();
    if (cliloc === 0) break;
    const argLen = r.readU16();
    let args = '';
    let consumed = 0;
    while (consumed < argLen && r.remaining >= 2) {
      const lo = r.readU8(), hi = r.readU8();
      consumed += 2;
      const c = (hi << 8) | lo;
      if (c === 0) break;
      args += String.fromCharCode(c);
    }
    while (consumed < argLen && r.remaining >= 1) { r.readU8(); consumed++; }
    lines.push({ cliloc, args });
  }
  return { serial, revision, lines };
}

/** 0xDC OPLInfo (9B) — pre-cached tooltip revision check. */
export function decodeOPLInfo(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const revision = r.readU32();
  return { serial, revision };
}

/** 0x72 SetWarMode (5B). */
export function decodeWarMode(pkt) {
  return { warMode: pkt[1] !== 0 };
}

/** 0x2D MobileAttributes (17B). HP/Mana/Stam max+current pack. */
export function decodeMobileAttributes(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const hpMax  = r.readU16();
  const hpCur  = r.readU16();
  const mpMax  = r.readU16();
  const mpCur  = r.readU16();
  const stMax  = r.readU16();
  const stCur  = r.readU16();
  return { serial, hpMax, hpCur, mpMax, mpCur, stMax, stCur };
}

/** 0x2E EquipUpdate (15B). Equipment item attached to a layer on a mobile. */
export function decodeEquipUpdate(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial   = r.readU32();
  let itemId     = r.readU16();
  // Audit #42 client P1 #11 — CUO `PacketHandlers.cs:1831` reads an i8
  // `graphicInc` and adds it to itemId. Was: skipped as "unknown" →
  // paragon NPCs + ornament-suffix tinted-stack equipment rendered
  // the wrong sprite on the paperdoll.
  const graphicInc = r.readI8();
  itemId = (itemId + graphicInc) & 0xffff;
  const layer    = r.readU8();
  const mobile   = r.readU32();
  const hue      = r.readU16();
  return { serial, itemId, layer, mobile, hue };
}

/** 0x2F Swing (10B). Combat strike between two mobiles. */
export function decodeSwing(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU8();
  const attacker = r.readU32();
  const defender = r.readU32();
  return { attacker, defender };
}

/** 0x97 MovePlayer (2B). Server force-walks the player one step. */
export function decodeMovePlayer(pkt) {
  return { direction: pkt[1] };
}

/** 0xAB TextEntryDialog (VAR) — input prompt. Audit #39 client P1 #2:
 *  the layout we used was invented — CUO `PacketHandlers.cs:3518-3530`
 *  reads `serial(4) parentID(1) buttonID(1) textLen(2) text(ascii)
 *  haveCancel(1) variant(1) maxLength(4) descLen(2) desc(ascii)`. The
 *  first ASCII string is the *default text* (preset value), the second
 *  is the *prompt description*. Was: rune-name and vendor-search
 *  dialogs surfaced garbled fields or threw. */
export function decodeTextEntryDialog(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial      = r.readU32();
  const parentId    = r.readU8();
  const buttonId    = r.readU8();
  const textLen     = r.readU16();
  const defaultText = r.readAsciiFixed(textLen);
  const cancel      = r.readU8();
  const variant     = r.readU8();
  const maxLen      = r.readU32();
  const descLen     = r.readU16();
  const prompt      = r.readAsciiFixed(descLen);
  return { serial, parentId, buttonId, defaultText, cancel, variant, maxLen, prompt };
}

/** 0xAF DisplayDeathAction (13B). Audit #32 P1 #1 — the third u32 is
 *  the `running` flag (CUO `PacketHandlers.cs:3693`), not "unknown".
 *  Without it the death animation defaulted to Die1 (peace) on every
 *  death — runners never got the trailing-stumble Die2 frame. */
export function decodeDeathAction(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const corpseSerial = r.readU32();
  const running = r.readU32() !== 0;
  return { serial, corpseSerial, running };
}

/** 0xB7 HelpResponse (VAR). */
export function decodeHelpResponse(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  r.readU32();   // serial
  // Unicode help text follows; mostly ignored client-side.
  return {};
}

/** 0xB8 CharacterProfile (VAR). */
export function decodeCharacterProfile(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const header = r.readAsciiNull();
  const title  = r.readUnicodeNull();
  const body   = r.readUnicodeNull();
  return { serial, header, title, body };
}

/** 0xBA QuestArrow.
 *  Modern (≥7.0.9.0): 10B — op + active(u8) + x(u16) + y(u16) + serial(u32).
 *  Pre-AOS: 6B — op + active(u8) + x(u16) + y(u16). */
export function decodeQuestArrow(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const active = r.readU8() !== 0;
  const x = r.readU16();
  const y = r.readU16();
  let serial = 0;
  if (pkt.length >= 10) serial = r.readU32();
  return { active, x, y, serial };
}

/** 0xC2 UnicodePrompt (VAR). */
export function decodeUnicodePrompt(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const senderSerial = r.readU32();
  const promptId     = r.readU32();
  const lang         = r.readAsciiFixed(4);
  // Audit #41 deferred (client P2 #17) — CUO `UnicodePrompt` reads the
  // trailing UCS-2 text so the dialog can show a server-supplied
  // default (e.g. vendor "name your rune" pre-filled with current
  // name). Read explicit little-endian to match ServUO's
  // `WriteLittleUniNull` (audit #41 client P1 #2).
  let text = '';
  while (r.remaining >= 2) {
    const lo = r.readU8();
    const hi = r.readU8();
    const c = lo | (hi << 8);
    if (c === 0) break;
    text += String.fromCharCode(c);
  }
  return { senderSerial, promptId, lang, text };
}

/** 0xCB — ServUO `Packets.cs:1582-1590 GQCount` (i16 unk + i32 count).
 *  Audit #41 client P1 #5 — was decoded as `u32 value + u16 reason`
 *  (a guess); consumer destructured `{ amount }` so journal logged
 *  `+undefined gold`. Now matches ServUO layout. */
export function decodeGoldReward(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  /* const unk = */ r.readI16();
  const amount = r.readI32();
  return { amount };
}

/** 0xC4 Semivisible (6B). Server toggles invisibility on a mobile. */
export function decodeSemivisible(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const visible = r.readU8() !== 0;
  return { serial, visible };
}

/** 0xD2 UpdateObject (17B) — modern variant of 0x20 MobileUpdate. */
export function decodeUpdateObject(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const body = r.readU16();
  const hue = r.readU16();
  const flags = r.readU8();
  const x = r.readU16();
  const y = r.readU16();
  r.readU16();   // unknown
  const direction = r.readU8();
  const z = r.readI8();
  return { serial, body, hue, flags, x, y, direction, z };
}

/** 0xD3 CharacterMoveAnim (26B) — modern animation packet, replaces 0x6E. */
export function decodeCharMoveAnim(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  /* skip 4 bytes (body + hue + skip) */ r.readU32();
  /* xyz */ r.readU16(); r.readU16(); r.readI8();
  /* dir + flags */ r.readU8(); r.readU8();
  /* notoriety */ r.readU8();
  /* anim */ const action = r.readU16();
  /* etc */ r.readU16(); r.readU16();
  return { serial, action };
}

/** 0xDF BuffDebuff (VAR). Adds / removes a status icon on the player.
 *
 * Layout (CUO `PacketHandlers.BuffDebuff`):
 *   u8 op
 *   u16 length
 *   u32 serial          (always world.player; server resends per buff)
 *   u16 iconId          (0..0x3EE BuffIconType)
 *   u16 action          (0x01 = add, 0x00 = remove, 0x02 = update)
 *   u16 unknown1        (0)
 *   u16 timer/duration  (seconds) — only on add
 *   u8  unknown2 (×3)
 *   u32 titleCliloc     — only on add
 *   u32 secondaryCliloc — only on add
 *   u32 unknown3
 *   u16 titleArgsLen    — UCS-2 BE chars
 *   ...titleArgs        UTF-16 BE, no trailer
 *   u16 secondaryArgsLen
 *   ...secondaryArgs */
export function decodeBuffDebuff(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const icon   = r.readU16();
  const action = r.readU16();
  const out = { serial, icon, action, op: action };
  if (action !== 0x01) return out;
  if (r.remaining < 2) return out;
  r.readU16();                      // unknown1
  out.duration = r.readU16();       // seconds
  if (r.remaining >= 3) { r.readU8(); r.readU8(); r.readU8(); }
  if (r.remaining >= 4) out.titleCliloc = r.readU32();
  if (r.remaining >= 4) out.secondaryCliloc = r.readU32();
  if (r.remaining >= 4) r.readU32(); // unknown3
  if (r.remaining >= 2) {
    const titleLen = r.readU16();
    let title = '';
    for (let i = 0; i < titleLen && r.remaining >= 2; i++) {
      const c = r.readU16();
      if (c === 0) break;
      title += String.fromCharCode(c);
    }
    out.title = title;
  }
  if (r.remaining >= 2) {
    const sndLen = r.readU16();
    let snd = '';
    for (let i = 0; i < sndLen && r.remaining >= 2; i++) {
      const c = r.readU16();
      if (c === 0) break;
      snd += String.fromCharCode(c);
    }
    out.secondary = snd;
  }
  return out;
}

/** 0x89 CorpseEquipment (VAR). Tells the client what items are equipped on
 *  a corpse (so the loot bag draws the silhouettes correctly).
 *
 *  Layout (CUO `PacketHandlers.CorpseClothing`):
 *    u8 op
 *    u16 length
 *    u32 corpseSerial
 *    repeat until u8 layer == 0:
 *      u8  layer
 *      u32 itemSerial
 */
export function decodeCorpseEquipment(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const serial = r.readU32();
  /** @type {{layer:number, item:number}[]} */
  const items = [];
  while (r.remaining >= 5) {
    const layer = r.readU8();
    if (layer === 0) break;
    const item = r.readU32();
    items.push({ layer, item });
  }
  return { serial, items };
}

/** 0x98 AllNamesAck (VAR). Server reply to our 0x98 NameRequest. Carries the
 *  display name for `serial` so the client can update tooltips/labels.
 *
 *  Layout:
 *    u8 op
 *    u16 length
 *    u32 serial
 *    char[30] name (NUL-padded ASCII)  */
export function decodeAllNames(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const serial = r.readU32();
  const name = r.readAsciiFixed(Math.min(30, r.remaining)).replace(/\0+$/, '');
  return { serial, name };
}

/** 0x95 DyeData (9B). Server asks the client to open a hue picker.
 *  Layout:
 *    u8 op + u32 serial + u16 modelOpen + u16 modelDye  */
export function decodeDyeData(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  /* const open  = */ r.readU16();
  const dyeId   = r.readU16();
  // Audit #41 client P1 #8 — handler reads `info.graphic`; return the
  // matching field name so the hue-picker reply is built with the real
  // dye graphic, not `undefined`.
  return { serial, graphic: dyeId };
}

/** 0xCC DisplayClilocStringAffix (VAR). Same as 0xC1 but with a static
 *  affix string (e.g. crafted-by note appended after the cliloc text). */
export function decodeClilocAffix(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const serial   = r.readU32();
  const graphic  = r.readU16();
  const type     = r.readU8();
  const hue      = r.readU16();
  const font     = r.readU16();
  const cliloc   = r.readU32();
  /* const flags = */ r.readU8();     // 0xCC carries this byte; 0xC1 does not
  const name     = r.readAsciiFixed(30).replace(/\0+$/, '');
  const affix    = r.readAsciiNull();
  // Audit #41 client P1 #2 — ServUO writes args as UTF-16 LE
  // (`Packets.cs:5050 WriteLittleUniNull`). Audit #31 dropped a swap
  // thinking the wire was BE; that direction was wrong. Read each char
  // explicitly as little-endian so `~1_foo~\t~2_bar~` keeps its `\t`.
  let args = '';
  while (r.remaining >= 2) {
    const lo = r.readU8();
    const hi = r.readU8();
    const c = lo | (hi << 8);
    if (c === 0) break;
    args += String.fromCharCode(c);
  }
  return { serial, graphic, type, hue, font, cliloc, name, affix, args };
}

/** 0x23 DragAnimation (26B). Server tells the client to play an item-drag
 *  visual (e.g. healing potion lobbed from heal-thyself). Pure FX. */
export function decodeDragAnimation(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  let itemId  = r.readU16();
  // Audit #42 client P1 #4 — CUO `PacketHandlers.cs:1219-1232` reads an
  // i8 `graphicInc` between graphic and hue and adds it to the itemId.
  // Was: skipped as "unknown" → itemHue/amount were off by 1 byte for
  // any graphic-incremented stack.
  const graphicInc = r.readI8();
  itemId = (itemId + graphicInc) & 0xffff;
  const itemHue = r.readU16();
  const amount  = r.readU16();
  const sourceSerial = r.readU32();
  const sourceX = r.readU16(), sourceY = r.readU16(); const sourceZ = r.readI8();
  const targetSerial = r.readU32();
  const targetX = r.readU16(), targetY = r.readU16(); const targetZ = r.readI8();
  // Field names now match the handler's destructuring (sourceX/Y/Z + targetX/Y/Z).
  return { itemId, itemHue, amount, sourceSerial, sourceX, sourceY, sourceZ,
           targetSerial, targetX, targetY, targetZ };
}

/** 0x7C OpenMenu (VAR). Server-driven choice list (gray menu). */
export function decodeOpenMenu(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const dialogId = r.readU32();
  const menuId   = r.readU16();
  const titleLen = r.readU8();
  const title    = r.readAsciiFixed(titleLen).replace(/\0+$/, '');
  const count    = r.readU8();
  /** @type {{itemId:number, hue:number, label:string}[]} */
  const items = [];
  for (let i = 0; i < count && r.remaining >= 5; i++) {
    const itemId = r.readU16();
    const hue    = r.readU16();
    const labLen = r.readU8();
    const label  = r.readAsciiFixed(labLen).replace(/\0+$/, '');
    items.push({ itemId, hue, label });
  }
  return { dialogId, menuId, title, items };
}

/** 0xE5 WaypointMessage (VAR). Adds a waypoint to the world map. */
export function decodeWaypoint(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const serial = r.readU32();
  const x = r.readU16();
  const y = r.readU16();
  const map = r.readU8();
  const type = r.readU8();
  const ignoreObject = r.readU8() !== 0;
  const cliloc = r.readU32();
  /* unicode name follows; ignored for now */
  return { serial, x, y, map, type, ignoreObject, cliloc };
}

/** 0xF6 BoatMoving (VAR). Audit #38 P1 #2 — CUO
 *  `PacketHandlers.cs:5814` reads a passenger tail after the boat
 *  header: `count(u16) + N×(serial(u32) + x(u16) + y(u16) + z(i16))`.
 *  Was: decoder stopped at z, so passengers + on-deck items didn't
 *  ride the boat lerp — they snapped back on the next 0x77 self-sync. */
export function decodeBoatMoving(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const speed = r.readU8();
  const direction = r.readU8();
  const facing = r.readU8();
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI16();
  const passengers = [];
  if (r.remaining >= 2) {
    const count = r.readU16();
    for (let i = 0; i < count && r.remaining >= 10; i++) {
      passengers.push({
        serial: r.readU32(),
        x: r.readU16(),
        y: r.readU16(),
        z: r.readI16(),
      });
    }
  }
  return { serial, speed, direction, facing, x, y, z, passengers };
}

/** 0x4E PersonalLight (6B). Audit #42 client P3 #25 — CUO clamps to 0x1E. */
export function decodePersonalLight(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const level  = Math.min(0x1E, r.readU8());
  return { serial, level };
}

/** 0xD8 CustomHouse (VAR). For now just emits raw payload — UI-side
 *  parsing of house components lands in a follow-up. */
export function decodeCustomHouse(pkt) {
  return { raw: pkt };
}

/** 0x93 OpenBookLegacy (99B, fixed) — pre-Unicode book header. CUO
 *  `PacketHandlers.cs:OpenBook` decodes: serial(u32) + writable(u8) +
 *  newBook(u8) + pageCount(u16) + title[60 ASCII] + author[30 ASCII].
 *  Mainstream books use 0xD4, but legacy / shard-modified books still
 *  push 0x93 (e.g. RunUO BookItem.OnDoubleClick → SendBookHeader). */
export function decodeOpenBookLegacy(pkt) {
  const r = packetReader(pkt);
  r.readU8();                       // opcode
  const serial = r.readU32();
  const writable = r.readU8();
  /* const newBook = */ r.readU8();
  const pageCount = r.readU16();
  const title = r.readAsciiFixed(60).replace(/\0+$/, '');
  const author = r.readAsciiFixed(30).replace(/\0+$/, '');
  return { serial, writable, pageCount, title, author, legacy: true };
}

/** 0xD4 OpenBookNew (VAR) — modern unified book packet. */
export function decodeOpenBook(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const writable = r.readU8();
  /* const newBook = */ r.readU8();
  const pageCount = r.readU16();
  const titleLen = r.readU16();
  const title = r.readAsciiFixed(titleLen);
  const authorLen = r.readU16();
  const author = r.readAsciiFixed(authorLen);
  return { serial, writable, pageCount, title, author };
}

/** 0x99 MultiPlacement (30B) — server asks the client to target a ground
 *  spot for a multi (house / boat / ship). Response: 0x6C TargetResponse
 *  with cursorType = 2 (Multi) and the picked tile.
 */
export function decodeMultiPlacement(pkt) {
  // Audit #41 client P1 #3 — ServUO `MultiTargetReqHS` calls
  // `m_Stream.Seek(18, SeekOrigin.Begin)` before writing MultiID;
  // CUO `PacketHandlers.cs:3320 MultiPlacement` mirrors with `p.Seek(18)`.
  // Was: read multiId right after cursorId (byte 6) → grabbed 12 bytes
  // of zero padding. Every house/boat placement ghost had multiId=0
  // and the wrong offsets, so the preview was invisible / wrong.
  const r = packetReader(pkt);
  r.readU8();                       // op
  /* allowGround */ r.readU8();
  const cursorId  = r.readU32();    // bytes 2..5
  // Skip 12 bytes of padding (bytes 6..17). MultiID starts at byte 18.
  for (let i = 0; i < 12; i++) r.readU8();
  const multiId   = r.readU16();
  // Audit #46 P2 — CUO `PacketHandlers.cs:3325-3326` reads `ushort` for
  // offsets. Was `i16` → x/y offsets > 32767 wrapped to negative and
  // the placement ghost rendered on the wrong tile.
  const offsetX   = r.readU16();
  const offsetY   = r.readU16();
  // Audit #43 client P1 #21 — CUO `PacketHandlers.cs:3327` reads u16.
  // Was i16 → multi-storey houses with placement-z > 32767 wrapped to
  // negative and rendered 1 tile below the actual build target.
  const offsetZ   = r.readU16();
  const hue       = r.readU16();
  return { cursorId, multiId, offsetX, offsetY, offsetZ, hue };
}

/** 0x0B Damage (7B) — legacy short damage announcement. */
export function decodeDamage(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const amount = r.readU16();
  return { serial, amount };
}

/** 0x70 GraphicEffect (28B). */
export function decodeGraphicEffect(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const type        = r.readU8();
  const sourceSerial = r.readU32();
  const targetSerial = r.readU32();
  const graphic     = r.readU16();
  const sx = r.readU16(), sy = r.readU16(); const sz = r.readI8();
  const tx = r.readU16(), ty = r.readU16(); const tz = r.readI8();
  const speed = r.readU8();
  const duration = r.readU8();
  r.readU16();   // unknown
  const fixed = r.readU8();
  const explode = r.readU8();
  return { type, sourceSerial, targetSerial, graphic,
    sx, sy, sz, tx, ty, tz, speed, duration, fixed, explode };
}

/** 0xC0 GraphicEffectHued (36B) — same as 0x70 + hue + render mode. */
export function decodeGraphicEffectHued(pkt) {
  const base = decodeGraphicEffect(pkt.subarray(0, 28));
  const r = packetReader(pkt, 28);
  const hue = r.readU32();
  const renderMode = r.readU32();
  return { ...base, hue, renderMode };
}

/** 0xC7 GraphicEffectExt (49B). Audit #39 client P2 #6 — CUO
 *  `PacketHandlers.cs:2485-2493`. Extends Hued with tile id (for type 3
 *  attached-to-mobile effects), an "explode" follow-up effect/sound,
 *  and the layer to attach to. Was: routed through `decodeGraphicEffectHued`
 *  so the trailing 13 bytes (explode sound, attached serial/layer)
 *  silently dropped — SA/AOS proc graphics had no audio and didn't
 *  stick to the source mobile. */
export function decodeGraphicEffectExt(pkt) {
  const base = decodeGraphicEffectHued(pkt.subarray(0, 36));
  const r = packetReader(pkt, 36);
  const tileId         = r.readU16();
  const explodeEffect  = r.readU16();
  const explodeSound   = r.readU16();
  const attachedSerial = r.readU32();
  const attachedLayer  = r.readU8();
  r.readU16(); // unused tail
  return { ...base, tileId, explodeEffect, explodeSound, attachedSerial, attachedLayer };
}

/** 0x6E CharacterAnimation (14B). Audit #38 P1 #3 — `reverse` and
 *  `repeat` were discarded; the renderer's `_repeatCountOverride` was
 *  set but never decremented, so a server-scripted emote with
 *  `repeatCount=N` looped forever. CUO `Mobile.SetAnimation` honors
 *  `forward=false` by stepping `frame--` and counts down repeats. */
export function decodeCharacterAnimation(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial    = r.readU32();
  const action    = r.readU16();
  const frameCount = r.readU16();
  const repeatCount = r.readU16();
  const reverse   = r.readU8() !== 0;
  const repeat    = r.readU8() !== 0;
  const delay     = r.readU8();
  return { serial, action, frameCount, repeatCount, delay, reverse, repeat };
}

/** 0xE2 NewCharacterAnimation (10B). */
export function decodeNewCharacterAnimation(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const type   = r.readU16();
  const action = r.readU16();
  const delay  = r.readU8();
  return { serial, type, action, delay };
}

/** 0x54 PlaySoundEffect (12B). */
export function decodePlaySound(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU8();                       // mode
  const sound = r.readU16();
  r.readU16();                      // unk volume
  const x = r.readU16();
  const y = r.readU16();
  const z = r.readI16();
  return { sound, x, y, z };
}

/** 0x21 MovementRej (8B). server's "no, you can't" walk reply. */
export function decodeMovementRej(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const sequence = r.readU8();
  const x = r.readU16();
  const y = r.readU16();
  const direction = r.readU8();
  const z = r.readI8();
  return { sequence, x, y, direction, z };
}

/** 0x22 MovementAck (3B). */
export function decodeMovementAck(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const sequence = r.readU8();
  const notoriety = r.readU8();
  return { sequence, notoriety };
}

/** 0x73 Ping (2B). */
export function decodePing(pkt) {
  return { seq: pkt[1] };
}

/** 0x1C AsciiMessage (VAR). */
export function decodeAsciiMessage(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const graphic = r.readU16();
  const type = r.readU8();
  const hue = r.readU16();
  const font = r.readU16();
  const name = r.readAsciiFixed(30);
  const text = r.readAsciiNull();
  return { serial, graphic, type, hue, font, name, text };
}

/** 0xAE UnicodeMessage (VAR). */
export function decodeUnicodeMessage(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial = r.readU32();
  const graphic = r.readU16();
  const type = r.readU8();
  const hue = r.readU16();
  const font = r.readU16();
  const language = r.readAsciiFixed(4);
  const name = r.readAsciiFixed(30);
  const text = r.readUnicodeNull();
  return { serial, graphic, type, hue, font, language, name, text };
}

/** 0x4F OverallLight (2B). Audit #42 client P2 #17 — clamp to 0x1E
 *  (CUO `PacketHandlers.cs:2172-2178`); buggy/admin level 0xFF would
 *  blacken the screen completely. */
export function decodeOverallLight(pkt) {
  return { level: Math.min(0x1E, pkt[1] | 0) };
}

/** 0xBC Season (3B). Audit #33 P2.3 — byte 2 is the `playSound` flag,
 *  not a cursor. CUO `World.cs:218 ChangeSeason(season, music)` uses
 *  this trigger to re-play the regional music on season transition
 *  (e.g. autumn→winter swaps to winter music). Previously decoded as
 *  `cursor`, ignored — music never refreshed on season change. */
export function decodeSeason(pkt) {
  return { season: Math.max(0, Math.min(4, pkt[1] | 0)), playSound: pkt[2] !== 0 };
}

/** 0x65 Weather (4B). */
export function decodeWeather(pkt) {
  const rawTemperature = pkt[3] | 0;
  return {
    kind: pkt[1],
    particles: pkt[2],
    temperature: rawTemperature >= 0x80 ? rawTemperature - 0x100 : rawTemperature,
  };
}

/** 0x88 OpenPaperdoll (66B). */
export function decodeOpenPaperdoll(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const text = r.readAsciiFixed(60);
  const flags = r.readU8();
  return { serial, text, flags };
}

/** 0x24 OpenContainer (9B post-7.0.9: opcode + u32 serial + u16 gumpId + u16 cliloc unk). */
export function decodeOpenContainer(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const gumpId = r.readU16();
  // Audit #41 deferred (client P3 #26) — post-7.0.9 layout includes a
  // trailing u16 cliloc id used as the gump title prefix (so the user
  // sees "Backpack" / "Bank Box" / "Corpse" instead of generic
  // "Container"). Was: trailing bytes ignored → all containers had a
  // flat default title.
  let titleCliloc = 0;
  if (r.remaining >= 2) titleCliloc = r.readU16();
  return { serial, gumpId, titleCliloc };
}

/** 0x3C ContainerContents (VAR). Items have post-6017 layout (extra grid byte).
 *  Fields named both `x/y` (legacy) and `gridX/gridY` (canonical UO) so
 *  callers can use whichever — these are NOT world coordinates, they're
 *  per-container grid offsets the server stored on last drop. */
export function decodeContainerContents(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const count = r.readU16();
  const items = [];
  for (let i = 0; i < count; i++) {
    const serial   = r.readU32();
    let   itemId   = r.readU16();
    // Audit #43 client P1 #3 — CUO `PacketHandlers.cs:2089-2126` reads
    // this byte as `graphicInc` and adds to itemId; we were treating
    // it as "unknown" so paragon NPCs / ornament-suffix items (daedric
    // weapons, exceptional artifacts) rendered the base sprite.
    const graphicInc = r.readU8();
    itemId = (itemId + graphicInc) & 0xffff;
    const amount   = Math.max(1, r.readU16());     // CUO clamps min 1
    const gridX    = r.readU16();
    const gridY    = r.readU16();
    const gridLocation = r.readU8(); // post-6.0.1.7
    const parent   = r.readU32();
    const hue      = r.readU16();
    items.push({
      serial, itemId, amount,
      x: gridX, y: gridY, gridX, gridY, gridLocation,
      parent, hue,
    });
  }
  return { items };
}

/** 0x25 ContainerContentUpdate (21B). Same dual-name field block as 0x3C. */
export function decodeContainerContentUpdate(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial   = r.readU32();
  let   itemId   = r.readU16();
  // Audit #43 client P1 #3 — same graphicInc as 0x3C above.
  const graphicInc = r.readU8();
  itemId = (itemId + graphicInc) & 0xffff;
  const amount   = Math.max(1, r.readU16());
  const gridX    = r.readU16();
  const gridY    = r.readU16();
  const gridLocation = r.readU8();
  const parent   = r.readU32();
  const hue      = r.readU16();
  return {
    serial, itemId, amount,
    x: gridX, y: gridY, gridX, gridY, gridLocation,
    parent, hue,
  };
}

/** 0x3A SkillsList (VAR). One of several "type" bytes; we cover the
 * full snapshot (0x00 / 0x02) and single-skill (0xDF / 0xFF). */
export function decodeSkills(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const type = r.readU8();
  /** @type {{id:number,value:number,base:number,lock:number,cap:number}[]} */
  const skills = [];
  const isSnapshotWithCaps = type === 0x02 || type === 0xDF;
  const isSingle           = type === 0xFF || type === 0xDF;
  // Per-entry size: 7 bytes minimum (id + value + base + lock), +2 for
  // cap when the format is the post-AOS snapshot. Earlier the loop
  // gate was `remaining >= 7` even for the 9-byte variant, which let
  // the loop enter on the last incomplete entry and underflow when
  // it tried to read the trailing `cap` u16.
  const entrySize = isSnapshotWithCaps ? 9 : 7;
  while (r.remaining >= entrySize) {
    const id = r.readU16();
    if (id === 0) break;          // terminator in full snapshots
    const value = r.readU16();
    const base  = r.readU16();
    const lock  = r.readU8();
    let cap = 1000;
    if (isSnapshotWithCaps) cap = r.readU16();
    skills.push({ id: id - 1, value, base, lock, cap });
    if (isSingle) break;
  }
  return { type, skills };
}

/** 0x74 OpenBuyWindow (VAR). Vendor → list of buy lines. */
export function decodeBuyList(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const vendor = r.readU32();
  const count = r.readU8();
  /** @type {{price:number,description:string}[]} */
  const items = [];
  for (let i = 0; i < count; i++) {
    const price = r.readU32();
    const len   = r.readU8();
    const description = r.readAsciiFixed(len);
    items.push({ price, description });
  }
  return { vendor, items };
}

/** 0x9E SellList (VAR). Vendor → items the player can sell. */
export function decodeSellList(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const vendor = r.readU32();
  const count = r.readU16();
  /** @type {{serial:number,itemId:number,hue:number,amount:number,price:number,name:string}[]} */
  const items = [];
  for (let i = 0; i < count; i++) {
    const serial = r.readU32();
    const itemId = r.readU16();
    const hue    = r.readU16();
    const amount = r.readU16();
    const price  = r.readU16();
    // Audit #42 client P3 #31 — clamp to remaining bytes. A malformed
    // server packet with nameLen=0xFFFF would try to read 65535 bytes
    // past end-of-packet → `readAsciiFixed` throws and the entire
    // sell gump fails to open.
    const nameLen = Math.min(r.readU16(), r.remaining);
    const name   = r.readAsciiFixed(nameLen);
    items.push({ serial, itemId, hue, amount, price, name });
  }
  return { vendor, items };
}

/** 0x6C TargetCursor (19B). Server asks the client to pick a target. */
export function decodeTargetCursor(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const cursorType = r.readU8();   // 0 = object, 1 = position, 2 = cancel/multi
  const cursorId   = r.readU32();
  const flag       = r.readU8();
  // bytes 7..18 are zero (server hint payload only relevant for multi)
  return { cursorType, cursorId, flag };
}

/** 0xC1 DisplayClilocString (VAR) — server-localised overhead/system message. */
export function decodeClilocMessage(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serial   = r.readU32();
  const graphic  = r.readU16();
  const type     = r.readU8();
  const hue      = r.readU16();
  const font     = r.readU16();
  const cliloc   = r.readU32();
  // Audit #41 client P1 #1 — there is NO `flags` byte on 0xC1; that
  // byte exists only on 0xCC (Affix variant). ServUO `Packets.cs:2615
  // MessageLocalized` writes header → name → args with no flags. Was:
  // r.readU8() shifted every following field by 1 → name read from
  // middle of cliloc + args byte-offset by 1 (BE swap further corrupted
  // every multi-arg cliloc).
  const name     = r.readAsciiFixed(30);
  // Audit #41 client P1 #2 — ServUO writes args as UTF-16 LE
  // (`WriteLittleUniNull`); CUO reads `ReadUnicodeReversed`. Audit #31
  // dropped the byte-swap thinking the wire was BE — wrong direction.
  // Every `~1_foo~\t~2_bar~` substitution split on `\t` (0x09 0x00 LE)
  // became one mashed CJK string. Read as little-endian explicitly.
  let args = '';
  while (r.remaining >= 2) {
    const lo = r.readU8();
    const hi = r.readU8();
    const c = lo | (hi << 8);
    if (c === 0) break;
    args += String.fromCharCode(c);
  }
  return { serial, graphic, type, hue, font, cliloc, name, args };
}

/** 0x88 Open Spellbook contents — actually a 0xBF subop 0x1B. We don't
 *  need a full BF subop decoder right now; the spellbook gump opens
 *  via a 0x24 OpenContainer with a special gumpId (0xFFB1..). */

/** 0xA1 UpdateHealth / 0xA2 UpdateMana / 0xA3 UpdateStamina (9B each). */
export function decodeAttributeUpdate(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  const serial = r.readU32();
  const max = r.readU16();
  const current = r.readU16();
  return { serial, max, current };
}

/** 0xB0 OpenGump (VAR) — uncompressed gump.
 *
 *   u8 op
 *   u16 length
 *   u32 serverSerial   (mob serial that owns the gump)
 *   u32 gumpSerial     (server-chosen unique id)
 *   u32 x
 *   u32 y
 *   u16 layoutLength   (length of ASCII layout string, NUL-terminated below)
 *   ASCII layout (`{ ... }{ ... }...`)  — `layoutLength` bytes, includes terminator
 *   u16 textCount
 *   textCount × { u16 lineLength; UCS-2 BE chars (no terminator) }
 */
export function decodeOpenGump(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serverSerial = r.readU32();
  const gumpSerial   = r.readU32();
  const x            = r.readU32();
  const y            = r.readU32();
  const layoutLen    = r.readU16();
  // ASCII bytes; trailing NUL is included in layoutLen.
  const layoutBytes  = r.readBytes(layoutLen);
  let layout = '';
  for (let i = 0; i < layoutBytes.length && layoutBytes[i] !== 0; i++) {
    layout += String.fromCharCode(layoutBytes[i]);
  }
  const textCount = r.readU16();
  const textLines = new Array(textCount);
  for (let i = 0; i < textCount; i++) {
    const lineLen = r.readU16();
    let line = '';
    for (let j = 0; j < lineLen; j++) line += String.fromCharCode(r.readU16());
    textLines[i] = line;
  }
  return { serverSerial, gumpSerial, x, y, layout, textLines };
}

/** 0xDD OpenCompressedGump (VAR) — same as 0xB0 but the layout and text
 * lines are zlib-compressed.
 *
 *   u8 op
 *   u16 length
 *   u32 serverSerial
 *   u32 gumpSerial
 *   u32 x
 *   u32 y
 *   u32 compressedLayoutLen      (incl. checksum + size header)
 *   u32 layoutLen                (uncompressed size)
 *   compressedLayoutLen-4 bytes  zlib-deflated ASCII layout
 *   u32 textCount
 *   u32 compressedTextLen
 *   u32 textBufLen
 *   compressedTextLen-4 bytes    zlib-deflated payload of {u16 lineLen; UCS-2 BE}* lines
 *
 * The uncompressed bodies are forwarded to `parseGumpLayout` exactly the
 * same as 0xB0. Decompression is async (`DecompressionStream('deflate')`).
 *
 * @returns {Promise<{ serverSerial:number, gumpSerial:number, x:number, y:number, layout:string, textLines:string[] }>}
 */
export async function decodeCompressedGump(pkt) {
  const r = packetReader(pkt);
  r.readU8();
  r.readU16();
  const serverSerial = r.readU32();
  const gumpSerial   = r.readU32();
  const x            = r.readU32();
  const y            = r.readU32();
  const cLayoutLen   = r.readU32();
  const layoutLen    = r.readU32();
  const layoutBytes  = r.readBytes(cLayoutLen - 4);
  const textCount    = r.readU32();
  const cTextLen     = r.readU32();
  const textBufLen   = r.readU32();
  const textBytes    = r.readBytes(cTextLen - 4);

  const [layoutBuf, textBuf] = await Promise.all([
    inflate(layoutBytes, layoutLen),
    inflate(textBytes,   textBufLen),
  ]);

  let layout = '';
  for (let i = 0; i < layoutBuf.length && layoutBuf[i] !== 0; i++) {
    layout += String.fromCharCode(layoutBuf[i]);
  }
  const textLines = decodeUnicodeLines(textBuf, textCount);
  return { serverSerial, gumpSerial, x, y, layout, textLines };
}

/** zlib-inflate via the browser's DecompressionStream (Chromium 80+, FF 113+,
 * Safari 16+). Returns a Uint8Array of exactly `expectedLen` bytes (the caller
 * already knows the size). Falls back to manual inflate later if needed. */
async function inflate(bytes, _expectedLen) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not available — browser unsupported (Chromium 80+, FF 113+, Safari 16+)');
  }
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

function decodeUnicodeLines(buf, count) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Array(count);
  let off = 0;
  for (let i = 0; i < count; i++) {
    // Audit #30 P1 #4 — CUO `PacketHandlers.cs:5404` reads the per-line
    // char count as `ReadUInt16BE`, not u32. The earlier u32 read pulled
    // 4 bytes (two extra) and then walked far too many UCS-2 chars,
    // shredding the line buffer on every compressed shop / quest / Razor
    // gump (0xDD with `linesCount > 0`). The plain 0xB0 path got the same
    // wire-format right; this branch was ported independently.
    const len = dv.getUint16(off, false); off += 2;
    let line = '';
    for (let j = 0; j < len; j++) {
      line += String.fromCharCode(dv.getUint16(off, false));
      off += 2;
    }
    out[i] = line;
  }
  return out;
}

/** 0x11 MobileStatus (variable). Full status payload — what the paperdoll's
 *  status button asks for via 0x34. The version byte controls how many
 *  trailing fields the server packs:
 *    0x00 brief (name, hp, hpMax)
 *    0x03 extended (mana, stam, str/dex/int, gold, weight, sex/race, ...)
 *    0x04 full     (+ stat cap, followers, ar/fire/cold/poison/energy resists)
 *    0x05 KR-era   (+ luck, dmgMin/Max, tithing)
 *    0x06 SA-era   (+ HitChance/SwingSpeed/DamageIncrease/...)
 *  We decode the union and let consumers pick the fields they need. */
export function decodeMobileStatus(pkt) {
  // Defensive: malformed/short 0x11 frames have been observed in the wild
  // (server sometimes emits a brief 1-byte stub when status is requested
  // for a serial it can't resolve). Bail with empty out rather than throw.
  if (!pkt || pkt.length < 43) return { serial: 0, malformed: true, length: pkt?.length | 0 };
  const r = packetReader(pkt);
  r.readU8(); r.readU16(); // op + len
  const serial = r.readU32();
  const name = r.readAsciiFixed(30).replace(/\0+$/, '');
  const hp = r.readU16();
  const hpMax = r.readU16();
  const canRename = r.readU8() !== 0;
  const out = { serial, name, hp, hpMax, canRename };
  if (r.remaining < 1) return out;
  const version = r.readU8();
  out.version = version;
  // Each block declares the EXACT byte count it consumes — under-budget
  // gates here used to underflow when the server packed v4 with only the
  // partial block that follows.
  if (version >= 0x01 && r.remaining >= 23) {
    out.sex   = r.readU8();
    out.str   = r.readU16();
    out.dex   = r.readU16();
    out.int   = r.readU16();
    out.stam  = r.readU16();
    out.stamMax = r.readU16();
    out.mana  = r.readU16();
    out.manaMax = r.readU16();
    out.gold = r.readU32();
    out.ar   = r.readU16();
    out.weight = r.readU16();
  }
  if (version >= 0x04 && r.remaining >= 7) {
    out.weightMax = r.readU16();
    out.race      = r.readU8();
    out.statCap   = r.readU16();
    out.followers = r.readU8();
    out.followersMax = r.readU8();
  }
  if (version >= 0x05 && r.remaining >= 18) {
    out.fireResist   = r.readU16();
    out.coldResist   = r.readU16();
    out.poisonResist = r.readU16();
    out.energyResist = r.readU16();
    out.luck         = r.readU16();
    out.dmgMin       = r.readU16();
    out.dmgMax       = r.readU16();
    out.tithingPoints = r.readU32();
    // Physical resist isn't on the wire — UO derives it from worn
    // armor's per-piece phys cap. We approximate as 100 minus the
    // sum of the other four (clamped 0..70) so the status panel has
    // something to show for the Phys row.
    const others = (out.fireResist | 0) + (out.coldResist | 0)
                 + (out.poisonResist | 0) + (out.energyResist | 0);
    out.physResist = Math.max(0, Math.min(70, 70 - Math.floor(others / 8)));
  }
  return out;
}

/** 0x16 NewHealthbarUpdate / 0x17 (variant). Tells the client a mobile's
 *  health bar should change colour to indicate poison/yellow-bar state.
 *  Layout: serial(4) + count(2) + count × { color(2), enabled(1) }
 *  Color codes: 1=Green (poisoned), 2=Yellow (invul). */
export function decodeNewHealthbarUpdate(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const serial = r.readU32();
  const count = r.readU16();
  const states = [];
  // Audit #43 client P1 #8 — CUO `PacketHandlers.cs:710-777` reads
  // `type(u16)` not "color"; semantics: type 1 = poison, 2 = yellow
  // (invul), 3 = ignored. No `level` field on the wire — the previous
  // handler's `s.level | 0` was reading `undefined`. Renamed field
  // to match CUO so future handlers can route by type.
  for (let i = 0; i < count && r.remaining >= 3; i++) {
    states.push({ type: r.readU16(), enabled: r.readU8() !== 0 });
  }
  return { serial, states };
}

/** 0x2C DeathStatusResponse — 2 bytes. Action code:
 *    0x00 = normal death (becomes ghost), 0x01 = manifest, 0x02 = resurrect. */
export function decodeDeathStatus(pkt) {
  return { action: pkt[1] | 0 };
}

/** 0x6F SecureTrade — variable. Action codes:
 *    0x00 open  — payload: containerSerial(4)+otherSerial(4)+ourSerial(4)+name(30)
 *    0x01 close — payload: containerSerial(4)
 *    0x02 check — payload: containerSerial(4)+ourFlag(4)+otherFlag(4)
 *    0x03 gold  — payload: containerSerial(4)+gold(4)+platinum(4)+otherGold(4)+otherPlat(4) */
export function decodeSecureTrade(pkt) {
  const r = packetReader(pkt);
  r.readU8(); r.readU16();
  const action = r.readU8();
  const out = { action };
  if (action === 0x00) {
    out.containerSerial = r.readU32();
    out.otherSerial     = r.readU32();
    out.ourSerial       = r.readU32();
    if (r.remaining >= 1) out.partnerName = r.readAsciiFixed(Math.min(30, r.remaining)).replace(/\0+$/, '');
  } else if (action === 0x01) {
    out.containerSerial = r.readU32();
  } else if (action === 0x02) {
    out.containerSerial = r.readU32();
    out.ourAccept       = r.readU32() !== 0;
    out.otherAccept     = r.readU32() !== 0;
  } else if (action === 0x03) {
    out.containerSerial = r.readU32();
    out.ourGold         = r.readU32();
    out.ourPlatinum     = r.readU32();
    out.otherGold       = r.readU32();
    out.otherPlatinum   = r.readU32();
  }
  return out;
}

/** 0xAA AttackReply — 5B. Server confirms the new attack focus (or 0 to
 *  clear). Mirrors CUO `Network/PacketHandlers.cs:AttackCharacter`. */
export function decodeAttackReply(pkt) {
  return { serial: ((pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4]) >>> 0 };
}

/** 0xD1 LogoutResponse — 2 bytes. byte[1]: 0=block (still in combat),
 *  1=accept (server is fine with us closing the connection). */
export function decodeLogoutResponse(pkt) {
  return { allowed: pkt[1] !== 0x00 };
}

/** 0xB9 EnableLockedFeatures (5B post-6.0.14). */
export function decodeSupportedFeatures(pkt) {
  // bytes 1..4 = u32 BE feature flags
  const flags = (pkt[1] << 24) | (pkt[2] << 16) | (pkt[3] << 8) | pkt[4];
  return { flags: flags >>> 0 };
}
