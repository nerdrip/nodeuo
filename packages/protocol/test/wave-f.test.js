// Wave F packets: party, trade, help, guild.

import { describe, it, expect } from 'vitest';
import {
  partyList, partyRemove, partyMessage, partyInvitation, readPartyCommand,
  tradeOpen, tradeClose, tradeCheck, tradeUpdateGold, readTradeCommand,
  readHelpRequest,
  guildMessage, readGuildMessage,
} from '../src/index.js';
import { PacketWriter } from '../src/buffer.js';

function buildPartyPacket(sub, payload) {
  const w = new PacketWriter(32);
  w.writeU8(0xBF); const lp = w.length; w.writeU16(0);
  w.writeU16(0x0006); w.writeU8(sub);
  for (const b of payload) w.writeU8(b);
  w.setU16At(lp, w.length);
  return w.bytes();
}

describe('party', () => {
  it('partyList includes every member serial', () => {
    const pkt = partyList([1, 2, 3]);
    expect(pkt[0]).toBe(0xBF);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(3)).toBe(0x0006);
    expect(dv.getUint8(5)).toBe(0x01);
    expect(dv.getUint8(6)).toBe(3);
    expect(dv.getUint32(7)).toBe(1);
    expect(dv.getUint32(11)).toBe(2);
    expect(dv.getUint32(15)).toBe(3);
  });

  it('partyRemove lists removed + remaining', () => {
    const pkt = partyRemove(9, [1, 2]);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(5)).toBe(0x02);
    expect(dv.getUint8(6)).toBe(2);
    expect(dv.getUint32(7)).toBe(9);
    expect(dv.getUint32(11)).toBe(1);
    expect(dv.getUint32(15)).toBe(2);
  });

  it('partyMessage encodes UTF-16BE and null-terminates', () => {
    const pkt = partyMessage(42, 'hi', true);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(5)).toBe(0x04);
    expect(dv.getUint32(6)).toBe(42);
    expect(dv.getUint16(10)).toBe(0x0068); // 'h'
    expect(dv.getUint16(12)).toBe(0x0069); // 'i'
    expect(dv.getUint16(14)).toBe(0x0000);
  });

  it('partyInvitation carries the leader serial', () => {
    const pkt = partyInvitation(0xDEADBEEF);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(5)).toBe(0x07);
    expect(dv.getUint32(6)).toBe(0xDEADBEEF);
  });

  it('readPartyCommand parses add/accept/decline/remove/canLoot', () => {
    const add = readPartyCommand(buildPartyPacket(0x01, [0, 0, 0, 0x2A]));
    expect(add).toEqual({ kind: 'add', target: 42 });
    const rem = readPartyCommand(buildPartyPacket(0x02, [0, 0, 0, 0x2A]));
    expect(rem.kind).toBe('remove');
    const acc = readPartyCommand(buildPartyPacket(0x08, [0, 0, 0, 9]));
    expect(acc).toEqual({ kind: 'accept', leader: 9 });
    const dec = readPartyCommand(buildPartyPacket(0x09, [0, 0, 0, 9]));
    expect(dec).toEqual({ kind: 'decline', leader: 9 });
    const loot = readPartyCommand(buildPartyPacket(0x06, [1]));
    expect(loot).toEqual({ kind: 'canLoot', canLoot: true });
  });

  it('readPartyCommand parses tell-all with UTF-16BE text', () => {
    const payload = [0x00, 0x68, 0x00, 0x69, 0x00, 0x00]; // "hi\0"
    const pkt = buildPartyPacket(0x04, payload);
    const parsed = readPartyCommand(pkt);
    expect(parsed.kind).toBe('tellAll');
    expect(parsed.text).toBe('hi');
  });
});

describe('trade', () => {
  it('tradeOpen carries all three serials', () => {
    const pkt = tradeOpen({ containerSerial: 1, otherSerial: 2, ourSerial: 3, partnerName: 'Bob' });
    expect(pkt[0]).toBe(0x6F);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(3)).toBe(0x00);
    expect(dv.getUint32(4)).toBe(1);
    expect(dv.getUint32(8)).toBe(2);
    expect(dv.getUint32(12)).toBe(3);
    expect(dv.getUint8(16)).toBe(1); // hasName
    expect(String.fromCharCode(dv.getUint8(17), dv.getUint8(18), dv.getUint8(19))).toBe('Bob');
    expect(dv.getUint8(20)).toBe(0); // NUL
  });

  it('tradeClose wraps the container serial', () => {
    const pkt = tradeClose(0x40000001);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint8(3)).toBe(0x01);
    expect(dv.getUint32(4)).toBe(0x40000001);
  });

  it('tradeCheck + tradeUpdateGold pack booleans and amounts', () => {
    const chk = tradeCheck({ containerSerial: 9, first: true, second: false });
    const dvc = new DataView(chk.buffer, chk.byteOffset, chk.byteLength);
    expect(dvc.getUint32(4)).toBe(9);
    expect(dvc.getUint32(8)).toBe(1);
    expect(dvc.getUint32(12)).toBe(0);

    const gold = tradeUpdateGold({ containerSerial: 9, gold: 1000, platinum: 7 });
    const dvg = new DataView(gold.buffer, gold.byteOffset, gold.byteLength);
    expect(dvg.getUint8(3)).toBe(0x03);
    expect(dvg.getUint32(8)).toBe(1000);
    expect(dvg.getUint32(12)).toBe(7);
  });

  it('readTradeCommand decodes close and check', () => {
    expect(readTradeCommand(tradeClose(5))).toEqual({ kind: 'close', containerSerial: 5 });
    const parsed = readTradeCommand(tradeCheck({ containerSerial: 5, first: true, second: true }));
    expect(parsed).toEqual({ kind: 'check', containerSerial: 5, first: true, second: true });
  });
});

describe('help', () => {
  it('readHelpRequest accepts a 0x9B packet', () => {
    const pkt = new Uint8Array(258);
    pkt[0] = 0x9B;
    expect(readHelpRequest(pkt)).toEqual({ received: 258 });
  });
  it('readHelpRequest rejects the wrong opcode', () => {
    expect(() => readHelpRequest(new Uint8Array([0x00]))).toThrow();
  });
});

describe('guild', () => {
  it('guildMessage emits 0xBF 0x28 with name and text', () => {
    const pkt = guildMessage({ name: 'Alice', text: 'hi', hue: 0x0042 });
    expect(pkt[0]).toBe(0xBF);
    const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
    expect(dv.getUint16(3)).toBe(0x0028);
    expect(dv.getUint8(5)).toBe(0x00); // padding byte
    // 'A','l','i','c','e',0
    let o = 6;
    for (const c of 'Alice') { expect(pkt[o++]).toBe(c.charCodeAt(0)); }
    expect(pkt[o++]).toBe(0);
    for (const c of 'hi') { expect(pkt[o++]).toBe(c.charCodeAt(0)); }
    expect(pkt[o++]).toBe(0);
    expect(dv.getUint16(o)).toBe(0x0042);
  });

  it('readGuildMessage extracts the ASCII text', () => {
    const w = new PacketWriter(16);
    w.writeU8(0xBF); const lp = w.length; w.writeU16(0);
    w.writeU16(0x0028);
    for (const c of 'hello') w.writeU8(c.charCodeAt(0));
    w.writeU8(0);
    w.setU16At(lp, w.length);
    expect(readGuildMessage(w.bytes())).toEqual({ text: 'hello' });
  });
});
