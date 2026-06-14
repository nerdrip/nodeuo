// Tests for Wave D packets: gumps, equipment, weather, context menu.

import { describe, it, expect } from 'vitest';
import {
  displayGump, readGumpResponse, GumpBuilder,
  equipUpdate, readWearItem, Layer,
  weather, WeatherKind,
  displayContextMenu, readContextMenuRequest, readContextMenuResponse,
} from '../src/index.js';
import { PacketWriter } from '../src/buffer.js';

describe('GumpBuilder', () => {
  it('emits layout + texts', () => {
    const g = new GumpBuilder()
      .page(0)
      .background(0, 0, 300, 200, 5054)
      .label(10, 10, 0x481, 'Hello')
      .button(10, 160, 4023, 4024, 1, 7)
      .compile();
    expect(g.layout).toMatch(/resizepic 0 0 5054 300 200/);
    expect(g.layout).toMatch(/button 10 160 4023 4024 1 0 7/);
    expect(g.texts).toEqual(['Hello']);
  });
});

describe('displayGump (0xB0)', () => {
  it('writes opcode + length + identity + text count', () => {
    const pkt = displayGump({
      serial: 0x01020304, gumpId: 42, x: 50, y: 75,
      layout: '{ page 0 }', texts: ['Hi'],
    });
    expect(pkt[0]).toBe(0xB0);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint32(3)).toBe(0x01020304);
    expect(dv.getUint32(7)).toBe(42);
    expect(dv.getUint32(11)).toBe(50);
    expect(dv.getUint32(15)).toBe(75);
    const layoutLen = dv.getUint16(19);
    expect(layoutLen).toBe('{ page 0 }'.length + 1);
    const textCountPos = 19 + 2 + layoutLen;
    expect(dv.getUint16(textCountPos)).toBe(1);
  });
});

describe('readGumpResponse (0xB1)', () => {
  it('round-trips switches and text entries', () => {
    const w = new PacketWriter(64);
    w.writeU8(0xB1);
    const lp = w.length;
    w.writeU16(0);
    w.writeU32(7);
    w.writeU32(42);
    w.writeU32(1);
    w.writeU32(2);
    w.writeU32(10); w.writeU32(11);
    w.writeU32(1);
    w.writeU16(5);
    w.writeU16(2);
    w.writeU8(0); w.writeU8('H'.charCodeAt(0));
    w.writeU8(0); w.writeU8('i'.charCodeAt(0));
    w.setU16At(lp, w.length);
    const r = readGumpResponse(w.bytes());
    expect(r.serial).toBe(7);
    expect(r.gumpId).toBe(42);
    expect(r.buttonId).toBe(1);
    expect(r.switches).toEqual([10, 11]);
    expect(r.textEntries).toEqual([{ entryId: 5, text: 'Hi' }]);
  });
});

describe('equipment', () => {
  it('equipUpdate (0x2E) packs 15 bytes', () => {
    const pkt = equipUpdate({
      serial: 0x40000001, itemId: 0x1F03, layer: Layer.Shirt,
      parent: 0x00000001, hue: 0x0021,
    });
    expect(pkt.length).toBe(15);
    expect(pkt[0]).toBe(0x2E);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint32(1)).toBe(0x40000001);
    expect(dv.getUint16(5)).toBe(0x1F03);
    expect(dv.getUint8(7)).toBe(0);
    expect(dv.getUint8(8)).toBe(Layer.Shirt);
    expect(dv.getUint32(9)).toBe(0x00000001);
    expect(dv.getUint16(13)).toBe(0x0021);
  });

  it('readWearItem parses 0x13 request', () => {
    const buf = new Uint8Array([
      0x13,
      0x40, 0, 0, 0x01,
      Layer.Cloak,
      0, 0, 0, 0x01,
    ]);
    const r = readWearItem(buf);
    expect(r.itemSerial).toBe(0x40000001);
    expect(r.layer).toBe(Layer.Cloak);
    expect(r.mobileSerial).toBe(1);
  });
});

describe('weather (0x65)', () => {
  it('packs 4 bytes', () => {
    const pkt = weather({ kind: WeatherKind.Rain, intensity: 30 });
    expect(pkt.length).toBe(4);
    expect(pkt[0]).toBe(0x65);
    expect(pkt[1]).toBe(WeatherKind.Rain);
    expect(pkt[2]).toBe(30);
  });
});

describe('context menu (0xBF)', () => {
  it('displayContextMenu uses enhanced (v2) layout', () => {
    const pkt = displayContextMenu({
      serial: 0x00000007,
      entries: [
        { responseId: 1, cliloc: 3006123, flags: 0 },
        { responseId: 2, cliloc: 3006168, flags: 0 },
      ],
    });
    expect(pkt[0]).toBe(0xBF);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint16(3)).toBe(0x0014);
    expect(dv.getUint16(5)).toBe(0x0002);
    expect(dv.getUint32(7)).toBe(7);
    expect(dv.getUint8(11)).toBe(2);
    expect(dv.getUint16(12)).toBe(1);
    expect(dv.getUint16(14)).toBe(6123);
  });

  it('parses request + response payloads', () => {
    const req = new PacketWriter(12);
    req.writeU8(0xBF); const lp1 = req.length; req.writeU16(0); req.writeU16(0x0015); req.writeU32(42);
    req.setU16At(lp1, req.length);
    const rr = readContextMenuRequest(req.bytes());
    expect(rr.serial).toBe(42);

    const resp = new PacketWriter(14);
    resp.writeU8(0xBF); const lp2 = resp.length; resp.writeU16(0); resp.writeU16(0x0016); resp.writeU32(42); resp.writeU16(7);
    resp.setU16At(lp2, resp.length);
    const rp = readContextMenuResponse(resp.bytes());
    expect(rp.serial).toBe(42);
    expect(rp.responseId).toBe(7);
  });
});
