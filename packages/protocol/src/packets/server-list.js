// 0xA8 Account Login Ack — "Server List" sent to the client after a successful
// 0x80 AccountLogin. ServUO: `AccountLoginAck` in Server/Network/Packets.cs.
//
// Layout:
//   u8   0xA8
//   u16  length (patched)
//   u8   flags (ServUO uses 0x5D: "RX packet compression enabled" etc.)
//   u16  server count
//   server[count]:
//     u16  index
//     char[32] name (fixed ASCII)
//     u8   fullPercent
//     i8   timeZone
//     u32  address (big-endian IPv4, **reversed** — see ServUO: ip is emitted
//          via `m_Stream.Write(address)` on an IPAddress which on the wire
//          arrives in network byte order. Client displays it byte-reversed on
//          some eras; we match ServUO exactly by writing the 4 address bytes
//          in the same order ServUO does: host → pack as little-endian u32.)

import { PacketWriter } from '../buffer.js';

/**
 * @typedef {Object} ServerListEntry
 * @property {string} name
 * @property {number} [fullPercent] 0..100
 * @property {number} [timeZone]
 * @property {string|number[]} address IPv4 dotted string or 4-element array
 */

/**
 * @param {ServerListEntry[]} servers
 * @param {number} [flags]
 * @returns {Uint8Array}
 */
export function serverList(servers, flags = 0x5D) {
  const w = new PacketWriter(64);
  w.writeU8(0xA8);
  const lenPos = w.length;
  w.writeU16(0);
  w.writeU8(flags);
  w.writeU16(servers.length);
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i];
    w.writeU16(i);
    w.writeAsciiFixed(s.name, 32);
    w.writeU8(s.fullPercent ?? 0);
    w.writeI8(s.timeZone ?? 0);
    writeIpLE(w, s.address);
  }
  w.setU16At(lenPos, w.length);
  return w.bytes();
}

function writeIpLE(w, address) {
  const ip = typeof address === 'string' ? parseIp(address) : address;
  // ServUO writes the address in network byte order as provided by
  // IPAddress.GetAddressBytes(); the classic client then rebuilds it LE.
  // Emit bytes reversed so the client sees e.g. 127.0.0.1 correctly.
  w.writeU8(ip[3]);
  w.writeU8(ip[2]);
  w.writeU8(ip[1]);
  w.writeU8(ip[0]);
}

function parseIp(s) {
  const parts = s.split('.').map((p) => parseInt(p, 10) & 0xff);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid IPv4 address: ${s}`);
  }
  return parts;
}
