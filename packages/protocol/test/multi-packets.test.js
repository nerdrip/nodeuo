import { describe, expect, it } from 'vitest';
import {
  PacketReader,
  boatMoving,
  extHouseCustomization,
  extHouseRevision,
} from '../src/index.js';

describe('classic UO multi packets', () => {
  it('encodes 0xF6 hull and passengers atomically', () => {
    const packet = boatMoving({
      serial: 0x40000001, speed: 3, direction: 2, facing: 2,
      x: 1234, y: 567, z: -5,
      passengers: [{ serial: 0x00000022, x: 1235, y: 567, z: -4 }],
    });
    expect(packet).toHaveLength(28);
    const reader = new PacketReader(packet);
    expect(reader.readU8()).toBe(0xF6);
    expect(reader.readU16()).toBe(packet.length);
    expect(reader.readU32()).toBe(0x40000001);
    expect([reader.readU8(), reader.readU8(), reader.readU8()]).toEqual([3, 2, 2]);
    expect([reader.readU16(), reader.readU16(), reader.readI16()]).toEqual([1234, 567, -5]);
    expect(reader.readU16()).toBe(1);
    expect([reader.readU32(), reader.readU16(), reader.readU16(), reader.readI16()])
      .toEqual([0x22, 1235, 567, -4]);
    expect(reader.remaining).toBe(0);
  });

  it('encodes standard 0xBF/0x20 custom-house interaction', () => {
    const packet = extHouseCustomization({
      serial: 0x40000010, type: 4, graphic: 0x31F4, x: 1500, y: 1600, z: -7,
    });
    expect(packet).toHaveLength(17);
    const reader = new PacketReader(packet);
    expect([reader.readU8(), reader.readU16(), reader.readU16()]).toEqual([0xBF, 17, 0x20]);
    expect(reader.readU32()).toBe(0x40000010);
    expect(reader.readU8()).toBe(4);
    expect([reader.readU16(), reader.readU16(), reader.readU16(), reader.readI8()])
      .toEqual([0x31F4, 1500, 1600, -7]);
    expect(reader.remaining).toBe(0);
  });

  it('encodes standard 0xBF/0x1D custom-house revision state', () => {
    const packet = extHouseRevision({ serial: 0x40000010, revision: 0x01020304 });
    expect(packet).toHaveLength(13);
    const reader = new PacketReader(packet);
    expect([reader.readU8(), reader.readU16(), reader.readU16()]).toEqual([0xBF, 13, 0x1D]);
    expect(reader.readU32()).toBe(0x40000010);
    expect(reader.readU32()).toBe(0x01020304);
    expect(reader.remaining).toBe(0);
  });
});
