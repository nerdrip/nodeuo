import { inflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { PacketReader } from '@uo/protocol';
import { customHouseDesign } from '../src/net/custom-house-packets.js';
import { sendHouseDesignDetails } from '../src/net/handlers/client-extensions.js';

describe('classic custom-house detail packet', () => {
  it('encodes exact 0xD8 mode-0 planes with foundation-relative coordinates', () => {
    const packet = customHouseDesign({
      serial: 0x40000123,
      revision: 42,
      origin: { x: 1000, y: 2000, z: -5 },
      tiles: [
        { g: 0x31F4, x: 999, y: 2002, z: 2 },
        { g: 0x06A5, x: 1003, y: 1998, z: 15 },
      ],
    });
    const reader = new PacketReader(packet);
    expect([reader.readU8(), reader.readU16(), reader.readU8(), reader.readU8()])
      .toEqual([0xD8, packet.length, 0x03, 1]);
    expect([reader.readU32(), reader.readU32(), reader.readU16()])
      .toEqual([0x40000123, 42, 2]);
    expect(reader.readU16()).toBe(packet.length - 17);
    expect(reader.readU8()).toBe(1);

    const type = reader.readU8();
    const rawLow = reader.readU8();
    const compressedLow = reader.readU8();
    const high = reader.readU8();
    const rawLength = rawLow | ((high & 0xF0) << 4);
    const compressedLength = compressedLow | ((high & 0x0F) << 8);
    expect(type).toBe(9);
    expect(rawLength).toBe(10);
    const raw = new Uint8Array(inflateSync(reader.readBytes(compressedLength)));
    expect(raw).toEqual(new Uint8Array([
      0x31, 0xF4, 0xFF, 0x02, 0x07,
      0x06, 0xA5, 0x03, 0xFE, 0x14,
    ]));
    expect(reader.remaining).toBe(0);
  });

  it('rejects silent truncation and out-of-range relative coordinates', () => {
    expect(() => customHouseDesign({
      serial: 1,
      origin: { x: 0, y: 0, z: 0 },
      tiles: [{ g: 0x31F4, x: 128, y: 0, z: 0 }],
    })).toThrow(/signed coordinate range/);
    expect(() => customHouseDesign({
      serial: 1,
      tiles: Array.from({ length: 4501 }, () => ({ g: 1, x: 0, y: 0, z: 0 })),
    })).toThrow(/plane limit/);
  });

  it('keeps committed fixtures as serial-backed items but includes them in an editor draft', () => {
    const send = vi.fn();
    const foundation = { serial: 0x40000123, x: 100, y: 200, z: 0 };
    const state = {
      mobile: { serial: 1 }, send,
      ctx: { world: { items: new Map([[foundation.serial, foundation]]) } },
    };
    const house = {
      id: 1, multiSerial: foundation.serial, revision: 3,
      tiles: [
        { kind: 'wall', g: 0x1000, x: 100, y: 200, z: 7 },
        { kind: 'door', g: 0x06A5, x: 101, y: 200, z: 7 },
      ],
      editing: null,
    };

    expect(sendHouseDesignDetails(state, house)).toBe(true);
    const committed = send.mock.calls[0][0];
    expect(new DataView(committed.buffer, committed.byteOffset, committed.byteLength).getUint16(13, false)).toBe(1);

    house.editing = { editorSerial: 1, revision: 4, tiles: house.tiles };
    expect(sendHouseDesignDetails(state, house)).toBe(true);
    const editing = send.mock.calls[1][0];
    expect(new DataView(editing.buffer, editing.byteOffset, editing.byteLength).getUint16(13, false)).toBe(2);
  });
});
