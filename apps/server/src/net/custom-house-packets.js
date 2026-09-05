import { deflateSync } from 'node:zlib';
import { PacketWriter } from '@uo/protocol';

const MAX_TILES_PER_PLANE = 750;
const MAX_PLANES = 6;

/**
 * Build the standard compressed 0xD8 custom-house design packet. Components
 * are encoded in mode-0 planes (graphic + signed relative XYZ), which every
 * classic UO client supports and which avoids allocating sparse rectangular
 * floor buffers for small or irregular designs.
 */
export function customHouseDesign({
  serial, revision = 0, response = true, origin = {}, tiles = [],
}) {
  const ox = origin.x | 0, oy = origin.y | 0, oz = origin.z | 0;
  if (!Array.isArray(tiles) || tiles.length > MAX_TILES_PER_PLANE * MAX_PLANES) {
    throw new RangeError('custom-house design exceeds the classic plane limit');
  }
  const safeTiles = [];
  for (const tile of tiles) {
    const x = (tile.x | 0) - ox, y = (tile.y | 0) - oy, z = (tile.z | 0) - oz;
    if (!Number.isInteger(tile.g) || tile.g <= 0 || tile.g > 0xffff) {
      throw new RangeError('custom-house tile has an invalid graphic');
    }
    if (x < -128 || x > 127 || y < -128 || y > 127 || z < -128 || z > 127) {
      throw new RangeError('custom-house tile is outside the signed coordinate range');
    }
    safeTiles.push({ g: tile.g >>> 0, x, y, z });
  }

  const planes = [];
  for (let offset = 0; offset < safeTiles.length; offset += MAX_TILES_PER_PLANE) {
    const chunk = safeTiles.slice(offset, offset + MAX_TILES_PER_PLANE);
    const raw = new Uint8Array(chunk.length * 5);
    const view = new DataView(raw.buffer);
    let cursor = 0;
    for (const tile of chunk) {
      view.setUint16(cursor, tile.g, false); cursor += 2;
      view.setInt8(cursor++, tile.x);
      view.setInt8(cursor++, tile.y);
      view.setInt8(cursor++, tile.z);
    }
    const compressed = new Uint8Array(deflateSync(raw));
    if (raw.length > 0xfff || compressed.length > 0xfff) {
      throw new RangeError('custom-house plane exceeds the classic 12-bit buffer limit');
    }
    planes.push({ rawLength: raw.length, compressed });
  }

  const payloadLength = 1 + planes.reduce((sum, plane) => sum + 4 + plane.compressed.length, 0);
  const packetLength = 17 + payloadLength;
  const writer = new PacketWriter(packetLength);
  writer.writeU8(0xD8);
  writer.writeU16(packetLength);
  writer.writeU8(0x03);
  writer.writeU8(response ? 1 : 0);
  writer.writeU32(serial >>> 0);
  writer.writeU32(revision >>> 0);
  writer.writeU16(safeTiles.length);
  writer.writeU16(payloadLength);
  writer.writeU8(planes.length);
  for (let index = 0; index < planes.length; index++) {
    const { rawLength, compressed } = planes[index];
    writer.writeU8(9 + index); // mode 0, plane id 9..14
    writer.writeU8(rawLength & 0xff);
    writer.writeU8(compressed.length & 0xff);
    writer.writeU8(((rawLength >> 4) & 0xf0) | ((compressed.length >> 8) & 0x0f));
    writer.writeBytes(compressed);
  }
  return writer.bytes();
}
