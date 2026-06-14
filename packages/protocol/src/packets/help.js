// 0x9B Help Request — 258 bytes fixed. Player clicks "Help" in client paperdoll;
// classic behavior was to open a GM-help page gump. We log it server-side.
//
// Layout:
//   u8 0x9B
//   257 bytes of payload (mostly zeros).

/**
 * @param {Uint8Array} pkt
 */
export function readHelpRequest(pkt) {
  if (pkt[0] !== 0x9B) throw new Error('not a 0x9B help request');
  return { received: pkt.length };
}
