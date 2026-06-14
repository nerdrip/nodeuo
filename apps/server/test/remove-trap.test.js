import { describe, it, expect, vi, beforeEach } from 'vitest';
import register from '../../scripts/src/skills/remove-trap.js';

function makeApi() {
  const commands = new Map();
  const items = new Map();
  let targetCb = null;
  const api = {
    world: { items },
    commands: {
      register: (def) => commands.set(def.name, def),
      unregister: (n) => commands.delete(n),
    },
    targeting: { request: (_state, cb) => { targetCb = cb; } },
    items: {
      destroyItem: (_w, serial) => { items.delete(serial); },
    },
    combat: { damage: vi.fn() },
    skillGain: { tryGain: vi.fn() },
    _trigger: (picked) => { targetCb?.(picked); targetCb = null; },
  };
  return { api, commands, items };
}

function makeSender({ removeTrap = 80, x = 0, y = 0 } = {}) {
  return {
    serial: 1,
    x, y,
    skills: { 49: removeTrap * 10, 22: 0 },
    client: { sendSystemMessage: vi.fn() },
  };
}

describe('Remove Trap skill', () => {
  let env;
  beforeEach(() => { env = makeApi(); register(env.api); });

  it('registers the [removetrap command', () => {
    expect(env.commands.has('removetrap')).toBe(true);
  });

  it('refuses non-trap items', () => {
    const sender = makeSender();
    const trapped = { serial: 100, x: 0, y: 0, kind: 'gold-coin' };
    env.api.world.items.set(100, trapped);
    const ctx = { sender, state: sender.client, args: [] };
    env.commands.get('removetrap').run(ctx);
    env.api._trigger({ serial: 100 });
    expect(sender.client.sendSystemMessage).toHaveBeenCalledWith('That is not trapped.');
    expect(env.api.world.items.has(100)).toBe(true);
  });

  it('refuses out-of-range traps', () => {
    const sender = makeSender({ x: 0, y: 0 });
    const trap = { serial: 200, x: 5, y: 5, kind: 'spike-trap' };
    env.api.world.items.set(200, trap);
    const ctx = { sender, state: sender.client, args: [] };
    env.commands.get('removetrap').run(ctx);
    env.api._trigger({ serial: 200 });
    expect(sender.client.sendSystemMessage).toHaveBeenCalledWith('You must be next to the trap to disarm it.');
    expect(env.api.world.items.has(200)).toBe(true);
  });

  it('destroys a kind-tagged trap on success', () => {
    const sender = makeSender({ removeTrap: 100 });
    const trap = { serial: 300, x: 1, y: 0, kind: 'spike-trap' };
    env.api.world.items.set(300, trap);
    // Pin the RNG so the roll is below the skill threshold.
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const ctx = { sender, state: sender.client, args: [] };
    env.commands.get('removetrap').run(ctx);
    env.api._trigger({ serial: 300 });
    expect(env.api.world.items.has(300)).toBe(false);
    expect(sender.client.sendSystemMessage).toHaveBeenCalledWith('You disarm the trap.');
    Math.random.mockRestore();
  });

  it('clears chest trapPower on success without destroying chest', () => {
    const sender = makeSender({ removeTrap: 100 });
    const chest = { serial: 400, x: 0, y: 1, kind: 'puzzle-chest', trapPower: 60 };
    env.api.world.items.set(400, chest);
    vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const ctx = { sender, state: sender.client, args: [] };
    env.commands.get('removetrap').run(ctx);
    env.api._trigger({ serial: 400 });
    expect(env.api.world.items.has(400)).toBe(true);
    expect(chest.trapPower).toBe(0);
    Math.random.mockRestore();
  });

  it('cooldown blocks rapid retries', () => {
    const sender = makeSender();
    const ctx = { sender, state: sender.client, args: [] };
    env.commands.get('removetrap').run(ctx);
    env.api._trigger({ serial: 999 }); // bad serial — no-op
    env.commands.get('removetrap').run(ctx);
    expect(sender.client.sendSystemMessage).toHaveBeenCalledWith(
      'You must wait before attempting another disarm.',
    );
  });
});
