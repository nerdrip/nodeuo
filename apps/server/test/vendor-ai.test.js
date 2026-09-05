// Vendor NPC behavior: wanders within a short leash around its home and
// greets passing players on a per-player cooldown. Shares the direct-tick
// pattern used in healer-ai.test.js / mage-ai.test.js.

import { describe, it, expect, beforeEach } from 'vitest';
import registerVendor, { VENDOR_KINDS } from '../../scripts/src/npcs/vendors/vendor.js';
import { resolveItemType } from '../src/world/item-types.js';

function makeApi(world) {
  let behavior = null;
  const stepped = [];
  return {
    world,
    log: () => {},
    ai: {
      registerBehavior(b) { behavior = b; },
      unregisterBehavior() {},
      attach() {},
      stepMobile(mob, dir) {
        stepped.push({ serial: mob.serial, dir });
        // Treat every direction as walkable — the scheduler already handles
        // the movement-math path in production; this test only cares that
        // the behavior issued a step.
        mob.direction = dir & 7;
        return true;
      },
    },
    items: { createItem: () => ({}), destroyItem: () => {} },
    protocol: {
      mobileIncoming: () => new Uint8Array([0x78]),
      containerContentUpdate: () => new Uint8Array([0x25]),
      removeEntity: () => new Uint8Array([0x1D]),
    },
    commands: { register: () => {}, unregister: () => {} },
    vendors: { register: () => {} },
    itemTypes: { resolve: resolveItemType },
    _behavior: () => behavior,
    _stepped: stepped,
  };
}

function makeWorld() { return { mobiles: new Map(), items: new Map() }; }

describe('vendor NPC behavior', () => {
  /** @type {any} */ let api;
  /** @type {any} */ let world;
  /** @type {any} */ let vendor;
  /** @type {any} */ let state;
  /** @type {any} */ let behavior;
  /** @type {string[]} */ let spoken;
  /** @type {number[]} */ let moved;

  beforeEach(() => {
    world = makeWorld();
    api = makeApi(world);
    registerVendor(api);
    behavior = api._behavior();
    vendor = {
      serial: 0x4100, x: 100, y: 100, z: 0, map: 1,
      body: 0x0190, direction: 0, hue: 0x83EA, notoriety: 1,
    };
    world.mobiles.set(vendor.serial, vendor);
    state = behavior.initState();
    spoken = [];
    moved = [];
  });

  function tick(now) {
    behavior.tick({
      world, now,
      broadcastMove: (m) => { moved.push(m.serial); },
      broadcastSpeech: (_m, text) => { spoken.push(text); },
    }, vendor, state);
  }

  it('locks in a home on the first tick', () => {
    tick(1000);
    expect(state.home).toEqual({ x: 100, y: 100 });
  });

  it('greets a nearby player and remembers them on cooldown', () => {
    const player = {
      serial: 0x5101, x: 102, y: 100, z: 0, map: 1,
      hp: 100, hpMax: 100, notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);

    tick(1000);
    expect(spoken.length).toBe(1);
    const firstLine = spoken[0];

    // Same tick window — no second greeting.
    tick(2000);
    expect(spoken.length).toBe(1);
    expect(spoken[0]).toBe(firstLine);

    // Still inside the 45s per-player cooldown.
    tick(40_000);
    expect(spoken.length).toBe(1);

    // Past the cooldown — greet again.
    tick(60_000);
    expect(spoken.length).toBe(2);
  });

  it('ignores players out of range', () => {
    const faraway = {
      serial: 0x5102, x: 120, y: 120, z: 0, map: 1,
      notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(faraway.serial, faraway);
    tick(1000);
    expect(spoken).toHaveLength(0);
  });

  it('faces the greeted player', () => {
    const player = {
      serial: 0x5103, x: 103, y: 100, z: 0, map: 1,
      notoriety: 1, client: { send: () => {} },
    };
    world.mobiles.set(player.serial, player);
    tick(1000);
    // Player is due East (dx=+1, dy=0) → direction 2.
    expect(vendor.direction).toBe(2);
  });

  it('wanders when no player is nearby', () => {
    // Arm the step clock so the behavior wants to move immediately.
    state.nextStepAt = 0;
    tick(1000);
    expect(api._stepped.length).toBe(1);
    expect(moved).toContain(vendor.serial);
  });

  it('heads back toward home when drifted past the leash', () => {
    state.home = { x: 100, y: 100 };
    state.nextStepAt = 0;
    vendor.x = 110; vendor.y = 100; // 10 tiles east of home
    tick(1000);
    // atan2(0, -10) = PI → direction 6 (W). Accept 5..7 for rounding.
    expect(api._stepped.length).toBe(1);
    const dir = api._stepped[0].dir;
    expect([5, 6, 7]).toContain(dir);
  });

  it('skips ghosts when picking a greet target', () => {
    const ghost = {
      serial: 0x5104, x: 101, y: 100, z: 0, map: 1,
      notoriety: 1, ghost: true, client: { send: () => {} },
    };
    world.mobiles.set(ghost.serial, ghost);
    tick(1000);
    expect(spoken).toHaveLength(0);
  });

  it('uses ServUO potion art ids and charges through a restored vendor binding', () => {
    const expectedPotionArt = new Map([
      ['heal potion', 0x0F0C], ['lesser heal potion', 0x0F0C],
      ['agility potion', 0x0F08], ['refresh potion', 0x0F0B],
      ['strength potion', 0x0F09], ['cure potion', 0x0F07],
      ['poison potion', 0x0F0A],
    ]);
    for (const stock of VENDOR_KINDS.alchemist.stock) {
      if (expectedPotionArt.has(stock.name)) {
        expect(stock.itemId, stock.name).toBe(expectedPotionArt.get(stock.name));
      }
    }

    const restoredVendor = {
      serial: 0x2200, vendorKind: 'alchemist', name: 'Veronica',
      x: 100, y: 100, z: 0, map: 1, body: 0x191, direction: 0, hue: 0,
    };
    const buyer = { serial: 0x3300, x: 101, y: 100, z: 0, map: 1, client: {} };
    const pack = { serial: 0x40000100, itemId: 0x0E75, parent: buyer.serial, layer: 21 };
    const gold = { serial: 0x40000101, itemId: 0x0EED, amount: 60, parent: pack.serial };
    const bindings = new Map();
    const delivered = [];
    const testWorld = {
      mobiles: new Map([
        [restoredVendor.serial, restoredVendor],
        [buyer.serial, buyer],
      ]),
      items: new Map([[pack.serial, pack], [gold.serial, gold]]),
    };
    const restoredApi = {
      world: testWorld,
      log() {},
      ai: { registerBehavior() {}, unregisterBehavior() {}, attach() {} },
      commands: { register() {}, unregister() {} },
      vendors: {
        register(binding) { bindings.set(binding.vendorSerial, binding); },
        get(serial) { return bindings.get(serial); },
      },
      itemTypes: { resolve: resolveItemType },
      items: { createItem: () => ({}), destroyItem: (_world, serial) => testWorld.items.delete(serial) },
      game: {
        inventory: {
          findBackpack: () => pack,
          *packItems() { yield gold; },
        },
        mobile: {
          giveItem(_buyer, data) {
            delivered.push(data);
            return { serial: 0x40000200, ...data, gridX: 0, gridY: 0 };
          },
        },
      },
      protocol: {
        containerContentUpdate: () => new Uint8Array([0x25]),
        removeEntity: () => new Uint8Array([0x1D]),
      },
    };
    registerVendor(restoredApi);
    const binding = bindings.get(restoredVendor.serial);
    const heal = binding.listStock().find((entry) => entry.description === 'heal potion');
    const messages = [];
    binding.onBuy({
      mobile: buyer, account: { accessLevel: 'Player' },
      send() {}, sendSystemMessage(message) { messages.push(message); },
    }, [{ serial: heal.serial, amount: 1 }]);

    expect(gold.amount).toBe(10);
    expect(delivered[0]).toMatchObject({ itemId: 0x0F0C, name: 'heal potion', amount: 1 });
    expect(messages.at(-1)).toMatch(/paid 50 gp/);

    const manual = binding.listStock().find((entry) => entry.definitionId === 'GlassblowingBook');
    expect(manual).toMatchObject({
      script: 'imbue-recipe-scroll', recipeUnlock: 'glassblowing',
    });
    binding.onBuy({
      mobile: buyer, account: { accessLevel: 'Admin' },
      send() {}, sendSystemMessage() {},
    }, [{ serial: manual.serial, amount: 1 }]);
    expect(delivered.at(-1)).toMatchObject({
      definitionId: 'GlassblowingBook', script: 'imbue-recipe-scroll',
      recipeUnlock: 'glassblowing',
    });
  });

  it('sells functional spellcraft supplies with stable definitions', () => {
    expect(VENDOR_KINDS.scribe.stock).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: 'blank-scroll', itemId: 0x0E34, category: 'blank-scroll',
      }),
      expect.objectContaining({
        definitionId: 'spell-schema-codex', script: 'spell-schema-codex',
      }),
    ]));
    expect(VENDOR_KINDS.mage.stock).toEqual(expect.arrayContaining([
      expect.objectContaining({
        definitionId: 'spell-schema-codex', script: 'spell-schema-codex',
      }),
    ]));
  });
});
