// Client → server packet builders. Mirror ClassicUO's
// Network/OutgoingPackets.cs Send_* methods, but in JS using
// `@uo/protocol`'s PacketWriter (big-endian, ServUO-bit-identical).

import { PacketWriter } from '@uo/protocol';

const utf8Encoder = new TextEncoder();

function utf8Bytes(value) {
  return utf8Encoder.encode(String(value ?? ''));
}

function writeUtf8Fixed(w, value, fixedLen) {
  const bytes = utf8Bytes(value);
  const n = Math.min(bytes.length, fixedLen);
  for (let i = 0; i < n; i++) w.writeU8(bytes[i]);
  if (n < fixedLen) w.writeZero(fixedLen - n);
}

// Default client version we advertise. ServUO's PacketHandlers reads only
// the seed from 0xEF; the version bytes are informational. 7.0.95.0 keeps
// us in modern packet variants (post-7.0.16 CreateCharacter, etc.).
export const CLIENT_VERSION = { major: 7, minor: 0, revision: 95, prototype: 0 };

/** 0xEF LoginServerSeed — 21 bytes. */
export function buildLoginSeed(seed = 0x0a000001) {
  const w = new PacketWriter(21);
  w.writeU8(0xEF);
  w.writeU32(seed >>> 0);
  w.writeU32(CLIENT_VERSION.major);
  w.writeU32(CLIENT_VERSION.minor);
  w.writeU32(CLIENT_VERSION.revision);
  w.writeU32(CLIENT_VERSION.prototype);
  return w.bytes();
}

/** Legacy login seed — old clients send only the raw u32 seed, no opcode. */
export function buildLoginSeedOld(seed = 0x0a000001) {
  const w = new PacketWriter(4);
  w.writeU32(seed >>> 0);
  return w.bytes();
}

/** 0x80 AccountLogin — 62 bytes. */
export function buildAccountLogin(account, password) {
  const w = new PacketWriter(62);
  w.writeU8(0x80);
  w.writeAsciiFixed(account ?? '', 30);
  w.writeAsciiFixed(password ?? '', 30);
  w.writeU8(0xFF); // nextLoginKey — unused by ServUO
  return w.bytes();
}

/** 0xA0 PlayServer — 3 bytes. */
export function buildPlayServer(serverIndex = 0) {
  const w = new PacketWriter(3);
  w.writeU8(0xA0);
  w.writeU16(serverIndex & 0xffff);
  return w.bytes();
}

/** 0x91 GameLogin — 65 bytes. */
export function buildGameLogin(authKey, account, password) {
  const w = new PacketWriter(65);
  w.writeU8(0x91);
  w.writeU32(authKey >>> 0);
  w.writeAsciiFixed(account ?? '', 30);
  w.writeAsciiFixed(password ?? '', 30);
  return w.bytes();
}

/** 0x5D PlayCharacter — 73 bytes.
 *
 * Wire layout per ClassicUO `Network/OutgoingPackets.cs` AND the
 * ServUO `PacketHandlers.cs::PlayCharacter` parser (which does
 * `Seek(24)` between flags and slot):
 *
 *   1  opcode 0x5D
 *   4  pattern1 0xEDEDEDED
 *  30  character name (ASCII, zero-padded)
 *   2  unknown (zero)
 *   4  flags (zero — not in war / female / etc.)
 *  24  zero padding (single block — DO NOT split into loginCount + pattern2)
 *   4  charSlot (the index the user clicked)
 *   4  clientIP (any non-zero u32; loopback works fine)
 *   ───
 *  73  total
 *
 * The earlier implementation split the 24-byte gap as
 *   `writeU32(loginCount=1) + writeZero(16)` (= 20 bytes)
 * and added a trailing `writeU32(0)` to reach 73. The total length
 * was right but the SLOT field landed at offset 61 instead of 65.
 * ServUO's `Seek(24)` then read our `clientIP` as the slot, and our
 * actual `slot` value as part of the 24-byte skip → "Invalid
 * Character Selection." for every PlayCharacter request.
 */
export function buildPlayCharacter(name, slot = 0) {
  const w = new PacketWriter(73);
  w.writeU8(0x5D);
  w.writeU32(0xEDEDEDED >>> 0);     // pattern1
  w.writeAsciiFixed(name ?? '', 30);
  w.writeU16(0x0000);                // unknown
  w.writeU32(0x00000000);            // flags
  w.writeZero(24);                   // ServUO Seek(24) gap — single block
  w.writeU32(slot >>> 0);            // charSlot — offset 65-68
  w.writeU32(0x0100007F);            // clientIP — non-zero loopback (127.0.0.1 BE)
  return w.bytes();
}

/** 0xF8 CreateCharacter70160 — 106 bytes (post-7.0.16 extended creator). */
export function buildCreateCharacter({
  name,
  sex = 0, race = 0, profession = 1,
  str = 45, dex = 35, int: intel = 10,
  skills = [
    { id: 2,  value: 30 },  // Anatomy
    { id: 18, value: 30 },  // Healing
    { id: 41, value: 30 },  // Swordsmanship
    { id: 28, value: 30 },  // Tactics
  ],
  skinHue = 0, hairId = 0, hairHue = 0,
  beardId = 0, beardHue = 0,
  shirtHue = 0, pantsHue = 0,
  city = 0, slot = 0,
}) {
  const w = new PacketWriter(106);
  w.writeU8(0xF8);
  w.writeU32(0xEDEDEDED >>> 0);  // patternRevision
  w.writeU32(0xFFFFFFFF >>> 0);  // clientFlag
  w.writeU8(0x00);               // unknown
  w.writeAsciiFixed(name ?? '', 30);
  w.writeU16(0x0000);             // unk
  w.writeU32(0x00000000);         // featureFlags
  w.writeU32(0x00000001);         // unknown
  w.writeU32(0x00000000);         // unknown
  w.writeU8(profession & 0xff);
  w.writeZero(15);                // padding
  // ClassicUO modern creator packs race and sex into one byte using
  // RaceType values (1=human, 2=elf, 3=gargoyle):
  //   2/3 human, 4/5 elf, 6/7 gargoyle; odd values are female.
  const raceType = Math.max(0, Math.min(2, race | 0)) + 1;
  w.writeU8(((raceType * 2) + (sex & 0x01)) & 0xff);
  w.writeU8(str & 0xff);
  w.writeU8(dex & 0xff);
  w.writeU8(intel & 0xff);
  // Up to 4 skill picks. Runtime skill ids are canonical 1..58; UO's
  // create-character wire uses zero-based SkillName enum indexes.
  for (let i = 0; i < 4; i++) {
    const s = skills[i];
    if (s) {
      const id = s.id | 0;
      const wireId = id >= 1 && id <= 58 ? id - 1 : 0xff;
      w.writeU8(wireId & 0xff);
      w.writeU8(s.value & 0xff);
    } else {
      w.writeU8(0xff); w.writeU8(0);
    }
  }
  w.writeU16(skinHue & 0xffff);
  w.writeU16(hairId & 0xffff);
  w.writeU16(hairHue & 0xffff);
  w.writeU16(beardId & 0xffff);
  w.writeU16(beardHue & 0xffff);
  w.writeU16(city & 0xffff);
  w.writeU16(0x0000);              // unknown
  w.writeU16(slot & 0xffff);
  w.writeU32(0x00000000);         // clientIP
  w.writeU16(shirtHue & 0xffff);
  w.writeU16(pantsHue & 0xffff);
  // Pad/truncate to 106. PacketWriter grows as needed; truncation by
  // returning bytes() up to the offset means we want offset === 106.
  while (w.length < 106) w.writeU8(0);
  return w.bytes().subarray(0, 106);
}

/** 0xBD ClientVersion — variable length, ASCII-null version string. */
export function buildClientVersion(versionStr = '7.0.95.0') {
  const ascii = versionStr;
  const total = 1 + 2 + ascii.length + 1; // op + len + chars + null
  const w = new PacketWriter(total);
  w.writeU8(0xBD);
  w.writeU16(total);
  for (let i = 0; i < ascii.length; i++) w.writeU8(ascii.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  return w.bytes();
}

/** 0xA4 SystemInfo — fixed 149 bytes. ServUO does not parse this. */
export function buildSystemInfo() {
  const w = new PacketWriter(149);
  w.writeU8(0xA4);
  w.writeZero(148);
  return w.bytes();
}

/** 0x73 Ping — 2 bytes. Server echoes back. */
export function buildPing(seq = 0) {
  const w = new PacketWriter(2);
  w.writeU8(0x73);
  w.writeU8(seq & 0xff);
  return w.bytes();
}

/** 0x02 MovementReq — 7 bytes. direction low 3 bits + 0x80 = run. */
export function buildMovementReq(direction, sequence, fastWalkKey = 0) {
  const w = new PacketWriter(7);
  w.writeU8(0x02);
  w.writeU8(direction & 0xff);
  w.writeU8(sequence & 0xff);
  w.writeU32(fastWalkKey >>> 0);
  return w.bytes();
}

/** 0x22 ClientResyncRequest — 3 bytes. */
export function buildResyncRequest() {
  const w = new PacketWriter(3);
  w.writeU8(0x22);
  w.writeU8(0);
  w.writeU8(0);
  return w.bytes();
}

/** 0xB1 DisplayGumpResponse — variable length. Sent when the player presses
 * a button inside a server-driven gump.
 *
 *   u8  op (0xB1)
 *   u16 length
 *   u32 serverSerial
 *   u32 gumpSerial
 *   u32 buttonId
 *   u32 switchCount
 *   switchCount × u32 (switch ids that are checked / radio-selected)
 *   u32 textEntryCount
 *   textEntryCount × { u16 entryId; u16 charCount; UCS-2 BE chars }
 */
export function buildGumpResponse({ serverSerial, gumpSerial, buttonId, switches = [], textEntries = [] }) {
  const w = new PacketWriter(64);
  w.writeU8(0xB1);
  const lp = w.length;
  w.writeU16(0);
  w.writeU32(serverSerial >>> 0);
  w.writeU32(gumpSerial   >>> 0);
  w.writeU32(buttonId     >>> 0);
  w.writeU32(switches.length >>> 0);
  for (const s of switches) w.writeU32(s >>> 0);
  w.writeU32(textEntries.length >>> 0);
  for (const e of textEntries) {
    w.writeU16(e.id & 0xffff);
    const text = String(e.text ?? '');
    w.writeU16(text.length & 0xffff);
    for (let i = 0; i < text.length; i++) w.writeU16(text.charCodeAt(i));
  }
  w.setU16At(lp, w.length);
  return w.bytes();
}

/** 0x06 UseReq — 5 bytes. Server reacts with 0x88 paperdoll, 0x24 container, etc. */
export function buildUseReq(serial) {
  const w = new PacketWriter(5);
  w.writeU8(0x06);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0x07 LiftReq — 7 bytes. Tells the server we picked up `serial` of `amount`. */
export function buildLiftReq(serial, amount) {
  const w = new PacketWriter(7);
  w.writeU8(0x07);
  w.writeU32(serial >>> 0);
  w.writeU16(amount & 0xffff);
  return w.bytes();
}

/** 0x08 DropReq — 15 bytes (post-6.0.1.7 layout: includes gridLocation). */
export function buildDropReq(serial, x, y, z, gridLocation, container) {
  const w = new PacketWriter(15);
  w.writeU8(0x08);
  w.writeU32(serial >>> 0);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  w.writeI8(z);
  w.writeU8(gridLocation & 0xff);
  w.writeU32(container >>> 0);
  return w.bytes();
}

/** 0x08 DropReq old — 14 bytes, pre-6.0.1.7 layout without gridLocation. */
export function buildDropReqOld(serial, x, y, z, container) {
  const w = new PacketWriter(14);
  w.writeU8(0x08);
  w.writeU32(serial >>> 0);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  w.writeI8(z);
  w.writeU32(container >>> 0);
  return w.bytes();
}

/** 0x13 EquipReq — 10 bytes. Equip held item to a layer on a mobile. */
export function buildEquipReq(serial, layer, mobileSerial) {
  const w = new PacketWriter(10);
  w.writeU8(0x13);
  w.writeU32(serial >>> 0);
  w.writeU8(layer & 0xff);
  w.writeU32(mobileSerial >>> 0);
  return w.bytes();
}

/** 0x09 LookReq — 5 bytes. Single click → server name + tooltip. */
export function buildLookReq(serial) {
  const w = new PacketWriter(5);
  w.writeU8(0x09);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0xD6 BatchQueryProperties — variable. Asks server for tooltip text. */
export function buildBatchQueryProperties(serials) {
  const w = new PacketWriter(3 + serials.length * 4);
  w.writeU8(0xD6);
  w.writeU16(3 + serials.length * 4);
  for (const s of serials) w.writeU32(s >>> 0);
  return w.bytes();
}

/** ClassicUO name for the modern 0xD6 object-property request. */
export function buildMegaClilocRequest(serials) {
  return buildBatchQueryProperties(Array.isArray(serials) ? serials : [serials]);
}

/** 0xBF subop 0x10 — old single-object MegaCliloc request fallback. */
export function buildMegaClilocRequestOld(serial) {
  const w = new PacketWriter(9);
  w.writeU8(0xBF);
  w.writeU16(9);
  w.writeU16(0x0010);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0x3F UOLive_HashResponse — UltimaLive map-block checksum response. */
export function buildUOLiveHashResponse(block, mapIndex, checksums = []) {
  const total = 1 + 2 + 4 + 6 + 1 + 1 + checksums.length * 2;
  const w = new PacketWriter(total);
  w.writeU8(0x3F);
  w.writeU16(total);
  w.writeU32(block >>> 0);
  w.writeZero(6);
  w.writeU8(0xFF);
  w.writeU8(mapIndex & 0xff);
  for (const checksum of checksums) w.writeU16(checksum & 0xffff);
  return w.bytes();
}

/** 0x05 AttackReq — 5 bytes. Right-click on mobile in war mode. */
export function buildAttackReq(serial) {
  const w = new PacketWriter(5);
  w.writeU8(0x05);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0x72 RequestWarMode — 5 bytes. */
export function buildWarMode(warMode) {
  const w = new PacketWriter(5);
  w.writeU8(0x72);
  w.writeU8(warMode ? 1 : 0);
  w.writeU8(0); w.writeU8(0x32); w.writeU8(0);
  return w.bytes();
}

/** 0xBF subop 0x15 — context-menu REQUEST (C→S). Server replies with
 *  0xBF subop 0x14 listing the entries available for the target. The
 *  ServUO header is `op + len + sub`; nothing else for the request. */
export function buildPopupMenuRequest(serial) {
  const w = new PacketWriter(9);
  w.writeU8(0xBF);
  w.writeU16(9);
  w.writeU16(0x0015);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0xBF subop 0x16 — context-menu CHOICE (C→S). Sent after the user
 *  picks one of the entries the server delivered via 0xBF 0x14. */
export function buildPopupMenuChoice(serial, responseId) {
  const w = new PacketWriter(11);
  w.writeU8(0xBF);
  w.writeU16(11);
  w.writeU16(0x0016);
  w.writeU32(serial >>> 0);
  w.writeU16(responseId & 0xffff);
  return w.bytes();
}

/** 0x6C TargetResponse — 19 bytes per ServUO `PacketHandlers.cs::TargetResponse`:
 *  opcode(1) + cursorType(1) + cursorId(4) + flag(1) + serial(4) + x(2)
 *  + y(2) + padding(u8 0) + z(i8) + graphic(2).
 *
 *  The earlier build wrote an EXTRA u16 between y and z (`writeU16(0)
 *  + writeI16(z)` = 4 bytes) producing a 21-byte packet — but the
 *  server table marks 0x6C as fixed size 19, so the framer kept only
 *  the first 19 bytes and the trailing 2 bytes leaked into the next
 *  packet's opcode position. After a few cast→target rounds the rx
 *  buffer looked like it was sliced wrong, the framer raised
 *  "Unknown opcode 0xC6 / 0x35", skip-recovered, and eventually the
 *  cast pipeline + walker stalled. Marcin: "rzucilem zaklecie na moga
 *  i przestalem moc rzucac zaklec".
 *
 *  Z is i8 in the wire, prefixed by a u8 padding byte (always 0). */
export function buildTargetResponse({
  cursorType, cursorId, flag = 0,
  serial = 0, x = 0, y = 0, z = 0, graphic = 0,
}) {
  const w = new PacketWriter(19);
  w.writeU8(0x6C);
  w.writeU8(cursorType & 0xff);
  w.writeU32(cursorId >>> 0);
  w.writeU8(flag & 0xff);
  w.writeU32(serial >>> 0);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  // Audit #41 client P1 #4 — ServUO `PacketHandlers.cs:1244` reads z
  // as `ReadInt16()`, not `padding + sbyte`. The earlier "padding +
  // i8" guess was wrong (verified against ServUO source). For z<0
  // (dungeons, second-floor houses) we previously sent 0x00 0xFF →
  // ServUO read +255 not −1. Now sign-extended i16.
  w.writeI16(z | 0);
  w.writeU16(graphic & 0xffff);
  return w.bytes();
}

/** 0x12 TextCommand — variable. Sends `cast`/`hide`/`setlanguage`/etc. */
export function buildTextCommand(type, text) {
  const ascii = String(text ?? '');
  const w = new PacketWriter(4 + ascii.length + 1);
  w.writeU8(0x12);
  w.writeU16(4 + ascii.length + 1);
  w.writeU8(type & 0xff);
  for (let i = 0; i < ascii.length; i++) w.writeU8(ascii.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  return w.bytes();
}

/** 0x12 subtype 0x24 UseSkill. CUO writes the canonical 1-indexed skill
 *  id followed by a zero arg (`"<id> 0"`) without an extra terminator. */
export function buildUseSkill(skillId) {
  const ascii = `${skillId | 0} 0`;
  const w = new PacketWriter(4 + ascii.length);
  w.writeU8(0x12);
  w.writeU16(4 + ascii.length);
  w.writeU8(0x24);
  for (let i = 0; i < ascii.length; i++) w.writeU8(ascii.charCodeAt(i) & 0x7f);
  return w.bytes();
}

/** 0x12 subtype 0x43 OpenSpellBook. `type` is CUO SpellBookType (Magery=0). */
export function buildOpenSpellBook(type = 0) {
  const w = new PacketWriter(5);
  w.writeU8(0x12);
  w.writeU16(5);
  w.writeU8(0x43);
  w.writeU8(type & 0xff);
  return w.bytes();
}

function _extendedCommandFrame(size, subop) {
  const w = new PacketWriter(size);
  w.writeU8(0xBF);
  w.writeU16(size);
  w.writeU16(subop & 0xffff);
  return w;
}

/** 0xBF sub 0x07 — quest arrow click acknowledgement. */
export function buildClickQuestArrow(rightClick = false) {
  const w = _extendedCommandFrame(6, 0x0007);
  w.writeU8(rightClick ? 1 : 0);
  return w.bytes();
}

/** 0xBF sub 0x0C — client closed a dragged-out status/health bar. */
export function buildCloseStatusBarGump(serial) {
  const w = _extendedCommandFrame(9, 0x000C);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0xBF sub 0x1E — request full custom-house design data. */
export function buildCustomHouseDataRequest(serial) {
  const w = _extendedCommandFrame(9, 0x001E);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0x75 RenameRequest — 35 bytes (mob serial + 30B ASCII new name). */
export function buildRenameRequest(serial, newName) {
  const w = new PacketWriter(35);
  w.writeU8(0x75);
  w.writeU32(serial >>> 0);
  w.writeAsciiFixed(newName ?? '', 30);
  return w.bytes();
}

/** 0x95 HuePickerResponse — 9 bytes. */
export function buildHuePickerResponse(serial, itemId, hue) {
  const w = new PacketWriter(9);
  w.writeU8(0x95);
  w.writeU32(serial >>> 0);
  w.writeU16(itemId & 0xffff);
  w.writeU16(hue & 0xffff);
  return w.bytes();
}

/** 0x9A AsciiPromptResponse — variable. Audit #43 client P1 #2 — was
 *  writing `senderSerial(u32) + promptId(u32) + u8 0 + ASCII null`,
 *  but our server (and CUO) reads `... + type(u32) + ASCII`. The u8 0
 *  padding caused the server to eat 3 bytes of the text as part of
 *  `type`. Now writes a full u32 cancel/type flag (0 = OK, 1 = cancel).
 */
export function buildAsciiPromptResponse(senderSerial, promptId, text, cancel = false) {
  const w = new PacketWriter(64);
  w.writeU8(0x9A);
  const lp = w.length;
  w.writeU16(0);
  w.writeU32(senderSerial >>> 0);
  w.writeU32(promptId >>> 0);
  w.writeU32(cancel ? 1 : 0);          // cancel/type flag (was u8 padding)
  w.writeAsciiNull(text ?? '');
  w.setU16At(lp, w.length);
  return w.bytes();
}

/** 0xC2 UnicodePromptResponse — variable. */
export function buildUnicodePromptResponse(senderSerial, promptId, text, lang = 'ENU') {
  const w = new PacketWriter(64 + (text?.length ?? 0) * 2);
  w.writeU8(0xC2);
  const lp = w.length;
  w.writeU16(0);
  w.writeU32(senderSerial >>> 0);
  w.writeU32(promptId >>> 0);
  w.writeU32(0);
  for (let i = 0; i < 4; i++) w.writeU8(i < lang.length ? lang.charCodeAt(i) : 0);
  w.writeUnicodeNull(text ?? '');
  w.setU16At(lp, w.length);
  return w.bytes();
}

/** 0x3A ChangeSkillLock — 6 bytes. lockState: 0=up, 1=down, 2=lock. */
export function buildChangeSkillLock(skillId, lockState) {
  const w = new PacketWriter(6);
  w.writeU8(0x3A);
  w.writeU16(6);
  w.writeU16(skillId & 0xffff);
  w.writeU8(lockState & 0xff);
  return w.bytes();
}

/** 0xB6 ObjectHelpRequest — 9 bytes. */
export function buildObjectHelpRequest(serial) {
  const w = new PacketWriter(9);
  w.writeU8(0xB6);
  w.writeU32(serial >>> 0);
  w.writeU16(0);
  w.writeU16(0);
  return w.bytes();
}

/** 0x6F SecureTrade — 17 bytes (basic update). Per CUO `Send_SecureTrade`:
 *  op(1) + size(2)=17 + action(1) + serial(4) + serial2(4) + accept(1) + pad(4).
 *  Prior version wrote 18 bytes (extra trailing u8) → server framer drift. */
export function buildSecureTrade({ action, serial, accept = false }) {
  const w = new PacketWriter(17);
  w.writeU8(0x6F);
  w.writeU16(17);
  w.writeU8(action & 0xff);
  w.writeU32(serial >>> 0);
  w.writeU32(0);
  w.writeU32(accept ? 1 : 0);
  w.writeU8(0);
  return w.bytes();
}

/** 0xEC EquipMacro — variable. Audit #37 P1 #2 — CUO
 *  `Network/OutgoingPackets.cs:4444 Send_EquipMacroKR` writes
 *  `u8 count + count × u32 serial`. The legacy `u8 layer` per entry
 *  was bogus — server-side ServUO reads only the serial (the layer is
 *  resolved from the equipped item's tiledata). The extra byte
 *  desynced every Razor/KR-era macro replay. */
export function buildEquipMacro(items) {
  const len = 4 + items.length * 4;
  const w = new PacketWriter(len);
  w.writeU8(0xEC);
  w.writeU16(len);
  w.writeU8(items.length & 0xff);
  for (const it of items) {
    w.writeU32(it.serial >>> 0);
  }
  return w.bytes();
}

/** 0xED UnequipMacro — variable. */
export function buildUnequipMacro(layers) {
  const w = new PacketWriter(4 + layers.length * 2);
  w.writeU8(0xED);
  w.writeU16(4 + layers.length * 2);
  w.writeU8(layers.length & 0xff);
  for (const l of layers) w.writeU16(l & 0xffff);
  return w.bytes();
}

/** 0x34 StatusRequest — 10 bytes. Asks the server for full status of `serial`.
 *  kind: 4 = status (HP/mana/stam/stats), 5 = skills list. CUO sends this
 *  when the player double-clicks the status-button on a paperdoll. */
export function buildStatusRequest(serial, kind = 4) {
  const w = new PacketWriter(10);
  w.writeU8(0x34);
  w.writeU32(0xEDEDEDED >>> 0); // pattern (CUO uses this magic)
  w.writeU8(kind & 0xff);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0x3B BuyRequest — variable. Sent after the player picks items from a
 *  vendor's buy window. Layout (CUO Send_BuyRequest):
 *    1B op + 2B len + 4B vendorSerial + 1B itemCount
 *    + count × { 1B layer(=0x1A) + 4B itemSerial + 2B amount }
 *  Last byte 0x00 = "no purchase" (cancel). */
export function buildBuyRequest(vendorSerial, picks) {
  if (!picks || picks.length === 0) {
    const w = new PacketWriter(8);
    w.writeU8(0x3B); w.writeU16(8);
    w.writeU32(vendorSerial >>> 0);
    w.writeU8(0x00);
    return w.bytes();
  }
  const total = 1 + 2 + 4 + 1 + picks.length * 7;
  const w = new PacketWriter(total);
  w.writeU8(0x3B); w.writeU16(total);
  w.writeU32(vendorSerial >>> 0);
  w.writeU8(0x02); // 0x02 = "I will buy" flag
  for (const p of picks) {
    w.writeU8(0x1A);
    w.writeU32(p.serial >>> 0);
    w.writeU16(p.amount & 0xffff);
  }
  return w.bytes();
}

/** 0x9F SellRequest — variable. Sent after the player ticks items in a
 *  vendor's sell window. Layout:
 *    1B op + 2B len + 4B vendorSerial + 2B itemCount
 *    + count × { 4B itemSerial + 2B amount } */
export function buildSellRequest(vendorSerial, picks) {
  const total = 1 + 2 + 4 + 2 + picks.length * 6;
  const w = new PacketWriter(total);
  w.writeU8(0x9F); w.writeU16(total);
  w.writeU32(vendorSerial >>> 0);
  w.writeU16(picks.length & 0xffff);
  for (const p of picks) {
    w.writeU32(p.serial >>> 0);
    w.writeU16(p.amount & 0xffff);
  }
  return w.bytes();
}

/** 0xD1 LogoutNotification — 2 bytes. Tells the server we WANT to log out.
 *  Server replies with 0xD1 0x01 (allowed) or 0xD1 0x00 (still in combat). */
export function buildLogoutRequest() {
  const w = new PacketWriter(2);
  w.writeU8(0xD1);
  w.writeU8(0x01);
  return w.bytes();
}

/** 0x05 AttackReq is already defined above. This sister builder asks the
 *  server to forget the current attack target — CUO sends 0x05 with serial
 *  0 to clear focus when the player presses Esc in combat. */
export function buildClearAttack() {
  return buildAttackReq(0);
}

/** 0x66 BookPageData — variable. Submits an edited page back to the server.
 *  Layout:
 *    1B op + 2B len + 4B bookSerial + 2B pageCount(=1)
 *    + 2B pageNum + 2B lineCount + lineCount × ASCII-null lines */
export function buildBookPage(bookSerial, pageNum, lines) {
  // Pre-size: header 11B + each line ASCII+null.
  let total = 11;
  for (const l of lines) total += String(l ?? '').length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0x66); w.writeU16(total);
  w.writeU32(bookSerial >>> 0);
  w.writeU16(0x0001);              // pages-in-this-packet
  w.writeU16(pageNum & 0xffff);
  w.writeU16(lines.length & 0xffff);
  for (const l of lines) w.writeAsciiNull(String(l ?? ''));
  return w.bytes();
}

/** 0xD4 BookHeaderChanged — variable, UTF-8 title/author lengths in bytes. */
export function buildBookHeader(bookSerial, title, author, pageCount = 0) {
  const titleBytes = utf8Bytes(title);
  const authorBytes = utf8Bytes(author);
  const total = 1 + 2 + 4 + 2 + 2 + 2 + titleBytes.length + 2 + authorBytes.length;
  const w = new PacketWriter(total);
  w.writeU8(0xD4); w.writeU16(total);
  w.writeU32(bookSerial >>> 0);
  w.writeU8(0); w.writeU8(0);            // unknown
  w.writeU16(pageCount & 0xffff);
  w.writeU16(titleBytes.length & 0xffff);
  w.writeBytes(titleBytes);
  w.writeU16(authorBytes.length & 0xffff);
  w.writeBytes(authorBytes);
  return w.bytes();
}

/** 0x93 BookHeaderChanged old — fixed 99-byte legacy title/author update. */
export function buildBookHeaderOld(bookSerial, title, author) {
  const w = new PacketWriter(99);
  w.writeU8(0x93);
  w.writeU32(bookSerial >>> 0);
  w.writeU8(0);
  w.writeU8(1);
  w.writeU16(0);
  writeUtf8Fixed(w, title, 60);
  writeUtf8Fixed(w, author, 30);
  return w.bytes();
}

/** 0x98 NameRequest — 9 bytes. CUO uses this for "all-names" macro and
 *  hover labels on followers; server replies with the name in 0x98. */
export function buildNameRequest(serial) {
  const w = new PacketWriter(9);
  w.writeU8(0x98); w.writeU16(9);
  w.writeU32(serial >>> 0);
  // 30 bytes of zeroed name buffer.
  for (let i = 0; i < 2; i++) w.writeU8(0);
  return w.bytes();
}

/** 0xC8 ClientViewRange — 2 bytes. Sets the server-side update range
 *  (number of tiles around the player the server broadcasts updates for).
 *  Range 5..18; 18 is the canonical default. */
export function buildClientViewRange(range = 18) {
  const w = new PacketWriter(2);
  w.writeU8(0xC8);
  w.writeU8(Math.max(5, Math.min(18, range | 0)));
  return w.bytes();
}

/** 0x38 PathfindingRequest — 7 bytes. Asks the server to walk us to
 *  (x, y, z). ServUO responds by streaming a sequence of 0x97 ForceWalk
 *  packets along the path. Client falls back to local A* when the server
 *  does not implement pathfinding (our server currently doesn't). */
export function buildPathfindingRequest(x, y, z) {
  const w = new PacketWriter(7);
  w.writeU8(0x38);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  w.writeI16(z);
  return w.bytes();
}

/** 0xAC TextEntryDialogResponse — variable. Reply to a server text-entry
 *  prompt (0xAB).
 *  Layout:
 *    1B op + 2B len + 4B serial + 1B parentId + 1B buttonId
 *    + 1B response(0=cancel,1=ok) + 2B textLen + ASCII text + null */
export function buildTextEntryResponse({ serial, parentId, buttonId, ok, text = '' }) {
  const ascii = String(text ?? '');
  const total = 1 + 2 + 4 + 1 + 1 + 1 + 2 + ascii.length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0xAC); w.writeU16(total);
  w.writeU32(serial >>> 0);
  w.writeU8(parentId & 0xff);
  w.writeU8(buttonId & 0xff);
  w.writeU8(ok ? 1 : 0);
  // Audit #39 client P1 #1 — CUO `OutgoingPackets.cs:1574` writes
  // `text.Length + 1` (counts the null). ServUO + Razor read this many
  // bytes; sending raw length leaves the null in the stream and the
  // next packet's first byte is consumed as 0.
  w.writeU16((ascii.length + 1) & 0xffff);
  w.writeAsciiNull(ascii);
  return w.bytes();
}

/** 0x03 ASCIISpeech (legacy). CUO uses this to ACK the server's
 *  "system" speech ping (0x1C with hue=0xFFFF). Without the ack, ServUO
 *  may rate-limit or disconnect. Layout:
 *    1B op + 2B len + 1B mode + 2B hue + 2B font + ASCII null text  */
export function buildAsciiSpeechAck(text = '', { mode = 0, hue = 0, font = 3 } = {}) {
  const ascii = String(text ?? '');
  const total = 1 + 2 + 1 + 2 + 2 + ascii.length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0x03);
  w.writeU16(total);
  w.writeU8(mode & 0xff);
  w.writeU16(hue & 0xffff);
  w.writeU16(font & 0xffff);
  for (let i = 0; i < ascii.length; i++) w.writeU8(ascii.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  return w.bytes();
}

/** 0x83 DeleteCharacter — 39 bytes.
 *  Layout: 1B op + 30B password + 4B charSlot + 4B clientIP. */
export function buildDeleteCharacter(slot, password = '') {
  const w = new PacketWriter(39);
  w.writeU8(0x83);
  w.writeAsciiFixed(password ?? '', 30);
  w.writeU32(slot >>> 0);
  w.writeU32(0x0000007F);
  return w.bytes();
}

/** 0x7D MenuResponse — variable. Reply to server 0x7C OpenMenu.
 *  Layout: 1B op + 2B len + 4B dialogId + 2B menuId + 2B itemIndex
 *          + 2B itemGfx + 2B itemHue. itemIndex=0 = cancel. */
export function buildMenuResponse(dialogId, menuId, itemIndex, itemGfx = 0, itemHue = 0) {
  // 0x7D is a FIXED-size 13-byte packet (no u16 size header). Prior
  // version wrote a bogus `writeU16(13)` right after the opcode, which
  // (a) corrupted dialogId on the server side, and (b) pushed the wire
  // length to 15 bytes — the trailing 2 bytes leaked into the next
  // packet's opcode position → framer drift.
  const w = new PacketWriter(13);
  w.writeU8(0x7D);
  w.writeU32(dialogId >>> 0);
  w.writeU16(menuId & 0xffff);
  w.writeU16(itemIndex & 0xffff);
  w.writeU16(itemGfx & 0xffff);
  w.writeU16(itemHue & 0xffff);
  return w.bytes();
}

/** 0xBF subop 0x06 — PartyCommand. Wraps the various sub-sub commands:
 *    0x01 add(serial)        — invite by serial (0 = open prompt)
 *    0x02 remove(serial)     — kick member (0 = self leave)
 *    0x03 messageTo(serial,t)— PM single member
 *    0x04 message(text)      — party-only chat
 *    0x06 (canLoot 0/1)      — toggle "party can loot my corpse"
 *    0x08 acceptInvite       — accept pending invite
 *    0x09 declineInvite      — decline pending invite */
export function buildPartyCommand(sub, payload = new Uint8Array()) {
  const total = 1 + 2 + 2 + 1 + payload.length;
  const w = new PacketWriter(total);
  w.writeU8(0xBF); w.writeU16(total);
  w.writeU16(0x0006);
  w.writeU8(sub & 0xff);
  for (let i = 0; i < payload.length; i++) w.writeU8(payload[i]);
  return w.bytes();
}

export function buildPartyAdd(serial = 0) {
  const p = new Uint8Array(4);
  p[0] = (serial >>> 24) & 0xff; p[1] = (serial >>> 16) & 0xff;
  p[2] = (serial >>> 8) & 0xff;  p[3] = serial & 0xff;
  return buildPartyCommand(0x01, p);
}
export function buildPartyRemove(serial = 0) {
  const p = new Uint8Array(4);
  p[0] = (serial >>> 24) & 0xff; p[1] = (serial >>> 16) & 0xff;
  p[2] = (serial >>> 8) & 0xff;  p[3] = serial & 0xff;
  return buildPartyCommand(0x02, p);
}
export function buildPartyMessage(text) {
  const u = String(text ?? '');
  const p = new Uint8Array((u.length + 1) * 2);
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    p[i * 2]     = (c >> 8) & 0xff;
    p[i * 2 + 1] = c & 0xff;
  }
  return buildPartyCommand(0x04, p);
}
export function buildPartyMessageTo(serial, text) {
  const u = String(text ?? '');
  const p = new Uint8Array(4 + (u.length + 1) * 2);
  p[0] = (serial >>> 24) & 0xff; p[1] = (serial >>> 16) & 0xff;
  p[2] = (serial >>> 8) & 0xff;  p[3] = serial & 0xff;
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    p[4 + i * 2]     = (c >> 8) & 0xff;
    p[4 + i * 2 + 1] = c & 0xff;
  }
  return buildPartyCommand(0x03, p);
}
export function buildPartyAccept(leaderSerial) {
  const p = new Uint8Array(4);
  p[0] = (leaderSerial >>> 24) & 0xff; p[1] = (leaderSerial >>> 16) & 0xff;
  p[2] = (leaderSerial >>> 8) & 0xff;  p[3] = leaderSerial & 0xff;
  return buildPartyCommand(0x08, p);
}
export function buildPartyDecline(leaderSerial) {
  const p = new Uint8Array(4);
  p[0] = (leaderSerial >>> 24) & 0xff; p[1] = (leaderSerial >>> 16) & 0xff;
  p[2] = (leaderSerial >>> 8) & 0xff;  p[3] = leaderSerial & 0xff;
  return buildPartyCommand(0x09, p);
}
export function buildPartyCanLoot(allow) {
  const p = new Uint8Array(1); p[0] = allow ? 0x01 : 0x00;
  return buildPartyCommand(0x06, p);
}

/** 0xBF subop 0x1A — StatLockStateRequest. statId 0=str,1=dex,2=int.
 *  lockState 0=up, 1=down, 2=lock. */
export function buildStatLockRequest(statId, lockState) {
  const w = new PacketWriter(7);
  w.writeU8(0xBF); w.writeU16(7);
  w.writeU16(0x001A);
  w.writeU8(statId & 0xff);
  w.writeU8(lockState & 0xff);
  return w.bytes();
}

/** 0xB8 ProfileUpdate (write). Layout:
 *    1B op + 2B len + 4B serial + 1B(=1, write) + 2B unk + 2B titleLen + title
 *    + 2B bodyLen + UCS-2 BE body */
export function buildProfileUpdate(serial, body) {
  const u = String(body ?? '');
  const total = 1 + 2 + 4 + 1 + 2 + 2 + 2 + u.length * 2;
  const w = new PacketWriter(total);
  w.writeU8(0xB8); w.writeU16(total);
  w.writeU32(serial >>> 0);
  w.writeU8(0x01);
  w.writeU16(0);                  // padding/unknown
  w.writeU16(0);                  // titleLen (we don't change title)
  w.writeU16(u.length & 0xffff);
  for (let i = 0; i < u.length; i++) w.writeU16(u.charCodeAt(i));
  return w.bytes();
}

/** 0xB8 ProfileRequest (read). 1B + 4B serial + 1B(=0). */
export function buildProfileRequest(serial) {
  const w = new PacketWriter(8);
  w.writeU8(0xB8); w.writeU16(8);
  w.writeU32(serial >>> 0);
  w.writeU8(0x00);
  return w.bytes();
}

/** Audit #35 F3 — 0xD7 sub-cmd 0x32 QuestMenuRequest. CUO
 *  `GameActions.RequestQuestMenu` → `Send_QuestMenuRequest(world)`.
 *  Packet shape: op + u16 len + u32 serial + u16 sub(=0x32) + u8(=0). */
export function buildQuestMenuRequest(playerSerial) {
  const w = new PacketWriter(10);
  w.writeU8(0xD7); w.writeU16(10);
  w.writeU32(playerSerial >>> 0);
  w.writeU16(0x0032);
  w.writeU8(0);
  return w.bytes();
}

/** 0x71 BulletinBoard write/post/remove sub-ops. */
export function buildBBSPostMessage(boardSerial, parentSerial, subject, body) {
  // Audit #46 P2 — CUO `OutgoingPackets.cs:2380, 2395` writes
  // `length + 1` for subject and per-line length bytes so the trailing
  // 0x00 null terminator is counted. We previously wrote raw .length →
  // server-side reader truncated by one character and shifted the
  // next length-prefixed slot.
  const subj = String(subject ?? '');
  const lines = String(body ?? '').split('\n');
  let bodyLen = 1; // line count byte
  for (const l of lines) bodyLen += 1 + l.length + 1; // +1 for null
  const total = 1 + 2 + 1 + 4 + 4 + 1 + (subj.length + 1) + bodyLen;
  const w = new PacketWriter(total);
  w.writeU8(0x71); w.writeU16(total);
  w.writeU8(0x05);
  w.writeU32(boardSerial >>> 0);
  w.writeU32(parentSerial >>> 0);
  w.writeU8((subj.length + 1) & 0xff);
  for (let i = 0; i < subj.length; i++) w.writeU8(subj.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  w.writeU8(lines.length & 0xff);
  for (const l of lines) {
    w.writeU8((l.length + 1) & 0xff);
    for (let i = 0; i < l.length; i++) w.writeU8(l.charCodeAt(i) & 0x7f);
    w.writeU8(0);
  }
  return w.bytes();
}
export function buildBBSRemoveMessage(boardSerial, postSerial) {
  // op(1) + size(2) + sub(1) + boardSerial(4) + postSerial(4) = 12 bytes.
  // Prior version declared 11 in header while writing 12 → framer drift.
  const w = new PacketWriter(12);
  w.writeU8(0x71); w.writeU16(12);
  w.writeU8(0x06);
  w.writeU32(boardSerial >>> 0);
  w.writeU32(postSerial >>> 0);
  return w.bytes();
}
export function buildBBSRequestPost(boardSerial, postSerial, contentBody = false) {
  const w = new PacketWriter(12);
  w.writeU8(0x71); w.writeU16(12);
  w.writeU8(contentBody ? 0x03 : 0x04);   // 0x03 = body, 0x04 = thread props
  w.writeU32(boardSerial >>> 0);
  w.writeU32(postSerial >>> 0);
  return w.bytes();
}

/** 0xBF subop 0x05 — Send_GameWindowSize (browser viewport advertise). */
export function buildGameWindowSize(width, height) {
  const w = new PacketWriter(13);
  w.writeU8(0xBF); w.writeU16(13);
  w.writeU16(0x0005);
  w.writeU32((width  | 0) >>> 0);
  w.writeU32((height | 0) >>> 0);
  return w.bytes();
}

/** 0xBF subop 0x0B — Language. 3-char lang code + null terminator.
 *  Audit #37 P1 #1 — declared length was 8 but the writer pushed 9
 *  bytes (op + u16 len + u16 sub + 4 chars). The off-by-one mis-
 *  framed every following packet on the stream after LoginComplete.
 *  Canonical: op(1) + len(2)=9 + sub(2) + char(3) + null(1) = 9. */
export function buildLanguageHello(lang = 'ENU') {
  const w = new PacketWriter(9);
  w.writeU8(0xBF); w.writeU16(9);
  w.writeU16(0x000B);
  for (let i = 0; i < 4; i++) w.writeU8(i < lang.length ? lang.charCodeAt(i) : 0);
  return w.bytes();
}

/** 0xBF subop 0x0F — ClientType. Audit #39 client P2 #7 — CUO sends
 *  this right after LoginComplete so ServUO `Account.GameClientType`
 *  picks the right feature flags (KR/SA paperdoll layer count, SA-only
 *  artifacts). Layout: op(1) + len(2)=9 + sub(2)=0x000F + clientFlag(4).
 *  ClassicUO transmits `0x000000FF` which marks us as full-AOS UO:KR. */
// Audit #41 client P2 #19 — default flag was `0x000000FF` (a junk
// mask). CUO `Send_ClientType` writes `0` for unknown / `0x100` (KR)
// / `0x200` (SA). Hardcoding 0xFF made ServUO classify us as legacy
// KR and skip SA-era artifact/paperdoll-layer broadcasts.
export function buildClientType(flag = 0) {
  const w = new PacketWriter(9);
  w.writeU8(0xBF); w.writeU16(9);
  w.writeU16(0x000F);
  w.writeU32(flag >>> 0);
  return w.bytes();
}

/** 0x34 SkillsRequest. Audit #39 client P2 #7 — pulls the full skill
 *  table (mode 0x05) after login so the Skills gump opens populated
 *  immediately instead of after the first 0x3A scroll-in.
 *  Layout: op(1) + magic(4)=0xEDEDEDED + mode(1) + serial(4). */
export function buildSkillsRequest(serial) {
  const w = new PacketWriter(10);
  w.writeU8(0x34);
  w.writeU32(0xEDEDEDED);
  w.writeU8(0x05);
  w.writeU32(serial >>> 0);
  return w.bytes();
}

/** 0xBF subop 0x24 — Invoke virtue. 1=Honor 2=Sacrifice 3=Valor 4=Compassion. */
export function buildInvokeVirtue(virtueId) {
  const w = new PacketWriter(6);
  w.writeU8(0xBF); w.writeU16(6);
  w.writeU16(0x0024);
  w.writeU8(virtueId & 0xff);
  return w.bytes();
}

/** Audit #42 client P2 #16 — 0xBF subop 0x09 StunRequest. ServUO
 *  expects this for the legacy Bushido stun special-move ack. */
export function buildStunRequest() {
  const w = new PacketWriter(5);
  w.writeU8(0xBF); w.writeU16(5);
  w.writeU16(0x0009);
  return w.bytes();
}

/** 0xBF subop 0x0A DisarmRequest. Legacy disarm special-move ack. */
export function buildDisarmRequest() {
  const w = new PacketWriter(5);
  w.writeU8(0xBF); w.writeU16(5);
  w.writeU16(0x000A);
  return w.bytes();
}

/** 0xBF subop 0x32 ToggleGargoyleFlying. Gargoyle-race flight toggle.
 *  op(1) + size(2) + sub(2) + reserved(4) = 9 bytes total. */
export function buildToggleGargoyleFlying() {
  const w = new PacketWriter(9);
  w.writeU8(0xBF); w.writeU16(9);
  w.writeU16(0x0032);
  w.writeU32(0);   // reserved
  return w.bytes();
}

/** 0x8B UltimaMessenger (mail send). Variable. Layout:
 *    1B op + 2B len + 4B recipientSerial + ascii subject + 0 + ascii body + 0
 *  ServUO's UltimaMessenger module accepts this; most modern shards
 *  ignore it (BBS via 0x71 is preferred). Provided so the audit gap
 *  ("no mail-send builder") is closed and any future inbox gump can
 *  hand off via this single builder. */
export function buildMailSend({ recipient, subject = '', body = '' }) {
  const subj = String(subject ?? '');
  const txt  = String(body ?? '');
  const total = 1 + 2 + 4 + subj.length + 1 + txt.length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0x8B); w.writeU16(total);
  w.writeU32((recipient >>> 0) & 0xffffffff);
  for (let i = 0; i < subj.length; i++) w.writeU8(subj.charCodeAt(i) & 0xff);
  w.writeU8(0);
  for (let i = 0; i < txt.length; i++) w.writeU8(txt.charCodeAt(i) & 0xff);
  w.writeU8(0);
  return w.bytes();
}

/** 0x2C DeathStatusResponse (legacy 2B). 0x02 = manifest as ghost. */
export function buildDeathStatusResponse(action = 0x02) {
  const w = new PacketWriter(2);
  w.writeU8(0x2C);
  w.writeU8(action & 0xff);
  return w.bytes();
}

/** 0xAD UnicodeSpeech — variable length. type 0x00 = normal, 0x09 = command. */
export function buildUnicodeSpeech(text, { type = 0x00, hue = 0x03B2, font = 3, lang = 'ENU' } = {}) {
  const w = new PacketWriter(64 + text.length * 2);
  w.writeU8(0xAD);
  const lenPos = w.length;
  w.writeU16(0);            // patched below
  w.writeU8(type & 0xff);
  w.writeU16(hue & 0xffff);
  w.writeU16(font & 0xffff);
  // language code: 4 ASCII bytes (terminating null included).
  for (let i = 0; i < 4; i++) w.writeU8(i < lang.length ? lang.charCodeAt(i) : 0);
  // No keywords, so write null word and Unicode body.
  w.writeUnicodeNull(text ?? '');
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

// ============================================================================
// Custom-house outgoing builders. CUO `OutgoingPackets.cs:3807-4313`.
// All are 0xD7 (GenericAOSCommand). Layout:
//   op + len(u16) + playerSerial(u32) + sub(u16) + payload + 0x0A.
// Payload u32 fields are prefixed with a 0x00 separator, matching CUO and
// the server-side parser in `handleHouseCustomization`.
// ============================================================================

function _customHouseFrame(size, serial, sub) {
  const w = new PacketWriter(size);
  w.writeU8(0xD7);
  w.writeU16(size);
  w.writeU32(serial >>> 0);
  w.writeU16(sub & 0xffff);
  return w;
}

/** 0xD7 sub 0x02 — request server-side house backup snapshot. */
export function buildCustomHouseBackup(houseSerial) {
  const w = _customHouseFrame(10, houseSerial, 0x02);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x03 — restore previous backup. */
export function buildCustomHouseRestore(houseSerial) {
  const w = _customHouseFrame(10, houseSerial, 0x03);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x04 — commit current edit. */
export function buildCustomHouseCommit(houseSerial) {
  const w = _customHouseFrame(10, houseSerial, 0x04);
  w.writeU8(0x0A);
  return w.bytes();
}
function _writeSepU32(w, value) {
  w.writeU8(0x00);
  w.writeU32(value >>> 0);
}

function _writeSepI32(w, value) {
  w.writeU8(0x00);
  w.writeI32(value | 0);
}

/** 0xD7 sub 0x05 — destroy item at (x,y,z). */
export function buildCustomHouseDeleteItem(playerSerial, graphic, x, y, z) {
  const w = _customHouseFrame(30, playerSerial, 0x05);
  _writeSepU32(w, graphic);
  _writeSepU32(w, x);
  _writeSepU32(w, y);
  _writeSepI32(w, z);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x06 — place tile at (x,y). */
export function buildCustomHouseAddItem(playerSerial, graphic, x, y) {
  const w = _customHouseFrame(25, playerSerial, 0x06);
  _writeSepU32(w, graphic);
  _writeSepU32(w, x);
  _writeSepU32(w, y);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x0C — exit customization without committing. */
export function buildCustomHouseBuildingExit(playerSerial) {
  const w = _customHouseFrame(10, playerSerial, 0x0C);
  w.writeU8(0x0A);
  return w.bytes();
}

/** Back-compat alias: older code called this "SelectFloor"; CUO uses
 *  sub 0x12 for the actual floor switch. */
export function buildCustomHouseSelectFloor(playerSerial, floor) {
  return buildCustomHouseGoToFloor(playerSerial, floor);
}

/** 0xD7 sub 0x0E — sync request (re-fetch house state). */
export function buildCustomHouseSync(playerSerial) {
  const w = _customHouseFrame(10, playerSerial, 0x0E);
  w.writeU8(0x0A);
  return w.bytes();
}

/** 0xD7 sub 0x10 — clear all on current floor/edit buffer. */
export function buildCustomHouseClear(playerSerial) {
  const w = _customHouseFrame(10, playerSerial, 0x10);
  w.writeU8(0x0A);
  return w.bytes();
}

/** 0xD7 sub 0x12 — switch visible editing floor. */
export function buildCustomHouseGoToFloor(playerSerial, floor) {
  const w = _customHouseFrame(15, playerSerial, 0x12);
  w.writeU32(0);
  w.writeU8(floor & 0xff);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x13 — add roof piece at (x,y,z). */
export function buildCustomHouseAddRoof(playerSerial, graphic, x, y, z) {
  const w = _customHouseFrame(30, playerSerial, 0x13);
  _writeSepU32(w, graphic);
  _writeSepU32(w, x);
  _writeSepU32(w, y);
  _writeSepI32(w, z);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x14 — delete roof piece at (x,y,z). */
export function buildCustomHouseDeleteRoof(playerSerial, graphic, x, y, z) {
  const w = _customHouseFrame(30, playerSerial, 0x14);
  _writeSepU32(w, graphic);
  _writeSepU32(w, x);
  _writeSepU32(w, y);
  _writeSepI32(w, z);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x0D — add stair piece. */
export function buildCustomHouseAddStair(playerSerial, graphic, x, y) {
  const w = _customHouseFrame(25, playerSerial, 0x0D);
  _writeSepU32(w, graphic);
  _writeSepU32(w, x);
  _writeSepU32(w, y);
  w.writeU8(0x0A);
  return w.bytes();
}
/** 0xD7 sub 0x1A — revert edits to last commit. */
export function buildCustomHouseRevert(playerSerial) {
  const w = _customHouseFrame(10, playerSerial, 0x1A);
  w.writeU8(0x0A);
  return w.bytes();
}

/** 0xD7 sub 0x0A — client response/ack during house customization. */
export function buildCustomHouseResponse(playerSerial) {
  const w = _customHouseFrame(10, playerSerial, 0x0A);
  w.writeU8(0x0A);
  return w.bytes();
}

// ============================================================================
// Audit #46 P1 #8 — buildTradeUpdateGold (0x6F sub 0x03/0x04 — gold/plat).
// CUO `OutgoingPackets.cs:1482` Send_TradeUpdateGold.
// ============================================================================
/** 0x6F sub 0x03 — update gold offered in current trade.
 *  op(1) + size(2) + sub(1) + tradeSerial(4) + gold(4) + plat(4) + pad(1) = 17.
 *  Prior version used `writeU16` for the trailer (18 bytes wire) → framer drift. */
export function buildTradeUpdateGold(tradeSerial, gold, platinum = 0) {
  const w = new PacketWriter(17);
  w.writeU8(0x6F);
  w.writeU16(17);
  w.writeU8(0x03);                    // sub = update gold
  w.writeU32(tradeSerial >>> 0);
  w.writeU32(gold >>> 0);
  w.writeU32(platinum >>> 0);
  w.writeU8(0);                       // unused trailer pad
  return w.bytes();
}

// ============================================================================
// Audit #46 P1 #9 — buildBookPageDataRequest (0x66).
// CUO `OutgoingPackets.cs:3339` Send_BookPageDataRequest. Was missing →
// multi-page books only ever rendered page 1.
// Layout: op(1) + len(u16) + bookSerial(u32) + pageCount(u16) +
//         per-page (pageNum(u16) + 0xFFFF lineCount sentinel = "fetch")
// ============================================================================
export function buildBookPageDataRequest(bookSerial, pageNum) {
  const w = new PacketWriter(13);
  w.writeU8(0x66);
  w.writeU16(13);
  w.writeU32(bookSerial >>> 0);
  w.writeU16(1);                      // pageCount = 1
  w.writeU16((pageNum | 0) & 0xffff);
  w.writeU16(0xFFFF);                 // 0xFFFF = client requests page data
  return w.bytes();
}

// ============================================================================
// Audit #46 P1 #10 — buildChangeRaceResponse (0xBF sub 0x2B reply).
// CUO `OutgoingPackets.cs:3659`. After server prompt 0xBF 0x2A the client
// sends 0xBF 0x2B with race(u8) + sex(u8) + answer(u8). answer=0 cancel,
// 1 confirm.
//
// Audit rev.9 P2 #1 — extended payload to match the CUO RaceChangeGump
// flow: when `appearance` is non-null we additionally write skinHue(u16),
// hair itemId(u16) + hue(u16), beard/horns itemId(u16) + hue(u16). The
// server reader is forward-compatible (reads only what's present).
// ============================================================================
export function buildChangeRaceResponse(race, sex, confirm = true, appearance = null) {
  const extended = !!appearance && confirm;
  const len = 8 + (extended ? 10 : 0);
  const w = new PacketWriter(len);
  w.writeU8(0xBF);
  w.writeU16(len);
  w.writeU16(0x002B);
  w.writeU8(race & 0xff);
  w.writeU8(sex  & 0xff);
  w.writeU8(confirm ? 1 : 0);
  if (extended) {
    w.writeU16((appearance.skinHue ?? 0) & 0xFFFF);
    w.writeU16((appearance.hairId  ?? 0) & 0xFFFF);
    w.writeU16((appearance.hairHue ?? 0) & 0xFFFF);
    w.writeU16((appearance.beardId ?? 0) & 0xFFFF);
    w.writeU16((appearance.beardHue ?? 0) & 0xFFFF);
  }
  return w.bytes();
}

// ============================================================================
// Audit #46 P2 — Chat conference outgoing builders (0xB3 family).
// CUO `OutgoingPackets.cs:2694-2880`. Each command shares the 0xB3 op
// + len(u16) + cmd(u16) + Unicode payload(s) layout.
// ============================================================================
function _chatHeader(cmd, w) {
  w.writeU8(0xB3);
  w.writeU16(0);            // patched
  w.writeU16(cmd & 0xffff);
}

function _writeUStr(w, s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w.writeU8((c >> 8) & 0xff);
    w.writeU8(c & 0xff);
  }
  w.writeU16(0);            // null terminator
}

/** 0xB3 cmd 0x55 — open chat / set chat handle. */
export function buildChatOpen(name = '') {
  const s = String(name);
  const total = 5 + s.length * 2 + 2;
  const w = new PacketWriter(total);
  _chatHeader(0x0055, w);
  _writeUStr(w, s);
  w.setU16At(1, total);
  return w.bytes();
}
/** 0xB3 cmd 0x58 — create conference. */
export function buildChatCreateConf(name = '', password = '') {
  const total = 5 + (name.length + password.length) * 2 + 4;
  const w = new PacketWriter(total);
  _chatHeader(0x0058, w);
  _writeUStr(w, name);
  _writeUStr(w, password);
  w.setU16At(1, total);
  return w.bytes();
}
/** 0xB3 cmd 0x59 — join conference. */
export function buildChatJoinConf(name = '', password = '') {
  const total = 5 + (name.length + password.length) * 2 + 4;
  const w = new PacketWriter(total);
  _chatHeader(0x0059, w);
  _writeUStr(w, name);
  _writeUStr(w, password);
  w.setU16At(1, total);
  return w.bytes();
}
/** 0xB3 cmd 0x43 — leave current conference. */
export function buildChatLeaveConf() {
  const w = new PacketWriter(5);
  _chatHeader(0x0043, w);
  w.setU16At(1, 5);
  return w.bytes();
}
/** 0xB3 cmd 0x61 — say a message in the current conference. */
export function buildChatMessage(text = '') {
  const total = 5 + text.length * 2 + 2;
  const w = new PacketWriter(total);
  _chatHeader(0x0061, w);
  _writeUStr(w, text);
  w.setU16At(1, total);
  return w.bytes();
}
/** 0xB3 cmd 0x62 — private msg to another chat user. */
export function buildChatPrivate(target, text) {
  const total = 5 + (target.length + text.length) * 2 + 4;
  const w = new PacketWriter(total);
  _chatHeader(0x0062, w);
  _writeUStr(w, target);
  _writeUStr(w, text);
  w.setU16At(1, total);
  return w.bytes();
}
/** 0xB3 cmd 0x65 — emote in current conference. */
export function buildChatEmote(text = '') {
  const total = 5 + text.length * 2 + 2;
  const w = new PacketWriter(total);
  _chatHeader(0x0065, w);
  _writeUStr(w, text);
  w.setU16At(1, total);
  return w.bytes();
}

// ============================================================================
// Audit #46 P2 — Misc outgoing builders.
// ============================================================================

/** 0xB1 VirtueGumpResponse — virtue panel button (1..7 = compassion..valor). */
export function buildVirtueGumpResponse(virtueId) {
  const w = new PacketWriter(15);
  w.writeU8(0xB1);
  w.writeU16(15);
  w.writeU32(0);              // serial unused
  w.writeU32(0x1CD);          // dialog id
  w.writeU32(virtueId | 0);
  return w.bytes();
}
/** 0xBF sub 0x19 — Send_UseCombatAbility. ServUO `PacketHandlers.cs:3462`.
 *  op(1) + size(2) + sub(2) + abilityId(1) + pad(1) = 7 bytes.
 *  Prior version wrote 6 bytes while declaring 7 → server framer waited
 *  for the missing byte, eating the first byte of the next packet. */
export function buildUseCombatAbility(abilityId) {
  const w = new PacketWriter(7);
  w.writeU8(0xBF);
  w.writeU16(7);
  w.writeU16(0x0019);
  w.writeU8(abilityId & 0xff);
  w.writeU8(0);                       // pad — CUO writes 7 bytes total
  return w.bytes();
}
/** 0xBF sub 0x28 — Send_GuildMenuRequest (opens guild gump). */
export function buildGuildMenuRequest() {
  const w = new PacketWriter(5);
  w.writeU8(0xBF);
  w.writeU16(5);
  w.writeU16(0x0028);
  return w.bytes();
}
/** 0xBF sub 0x1E — Send_EquipLastWeapon (toggle to last weapon). */
export function buildEquipLastWeapon() {
  const w = new PacketWriter(5);
  w.writeU8(0xBF);
  w.writeU16(5);
  w.writeU16(0x001E);
  return w.bytes();
}
/** 0xBF sub 0x33 — Send_MultiBoatMoveRequest (board-steered multi-tile boat).
 *  speed: 0x01 slow / 0x02 normal / 0x03 fast / 0x04 turn-only.
 *  op(1) + size(2) + sub(2) + playerSerial(4) + dir(1) + speed(1) + extra(1) = 12. */
export function buildMultiBoatMoveRequest(playerSerial, direction, speed) {
  const w = new PacketWriter(12);
  w.writeU8(0xBF);
  w.writeU16(12);
  w.writeU16(0x0033);
  w.writeU32(playerSerial >>> 0);
  w.writeU8(direction & 0xff);
  w.writeU8(speed & 0xff);
  w.writeU8(0);                       // extra/pad — CUO writes 12 bytes total
  return w.bytes();
}
/** 0xBF sub 0x1C 0x02 — modern Send_CastSpell. CUO `OutgoingPackets.cs:1053`.
 *  op(1) + size(2)=11 + sub(2) + cmd(1) + 3 ASCII chars + null(1) + pad(1) = 11.
 *  Prior version wrote 10 bytes while declaring 11 → server waited for the
 *  missing byte, eating the first byte of the next packet. */
export function buildCastSpellModern(spellId) {
  const w = new PacketWriter(11);
  w.writeU8(0xBF);
  w.writeU16(11);
  w.writeU16(0x001C);
  w.writeU8(0x02);
  // CUO writes spellId as ASCII number padded to 3 chars.
  const s = String(spellId | 0);
  for (let i = 0; i < 3; i++) w.writeU8(i < s.length ? s.charCodeAt(i) : 0);
  w.writeU8(0);
  w.writeU8(0);                       // final pad — CUO writes 11 bytes total
  return w.bytes();
}

// ============================================================================
// Audit #46 P3 — Help / Tip / Razor / Map / UO-Store / FreeshardList.
// ============================================================================

/** 0x9B HelpRequest — 258 B fixed. CUO `OutgoingPackets.cs:697`. */
export function buildHelpRequest() {
  const w = new PacketWriter(258);
  w.writeU8(0x9B);
  for (let i = 1; i < 258; i++) w.writeU8(0);
  return w.bytes();
}
/** 0xA7 TipRequest — 4 B. CUO `:1654`. */
export function buildTipRequest(tipId = 0, last = 1) {
  const w = new PacketWriter(4);
  w.writeU8(0xA7);
  w.writeU16(tipId & 0xffff);
  w.writeU8(last & 0xff);
  return w.bytes();
}
/** 0xF0 0xFF — Razor ACK. CUO `:2459`. */
export function buildRazorAck() {
  const w = new PacketWriter(5);
  w.writeU8(0xF0);
  w.writeU16(5);
  w.writeU8(0xFF);
  w.writeU8(0xFF);
  return w.bytes();
}
/** 0x56 MapMessage (client→server: add map pin). */
export function buildMapMessage(serial, action, pin, x, y) {
  const w = new PacketWriter(11);
  w.writeU8(0x56);
  w.writeU32(serial >>> 0);
  w.writeU8(action & 0xff);
  w.writeU8(pin & 0xff);
  w.writeU16(x & 0xffff);
  w.writeU16(y & 0xffff);
  return w.bytes();
}
/** 0xFA OpenUOStore — open UO Store browser. */
export function buildOpenUOStore() {
  const w = new PacketWriter(1);
  w.writeU8(0xFA);
  return w.bytes();
}
/** 0xFB Public-house content toggle. */
export function buildShowPublicHouseContent(show = true) {
  const w = new PacketWriter(2);
  w.writeU8(0xFB);
  w.writeU8(show ? 1 : 0);
  return w.bytes();
}
/** 0xF0 sub 0x01 — Send_QueryPartyPosition (Krrios peer ping). */
export function buildQueryPartyPosition() {
  const w = new PacketWriter(4);
  w.writeU8(0xF0);
  w.writeU16(4);
  w.writeU8(0x01);
  return w.bytes();
}
/** 0xF0 sub 0x02 — Send_QueryGuildPosition (Krrios). */
export function buildQueryGuildPosition() {
  const w = new PacketWriter(4);
  w.writeU8(0xF0);
  w.writeU16(4);
  w.writeU8(0x02);
  return w.bytes();
}
