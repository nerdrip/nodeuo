import { afterEach, describe, expect, it } from 'vitest';

import { buildHandlers, contextMenus } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { registerItemScript, unregisterItemScript } from '../src/world/item-scripts.js';

const TEST_CODEX_SCRIPT = 'test-arcane-schema-codex';

afterEach(() => unregisterItemScript(TEST_CODEX_SCRIPT));

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
    const necroBook = {
      serial: 0x300001, definitionId: 'necromancy-spellbook',
      itemId: 0x2253, parent: pack.serial, spellbook: true, firstSpellId: 101,
    };
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

  it('dispatches by definition script when a codex shares spellbook art', () => {
    const calls = [];
    registerItemScript({
      name: TEST_CODEX_SCRIPT,
      onUse(_world, item, user) {
        calls.push({ item, user });
        return true;
      },
    });

    const sent = [];
    const mobile = { serial: 0x100002 };
    const codex = {
      serial: 0x300002,
      definitionId: 'test-codex-sharing-art',
      itemId: 0x0EFA,
      parent: mobile.serial,
      script: TEST_CODEX_SCRIPT,
    };
    const world = {
      items: new Map([[codex.serial, codex]]),
      mobiles: new Map([[mobile.serial, mobile]]),
    };
    const state = {
      stage: Stage.InWorld,
      mobile,
      ctx: { world },
      send: (pkt) => sent.push(pkt),
      sendSystemMessage: () => {},
    };

    contextMenus.use(state, codex.serial);

    expect(calls).toEqual([{ item: codex, user: mobile }]);
    expect(sent).toEqual([]);
  });

  it('does not infer a spellbook from an untyped art id', () => {
    const sent = [];
    const messages = [];
    const mobile = { serial: 0x100003 };
    const decoration = { serial: 0x300003, itemId: 0x0EFA, parent: mobile.serial };
    const world = {
      items: new Map([[decoration.serial, decoration]]),
      mobiles: new Map([[mobile.serial, mobile]]),
    };
    contextMenus.use({
      stage: Stage.InWorld, mobile, ctx: { world },
      send: (pkt) => sent.push(pkt),
      sendSystemMessage: (message) => messages.push(message),
    }, decoration.serial);

    expect(sent).toEqual([]);
    expect(messages).toContain('You see nothing special about that.');
  });
});
