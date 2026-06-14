import { describe, expect, it, vi } from 'vitest';
import registerSmelt from '../../scripts/src/commands/crafting/smelt.js';
import registerPowerScrolls from '../../scripts/src/commands/crafting/powerscroll.js';
import registerRunebook from '../../scripts/src/commands/magic/runebook.js';
import registerTithe from '../../scripts/src/commands/magic/tithe.js';
import registerTrainer from '../../scripts/src/npcs/vendors/trainer.js';
import registerCook from '../../scripts/src/skills/cook.js';

function makeWorld() {
  return { items: new Map(), mobiles: new Map() };
}

function makeCommandApi(world, extra = {}) {
  const cmds = new Map();
  const updates = [];
  const removed = [];
  const destroyed = [];
  let nextSerial = 0x4000_3000;
  function* childrenOf(parentOrSerial) {
    const parent = typeof parentOrSerial === 'number' ? parentOrSerial >>> 0 : parentOrSerial?.serial >>> 0;
    for (const item of world.items.values()) {
      if ((item.parent >>> 0) === parent) yield item;
    }
  }
  function findBackpack(mob) {
    for (const item of childrenOf(mob)) {
      if ((item.layer ?? 0) === 21 || item.itemId === 0x0E76) return item;
    }
    return null;
  }
  function* descendantsOf(rootOrSerial) {
    const root = typeof rootOrSerial === 'number' ? rootOrSerial >>> 0 : rootOrSerial?.serial >>> 0;
    const stack = [root];
    while (stack.length) {
      const parent = stack.pop();
      for (const item of childrenOf(parent)) {
        yield item;
        stack.push(item.serial);
      }
    }
  }
  function* packItems(mob) {
    yield* descendantsOf(findBackpack(mob) ?? mob);
  }
  const api = {
    world,
    commands: {
      register(cmd) { cmds.set(cmd.name, cmd); },
      unregister(name) { cmds.delete(name); },
    },
    items: {
      createItem(worldArg, data) {
        expect(worldArg).toBe(world);
        const item = { serial: nextSerial++, amount: 1, hue: 0, ...data };
        world.items.set(item.serial, item);
        return item;
      },
      destroyItem(worldArg, serial) {
        expect(worldArg).toBe(world);
        destroyed.push(serial);
        world.items.delete(serial);
      },
    },
    protocol: {
      removeEntity(serial) {
        removed.push(serial);
        return { op: 'removeEntity', serial };
      },
      containerContentUpdate(entry, parent) {
        updates.push({ entry, parent });
        return { op: 'containerContentUpdate', entry, parent };
      },
    },
    skillGain: { tryGain() {} },
    log() {},
    _cmds: cmds,
    _updates: updates,
    _removed: removed,
    _destroyed: destroyed,
    ...extra,
  };
  api.game ??= {};
  api.game.inventory ??= {
    childrenOf,
    descendantsOf,
    findBackpack,
    packItems,
  };
  api.game.mobile ??= {
    giveItem(mob, data = {}, options = {}) {
      const pack = findBackpack(mob);
      if (!pack && options.requireBackpack !== false) return null;
      const gridX = data.gridX ?? data.x ?? 60;
      const gridY = data.gridY ?? data.y ?? 60;
      const item = api.items.createItem(world, {
        ...data,
        parent: data.parent ?? pack?.serial ?? mob.serial,
        map: data.map ?? mob.map ?? 1,
        x: data.x ?? gridX,
        y: data.y ?? gridY,
        z: data.z ?? 0,
        gridX,
        gridY,
        gridLocation: data.gridLocation ?? 0,
      });
      if (item && options.notify !== false && pack && mob.client) {
        mob.client.send(api.protocol.containerContentUpdate(item, pack.serial));
      }
      return item;
    },
  };
  return api;
}

function makeMob() {
  const sent = [];
  return {
    serial: 0x1001,
    x: 10,
    y: 10,
    z: 0,
    map: 1,
    skills: { 46: 100, 38: 100 },
    client: {
      account: { accessLevel: 'GM' },
      send: (packet) => sent.push(packet),
    },
    _sent: sent,
  };
}

function state() {
  const messages = [];
  return { sendSystemMessage: (msg) => messages.push(msg), _messages: messages };
}

describe('consumable hot paths', () => {
  it('[smelt consumes nested ore through destroyItem', () => {
    const world = makeWorld();
    const mob = makeMob();
    const bag = { serial: 0x4000_1000, parent: mob.serial, itemId: 0x0E76 };
    const ore = { serial: 0x4000_1001, parent: bag.serial, itemId: 0x19B7, amount: 3, map: 1 };
    const forge = { serial: 0x4000_1002, parent: null, itemId: 0x1985, x: 11, y: 10, z: 0, map: 1 };
    world.items.set(bag.serial, bag);
    world.items.set(ore.serial, ore);
    world.items.set(forge.serial, forge);
    const api = makeCommandApi(world);
    registerSmelt(api);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      api._cmds.get('smelt').run({ sender: mob, state: state(), args: [] });
    } finally {
      randomSpy.mockRestore();
    }

    expect(api._destroyed).toEqual([ore.serial]);
    expect(world.items.has(ore.serial)).toBe(false);
    expect([...world.items.values()].some((item) => item.itemId === 0x1BF2 && item.amount === 3)).toBe(true);
  });

  it('[runebook recharge consumes nested scroll and updates its container', () => {
    const world = makeWorld();
    const mob = makeMob();
    const bag = { serial: 0x4000_1100, parent: mob.serial, itemId: 0x0E76 };
    const book = { serial: 0x4000_1101, parent: bag.serial, itemId: 0x22C5, runebook: {} };
    const scroll = { serial: 0x4000_1102, parent: bag.serial, itemId: 0x1F60, amount: 2 };
    world.items.set(bag.serial, bag);
    world.items.set(book.serial, book);
    world.items.set(scroll.serial, scroll);
    const api = makeCommandApi(world, {
      systems: {
        runebook: {
          snapshot: () => ({ chargesLeft: 0, chargesMax: 10, slots: [], atlas: false }),
          recharge: () => 5,
        },
      },
    });
    registerRunebook(api);

    api._cmds.get('runebook').run({ sender: mob, state: state(), args: ['recharge'] }, ['recharge']);

    expect(scroll.amount).toBe(1);
    expect(api._updates).toContainEqual(
      expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: scroll.serial, amount: 1 }) }),
    );
  });

  it('[tithe consumes nested gold from the actual container', () => {
    const world = makeWorld();
    const mob = makeMob();
    const bag = { serial: 0x4000_1200, parent: mob.serial, itemId: 0x0E76 };
    const gold = { serial: 0x4000_1201, parent: bag.serial, itemId: 0x0EED, amount: 10 };
    world.items.set(bag.serial, bag);
    world.items.set(gold.serial, gold);
    const api = makeCommandApi(world);
    registerTithe(api);

    api._cmds.get('tithe').run({ sender: mob, state: state(), args: ['5'] });

    expect(gold.amount).toBe(5);
    expect(mob.tithingPoints).toBe(5);
    expect(api._updates).toContainEqual(
      expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: gold.serial, amount: 5 }) }),
    );
  });

  it('[cook requires a nearby heat source and cooks nested raw food', () => {
    const world = makeWorld();
    const mob = makeMob();
    mob.skills = { 14: 100 };
    const bag = { serial: 0x4000_1250, parent: mob.serial, itemId: 0x0E76 };
    const raw = { serial: 0x4000_1251, parent: bag.serial, itemId: 0x097B, amount: 1 };
    const oven = { serial: 0x4000_1252, parent: null, itemId: 0x0931, x: mob.x + 1, y: mob.y, z: 0, map: mob.map };
    world.items.set(bag.serial, bag);
    world.items.set(raw.serial, raw);
    world.items.set(oven.serial, oven);
    const api = makeCommandApi(world, {
      targeting: { request: (_state, cb) => cb({ serial: raw.serial }) },
      landProvider: { staticsAt: () => [], landAt: () => null },
    });
    registerCook(api);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      api._cmds.get('cook').run({ sender: mob, state: state(), args: [] });
    } finally {
      randomSpy.mockRestore();
    }

    expect(raw.itemId).toBe(0x097D);
    expect(raw.name).toBe('cooked food');
  });

  it('[cook refuses raw food when no heat source is nearby', () => {
    const world = makeWorld();
    const mob = makeMob();
    mob.skills = { 14: 100 };
    const bag = { serial: 0x4000_1260, parent: mob.serial, itemId: 0x0E76 };
    const raw = { serial: 0x4000_1261, parent: bag.serial, itemId: 0x097B, amount: 1 };
    world.items.set(bag.serial, bag);
    world.items.set(raw.serial, raw);
    const st = state();
    const api = makeCommandApi(world, {
      targeting: { request: (_state, cb) => cb({ serial: raw.serial }) },
      landProvider: { staticsAt: () => [], landAt: () => null },
    });
    registerCook(api);

    api._cmds.get('cook').run({ sender: mob, state: st, args: [] });

    expect(raw.itemId).toBe(0x097B);
    expect(st._messages).toContain('You need to be near a heat source to cook.');
  });

  it('[ps-combine finds power scrolls inside nested containers', () => {
    const world = makeWorld();
    const mob = makeMob();
    const bag = { serial: 0x4000_1300, parent: mob.serial, itemId: 0x0E76 };
    const a = { serial: 0x4000_1301, parent: bag.serial, itemId: 0x14EF, powerScroll: { skillId: 26, amount: 5 } };
    const b = { serial: 0x4000_1302, parent: bag.serial, itemId: 0x14EF, powerScroll: { skillId: 26, amount: 5 } };
    world.items.set(bag.serial, bag);
    world.items.set(a.serial, a);
    world.items.set(b.serial, b);
    const api = makeCommandApi(world);
    registerPowerScrolls(api);

    api._cmds.get('ps-combine').run({ sender: mob, state: state(), args: ['26'] });

    expect(api._destroyed).toEqual([a.serial, b.serial]);
    const merged = [...world.items.values()].find((item) => item.powerScroll?.skillId === 26);
    expect(merged).toMatchObject({ powerScroll: { skillId: 26, amount: 10 } });
  });

  it('skill trainer consumes nested gold from the actual container', () => {
    const world = makeWorld();
    const mob = makeMob();
    mob.skills = { 26: 0 };
    const clientMessages = [];
    mob.client.sendSystemMessage = (msg) => clientMessages.push(msg);
    const bag = { serial: 0x4000_1400, parent: mob.serial, itemId: 0x0E76 };
    const gold = { serial: 0x4000_1401, parent: bag.serial, itemId: 0x0EED, amount: 30 };
    world.items.set(bag.serial, bag);
    world.items.set(gold.serial, gold);
    const behaviors = [];
    const api = makeCommandApi(world, {
      ai: { registerBehavior: (behavior) => behaviors.push(behavior) },
      skills: { byId: new Map([[26, { name: 'Magery' }]]) },
    });
    registerTrainer(api);
    const behavior = behaviors.find((entry) => entry.name === 'trainer');
    const trainer = {
      serial: 0x2001,
      x: mob.x,
      y: mob.y,
      z: 0,
      map: mob.map,
      teaches: [26],
      _heardSpeech: [{ speaker: mob, text: 'magery' }],
    };
    const speech = [];

    behavior.tick({ now: 3000, broadcastSpeech: (_mob, text) => speech.push(text) }, trainer, behavior.initState());

    expect(gold.amount).toBe(5);
    expect(mob.skills[26]).toBe(30);
    expect(api._updates).toContainEqual(
      expect.objectContaining({ parent: bag.serial, entry: expect.objectContaining({ serial: gold.serial, amount: 5 }) }),
    );
    expect(speech).toContain('Magery — let me show you the basics.');
    expect(clientMessages.join(' ')).toMatch(/You learn Magery/);
  });
});
