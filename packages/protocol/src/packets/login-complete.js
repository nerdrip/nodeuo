// 0x55 Login Complete — a simple one-byte opcode. After this packet the
// client is fully in-game. ServUO: `LoginComplete`.

import { PacketWriter } from '../buffer.js';

export function loginComplete() {
  const w = new PacketWriter(1);
  w.writeU8(0x55);
  return w.bytes();
}

/** 0xBD ClientVersionReq — server asks the client to answer with version. */
export function clientVersionRequest() {
  const w = new PacketWriter(3);
  w.writeU8(0xBD);
  w.writeU16(3);
  return w.bytes();
}
