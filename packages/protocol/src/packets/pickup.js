// 0x29 DropAck — confirms a drop was accepted.
//
// Format: u8 0x29, u8 result (0x00 = accepted, 0x01 = rejected).
// Legacy clients accept the 2-byte form; SA+ clients expect just 0x29 with
// no payload for the "accepted" path. We emit the 2-byte form which is what
// ServUO ships (and ClassicUO handles both).

import { PacketWriter } from '../buffer.js';

export function dropAck(ok = true) {
  const w = new PacketWriter(2);
  w.writeU8(0x29);
  w.writeU8(ok ? 0x00 : 0x01);
  return w.bytes();
}

/**
 * 0x27 Bounce — tell the client the item it picked up didn't move; it must
 * reset the cursor. `reason` is a byte value; ServUO uses:
 *   0 CannotLift, 1 OutOfRange, 2 OutOfSight, 3 TryingToSteal,
 *   4 Unspecified, 5 NoMotion.
 */
export function bounce(reason = 0x05) {
  const w = new PacketWriter(2);
  w.writeU8(0x27);
  w.writeU8(reason & 0xff);
  return w.bytes();
}
