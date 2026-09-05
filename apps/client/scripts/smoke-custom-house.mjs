import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { PacketWriter } from '@uo/protocol';
import { decodeCustomHouse } from '../src/net/incoming.js';

function plane(mode, zPlane, raw) {
  const compressed = new Uint8Array(deflateSync(raw));
  return { mode, zPlane, raw, compressed };
}

function packetFor(planes, tileCount) {
  const length = 18 + planes.reduce((sum, value) => sum + 4 + value.compressed.length, 0);
  const writer = new PacketWriter(length);
  writer.writeU8(0xD8);
  writer.writeU16(length);
  writer.writeU8(3);
  writer.writeU8(1);
  writer.writeU32(0x40000123);
  writer.writeU32(7);
  writer.writeU16(tileCount);
  writer.writeU16(length - 17);
  writer.writeU8(planes.length);
  for (const value of planes) {
    writer.writeU8(((value.mode & 0x0F) << 4) | (value.zPlane & 0x0F));
    writer.writeU8(value.raw.length & 0xFF);
    writer.writeU8(value.compressed.length & 0xFF);
    writer.writeU8(((value.raw.length >> 4) & 0xF0) | ((value.compressed.length >> 8) & 0x0F));
    writer.writeBytes(value.compressed);
  }
  return writer.bytes();
}

const explicit = new Uint8Array([0x31, 0xF4, 0xFF, 0x02, 0x07]);
const sparse = new Uint8Array([0x06, 0xA5, 0x03, 0xFE]);
const dense = new Uint8Array([0x00, 0x00, 0x17, 0xB2]);
const decoded = await decodeCustomHouse(packetFor([
  plane(0, 9, explicit),
  plane(1, 2, sparse),
  plane(2, 1, dense),
], 3), { bounds: { minX: -1, minY: -1, maxY: 1 } });

assert.equal(decoded.serial, 0x40000123);
assert.equal(decoded.revision, 7);
assert.deepEqual(decoded.tiles, [
  { graphic: 0x31F4, x: -1, y: 2, z: 7 },
  { graphic: 0x06A5, x: 3, y: -2, z: 27 },
  { graphic: 0x17B2, x: 0, y: 1, z: 7 },
]);

await assert.rejects(
  () => decodeCustomHouse(packetFor([plane(2, 1, dense)], 1)),
  /requires foundation bounds/,
);

console.log('custom-house packet smoke: ok');
