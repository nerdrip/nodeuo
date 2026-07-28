import { describe, expect, it, vi } from 'vitest';
import registerSeason from '../../scripts/src/commands/system/season.js';

describe('season command gump', () => {
  it('offers local previews and a persistent shard-wide apply action', () => {
    let command;
    let definition;
    let respond;
    const localPackets = [];
    const remotePackets = [];
    const state = {
      send: vi.fn((packet) => localPackets.push(packet)),
      sendSystemMessage: vi.fn(),
    };
    const remoteState = { send: vi.fn((packet) => remotePackets.push(packet)) };
    const world = {
      mobiles: new Map([
        [1, { serial: 1, client: state }],
        [2, { serial: 2, client: remoteState }],
      ]),
    };
    const api = {
      world,
      commands: {
        register(value) { command = value; },
        unregister() {},
      },
      gumps: {
        send(_state, value, callback) { definition = value; respond = callback; },
      },
      dayNight: { season: 1 },
      protocol: { seasonChange: (season, sound) => ({ season, sound }) },
    };
    registerSeason(api);
    const ctx = { state, sender: world.mobiles.get(1), args: [] };

    command.run(ctx);
    expect(definition.gumpId).toBe(0x53454153);
    expect(definition.texts).toContain('Season laboratory');
    expect(definition.texts).toContain('● 1. Summer');

    respond({ buttonId: 103 });
    expect(localPackets.at(-1)).toEqual({ season: 3, sound: 1 });
    expect(remotePackets).toEqual([]);
    expect(api.dayNight.season).toBe(1);

    respond({ buttonId: 202 });
    expect(api.dayNight.season).toBe(2);
    expect(localPackets.at(-1)).toEqual({ season: 2, sound: 1 });
    expect(remotePackets.at(-1)).toEqual({ season: 2, sound: 1 });
  });

  it('keeps numeric syntax and rejects invalid season ids', () => {
    let command;
    const state = { send: vi.fn(), sendSystemMessage: vi.fn() };
    const api = {
      world: { mobiles: new Map([[1, { client: state }]]) },
      commands: { register(value) { command = value; }, unregister() {} },
      dayNight: { season: 1 },
      protocol: { seasonChange: (season) => ({ season }) },
    };
    registerSeason(api);

    command.run({ state, args: ['4'] });
    expect(api.dayNight.season).toBe(4);
    command.run({ state, args: ['99'] });
    expect(api.dayNight.season).toBe(4);
    expect(state.sendSystemMessage).toHaveBeenLastCalledWith(expect.stringContaining('Usage'));
  });
});
