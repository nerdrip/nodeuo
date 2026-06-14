// Speech packets: 0x1C AsciiMessage (legacy), 0xAE UnicodeMessage.
// ServUO: Server/Network/Packets.cs — `AsciiMessage`, `UnicodeMessage`.

import { PacketWriter } from '../buffer.js';

export const MessageType = Object.freeze({
  Regular: 0,
  System:  1,
  Emote:   2,
  Label:   6,
  Focus:   7,
  Whisper: 8,
  Yell:    9,
  Spell:   10,
  Guild:   13,
  Alliance:14,
  Command: 15,
  Encoded: 0xC0,
});

/**
 * 0xAE Unicode message. Variable-length.
 */
export function unicodeMessage({ serial = 0xFFFFFFFF, graphic = 0xFFFF, type = MessageType.System, hue = 0x03B2, font = 3, language = 'ENU', name = 'System', text = '' }) {
  const w = new PacketWriter(64);
  w.writeU8(0xAE);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial);
  w.writeU16(graphic);
  w.writeU8(type & 0xff);
  w.writeU16(hue);
  w.writeU16(font);
  w.writeAsciiFixed(language, 4);
  w.writeAsciiFixed(name, 30);
  w.writeUnicodeNull(text);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0xC1 Localized message (cliloc-based). Variable length.
 *
 * ServUO: `Server/Network/Packets.cs` — `MessageLocalized`.
 *
 * @param {Object} p
 * @param {number} [p.serial]
 * @param {number} [p.graphic]
 * @param {number} [p.type]
 * @param {number} [p.hue]
 * @param {number} [p.font]
 * @param {string} [p.language]  4-char
 * @param {string} [p.name]      sender name (ASCII, 30 bytes)
 * @param {number} p.clilocNumber
 * @param {string} [p.args]      tab-separated substitution args (Unicode)
 */
export function messageLocalized({
  serial = 0xFFFFFFFF,
  graphic = 0xFFFF,
  type = MessageType.System,
  hue = 0x03B2,
  font = 3,
  language = 'ENU',
  name = 'System',
  clilocNumber,
  args = '',
}) {
  const w = new PacketWriter(64);
  w.writeU8(0xC1);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial);
  w.writeU16(graphic);
  w.writeU8(type & 0xff);
  w.writeU16(hue);
  w.writeU16(font);
  w.writeU32(clilocNumber >>> 0);
  w.writeAsciiFixed(name, 30);
  w.writeUnicodeNull(args);
  // Note: language is not part of 0xC1 in the classic client; the client
  // picks cliloc from its own locale. `language` param is kept for API
  // symmetry with unicodeMessage().
  void language;
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * 0xCC Localized message with affix (cliloc-based + plain string prefix
 * or suffix). Variable length.
 *
 * ServUO: `Server/Network/Packets.cs` — `MessageLocalizedAffix`. Used
 * for things like death messages where the cliloc handles the body
 * ("You see") and the affix carries the variable target name. Layout:
 *   u8 0xCC, u16 len, u32 serial, u16 graphic, u8 type, u16 hue,
 *   u16 font, u32 clilocNumber,
 *   u8 affixType (0 = prepend, 1 = append),
 *   ascii name(30), ascii affix(NUL), unicode args(NUL).
 *
 * @param {Object} p
 * @param {number} [p.serial]
 * @param {number} [p.graphic]
 * @param {number} [p.type]
 * @param {number} [p.hue]
 * @param {number} [p.font]
 * @param {string} [p.name]
 * @param {number} p.clilocNumber
 * @param {string} [p.affix]
 * @param {boolean} [p.append]   true = append, false = prepend (default false)
 * @param {string} [p.args]
 */
export function messageLocalizedAffix({
  serial = 0xFFFFFFFF,
  graphic = 0xFFFF,
  type = MessageType.System,
  hue = 0x03B2,
  font = 3,
  name = 'System',
  clilocNumber,
  affix = '',
  append = false,
  args = '',
}) {
  const w = new PacketWriter(96);
  w.writeU8(0xCC);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU32(serial);
  w.writeU16(graphic);
  w.writeU8(type & 0xff);
  w.writeU16(hue);
  w.writeU16(font);
  w.writeU32(clilocNumber >>> 0);
  w.writeU8(append ? 0x01 : 0x00);
  w.writeAsciiFixed(name, 30);
  // affix is plain ASCII null-terminated (mirrors ServUO write).
  for (let i = 0; i < affix.length; i++) w.writeU8(affix.charCodeAt(i) & 0xFF);
  w.writeU8(0);
  w.writeUnicodeNull(args);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}
