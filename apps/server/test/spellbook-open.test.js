import { describe, expect, it } from 'vitest';

import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';

function openSpellbookPacket(type) {
  return new Uint8Array([0x12, 0x00, 0x05, 0x43, type & 0xff]);
}

describe('0x12 OpenSpellBook', () => {
  it('opens the matching owned spellbook via 0xBF 0x1B content', () => {
    const handlers = buildHandlers();
    const sent = [];
    const messages = [];
    const mobile = { serial: 0x100001 };
    const pack = { serial: 0x200001, itemId: 0x0E75, parent: mobile.serial, layer: 21, gumpId: 0x003C };
    const necroBook = { serial: 0x300001, itemId: 0x2253, parent: pack.serial };
    const world = { items: new Map([
      [pack.serial, pack],
      [necroBook.serial, necroBook],
    ]) };
    const state = {
      stage: Stage.InWorld,
      mobile,
      ctx: { world },
      send: (pkt) => sent.push(pkt),
      sendSystemMessage: (msg) => messages.push(msg),
    };

    handlers[0x12](state, openSpellbookPacket(1));

    expect(messages).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe(0xBF);
    expect((sent[0][3] << 8) | sent[0][4]).toBe(0x001B);
  });
});
