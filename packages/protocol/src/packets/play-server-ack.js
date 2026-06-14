// 0x8C Play Server Ack (Game Server Relay). After the client picks a shard
// from 0xA8 and sends 0xA0, the server responds with 0x8C containing the
// game-server address/port + an auth key that the next connection must send
// via 0x91 GameLogin. ServUO: `PlayServerAck`.
//
// Layout (11 bytes):
//   u8 0x8C
//   u8[4] IP (network byte order, same writer as 0xA8)
//   u16 port
//   u32 authId

import { PacketWriter } from '../buffer.js';

/**
 * @param {string|number[]} address  IPv4
 * @param {number} port
 * @param {number} authId    seed / auth key the client will echo in 0x91
 */
export function playServerAck(address, port, authId) {
  const ip = typeof address === 'string' ? address.split('.').map((p) => parseInt(p, 10) & 0xff) : address;
  const w = new PacketWriter(11);
  w.writeU8(0x8C);
  w.writeU8(ip[0]); w.writeU8(ip[1]); w.writeU8(ip[2]); w.writeU8(ip[3]);
  w.writeU16(port);
  w.writeU32(authId);
  return w.bytes();
}
