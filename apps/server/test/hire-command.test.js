import { describe, it, expect } from 'vitest';
import registerHire, { _HIRE_CONST } from '../../scripts/src/commands/economy/hire.js';
import { World } from '../src/world/world.js';
import { createItem, destroyItem } from '../src/world/items.js';

function fakeApi(world) {
  const commands = new Map();
  const ai = {
    attached: [],
    detached: [],
    attach(mob, behavior, state) {
      this.attached.push({ serial: mob.serial, behavior, state });
    },
    detach(mob) {
      this.detached.push(mob.serial);
    },
  };
  return {
    world,
    commands: {
      register: (cmd) => commands.set(cmd.name, cmd),
      unregister: (name) => commands.delete(name),
    },
    items: { createItem, destroyItem },
    protocol: { mobileIncoming: () => new Uint8Array([0x78]) },
    ai,
    _cmds: commands,
  };
}

function addBackpackWithGold(world, mob, amount) {
  const pack = createItem(world, {
    itemId: 0x0E75,
    parent: mob.serial,
    layer: 21,
    gumpId: 0x003C,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    map: mob.map,
  });
  const gold = createItem(world, {
    itemId: 0x0EED,
    amount,
    parent: pack.serial,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    map: mob.map,
  });
  return { pack, gold };
}

function runHire(role, goldAmount = 5000) {
  const world = new World();
  const api = fakeApi(world);
  const unregister = registerHire(api);
  const player = world.createMobile({
    name: 'player',
    body: 0x190,
    x: 100,
    y: 100,
    z: 0,
    map: 1,
  });
  const inventory = addBackpackWithGold(world, player, goldAmount);
  const messages = [];
  const ctx = {
    sender: player,
    args: [role],
    state: { sendSystemMessage: (msg) => messages.push(msg) },
  };
  try {
    api._cmds.get('hire').run(ctx);
    const hirelings = [...world.mobiles.values()].filter((m) => m.serial !== player.serial);
    return { world, api, player, inventory, messages, hireling: hirelings[0] ?? null };
  } finally {
    unregister();
  }
}

describe('hire command', () => {
  it('hires ServUO-style role variants with canonical hireling kind', () => {
    const { api, player, inventory, messages, hireling } = runHire('paladin');

    expect(hireling).toMatchObject({
      kind: 'hireling-paladin',
      hireRole: 'paladin',
      controlMaster: player.serial,
      team: player.serial,
      hp: 130,
      hpMax: 130,
      str: 95,
      dex: 75,
      int: 70,
    });
    expect(hireling.paidUntil).toBeGreaterThan(Date.now());
    expect(inventory.gold.amount).toBe(2800);
    expect(api.ai.attached).toEqual([
      { serial: hireling.serial, behavior: 'pet', state: { command: 'follow', targetSerial: 0 } },
    ]);
    expect(messages.at(-1)).toContain('paladin for hire pledges to follow you');
  });

  it('keeps fighter as an alias for the warrior hireling', () => {
    const { inventory, hireling } = runHire('fighter', 1000);

    expect(hireling.kind).toBe('hireling-warrior');
    expect(hireling.hireRole).toBe('warrior');
    expect(inventory.gold.amount).toBe(0);
  });

  it('publishes costs for every accepted role alias', () => {
    expect(_HIRE_CONST.HIRE_COST).toMatchObject({
      fighter: 1000,
      warrior: 1000,
      archer: 1500,
      mage: 2000,
      thief: 1500,
      bard: 1800,
      paladin: 2200,
      beggar: 250,
    });
  });
});
