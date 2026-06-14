import { PacketWriter } from '../buffer.js';

/**
 * 0x82 Login Denied.
 * Sent in response to 0x80 AccountLogin when auth fails.
 * See ServUO Server/Network/Packets.cs `AccountLoginRej`.
 *
 * @param {number} reason see `LoginRejectReason` for canonical values
 */
export function loginReject(reason) {
  const w = new PacketWriter(2);
  w.writeU8(0x82);
  w.writeU8(reason & 0xff);
  return w.bytes();
}

export const LoginRejectReason = Object.freeze({
  Invalid:        0x00, // Invalid account credentials
  InUse:          0x01, // Account already in use
  Blocked:        0x02, // Account blocked
  BadPassword:    0x03, // Password invalid
  Idle:           0xFE, // Connection idle
  BadCommunication: 0xFF,
});
