// Wave E packets: vendors, books, combat atoms, prompt.

import { describe, it, expect } from 'vitest';
import {
  openBuyWindow, vendorSellList, readBuyRequest, readSellReply,
  openBookNew, openBookLegacy, bookPages, readBookPages, readBookHeader,
  clientVersionRequest,
  warmode, readWarmode, playerAnimation, newPlayerAnimation, damagePacket, Anim,
  unicodePrompt, readUnicodePromptReply,
} from '../src/index.js';
import { PacketWriter } from '../src/buffer.js';

describe('vendors', () => {
  it('openBuyWindow packs entries with length-prefixed descriptions', () => {
    const pkt = openBuyWindow({
      vendorSerial: 0x01000001,
      entries: [
        { price: 12, description: 'apple' },
        { price: 99, description: 'cheese' },
      ],
    });
    expect(pkt[0]).toBe(0x74);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint32(3)).toBe(0x01000001);
    expect(dv.getUint8(7)).toBe(2);
    expect(dv.getUint32(8)).toBe(12);
    expect(dv.getUint8(12)).toBe(6); // "apple\0"
  });

  it('readBuyRequest parses item picks', () => {
    const w = new PacketWriter(32);
    w.writeU8(0x3B); const lp = w.length; w.writeU16(0);
    w.writeU32(0x00000007); w.writeU8(0x02);
    w.writeU8(0x1A); w.writeU32(0x40000001); w.writeU16(3);
    w.writeU8(0x1A); w.writeU32(0x40000002); w.writeU16(1);
    w.setU16At(lp, w.length);
    const r = readBuyRequest(w.bytes());
    expect(r.vendorSerial).toBe(7);
    expect(r.flag).toBe(2);
    expect(r.items).toEqual([
      { serial: 0x40000001, amount: 3 },
      { serial: 0x40000002, amount: 1 },
    ]);
  });

  it('vendorSellList + readSellReply round-trip', () => {
    const list = vendorSellList({
      vendorSerial: 9, entries: [
        { serial: 0x40000010, itemId: 0x1F03, hue: 0, amount: 1, price: 50, name: 'ring' },
      ],
    });
    expect(list[0]).toBe(0x9E);

    const w = new PacketWriter(16);
    w.writeU8(0x9F); const lp = w.length; w.writeU16(0);
    w.writeU32(9); w.writeU16(1);
    w.writeU32(0x40000010); w.writeU16(1);
    w.setU16At(lp, w.length);
    const r = readSellReply(w.bytes());
    expect(r.vendorSerial).toBe(9);
    expect(r.items).toEqual([{ serial: 0x40000010, amount: 1 }]);
  });
});

describe('books', () => {
  it('openBookLegacy is 99 bytes fixed', () => {
    const pkt = openBookLegacy({
      serial: 7, writable: true, pages: 3, title: 'Hello', author: 'Me',
    });
    expect(pkt.length).toBe(99);
    expect(pkt[0]).toBe(0x93);
  });

  it('openBookNew packs variable Unicode header', () => {
    const pkt = openBookNew({
      serial: 7, writable: false, pages: 2, title: 'Tales', author: 'Some bard',
    });
    expect(pkt[0]).toBe(0xD4);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint32(3)).toBe(7);
    expect(dv.getUint8(7)).toBe(0);
    expect(dv.getUint16(9)).toBe(2);
  });

  it('bookPages round-trips through readBookPages', () => {
    const pages = [
      ['First page line 1', 'second line'],
      ['Page two'],
    ];
    const pkt = bookPages({ serial: 42, pages });
    expect(pkt[0]).toBe(0x66);
    const r = readBookPages(pkt);
    expect(r.serial).toBe(42);
    expect(r.pages).toEqual(pages);
  });

  it('readBookHeader parses author + title', () => {
    const pkt = openBookNew({
      serial: 99, writable: true, pages: 0, title: 'Draft', author: 'Scribe',
    });
    const r = readBookHeader(pkt);
    expect(r.serial).toBe(99);
    expect(r.writable).toBe(true);
    expect(r.title).toBe('Draft');
    expect(r.author).toBe('Scribe');
  });

  it('readBookHeader decodes UTF-8 title and author bytes', () => {
    const pkt = openBookNew({
      serial: 100, writable: true, pages: 0, title: 'Caf\u00e9', author: 'Bj\u00f6rn',
    });
    const r = readBookHeader(pkt);
    expect(r.title).toBe('Caf\u00e9');
    expect(r.author).toBe('Bj\u00f6rn');
  });

  it('clientVersionRequest packs the ServUO 0xBD request frame', () => {
    expect(Array.from(clientVersionRequest())).toEqual([0xBD, 0x00, 0x03]);
  });
});

describe('combat atoms', () => {
  it('warmode packs 5 bytes; readWarmode round-trips', () => {
    const on = warmode(true);
    expect(on.length).toBe(5);
    expect(on[0]).toBe(0x72);
    expect(on[1]).toBe(1);
    expect(readWarmode(on).warmode).toBe(true);
    expect(readWarmode(warmode(false)).warmode).toBe(false);
  });

  it('playerAnimation produces 14 bytes', () => {
    const pkt = playerAnimation({ serial: 7, action: Anim.Salute });
    expect(pkt.length).toBe(14);
    expect(pkt[0]).toBe(0x6E);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint32(1)).toBe(7);
    expect(dv.getUint16(5)).toBe(Anim.Salute);
  });

  it('newPlayerAnimation 10 bytes', () => {
    const pkt = newPlayerAnimation({ serial: 7, action: 4, subAction: 1 });
    expect(pkt.length).toBe(10);
    expect(pkt[0]).toBe(0xE2);
  });

  it('damagePacket is 7 bytes', () => {
    const pkt = damagePacket({ serial: 7, amount: 250 });
    expect(pkt.length).toBe(7);
    expect(pkt[0]).toBe(0x0B);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(5)).toBe(250);
  });
});

describe('unicodePrompt (0xC2)', () => {
  it('encodes text and echoes promptId', () => {
    const pkt = unicodePrompt({ serial: 7, promptId: 42, text: 'Hi' });
    expect(pkt[0]).toBe(0xC2);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(1)).toBe(pkt.length);
    expect(dv.getUint32(3)).toBe(7);
    expect(dv.getUint32(7)).toBe(42);
  });

  it('readUnicodePromptReply parses ok and cancel', () => {
    // Build a reply: serial=7, promptId=42, type=1 (reply), lang=ENU\0, "Hello"
    const w = new PacketWriter(32);
    w.writeU8(0xC2); const lp = w.length; w.writeU16(0);
    w.writeU32(7); w.writeU32(42); w.writeU32(1);
    w.writeU8('E'.charCodeAt(0)); w.writeU8('N'.charCodeAt(0));
    w.writeU8('U'.charCodeAt(0)); w.writeU8(0);
    for (const ch of 'Hello') {
      w.writeU8(0); w.writeU8(ch.charCodeAt(0));
    }
    w.writeU8(0); w.writeU8(0);
    w.setU16At(lp, w.length);
    const r = readUnicodePromptReply(w.bytes());
    expect(r.serial).toBe(7);
    expect(r.promptId).toBe(42);
    expect(r.cancelled).toBe(false);
    expect(r.text).toBe('Hello');
  });
});
