import { beforeEach, describe, expect, it, vi } from 'vitest';

import registerBanker from '../../scripts/src/npcs/vendors/banker.js';
import { World } from '../src/world/world.js';

function fixture() {
  const world = new World();
  const commands = new Map();
  const sentContents = [];
  const given = [];
  let behavior = null;
  const api = {
    world,
    ctx: { bankBoxes: new Map() },
    commands: {
      register(command) { commands.set(command.name, command); },
      unregister(name) { commands.delete(name); },
    },
    ai: {
      registerBehavior(value) { behavior = value; },
      unregisterBehavior() {},
      attach: vi.fn(),
    },
    game: {
      inventory: {
        findBackpack(mob) { return mob.backpack ?? null; },
      },
      mobile: {
        giveItem: vi.fn((mob, data) => { given.push({ mob, data }); return data; }),
      },
    },
    protocol: {
      displayContainer: () => new Uint8Array([0x24]),
      containerContents: (_serial, entries) => {
        sentContents.push(entries);
        return new Uint8Array([0x3c]);
      },
      mobileIncoming: () => new Uint8Array([0x78]),
    },
    _commands: commands,
    _behavior: () => behavior,
    _sentContents: sentContents,
    _given: given,
  };
  registerBanker(api);
  return api;
}

function hear(behavior, banker, state, speaker, text, now) {
  banker._heardSpeech = [{ speaker, text, hue: 0x3b2 }];
  behavior.tick({ now, broadcastSpeech: vi.fn() }, banker, state);
}

describe('banker AI', () => {
  let api;
  let world;
  let banker;
  let speaker;
  let state;
  let messages;

  beforeEach(() => {
    api = fixture();
    world = api.world;
    banker = world.createMobile({ name: 'Banker', x: 100, y: 100, z: 0, map: 1 });
    speaker = world.createMobile({ name: 'Customer', x: 101, y: 100, z: 0, map: 1 });
    speaker.backpack = world.createItem({ itemId: 0x0e75, parent: speaker.serial, map: 1 });
    messages = [];
    speaker.client = {
      send: vi.fn(),
      sendSystemMessage: (text) => messages.push(String(text)),
    };
    state = api._behavior().initState();
  });

  it('sends the actual bank contents instead of an always-empty snapshot', () => {
    hear(api._behavior(), banker, state, speaker, 'bank', 5_000);
    const box = world.items.get(api.ctx.bankBoxes.get(speaker.serial));
    world.createItem({ itemId: 0x0eed, amount: 75, parent: box.serial, map: 1 });

    hear(api._behavior(), banker, state, speaker, 'bank', 10_000);

    expect(api._sentContents.at(-1)).toEqual([
      expect.objectContaining({ itemId: 0x0eed, amount: 75 }),
    ]);
  });

  it('rejects an underfunded withdrawal atomically', () => {
    hear(api._behavior(), banker, state, speaker, 'bank', 5_000);
    const box = world.items.get(api.ctx.bankBoxes.get(speaker.serial));
    const gold = world.createItem({ itemId: 0x0eed, amount: 50, parent: box.serial, map: 1 });

    hear(api._behavior(), banker, state, speaker, 'withdraw 100', 10_000);

    expect(gold.amount).toBe(50);
    expect(api.game.mobile.giveItem).not.toHaveBeenCalled();
    expect(messages).toContain('Thou hast not the gold in thy account.');
  });

  it('spawns bankers subscribed to every supported banking keyword', () => {
    const admin = world.createMobile({ name: 'Admin', x: 10, y: 20, z: 0, map: 1 });
    api._commands.get('banker').run({
      sender: admin,
      state: { sendSystemMessage: vi.fn() },
    });
    const spawned = [...world.mobiles.values()].at(-1);

    expect(spawned?._speechKeywords).toEqual(['bank', 'balance', 'withdraw', 'check']);
    expect(api.ai.attach).toHaveBeenCalledWith(spawned, 'banker');
  });

  it('throttles each customer independently', () => {
    const second = world.createMobile({ name: 'Second Customer', x: 101, y: 101, z: 0, map: 1 });
    second.client = { send: vi.fn(), sendSystemMessage: vi.fn() };

    hear(api._behavior(), banker, state, speaker, 'bank', 5_000);
    hear(api._behavior(), banker, state, second, 'bank', 5_001);

    expect(api.ctx.bankBoxes.has(speaker.serial)).toBe(true);
    expect(api.ctx.bankBoxes.has(second.serial)).toBe(true);
  });
});
