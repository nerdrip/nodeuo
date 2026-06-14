import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { registerItemScript, unregisterItemScript } from '../src/world/item-scripts.js';
import {
  registerArena, tryUnlock, _resetArenasForTest,
} from '../src/systems/bosses/peerless.js';
import { consign } from '../src/systems/economy/auction-house.js';
import buildPowerHourScript from '../../scripts/src/items/scripts/consumables/power-hour-scroll.js';
import animateDead from '../../scripts/src/spells/necro/animate-dead.js';
import buildTrophyCommand from '../../scripts/src/commands/economy/trophy.js';
import buildHairStylist from '../../scripts/src/npcs/vendors/hair-stylist.js';
import { destroyItem } from '../src/world/items.js';

const SCRIPT = '__lifecycle-delete-test';

function installDestroyTracker(seen) {
  registerItemScript({
    name: SCRIPT,
    onDestroy(world, item) {
      seen.push(item.serial);
      expect(world.items.has(item.serial)).toBe(true);
    },
  });
}

describe('audited lifecycle delete paths', () => {
  let seen;

  beforeEach(() => {
    seen = [];
    installDestroyTracker(seen);
    _resetArenasForTest();
  });

  afterEach(() => {
    unregisterItemScript(SCRIPT);
    _resetArenasForTest();
  });

  it('peerless altar key consumption fires item onDestroy', () => {
    const world = new World();
    registerArena({
      name: 'mel',
      requiredKeys: ['fairy crown'],
      bossKind: 'lady-mel',
      spawnAt: { x: 0, y: 0, z: 0, map: 1 },
      teleportTo: { x: 0, y: 0, z: 0, map: 1 },
    });
    const altar = createItem(world, { itemId: 0x1F1A, x: 0, y: 0, z: 0, map: 1 });
    altar.arenaName = 'mel';
    const key = createItem(world, {
      itemId: 0x1086,
      name: 'fairy crown',
      parent: altar.serial,
      x: 0,
      y: 0,
      z: 0,
      map: 1,
      script: SCRIPT,
    });

    expect(tryUnlock(world, altar).ok).toBe(true);
    expect(seen).toEqual([key.serial]);
    expect(world.items.has(key.serial)).toBe(false);
    expect(world._childrenByParent.get(altar.serial)?.has(key.serial)).not.toBe(true);
  });

  it('auction consign escrow destroys the live item through lifecycle hooks', () => {
    const world = new World();
    const consigner = world.createMobile({ name: 'seller', body: 0x190, gold: 10 });
    const item = createItem(world, {
      itemId: 0x13B2,
      parent: consigner.serial,
      name: 'marked bow',
      script: SCRIPT,
    });

    const result = consign(world, consigner, item, { startingBid: 100 });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([item.serial]);
    expect(world.items.has(item.serial)).toBe(false);
  });

  it('power-hour scroll consumption uses destroyItem even without a protocol remove packet', () => {
    const world = new World();
    const user = world.createMobile({ name: 'reader', body: 0x190 });
    user.client = { sendSystemMessage: () => {}, send: () => {} };
    const scroll = createItem(world, {
      itemId: 0x14F0,
      parent: user.serial,
      name: 'power hour scroll',
      script: SCRIPT,
    });
    const script = buildPowerHourScript({});

    expect(script.onUse(world, scroll, user)).toBe(true);
    expect(seen).toEqual([scroll.serial]);
    expect(world.items.has(scroll.serial)).toBe(false);
  });

  it('Animate Dead consumes the corpse through destroyItem when api.items is absent', () => {
    const world = new World();
    const caster = world.createMobile({
      name: 'necromancer',
      body: 0x190,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
    });
    const corpse = createItem(world, {
      itemId: 0x2006,
      x: 11,
      y: 10,
      z: 0,
      map: 1,
      script: SCRIPT,
    });
    corpse._originalKind = 'dragon';
    const spawned = [];
    const api = {
      world,
      ctx: {
        spawnFactory(w, kind, pos) {
          spawned.push(kind);
          return w.createMobile({ name: kind, body: 0x32, ...pos });
        },
      },
      ai: { attach: () => {} },
      protocol: { playSound: () => new Uint8Array([0x54]) },
    };

    animateDead.cast(api, {
      sender: caster,
      state: { sendSystemMessage: () => {} },
    });

    expect(spawned).toEqual(['skeletal-dragon']);
    expect(seen).toEqual([corpse.serial]);
    expect(world.items.has(corpse.serial)).toBe(false);
  });

  it('[trophy passes a serial to destroyItem when consuming the fish', () => {
    const world = new World();
    const commands = new Map();
    const mob = world.createMobile({
      name: 'angler',
      body: 0x190,
      x: 5,
      y: 5,
      z: 0,
      map: 1,
      skills: { 38: 50 },
    });
    const fish = createItem(world, {
      itemId: 0x09CC,
      parent: mob.serial,
      name: 'a big fish',
      script: SCRIPT,
    });
    fish._trophyWeight = 88;
    const api = {
      world,
      commands: { register: (cmd) => commands.set(cmd.name, cmd), unregister: () => {} },
      targeting: { request: (_state, cb) => cb({ serial: fish.serial }) },
      items: { createItem, destroyItem },
      skillGain: { tryGain: () => {} },
    };
    buildTrophyCommand(api);

    commands.get('trophy').run({
      sender: mob,
      args: [],
      state: { sendSystemMessage: () => {} },
    });

    expect(seen).toEqual([fish.serial]);
    expect(world.items.has(fish.serial)).toBe(false);
  });

  it('hair stylist drains gold and replaces worn hair through serial destroyItem calls', () => {
    const world = new World();
    const commands = new Map();
    let behavior = null;
    const speaker = world.createMobile({
      name: 'customer',
      body: 0x190,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
    });
    speaker.client = { sendSystemMessage: () => {} };
    const stylist = world.createMobile({
      name: 'stylist',
      body: 0x191,
      x: 10,
      y: 11,
      z: 0,
      map: 1,
    });
    stylist._heardSpeech = [{ text: 'haircut', speaker }];
    const pack = createItem(world, {
      itemId: 0x0E75,
      parent: speaker.serial,
      layer: 21,
    });
    const gold = createItem(world, {
      itemId: 0x0EED,
      amount: 3000,
      parent: pack.serial,
      script: SCRIPT,
    });
    const oldHair = createItem(world, {
      itemId: 0x203B,
      hue: 0x044E,
      parent: speaker.serial,
      layer: 11,
      script: SCRIPT,
    });
    const api = {
      world,
      commands: { register: (cmd) => commands.set(cmd.name, cmd), unregister: () => {} },
      protocol: {},
      ai: {
        registerBehavior(def) { behavior = def; },
        unregisterBehavior: () => {},
      },
      items: { createItem, destroyItem },
      ctx: {},
    };
    buildHairStylist(api);

    behavior.tick({ now: 10_000, broadcastSpeech: () => {} }, stylist, behavior.initState());

    expect(seen).toEqual([gold.serial, oldHair.serial]);
    expect(world.items.has(gold.serial)).toBe(false);
    expect(world.items.has(oldHair.serial)).toBe(false);
    const hairItems = [...world.items.values()].filter((it) => it.parent === speaker.serial && it.layer === 11);
    expect(hairItems).toHaveLength(1);
  });
});
