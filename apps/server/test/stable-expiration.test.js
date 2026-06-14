// FAZA DJ — stable expiration: pets stabled longer than 30 days run
// off on next list/withdraw.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import buildStable from '../../scripts/src/commands/economy/stable.js';

function fakeApi(world) {
  const cmds = new Map();
  return {
    world,
    commands: { register: (c) => cmds.set(c.name, c), unregister: (n) => cmds.delete(n) },
    protocol: {
      mobileIncoming: () => new Uint8Array([0x78]),
      removeEntity: () => new Uint8Array([0x1D]),
    },
    ai: { detach: () => {}, attach: () => {} },
    _cmds: cmds,
  };
}

describe('stable expiration (FAZA DJ)', () => {
  it('pets boarded < 30 days survive the next list', async () => {
    const w = new World();
    const api = fakeApi(w);
    buildStable(api);
    const owner = w.createMobile({ name: 'o', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    let lastMsg = '';
    owner.client = { send: () => {}, sendSystemMessage: (s) => { lastMsg = s; } };
    owner.stabled = [{
      name: 'rex', kind: 'wolf', body: 0xE1,
      stabledAt: Date.now() - (5 * 24 * 60 * 60 * 1000),
    }];
    api._cmds.get('stable').run({
      sender: owner, args: ['list'],
      state: { sendSystemMessage: (s) => { lastMsg = s; } },
    });
    expect(owner.stabled.length).toBe(1);
    expect(lastMsg).toContain('rex');
  });

  it('pets boarded > 30 days run off on next list', () => {
    const w = new World();
    const api = fakeApi(w);
    buildStable(api);
    const owner = w.createMobile({ name: 'o', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const messages = [];
    owner.client = { send: () => {}, sendSystemMessage: (s) => messages.push(s) };
    owner.stabled = [
      { name: 'rex', kind: 'wolf', stabledAt: Date.now() - (35 * 24 * 60 * 60 * 1000) },
      { name: 'fluffy', kind: 'cat', stabledAt: Date.now() - (1 * 24 * 60 * 60 * 1000) },
    ];
    api._cmds.get('stable').run({
      sender: owner, args: ['list'],
      state: { sendSystemMessage: (s) => messages.push(s) },
    });
    expect(owner.stabled.length).toBe(1);
    expect(owner.stabled[0].name).toBe('fluffy');
    expect(messages.some((m) => m.includes('ran off'))).toBe(true);
  });

  it('store snapshots stable timestamp + training fields', () => {
    const w = new World();
    const api = fakeApi(w);
    buildStable(api);
    const owner = w.createMobile({ name: 'o', body: 0x190, x: 50, y: 50, z: 0, map: 1 });
    owner.client = { send: () => {}, sendSystemMessage: () => {} };
    const pet = w.createMobile({ name: 'rex', body: 0xE1, x: 50, y: 51, z: 0, map: 1 });
    pet.controlMaster = owner.serial >>> 0;
    pet.petXp = 1500; pet.petLevel = 1;
    api._cmds.get('stable').run({
      sender: owner, args: ['store'],
      state: { sendSystemMessage: () => {} },
    });
    expect(owner.stabled.length).toBe(1);
    expect(owner.stabled[0].stabledAt).toBeGreaterThan(0);
    expect(owner.stabled[0].petXp).toBe(1500);
    expect(owner.stabled[0].petLevel).toBe(1);
  });
});
