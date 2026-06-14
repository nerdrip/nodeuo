// Guild chat — ServUO exposes guilds through 0xBF 0x28 "GuildChatMessage" plus
// 0xB2 Chat and 0x73 Ping. For v1 we implement a minimal "guild-line" emit
// compatible with modern clients: system message tinted with the guild hue.
//
// The actual guild membership model lives in `apps/server/src/guild.js`.

import { PacketWriter } from '../buffer.js';

/**
 * 0xBF 0x28 Guild message.
 *
 * @param {Object} p
 * @param {string} p.name       speaker's name
 * @param {string} p.text
 * @param {number} [p.hue]
 */
export function guildMessage({ name, text, hue = 0x03B2 }) {
  const w = new PacketWriter(32);
  w.writeU8(0xBF);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU16(0x0028);
  // ServUO emits a "short" format: u8 0 + ASCII name + 0 + ASCII text + 0 + u16 hue.
  w.writeU8(0);
  const nameBytes = new TextEncoder().encode(name);
  for (const b of nameBytes) w.writeU8(b);
  w.writeU8(0);
  const textBytes = new TextEncoder().encode(text);
  for (const b of textBytes) w.writeU8(b);
  w.writeU8(0);
  w.writeU16(hue & 0xFFFF);
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

/**
 * Parse a client 0xBF 0x28 GuildChatMessage (plain ASCII text).
 * @param {Uint8Array} pkt
 */
export function readGuildMessage(pkt) {
  if (pkt[0] !== 0xBF) throw new Error('not 0xBF');
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const sub = dv.getUint16(3);
  if (sub !== 0x0028) throw new Error(`0xBF subcmd ${sub.toString(16)} is not 0x0028`);
  // ServUO client sends ASCII null-terminated text starting at byte 5.
  let o = 5;
  let text = '';
  while (o < pkt.length) {
    const b = dv.getUint8(o); o += 1;
    if (b === 0) break;
    text += String.fromCharCode(b);
  }
  return { text };
}
