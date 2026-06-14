// Tests for the [loot chat command: sweep gold from nearby corpses.
// We drive the command directly (mocking the script api) rather than
// routing through the server's speech parser, so this stays hermetic.

import { describe, it, expect, beforeEach } from 'vitest';
import registerLoot from '../../scripts/src/commands/economy/loot.js';

const CORPSE_ITEM_ID = 0x2006;
const GOLD_ITEM_ID   = 0x0EED;

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeApi(world) {
  const cmds = new Map();
  return {
    world,
    log: () => {},
    protocol: {
      removeEntity: (serial) => new Uint8Array([0x1D, (serial >>> 24) & 0xff, (serial >>> 16) & 0xff, (serial >>> 8) & 0xff, serial & 0xff]),
      containerContentUpdate: (entry, container) => {
        const b = new Uint8Array(21); b[0] = 0x25;
        // Only mark for test assertions; we don't care about exact layout here.
        b[1] = (entry.serial >>> 24) & 0xff; b[2] = (entry.serial >>> 16) & 0xff;
        b[3] = (entry.serial >>> 8) & 0xff;  b[4] = entry.serial & 0xff;
        b[17] = (container >>> 24) & 0xff; b[18] = (container >>> 16) & 0xff;
        b[19] = (container >>> 8) & 0xff;  b[20] = container & 0xff;
        return b;
      },
    },
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    game: {
      inventory: {
        findBackpack(mob) {
          for (const item of world.items.values()) {
            if ((item.parent >>> 0) === (mob?.serial >>> 0) && (item.layer ?? 0) === 21) return item;
          }
          return null;
        },
      },
    },
    _cmds: cmds,
  };
}

function makeState(mob) {
  const sysmsgs = [];
  const state = {
    mobile: mob,
    sendSystemMessage(msg) { sysmsgs.push(msg); },
    _sysmsgs: sysmsgs,
  };
  return state;
}

function placeCorpse(world, serial, x, y, map = 1) {
  world.items.set(serial, { serial, itemId: CORPSE_ITEM_ID, x, y, z: 0, map, parent: null });
}

function placeGold(world, serial, parentCorpse, amount) {
  world.items.set(serial, {
    serial, itemId: GOLD_ITEM_ID, x: 0, y: 0, z: 0, map: 1,
    parent: parentCorpse, amount,
  });
}

describe('[loot command', () => {
  /** @type {ReturnType<typeof makeWorld>} */ let world;
  /** @type {ReturnType<typeof makeApi>} */   let api;
  /** @type {any} */ let mob;
  /** @type {ReturnType<typeof makeState>} */ let state;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerLoot(api);
    mob = { serial: 0x42, x: 100, y: 100, z: 0, map: 1, gold: 0, client: null };
    world.mobiles.set(mob.serial, mob);
    world.items.set(0x4000_0F00, {
      serial: 0x4000_0F00, itemId: 0x0E75, parent: mob.serial, layer: 21,
      x: 0, y: 0, z: 0, map: 1,
    });
    state = makeState(mob);
  });

  function run(...args) {
    const cmd = api._cmds.get('loot');
    cmd.run({ state, sender: mob }, args);
  }

  it('adds gold from an adjacent corpse to the mobile purse', () => {
    placeCorpse(world, 0x4000_0001, 101, 100);
    placeGold(world, 0x4000_0002, 0x4000_0001, 57);
    run();
    expect(mob.gold).toBe(57);
    expect(world.items.has(0x4000_0002)).toBe(false);
    expect(world.items.has(0x4000_0001)).toBe(true); // corpse remains
    expect(state._sysmsgs.join(' ')).toMatch(/57 gold/);
  });

  it('ignores non-gold children and corpses out of range', () => {
    placeCorpse(world, 0x4000_0010, 101, 100);
    placeGold(world, 0x4000_0011, 0x4000_0010, 10);
    // Out-of-range corpse with more gold.
    placeCorpse(world, 0x4000_0020, 200, 100);
    placeGold(world, 0x4000_0021, 0x4000_0020, 9999);
    // Non-gold in-range corpse child (should not be looted or destroyed).
    world.items.set(0x4000_0012, {
      serial: 0x4000_0012, itemId: 0x1B72, x: 0, y: 0, z: 0, map: 1,
      parent: 0x4000_0010, amount: 1,
    });
    run();
    expect(mob.gold).toBe(10);
    expect(world.items.has(0x4000_0012)).toBe(true); // shield remains
    expect(world.items.has(0x4000_0021)).toBe(true); // out-of-range gold remains
  });

  it('picks the nearest corpse when multiple are in reach', () => {
    placeCorpse(world, 0x4000_0030, 102, 100); // d=2
    placeGold(world, 0x4000_0031, 0x4000_0030, 5);
    placeCorpse(world, 0x4000_0040, 101, 100); // d=1 — nearest
    placeGold(world, 0x4000_0041, 0x4000_0040, 99);
    run();
    expect(mob.gold).toBe(99);
    expect(world.items.has(0x4000_0041)).toBe(false);
    expect(world.items.has(0x4000_0031)).toBe(true);
  });

  it('reports when no corpse is in reach', () => {
    run();
    expect(mob.gold).toBe(0);
    expect(state._sysmsgs.join(' ')).toMatch(/No corpse/);
  });

  it('reports when the corpse has no gold', () => {
    placeCorpse(world, 0x4000_0050, 101, 100);
    run();
    expect(mob.gold).toBe(0);
    expect(state._sysmsgs.join(' ')).toMatch(/no gold/);
  });

  it('[loot all reparents non-gold movable items into the player\'s backpack', () => {
    placeCorpse(world, 0x4000_0060, 101, 100);
    placeGold(world, 0x4000_0061, 0x4000_0060, 15);
    // Two items — one movable shield, one immovable bone fragment.
    world.items.set(0x4000_0062, {
      serial: 0x4000_0062, itemId: 0x1B72, x: 0, y: 0, z: 0, map: 1,
      parent: 0x4000_0060, amount: 1, movable: true,
    });
    world.items.set(0x4000_0063, {
      serial: 0x4000_0063, itemId: 0x1B17, x: 0, y: 0, z: 0, map: 1,
      parent: 0x4000_0060, amount: 1, movable: false,
    });
    // Give the player a client to receive 0x25.
    const sent = [];
    mob.client = { send: (b) => sent.push(b) };
    run('all');
    expect(mob.gold).toBe(15);
    // Shield moved into backpack.
    expect(world.items.get(0x4000_0062).parent).toBe(0x4000_0F00);
    // Bone stayed.
    expect(world.items.get(0x4000_0063).parent).toBe(0x4000_0060);
    // Client got at least one 0x25 for the reparent.
    expect(sent.some((p) => p[0] === 0x25)).toBe(true);
    expect(state._sysmsgs.join(' ')).toMatch(/1 item/);
  });

  it('[loot all reports nothing when the corpse is empty', () => {
    placeCorpse(world, 0x4000_0070, 101, 100);
    run('all');
    expect(state._sysmsgs.join(' ')).toMatch(/nothing/);
  });
});
