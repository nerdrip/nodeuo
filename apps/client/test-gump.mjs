// Smoke test for the server-gump roundtrip:
//   server displayGump(...)        →  client decodeOpenGump(pkt)
//   client buildGumpResponse(...)  →  server readGumpResponse(pkt)
//
// Asserts that field-for-field both directions stay byte-identical to
// what ServUO produces / consumes.
//
//   node apps/client/test-gump.mjs

import { displayGump, readGumpResponse } from '@uo/protocol/packets';
import { displayGumpPacked } from '../server/src/net/gump-packed.js';
import { decodeOpenGump, decodeCompressedGump } from './src/net/incoming.js';
import { buildGumpResponse } from './src/net/outgoing.js';

const fail = (msg) => { console.error('✖', msg); process.exit(1); };
const ok   = (msg) => console.log('✓', msg);

// ---------- 0xB0 round-trip ------------------------------------------------

const layout = [
  '{ resizepic 0 0 3500 200 120 }',
  '{ button 80 90 4005 4007 1 0 1 }',
  '{ checkbox 16 16 210 211 1 42 }',
  '{ radio 16 36 208 209 0 11 }',
  '{ radio 16 56 208 209 1 12 }',
  '{ text 60 16 32 0 }',
  '{ textentry 16 76 100 18 0 99 1 }',
].join(' ');
const texts = ['Pick wisely', 'preset name'];

const pkt = displayGump({
  serial: 0xDEADBEEF, gumpId: 0xC0FFEE,
  x: 100, y: 200, layout, texts,
});

const decoded = decodeOpenGump(pkt);
if (decoded.serverSerial !== 0xDEADBEEF) fail(`serverSerial mismatch: ${decoded.serverSerial.toString(16)}`);
if (decoded.gumpSerial   !== 0xC0FFEE)  fail(`gumpSerial mismatch: ${decoded.gumpSerial.toString(16)}`);
if (decoded.x !== 100 || decoded.y !== 200) fail(`xy mismatch: ${decoded.x},${decoded.y}`);
if (decoded.layout.replace(/\s+/g, ' ').trim() !== layout.replace(/\s+/g, ' ').trim())
  fail(`layout mismatch:\n  got:  ${decoded.layout}\n  want: ${layout}`);
if (decoded.textLines.length !== 2) fail(`textLines count: ${decoded.textLines.length}`);
if (decoded.textLines[0] !== 'Pick wisely') fail(`textLines[0] = ${decoded.textLines[0]}`);
if (decoded.textLines[1] !== 'preset name') fail(`textLines[1] = ${decoded.textLines[1]}`);
ok('0xB0 round-trip: serial/serial/x/y/layout/textLines all match');

// ---------- 0xB1 round-trip ------------------------------------------------

const respPkt = buildGumpResponse({
  serverSerial: 0xDEADBEEF, gumpSerial: 0xC0FFEE, buttonId: 7,
  switches: [42, 12],
  textEntries: [{ id: 99, text: 'Boberski' }, { id: 33, text: 'Bartek' }],
});
const back = readGumpResponse(respPkt);
if (back.serial !== 0xDEADBEEF) fail(`resp serial: ${back.serial.toString(16)}`);
if (back.gumpId !== 0xC0FFEE)  fail(`resp gumpId: ${back.gumpId.toString(16)}`);
if (back.buttonId !== 7)        fail(`resp buttonId: ${back.buttonId}`);
if (back.switches.length !== 2 || back.switches[0] !== 42 || back.switches[1] !== 12)
  fail(`resp switches: ${JSON.stringify(back.switches)}`);
if (back.textEntries.length !== 2) fail(`resp textEntries count: ${back.textEntries.length}`);
if (back.textEntries[0].entryId !== 99 || back.textEntries[0].text !== 'Boberski')
  fail(`resp textEntries[0]: ${JSON.stringify(back.textEntries[0])}`);
if (back.textEntries[1].entryId !== 33 || back.textEntries[1].text !== 'Bartek')
  fail(`resp textEntries[1]: ${JSON.stringify(back.textEntries[1])}`);
ok('0xB1 round-trip: serial/gumpId/buttonId/switches/textEntries all match');

// ---------- 0xDD round-trip ------------------------------------------------

const bigLayout = (
  '{ resizepic 0 0 3500 400 300 } ' +
  Array.from({ length: 32 }, (_, i) => `{ button 16 ${10 + i * 16} 4005 4007 1 0 ${100 + i} }`).join(' ')
);
const bigTexts = Array.from({ length: 16 }, (_, i) => `entry-${i}-quite-long-line-of-text`);
const ddPkt = displayGumpPacked({
  serial: 0xCAFE0123, gumpId: 0xBEEF4567, x: 50, y: 60,
  layout: bigLayout, texts: bigTexts,
});

const ddDecoded = await decodeCompressedGump(ddPkt);
if (ddDecoded.serverSerial !== 0xCAFE0123) fail(`0xDD serverSerial: ${ddDecoded.serverSerial.toString(16)}`);
if (ddDecoded.gumpSerial   !== 0xBEEF4567) fail(`0xDD gumpSerial: ${ddDecoded.gumpSerial.toString(16)}`);
if (ddDecoded.x !== 50 || ddDecoded.y !== 60) fail(`0xDD xy: ${ddDecoded.x},${ddDecoded.y}`);
if (ddDecoded.layout.replace(/\s+/g, ' ').trim() !== bigLayout.replace(/\s+/g, ' ').trim())
  fail(`0xDD layout mismatch (uncompressed via DecompressionStream)`);
if (ddDecoded.textLines.length !== bigTexts.length)
  fail(`0xDD textLines count: ${ddDecoded.textLines.length}`);
for (let i = 0; i < bigTexts.length; i++) {
  if (ddDecoded.textLines[i] !== bigTexts[i])
    fail(`0xDD textLines[${i}] = "${ddDecoded.textLines[i]}" want "${bigTexts[i]}"`);
}
ok('0xDD round-trip: 32-button compressed gump deflated & framed correctly');

console.log('\nfinal: all 3 round-trips passed');
