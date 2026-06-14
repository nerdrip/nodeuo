// FAZA BN: lifecycle scripts wired through items.json + bugfix #30:
//
//   1. `dispatchItemEvent` honours `item.script` and routes to the
//      registered handler.
//   2. `destroyItem()` fires the `onDestroy` hook before deletion.
//   3. `spawn()` no longer overwrites an explicit `hue: 0` with the
//      template's `defaultHue` (the previous bug treated 0 as "no
//      override given").

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { World } from '../src/world/world.js';
import { createItem, destroyItem, setItemParent } from '../src/world/items.js';
import { registerItem as registerContentItem } from '../src/content/items/index.js';
import {
  registerItemScript, unregisterItemScript, dispatchItemEvent,
} from '../src/world/item-scripts.js';
import {
  registerTemplate, unregisterTemplate, spawn,
} from '../src/world/templates.js';
import * as addons from '../src/systems/housing/addons.js';
import buildAddonDeed from '../../scripts/src/items/scripts/housing/addon-deed.js';
import buildReadableBook from '../../scripts/src/items/scripts/tools/readable-book.js';
import buildFirstAidBelt from '../../scripts/src/items/scripts/tools/first-aid-belt.js';
import buildImprisonedMobile from '../../scripts/src/items/scripts/functional/imprisoned-mobile.js';
import buildCleanupAddonContainer from '../../scripts/src/items/scripts/functional/cleanup-addon-container.js';
import {
  buildPoisonPotion, buildEodonPotion, buildEndlessDecanter,
} from '../../scripts/src/items/scripts/consumables/special-potions.js';
import buildAquarium, {
  buildFishBowl, buildAquariumFishingNet,
} from '../../scripts/src/items/scripts/functional/aquarium.js';
import * as statusEffects from '../src/status-effects.js';
import { effectiveAttributes, effectiveResistance } from '../src/world/attributes.js';
import {
  buildArcheryButte, buildAwesomeDisturbingPortrait, buildBanner, buildBedOfNails,
  buildClawFootTub, buildDolphinRug, buildEnchantedGraniteCart, buildFlamingHead, buildFlamingHeadDeed,
  buildFirePainting, buildFountainAddon, buildHarpsichord, buildHarpsichordRoll, buildMiningCart, buildMusicBox,
  buildRoseRug, buildSheepStatue, buildShipPainting, buildSkullRug,
  buildPickpocketDip, buildTreeStump, buildWoodStove, buildFountainOfLife,
} from '../../scripts/src/items/scripts/functional/decorative-addons.js';
import { buildBallotBox, buildPlayerBulletinBoard } from '../../scripts/src/items/scripts/functional/player-boards.js';
import { buildAnkhOfSacrifice, buildSmithingPress, buildSpinningWheel, buildTrainingDummy } from '../../scripts/src/items/scripts/functional/anvil-forge.js';
import { buildHitchingPost, buildSwitch, buildXmlTileTrap } from '../../scripts/src/items/scripts/world/simple-items.js';
import * as xmlSpawner from '../src/systems/xml-spawner.js';
import { adjustKarma } from '../src/notoriety.js';

describe('item-scripts (FAZA BN)', () => {
  /** @type {World} */
  let world;

  beforeEach(() => { world = new World(); });

  it('dispatches onUse via item.script', () => {
    const calls = [];
    registerItemScript({
      name: '__test-onuse',
      onUse(_w, item, user) { calls.push([item.serial, user?.serial ?? null]); return true; },
    });
    const it = createItem(world, { itemId: 0x1234, x: 1, y: 1, z: 0 });
    it.script = '__test-onuse';
    const result = dispatchItemEvent(world, it, 'onUse', { serial: 99 });
    expect(result).toBe(true);
    expect(calls).toEqual([[it.serial, 99]]);
    unregisterItemScript('__test-onuse');
  });

  it('destroyItem fires onDestroy BEFORE deletion (BUGFIX #30)', () => {
    let seenSerial = null;
    let seenInWorld = null;
    registerItemScript({
      name: '__test-ondestroy',
      onDestroy(w, item) {
        seenSerial = item.serial;
        seenInWorld = w.items.has(item.serial);
      },
    });
    const it = createItem(world, { itemId: 0x4321, x: 2, y: 2, z: 0 });
    it.script = '__test-ondestroy';
    destroyItem(world, it.serial);
    expect(seenSerial).toBe(it.serial);
    expect(seenInWorld).toBe(true);   // hook saw the item still alive
    expect(world.items.has(it.serial)).toBe(false); // and gone after
    unregisterItemScript('__test-ondestroy');
  });

  it('spawn() no longer clobbers explicit hue=0 with defaultHue (BUGFIX #30)', () => {
    registerTemplate({ name: '__test-tinted', itemId: 0x0EED, defaultHue: 0x021C });

    // No override → defaultHue applies.
    const a = spawn(world, '__test-tinted', { x: 0, y: 0, z: 0 });
    expect(a.hue).toBe(0x021C);

    // Explicit override → caller wins.
    const b = spawn(world, '__test-tinted', { x: 0, y: 0, z: 0, hue: 0x0234 });
    expect(b.hue).toBe(0x0234);

    // Explicit zero → caller still wins (was the bug).
    const c = spawn(world, '__test-tinted', { x: 0, y: 0, z: 0, hue: 0 });
    expect(c.hue).toBe(0);

    unregisterTemplate('__test-tinted');
  });

  it('script onCreate runs at spawn() time', () => {
    const seen = [];
    registerItemScript({
      name: '__test-oncreate',
      onCreate(_w, item) { seen.push(item.serial); item.markedAtCreate = true; },
    });
    registerTemplate({ name: '__test-on-create-tmpl', itemId: 0x1A1A, script: '__test-oncreate' });
    const it = spawn(world, '__test-on-create-tmpl', { x: 0, y: 0, z: 0 });
    expect(seen).toEqual([it.serial]);
    expect(it.markedAtCreate).toBe(true);
    unregisterTemplate('__test-on-create-tmpl');
    unregisterItemScript('__test-oncreate');
  });

  it('missing script name on item is a no-op (no crash)', () => {
    const it = createItem(world, { itemId: 1, x: 0, y: 0, z: 0 });
    expect(() => dispatchItemEvent(world, it, 'onUse', null)).not.toThrow();
    it.script = 'never-registered';
    expect(() => dispatchItemEvent(world, it, 'onUse', null)).not.toThrow();
  });

  it('hydrates readable ServUO book content by tag and opens through the book registry', () => {
    registerContentItem({
      id: 0x0FEF,
      tagId: '__test-readable-book',
      name: 'Test Readable Book',
      title: 'Test Readable Book',
      author: 'Tester',
      pages: [['one', 'two']],
      script: 'readable-book',
    });
    const opened = [];
    const script = buildReadableBook({
      books: {
        register: (serial, rec) => opened.push(['register', serial, rec]),
        unregister: () => {},
        open: (state, serial) => {
          opened.push(['open', serial, state.id]);
          return true;
        },
      },
    });
    registerItemScript(script);
    const it = createItem(world, { tagId: '__test-readable-book', x: 1, y: 1, z: 0 });
    expect(it.itemId).toBe(0x0FEF);
    expect(it.script).toBe('readable-book');
    expect(it.title).toBe('Test Readable Book');
    const user = { client: { id: 'state-1', sendSystemMessage: () => {} } };
    expect(dispatchItemEvent(world, it, 'onUse', user)).toBe(true);
    expect(opened[0][0]).toBe('register');
    expect(opened[0][2].pages).toEqual([['one', 'two']]);
    expect(opened[1]).toEqual(['open', it.serial, 'state-1']);
    unregisterItemScript('readable-book');
  });

  it('hydrates poison potion payloads and applies poison on use', () => {
    registerContentItem({
      id: 0x0F0A,
      tagId: '__test-deadly-poison',
      name: 'Deadly Poison Potion',
      script: 'potion-poison',
      poisonLevel: 3,
      poisonKind: 'deadly',
    });
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1, hp: 50, hpMax: 50 });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const potion = createItem(world, { tagId: '__test-deadly-poison', parent: mob.serial, amount: 2 });
    registerItemScript(buildPoisonPotion({ statusEffects }));

    expect(dispatchItemEvent(world, potion, 'onUse', mob)).toBe(true);
    expect(potion.amount).toBe(1);
    expect(mob.poisoned).toBe(true);
    expect(mob.poisonLevel).toBe(3);
    expect(messages).toContain('You drink the poison.');
    unregisterItemScript('potion-poison');
  });

  it('applies Eodon potion timed attribute and resistance overlays', () => {
    registerContentItem({
      id: 0x0F06,
      tagId: '__test-jukari-potion',
      name: 'Jukari Burn Poultice',
      script: 'eodon-potion',
      eodonEffect: 'jukari',
      eodonDurationMs: 60_000,
    });
    const mob = world.createMobile({ x: 1, y: 1, map: 1, stam: 20, stamMax: 50 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const potion = createItem(world, { tagId: '__test-jukari-potion', parent: mob.serial, amount: 2 });
    registerItemScript(buildEodonPotion({ statusEffects }));

    expect(dispatchItemEvent(world, potion, 'onUse', mob)).toBe(true);
    expect(potion.amount).toBe(1);
    expect(mob._eodonPotions.jukari).toBeTruthy();
    expect(effectiveAttributes(mob).staminaIncrease).toBe(8);
    expect(effectiveResistance(mob).fire).toBe(10);
    unregisterItemScript('eodon-potion');
  });

  it('uses Endless Decanter without consuming the item and refills near the linked trough', () => {
    registerContentItem({
      id: 0x0FF6,
      tagId: '__test-endless-decanter',
      name: 'Endless Decanter of Water',
      script: 'endless-decanter',
      quantity: 1,
      maxQuantity: 5,
      linked: true,
      linkLocation: { x: 10, y: 10, z: 0 },
      linkMap: 1,
    });
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const decanter = createItem(world, { tagId: '__test-endless-decanter', parent: mob.serial });
    registerItemScript(buildEndlessDecanter({}));

    expect(dispatchItemEvent(world, decanter, 'onUse', mob)).toBe(true);
    expect(world.items.has(decanter.serial)).toBe(true);
    expect(decanter.quantity).toBe(5);
    unregisterItemScript('endless-decanter');
  });

  it('applies equipment set bonuses when enough pieces are worn', () => {
    const mob = world.createMobile({ x: 1, y: 1, map: 1 });
    mob._equipment = [
      { setId: 'test-set', setPieces: 4, attributes: { regenStam: 1 }, resist: { physical: 1 }, setAttributes: { lowerManaCost: 20 }, setResist: { physical: 8 } },
      { setId: 'test-set', setPieces: 4, attributes: { regenStam: 1 }, resist: { physical: 1 }, setAttributes: { lowerManaCost: 20 }, setResist: { physical: 8 } },
      { setId: 'test-set', setPieces: 4, attributes: { regenStam: 1 }, resist: { physical: 1 }, setAttributes: { lowerManaCost: 20 }, setResist: { physical: 8 } },
      { setId: 'test-set', setPieces: 4, attributes: { regenStam: 1 }, resist: { physical: 1 }, setAttributes: { lowerManaCost: 20 }, setResist: { physical: 8 } },
    ];

    expect(effectiveAttributes(mob).lowerManaCost).toBe(20);
    expect(effectiveResistance(mob).physical).toBe(12);
  });

  it('addon-deed places a registered multi-addon and consumes the deed', () => {
    addons.setAddons({
      '__test-addon': {
        components: [{ dx: 1, dy: 0, dz: 2, id: 0x1234, script: 'training-dummy', hue: 12 }],
      },
    });
    const mob = world.createMobile({ x: 10, y: 20, z: 0, map: 1 });
    mob.direction = 2;
    mob.dir = 2;
    const messages = [];
    mob.client = { send: () => {}, sendSystemMessage: (msg) => messages.push(msg) };
    const deed = createItem(world, { itemId: 0x14F0, parent: mob.serial, addonName: '__test-addon' });
    const script = buildAddonDeed({
      systems: { addons },
      world,
      protocol: {
        worldItemSA: () => new Uint8Array([0x1A]),
        removeEntity: () => new Uint8Array([0x1D]),
      },
    });

    expect(script.onUse(world, deed, mob)).toBe(true);
    expect(world.items.has(deed.serial)).toBe(false);
    const placed = [...world.items.values()].find((it) => it.itemId === 0x1234);
    expect(placed).toMatchObject({ x: 12, y: 20, z: 2, map: 1, script: 'training-dummy', hue: 12 });
    expect(placed.servuoClasses).toContain('AddonComponent');
    expect(messages).toContain('You place __test addon.');
    addons.setAddons({});
  });

  it('addon-deed picks directional addon variants by facing when no gump is available', () => {
    addons.setAddons({
      '__dir-south': { components: [{ dx: 0, dy: 1, id: 0x1111 }] },
      '__dir-east': { components: [{ dx: 1, dy: 0, id: 0x2222 }] },
    });
    const mob = world.createMobile({ x: 4, y: 5, z: 0, map: 1, direction: 2 });
    mob.direction = 2;
    mob.dir = 2;
    mob.client = { send: () => {}, sendSystemMessage: () => {} };
    const deed = createItem(world, {
      itemId: 0x14F0,
      parent: mob.serial,
      addonNames: { south: '__dir-south', east: '__dir-east' },
    });
    const script = buildAddonDeed({
      systems: { addons },
      world,
      protocol: {
        worldItemSA: () => new Uint8Array([0x1A]),
        removeEntity: () => new Uint8Array([0x1D]),
      },
    });

    script.onUse(world, deed, mob);
    expect(deed.servuoClasses).toEqual(expect.arrayContaining(['InternalGump', 'InternalTarget', 'FacingGump']));
    expect([...world.items.values()].some((it) => it.itemId === 0x2222)).toBe(true);
    expect([...world.items.values()].some((it) => it.itemId === 0x1111)).toBe(false);
    addons.setAddons({});
  });

  it('addon placement stamps ServUO component aliases for localized containers', () => {
    addons.setAddons({
      '__localized-container-addon': {
        name: 'localized container addon',
        container: true,
        labelNumber: 123456,
        components: [{ dx: 0, dy: 0, id: 0x2222 }],
      },
    });

    const [placed] = addons.placeAddon(world, '__localized-container-addon', { x: 1, y: 2, z: 3, map: 1 });

    expect(placed).toMatchObject({
      itemId: 0x2222,
      container: true,
      labelNumber: 123456,
      servuoClass: 'AddonContainerComponent',
    });
    expect(placed.servuoClasses).toEqual(expect.arrayContaining([
      'AddonContainerComponent',
      'LocalizedContainerComponent',
    ]));
    addons.setAddons({});
  });

  it('addon placement infers craft scripts for ServUO craft addon components', () => {
    addons.setAddons({
      'stone-anvil-east': {
        servuoClasses: ['StoneAnvilEastAddon', 'StoneAnvilEastDeed'],
        components: [{ dx: 0, dy: 0, id: 0x2DD6 }],
      },
    });

    const [placed] = addons.placeAddon(world, 'stone-anvil-east', { x: 5, y: 6, z: 0, map: 1 });

    expect(placed).toMatchObject({
      script: 'anvil',
      craftingStation: 'anvil',
      addonCraftSystem: 'Blacksmithy',
      addonToolTurnedOn: true,
    });
    addons.setAddons({});
  });

  it('addon placement preserves ContestMiniHouse reward metadata', () => {
    addons.setAddons({
      'contest-mini-house': {
        name: 'Contest Mini House',
        labelNumber: 1062692,
        miniHouseType: 'MalasMountainPass',
        isRewardItem: true,
        servuoClass: 'ContestMiniHouse',
        servuoClasses: ['ContestMiniHouse', 'ContestMiniHouseDeed', 'MiniHouseAddon', 'MiniHouseAddonComponent', 'IRewardItem'],
        components: [
          { dx: 1, dy: 1, id: 0x2316, servuoClass: 'MiniHouseAddonComponent' },
          { dx: 0, dy: 1, id: 0x2315, servuoClass: 'MiniHouseAddonComponent' },
          { dx: 1, dy: 0, id: 0x2314, servuoClass: 'MiniHouseAddonComponent' },
          { dx: 0, dy: 0, id: 0x2313, servuoClass: 'MiniHouseAddonComponent' },
        ],
      },
    });

    const placed = addons.placeAddon(world, 'contest-mini-house', { x: 10, y: 20, z: 0, map: 1 });

    expect(placed).toHaveLength(4);
    expect(placed[0]).toMatchObject({
      itemId: 0x2316,
      x: 11,
      y: 21,
      labelNumber: 1062692,
      miniHouseType: 'MalasMountainPass',
      isRewardItem: true,
      servuoClass: 'MiniHouseAddonComponent',
    });
    expect(placed[0].servuoClasses).toEqual(expect.arrayContaining([
      'ContestMiniHouse',
      'ContestMiniHouseDeed',
      'MiniHouseAddon',
      'MiniHouseAddonComponent',
      'IRewardItem',
    ]));
    addons.setAddons({});
  });

  it('claw-foot-tub addon toggles ServUO water graphics for all linked components', () => {
    const anchor = { x: 10, y: 10, z: 0 };
    const a = createItem(world, { itemId: 0x996D, x: 10, y: 9, z: 0, map: 1, _addon: 'claw-foot-tub-south', _addonAnchor: anchor });
    const b = createItem(world, { itemId: 0x996C, x: 10, y: 10, z: 0, map: 1, _addon: 'claw-foot-tub-south', _addonAnchor: anchor });
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const script = buildClawFootTub({
      protocol: { worldItemSA: () => null },
    });

    expect(script.onUse(world, a, mob)).toBe(true);
    expect(a.itemId).toBe(0x9972);
    expect(b.itemId).toBe(0x996C);

    script.onUse(world, a, mob);
    expect(a.itemId).toBe(0x996D);
  });

  it('wood-stove addon toggles lit graphics', () => {
    const stove = createItem(world, { itemId: 0xA2A8, x: 10, y: 10, z: 0, map: 1, script: 'wood-stove' });
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const script = buildWoodStove({ protocol: { worldItemSA: () => null, playSound: () => null } });

    script.onUse(world, stove, mob);
    expect(stove.itemId).toBe(0xA2A9);
    script.onUse(world, stove, mob);
    expect(stove.itemId).toBe(0xA2A8);
  });

  it('tree-stump addon produces logs and tracks remaining count', () => {
    const mob = world.createMobile({ x: 1, y: 1, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const backpack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 0x1D, name: 'Backpack', container: true });
    const stump = createItem(world, { itemId: 0x0E57, x: 1, y: 1, z: 0, map: 1, script: 'tree-stump', _logs: 15, _nextResourceCount: Date.now() + 10_000 });
    const script = buildTreeStump({ items: { createItem } });

    script.onUse(world, stump, mob);
    const logs = [...world.items.values()].find((it) => it.itemId === 0x1BDD);
    expect(logs).toMatchObject({ parent: backpack.serial, amount: 10 });
    expect(stump._logs).toBe(5);
  });

  it('Fountain of Life converts regular bandages into EnhancedBandage stacks', () => {
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1 });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {}, openContainers: new Set() };
    const fountain = createItem(world, {
      itemId: 0x2AC0,
      x: 1,
      y: 1,
      z: 0,
      map: 1,
      script: 'fountain-of-life',
      container: true,
      gumpId: 0x0484,
      fountainCharges: 3,
      fountainMaxCharges: 10,
    });
    const stack = createItem(world, { itemId: 0x0E21, parent: mob.serial, amount: 5, x: 0, y: 0, z: 0, map: 1 });
    const script = buildFountainOfLife({
      world,
      protocol: { containerContentUpdate: () => null, removeEntity: () => null },
      items: { createItem, destroyItem, setItemParent },
    });

    expect(script.onDrop(world, fountain, stack, mob)).toBe(true);
    const enhanced = [...world.items.values()].find((it) => it.servuoClass === 'EnhancedBandage');
    expect(enhanced).toMatchObject({
      parent: fountain.serial,
      amount: 3,
      hue: 0x08A5,
      bandageHealingBonus: 10,
    });
    expect(stack.amount).toBe(2);
    expect(stack.parent).toBe(fountain.serial);
    expect(fountain.fountainCharges).toBe(0);
    expect(messages).toContain('The fountain enhances 3 bandage(s).');
  });

  it('FirstAidBelt accepts and stacks only one kind of bandage', () => {
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1 });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {}, openContainers: new Set() };
    const belt = createItem(world, {
      itemId: 0xA1F6,
      parent: mob.serial,
      layer: 12,
      script: 'first-aid-belt',
      firstAidBelt: true,
      firstAidMaxBandages: 10,
    });
    const a = createItem(world, { itemId: 0x0E21, parent: mob.serial, amount: 4, x: 0, y: 0, z: 0, map: 1 });
    const b = createItem(world, { itemId: 0x0E21, parent: mob.serial, amount: 3, x: 0, y: 0, z: 0, map: 1 });
    const enhanced = createItem(world, {
      itemId: 0x0E21,
      hue: 0x08A5,
      parent: mob.serial,
      amount: 1,
      x: 0,
      y: 0,
      z: 0,
      map: 1,
      servuoClass: 'EnhancedBandage',
    });
    const script = buildFirstAidBelt({
      world,
      protocol: { containerContentUpdate: () => null, removeEntity: () => null },
      items: { destroyItem, setItemParent },
    });

    expect(script.onDrop(world, belt, a, mob)).toBe(true);
    expect(a.parent).toBe(belt.serial);
    expect(script.onDrop(world, belt, b, mob)).toBe(true);
    expect(world.items.has(b.serial)).toBe(false);
    expect(a.amount).toBe(7);
    const result = script.onDrop(world, belt, enhanced, mob);
    expect(result).toEqual({ handled: true, consumeHeld: false });
    expect(enhanced.parent).toBe(mob.serial);
    expect(messages).toContain('The belt can only hold one kind of bandage at a time.');
  });

  it('training dummy uses equipped melee weapon skill and swing cooldown', () => {
    const calls = [];
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1, skills: { 41: 10, 28: 10 } });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    createItem(world, {
      itemId: 0x0F51,
      parent: mob.serial,
      layer: 1,
      weapon: { skill: 41, range: 1 },
      x: 0,
      y: 0,
      z: 0,
      map: 1,
    });
    const dummy = createItem(world, {
      itemId: 0x1074,
      x: 1,
      y: 1,
      z: 0,
      map: 1,
      script: 'training-dummy',
      training: { minSkill: -25, maxSkill: 60 },
    });
    const script = buildTrainingDummy({
      world,
      skillGain: { tryGain: (...args) => calls.push(args) },
      events: { emit: () => {} },
      protocol: { playSound: () => null, worldItemSA: () => null },
    });

    expect(script.onUse(world, dummy, mob)).toBe(true);
    expect(dummy.itemId).toBe(0x1075);
    expect(calls.map((c) => c.slice(1))).toEqual([
      [41, -25, 60],
      [28, -25, 60],
    ]);

    expect(script.onUse(world, dummy, mob)).toBe(true);
    expect(messages).toContain('You have to wait until it stops swinging.');
    dummy._trainingDummySwingUntil = Date.now() - 1;
    expect(script.onTick(world, dummy)).toBe(true);
    expect(dummy.itemId).toBe(0x1074);
  });

  it('archery butte consumes ammo, records ServUO score entries, and gathers shots', () => {
    const calls = [];
    const messages = [];
    const mob = world.createMobile({ x: 6, y: 1, map: 1, skills: { 32: 1000 } });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, container: true, name: 'Backpack' });
    createItem(world, { itemId: 0x0F3F, parent: pack.serial, amount: 3, stackable: true, x: 0, y: 0, z: 0, map: 1 });
    const bow = createItem(world, {
      itemId: 0x13B2,
      parent: mob.serial,
      layer: 1,
      weapon: { skill: 32, range: 8, ammoId: 0x0F3F },
      x: 0,
      y: 0,
      z: 0,
      map: 1,
    });
    const butte = createItem(world, { itemId: 0x100A, x: 1, y: 1, z: 0, map: 1, script: 'archery-butte' });
    const script = buildArcheryButte({
      world,
      items: { createItem, destroyItem, setItemParent },
      skillGain: { tryGain: (...args) => calls.push(args) },
      events: { emit: () => {} },
    });

    script.onCreate(world, butte);
    const rolls = [0, 0.05, 1];
    const oldRandom = Math.random;
    Math.random = () => rolls.shift() ?? 1;
    try {
      expect(script.onUse(world, butte, mob)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    const ammo = [...world.items.values()].find((it) => it.itemId === 0x0F3F && it.parent === pack.serial && it.amount === 2);
    expect(ammo).toBeTruthy();
    expect(butte.archeryButteArrows).toBe(1);
    expect(butte.archeryButteEntries[String(mob.serial)]).toMatchObject({ servuoClass: 'ScoreEntry', total: 50, count: 1 });
    expect(calls.map((c) => c.slice(1))).toEqual([[32, -25, 25]]);
    expect(butte.servuoClasses).toContain('ScoreEntry');
    expect(messages).toContain('You hit the target for 50 point(s).');

    bow.weapon = null;
    mob.x = 1;
    mob.y = 1;
    expect(script.onUse(world, butte, mob)).toBe(true);
    expect(butte.archeryButteArrows).toBe(0);
    expect(messages).toContain('You gather the arrows and bolts.');
  });

  it('disturbing portrait follows the shard clock and screams at night', () => {
    let hour = 22;
    const sent = [];
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { send: (pkt) => sent.push(pkt), sendSystemMessage: () => {} };
    const portrait = createItem(world, {
      itemId: 0x2A5D,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
      script: 'awesome-disturbing-portrait',
    });
    const script = buildAwesomeDisturbingPortrait({
      dayNight: { hourOfDay: () => hour },
      protocol: { playSound: (pkt) => pkt },
    });

    script.onCreate(world, portrait);
    expect(portrait).toMatchObject({
      itemId: 0x2A60,
      labelNumber: 1074479,
      servuoClass: 'AwesomeDisturbingPortraitComponent',
    });
    expect(portrait.servuoClasses).toEqual(expect.arrayContaining([
      'AwesomeDisturbingPortraitAddon',
      'AwesomeDisturbingPortraitDeed',
    ]));

    expect(script.onUse(world, portrait, mob)).toBe(true);
    expect(sent[0]).toMatchObject({ soundId: 0x569, x: 10, y: 10, z: 0 });

    hour = 12;
    portrait._portraitNextUpdateAt = 0;
    script.onTick(world, portrait);
    expect(portrait.itemId).toBe(0x2A5D);
  });

  it('bed of nails starts a ServUO-style blood trail on walk-over', () => {
    const sent = [];
    const mob = world.createMobile({ x: 5, y: 5, z: 0, map: 1, body: 0x0191 });
    mob.client = { send: (pkt) => sent.push(pkt), sendSystemMessage: () => {} };
    const bed = createItem(world, {
      itemId: 0x2A81,
      x: 5,
      y: 5,
      z: 0,
      map: 1,
      script: 'bed-of-nails',
    });
    const script = buildBedOfNails({
      items: { createItem, destroyItem },
      protocol: { playSound: (pkt) => pkt },
    });

    script.onCreate(world, bed);
    expect(bed.labelNumber).toBe(1074801);
    expect(bed.servuoClasses).toEqual(expect.arrayContaining([
      'BedOfNailsComponent',
      'BedOfNailsAddon',
      'BedOfNailsDeed',
    ]));

    const rolls = [0.10, 0.30, 0, 0, 0, 0.25, 0.80, 0.90, 0];
    const oldRandom = Math.random;
    Math.random = () => rolls.shift() ?? 0;
    try {
      expect(script.onWalkOn(world, bed, mob)).toBe(true);
      script.onTick(world, bed);
    } finally {
      Math.random = oldRandom;
    }

    expect(sent[0].soundId).toBeGreaterThanOrEqual(0x53B);
    expect(sent[0].soundId).toBeLessThanOrEqual(0x53D);
    const blood = [...world.items.values()].filter((it) => it.servuoClass === 'Blood');
    expect(blood.length).toBeGreaterThan(0);
    expect(blood[0]).toMatchObject({ movable: false, servuoClasses: ['Blood'] });
  });

  it("Dawn's Music Box exposes a MusicGump, explicit track play, and StopMusic", () => {
    const sent = [];
    const gumpButtons = [100, 1];
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { send: (pkt) => sent.push(pkt), sendSystemMessage: () => {} };
    const box = createItem(world, {
      itemId: 0x2AF9,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
      script: 'music-box',
      musicTracks: [0x3D, 0x41],
      musicDurationMs: 60_000,
    });
    const script = buildMusicBox({
      protocol: { playMusic: (id) => ({ music: id }) },
      gumps: {
        send: (_state, gump, cb) => {
          expect(gump.texts).toContain("Dawn's Music Box");
          cb({ buttonId: gumpButtons.shift() });
        },
      },
    });

    script.onCreate(world, box);
    expect(box.servuoClasses).toEqual(expect.arrayContaining([
      'DawnsMusicBox',
      'DawnsMusicInfo',
      'PlayingTimer',
      'MusicGump',
      'StopMusic',
    ]));

    expect(script.onUse(world, box, mob)).toBe(true);
    expect(box._musicActualSong).toBe(0x3D);
    expect(sent).toContainEqual({ music: 0x3D });

    expect(script.onUse(world, box, mob)).toBe(true);
    expect(box._musicPlayingUntil).toBe(0);
    expect(sent).toContainEqual({ music: 0x1FFF });
  });

  it('Enchanted Granite Cart regenerates and dispenses granite rewards', () => {
    const messages = [];
    const mob = world.createMobile({ x: 10, y: 10, map: 1 });
    mob.client = { send: () => {}, sendSystemMessage: (msg) => messages.push(msg) };
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, container: true, name: 'Backpack' });
    const cart = createItem(world, {
      itemId: 0xA54B,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
      script: 'enchanted-granite-cart',
      graniteRewardCount: 0,
      graniteNextUseAt: Date.now() - 1,
    });
    const script = buildEnchantedGraniteCart({
      world,
      items: { createItem, destroyItem },
    });

    script.onCreate(world, cart);
    expect(cart.servuoClasses).toEqual(expect.arrayContaining([
      'EnchantedGraniteCartComponent',
      'EnchantedGraniteCartAddon',
      'EnchantedGraniteCartAddonDeed',
      'IRewardItem',
    ]));

    script.onTick(world, cart);
    expect(cart.graniteRewardCount).toBe(2);

    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(script.onUse(world, cart, mob)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    expect(cart.graniteRewardCount).toBe(0);
    const granite = [...world.items.values()].find((it) => it.parent === pack.serial && it.resource === 'granite');
    expect(granite).toMatchObject({
      itemId: 0x1779,
      amount: 2,
      servuoClass: 'Granite',
      kind: 'resource',
    });
    expect(messages).toContain('You take two pieces of granite from the cart.');
  });

  it('flaming head deed requires a house wall and redeeds through RewardDemolitionGump', () => {
    const messages = [];
    const owner = world.createMobile({ x: 10, y: 10, z: 0, map: 1, accessLevel: 0 });
    owner.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: owner.serial, layer: 21, container: true, name: 'Backpack' });
    const house = { ownerSerial: owner.serial, x1: 0, y1: 0, x2: 20, y2: 20, map: 1 };
    const houses = {
      houseAt: (x, y, map) => (map === 1 && x >= 0 && x <= 20 && y >= 0 && y <= 20 ? house : null),
      roleOf: (h, serial) => ((h.ownerSerial >>> 0) === (serial >>> 0) ? 'owner' : 'visitor'),
    };
    createItem(world, { itemId: 0x0006, name: 'house wall', solid: true, x: 10, y: 9, z: 0, map: 1, movable: false });
    createItem(world, { itemId: 0x0007, name: 'house wall', solid: true, x: 9, y: 10, z: 0, map: 1, movable: false });
    const deed = createItem(world, { itemId: 0x14F0, parent: pack.serial, script: 'flaming-head-deed' });
    const deedScript = buildFlamingHeadDeed({
      world,
      items: { createItem, destroyItem },
      houses,
      targeting: { request: (_state, cb) => cb({ x: 10, y: 10, z: 0, map: 1 }) },
    });

    deedScript.onCreate(world, deed);
    expect(deed.servuoClasses).toEqual(expect.arrayContaining(['FlamingHeadDeed', 'InternalTarget', 'IRewardItem']));
    expect(deedScript.onUse(world, deed, owner)).toBe(true);
    expect(world.items.has(deed.serial)).toBe(false);
    const head = [...world.items.values()].find((it) => it.script === 'flaming-head');
    expect(head).toMatchObject({
      itemId: 0x10F5,
      flamingHeadType: 'north-west-wall',
      labelNumber: 1041266,
      movable: false,
      blessed: true,
    });
    expect(head.servuoClasses).toEqual(expect.arrayContaining(['FlamingHead', 'StoneFaceTrapNoDamage', 'RewardDemolitionGump']));

    const headScript = buildFlamingHead({
      world,
      items: { createItem, destroyItem },
      houses,
      gumps: { send: (_state, _gump, cb) => cb({ buttonId: 1 }) },
    });
    expect(headScript.onUse(world, head, owner)).toBe(true);
    expect(world.items.has(head.serial)).toBe(false);
    const returned = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'FlamingHeadDeed');
    expect(returned).toMatchObject({ itemId: 0x14F0, script: 'flaming-head-deed', labelNumber: 1041050 });
    expect(messages).toContain('You place the flaming head.');
  });

  it('pickpocket dip uses ServUO stealing practice swing timer', () => {
    const messages = [];
    const sent = [];
    const thief = world.createMobile({ x: 2, y: 2, map: 1, skills: { 34: 0 } });
    thief.client = { sendSystemMessage: (msg) => messages.push(msg), send: (pkt) => sent.push(pkt) };
    const dip = createItem(world, { itemId: 0x1EC0, x: 2, y: 2, z: 0, map: 1, script: 'pickpocket-dip' });
    const calls = [];
    const script = buildPickpocketDip({
      skillGain: { tryGain: (...args) => calls.push(args) },
      protocol: { playSound: (pkt) => pkt },
    });

    script.onCreate(world, dip);
    const oldRandom = Math.random;
    Math.random = () => 1;
    try {
      expect(script.onUse(world, dip, thief)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    expect(dip.itemId).toBe(0x1EC1);
    expect(dip.servuoClasses).toEqual(expect.arrayContaining(['PickpocketDip', 'InternalTimer']));
    expect(calls.map((c) => c.slice(1))).toEqual([[34, -25, 25]]);
    expect(messages).toContain('You carelessly bump the dip and start it swinging.');
    expect(sent).toContainEqual({ soundId: 0x390, x: 2, y: 2, z: 0 });

    dip._pickpocketSwingUntil = Date.now() - 1;
    script.onTick(world, dip);
    expect(dip.itemId).toBe(0x1EC0);
  });

  it('Dolphin Rug shares resource count across components and gives MIB rewards', () => {
    const messages = [];
    const owner = world.createMobile({ x: 4, y: 4, map: 1 });
    owner.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: owner.serial, layer: 21, container: true, name: 'Backpack' });
    const statePiece = createItem(world, {
      itemId: 14593,
      x: 4,
      y: 4,
      z: 0,
      map: 1,
      script: 'dolphin-rug',
      _addon: 'dolphin-rug-large-east',
      _addonAnchor: { x: 4, y: 4, z: 0 },
      dolphinRugState: true,
      dolphinResourceCount: 1,
      dolphinNextResourceAt: Date.now() + 100000,
    });
    const edgePiece = createItem(world, {
      itemId: 14590,
      x: 5,
      y: 3,
      z: 0,
      map: 1,
      script: 'dolphin-rug',
      _addon: 'dolphin-rug-large-east',
      _addonAnchor: { x: 4, y: 4, z: 0 },
    });
    const script = buildDolphinRug({ world, items: { createItem, destroyItem } });

    script.onCreate(world, statePiece);
    script.onCreate(world, edgePiece);
    expect(script.onUse(world, edgePiece, owner)).toBe(true);
    expect(statePiece.dolphinResourceCount).toBe(0);
    const bottle = [...world.items.values()].find((it) => it.parent === pack.serial && it.script === 'message-in-bottle');
    expect(bottle).toMatchObject({ itemId: 0x099F, servuoClass: 'MessageInABottle' });
    expect(edgePiece.servuoClasses).toEqual(expect.arrayContaining(['DolphinRugAddon', 'InternalAddonComponent', 'DolphinRugAddonDeed']));
    expect(messages).toContain('An item has been placed in your backpack.');

    statePiece.dolphinNextResourceAt = Date.now() - 1;
    script.onTick(world, statePiece);
    expect(statePiece.dolphinResourceCount).toBe(1);
  });

  it('BallotBox stamps TopicPrompt and records owner topic edits through prompts', () => {
    const messages = [];
    const prompts = [];
    let sends = 0;
    const owner = world.createMobile({ x: 1, y: 1, map: 1 });
    owner.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const box = createItem(world, { itemId: 0x09A8, x: 1, y: 1, z: 0, map: 1, script: 'ballot-box' });
    const script = buildBallotBox({
      gumps: { send: (_state, _gump, cb) => { sends++; if (sends === 1) cb({ buttonId: 1 }); } },
      prompts: { ask: (_state, _opts, cb) => prompts.push(cb) },
    });

    script.onCreate(world, box);
    expect(box.servuoClasses).toEqual(expect.arrayContaining(['BallotBox', 'TopicPrompt', 'BallotBoxAddon', 'BallotBoxDeed']));
    expect(script.onUse(world, box, owner)).toBe(true);
    prompts[0]({ text: 'Should the tavern stay open?' });
    prompts[1]({ cancelled: true });

    expect(box.ballot.topic).toEqual(['Should the tavern stay open?']);
    expect(box.ballot.yes).toEqual([]);
    expect(box.ownerSerial).toBe(owner.serial);
    expect(messages).toContain('Ballot entry complete.');
  });

  it('FountainAddon stamps exact ServUO fountain classes', () => {
    const fountain = createItem(world, { itemId: 0x1731, x: 0, y: 0, z: 0, map: 1, script: 'fountain' });
    const script = buildFountainAddon({});

    script.onCreate(world, fountain);

    expect(fountain).toMatchObject({ movable: false, servuoClass: 'FountainAddon' });
    expect(fountain.servuoClasses).toEqual(expect.arrayContaining(['FountainAddon', 'FountainDeed', 'StoneFountainAddon']));
  });

  it('Player bulletin boards stamp ServUO prompt and message helper classes', () => {
    const board = createItem(world, { itemId: 0x2312, x: 1, y: 1, z: 0, map: 1, script: 'player-bulletin-board' });
    const script = buildPlayerBulletinBoard({});

    script.onCreate(world, board);

    expect(board.servuoClass).toBe('PlayerBBEast');
    expect(board.servuoClasses).toEqual(expect.arrayContaining([
      'PlayerBBEast',
      'BasePlayerBB',
      'PlayerBBGump',
      'PostPrompt',
      'SetTitlePrompt',
      'PlayerBBMessage',
    ]));
  });

  it('addon catalogue carries exact ServUO GardenShed and GiantWeb layouts', () => {
    const catalogue = JSON.parse(readFileSync(new URL('../../scripts/src/data/world/addons.json', import.meta.url), 'utf8'));

    expect(catalogue['garden-shed-east'].components).toHaveLength(11);
    expect(catalogue['garden-shed-east'].components[0]).toMatchObject({
      id: 0x4BEB,
      container: true,
      gumpId: 0x10B,
      servuoClass: 'GardenShedAddon',
    });
    expect(catalogue['garden-shed-east'].components[1]).toMatchObject({
      id: 0x4BED,
      dx: 0,
      dy: -2,
      container: true,
      gumpId: 0x3E,
      servuoClass: 'GardenShedBarrel',
    });
    expect(catalogue['garden-shed-south'].components[1]).toMatchObject({
      id: 0x4BE9,
      dx: 2,
      dy: 0,
      servuoClass: 'GardenShedBarrel',
    });
    expect(catalogue['giant-web-1'].components.map((c) => [c.id, c.dx, c.dy])).toEqual([
      [0x10B8, 4, -4],
      [0x10B9, 3, -3],
      [0x10BA, 2, -2],
      [0x10BB, 1, -1],
      [0x10BC, 0, 0],
    ]);
    expect(catalogue['giant-web-6'].components.map((c) => c.id)).toEqual([0x10CE, 0x10CF, 0x10D0, 0x10D1]);
    expect(catalogue['gold-carpet'].components).toHaveLength(25);
    expect(catalogue['gold-carpet'].components[0]).toMatchObject({ id: 2779, dx: 2, dy: 2 });
    expect(catalogue['sheep-statue'].components[0]).toMatchObject({ id: 0x4A95, script: 'sheep-statue' });
    expect(catalogue['medusa-s-nest'].components).toHaveLength(9);
    expect(catalogue['geoffrey-camp'].components).toHaveLength(36);
    expect(catalogue['alchemists-bookshelf-south'].components[0]).toMatchObject({
      id: 0x4C24,
      container: true,
      gumpId: 0x4D,
      servuoClass: 'AlchemistsBookshelfAddon',
    });
    expect(catalogue['rose-rug-large-east'].components).toHaveLength(28);
    expect(catalogue['rose-rug-small-south'].components).toHaveLength(15);
    expect(catalogue['rose-rug-large-east'].components[0]).toMatchObject({ id: 0x38D7, dx: 2, dy: -3, addonResourceState: true });
    expect(catalogue['skull-rug-large-south'].components).toHaveLength(28);
    expect(catalogue['skull-rug-small-east'].components).toHaveLength(15);
    expect(catalogue['skull-rug-small-east'].components[0]).toMatchObject({ id: 0x4716, dx: 1, dy: 2, addonResourceState: true });
    expect(catalogue['fire-painting-south'].components[0]).toMatchObject({ id: 0x4C28, script: 'fire-painting', addonResourceState: true });
    expect(catalogue['ship-painting-east'].components[0]).toMatchObject({ id: 0x4C27, script: 'ship-painting', addonResourceState: true });
    expect(catalogue['medusa-floor-tile'].components).toHaveLength(25);
    expect(catalogue['medusa-floor-tile'].components[0]).toMatchObject({ id: 0x40CD, dx: 0, dy: 0 });
    expect(catalogue['lord-british-throne'].components.map((c) => [c.id, c.dx, c.dy])).toEqual([[0x1526, 0, 0], [0x1527, 0, -1]]);
    expect(catalogue['enormous-venus-flytrap-south'].components[0]).toMatchObject({
      id: 0x9967,
      script: 'cleanup-addon-container',
      container: true,
      servuoClass: 'EnormousVenusFlytrapAddon',
    });
    expect(catalogue['sacrificial-altar-east'].components.map((c) => [c.id, c.dx, c.dy])).toEqual([[0x2A9C, 0, 0], [0x2A9D, 0, -1]]);
    expect(catalogue['vendor-mall'].components).toHaveLength(499);
    expect(catalogue['vendor-mall'].components[0]).toMatchObject({ id: 3216, dx: -16, dy: -4 });
    expect(catalogue['vendor-mall'].components[498]).toMatchObject({ id: 3203, dx: 5, dy: 8 });
  });

  it('MiningCart gives ServUO ore resources and recharges on its state component', () => {
    const messages = [];
    const user = world.createMobile({ x: 5, y: 5, map: 1 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const cart = createItem(world, {
      itemId: 0x1A83,
      x: 5,
      y: 5,
      z: 0,
      map: 1,
      script: 'mining-cart',
      miningCartType: 'OreSouth',
      miningCartState: true,
      miningCartOre: 12,
      miningCartNextResourceAt: Date.now() + 100000,
    });
    const script = buildMiningCart({});

    script.onCreate(world, cart);
    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(script.onUse(world, cart, user)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    expect(cart.miningCartOre).toBe(2);
    const ingots = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'IronIngot');
    expect(ingots).toMatchObject({ itemId: 0x1BF2, amount: 10, stackable: true });
    expect(messages).toContain('Ore: 10');

    cart.miningCartNextResourceAt = Date.now() - 1;
    script.onTick(world, cart);
    expect(cart.miningCartOre).toBe(12);
    expect(cart.servuoClasses).toEqual(expect.arrayContaining(['MiningCart', 'MiningCartType', 'InternalAddonComponent']));
  });

  it('SheepStatue gives daily textile resources and flips art by resource count', () => {
    const messages = [];
    const user = world.createMobile({ x: 6, y: 6, map: 1 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const statue = createItem(world, {
      itemId: 0x4A95,
      x: 6,
      y: 6,
      z: 0,
      map: 1,
      script: 'sheep-statue',
      sheepResourceCount: 10,
      sheepNextResourceAt: Date.now() + 100000,
    });
    const script = buildSheepStatue({});

    script.onCreate(world, statue);
    expect(statue.itemId).toBe(0x4A94);
    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      expect(script.onUse(world, statue, user)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    expect(statue.sheepResourceCount).toBe(0);
    expect(statue.itemId).toBe(0x4A95);
    const wool = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'Wool');
    expect(wool).toMatchObject({ itemId: 0x0EE3, amount: 10, stackable: true });
    expect(messages).toContain('Resources: 0');

    statue.sheepNextResourceAt = Date.now() - 1;
    script.onTick(world, statue);
    expect(statue.sheepResourceCount).toBe(10);
    expect(statue.itemId).toBe(0x4A94);
  });

  it('Harpsichord rolls install songs and the addon plays through the music gump', () => {
    const messages = [];
    const sent = [];
    const user = world.createMobile({ x: 8, y: 8, map: 1 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: (pkt) => sent.push(pkt) };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const harp = createItem(world, {
      itemId: 25544,
      x: 8,
      y: 8,
      z: 0,
      map: 1,
      script: 'harpsichord',
      harpsichordState: true,
    });
    const roll = createItem(world, {
      itemId: 0x4BA1,
      parent: pack.serial,
      script: 'harpsichord-roll',
      harpsichordRollMusic: 88,
    });
    const api = {
      targeting: { request: (_state, cb) => cb({ serial: harp.serial }) },
      gumps: { send: (_state, _gump, cb) => cb({ buttonId: 188 }) },
      protocol: { playMusic: (musicId) => ({ musicId }) },
    };
    const harpScript = buildHarpsichord(api);
    const rollScript = buildHarpsichordRoll(api);

    harpScript.onCreate(world, harp);
    rollScript.onCreate(world, roll);
    expect(rollScript.onUse(world, roll, user)).toBe(true);

    expect(world.items.has(roll.serial)).toBe(false);
    expect(harp.harpsichordSongs).toEqual([88]);
    expect(messages).toContain('You carefully feed the roll into the Harpsichord.');

    expect(harpScript.onUse(world, harp, user)).toBe(true);
    expect(sent).toContainEqual({ musicId: 88 });
    expect(harp.servuoClasses).toEqual(expect.arrayContaining(['HarpsichordAddon', 'HarpsichordSongGump', 'HarpsichordAddonDeed']));
  });

  it('RoseRug and SkullRug share ServUO weekly resource state and give rewards', () => {
    const messages = [];
    const user = world.createMobile({ x: 9, y: 9, map: 1 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const roseState = createItem(world, {
      itemId: 14538,
      x: 9,
      y: 9,
      z: 0,
      map: 1,
      script: 'rose-rug',
      _addon: 'rose-rug-large-east',
      _addonAnchor: { x: 9, y: 9, z: 0 },
      addonResourceKind: 'rose-rug',
      addonResourceState: true,
      addonResourceCount: 1,
      addonNextResourceAt: Date.now() + 100000,
    });
    const roseEdge = createItem(world, {
      itemId: 14551,
      x: 10,
      y: 8,
      z: 0,
      map: 1,
      script: 'rose-rug',
      _addon: 'rose-rug-large-east',
      _addonAnchor: { x: 9, y: 9, z: 0 },
      addonResourceKind: 'rose-rug',
    });
    const skull = createItem(world, {
      itemId: 14482,
      x: 9,
      y: 9,
      z: 0,
      map: 1,
      script: 'skull-rug',
      addonResourceKind: 'skull-rug',
      addonResourceCount: 1,
      addonNextResourceAt: Date.now() + 100000,
    });
    const roseScript = buildRoseRug({});
    const skullScript = buildSkullRug({});

    roseScript.onCreate(world, roseState);
    roseScript.onCreate(world, roseEdge);
    expect(roseScript.onUse(world, roseEdge, user)).toBe(true);
    expect(roseState.addonResourceCount).toBe(0);
    const seed = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'Seed');
    expect(seed).toMatchObject({ itemId: 0x0DCF, tagId: 'plant-seed' });

    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      skullScript.onCreate(world, skull);
      expect(skullScript.onUse(world, skull, user)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }
    const map = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'TreasureMap');
    expect(map).toMatchObject({ itemId: 0x14EB, treasureMap: { level: 1, decoded: false } });
    expect(skull.addonResourceCount).toBe(0);

    roseState.addonNextResourceAt = Date.now() - 1;
    roseScript.onTick(world, roseState);
    expect(roseState.addonResourceCount).toBe(1);
    expect(roseState.servuoClasses).toEqual(expect.arrayContaining(['RoseRugAddon', 'RoseRugAddonDeed', 'IRewardItem']));
    expect(skull.servuoClasses).toEqual(expect.arrayContaining(['SkullRugAddon', 'SkullRugAddonDeed', 'IRewardOption']));
    expect(messages).toEqual(expect.arrayContaining([
      'Seeds have been placed in your backpack.',
      'A treasure map has been placed in your backpack.',
    ]));
  });

  it('FirePainting and ShipPainting use ServUO resource rewards and recharge amounts', () => {
    const messages = [];
    const user = world.createMobile({ x: 10, y: 10, map: 1 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const fire = createItem(world, {
      itemId: 0x4C28,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
      script: 'fire-painting',
      addonResourceKind: 'fire-painting',
      addonResourceCount: 1,
      addonNextResourceAt: Date.now() + 100000,
    });
    const ship = createItem(world, {
      itemId: 0x4C26,
      x: 10,
      y: 10,
      z: 0,
      map: 1,
      script: 'ship-painting',
      addonResourceKind: 'ship-painting',
      addonResourceCount: 1,
      addonNextResourceAt: Date.now() + 100000,
    });
    const fireScript = buildFirePainting({});
    const shipScript = buildShipPainting({});

    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      fireScript.onCreate(world, fire);
      shipScript.onCreate(world, ship);
      expect(fireScript.onUse(world, fire, user)).toBe(true);
      expect(shipScript.onUse(world, ship, user)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    const scroll = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'ScrollOfTranscendence');
    const powder = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'HeavyPowderCharge');
    expect(scroll).toMatchObject({ itemId: 0x14F0, hue: 0x0490, powerScroll: { value: 0.1, transcendence: true } });
    expect(powder).toMatchObject({ itemId: 0x4224, hue: 0x07EF, stackable: true });
    expect(fire.addonResourceCount).toBe(0);
    expect(ship.addonResourceCount).toBe(0);

    ship.addonNextResourceAt = Date.now() - 1;
    shipScript.onTick(world, ship);
    expect(ship.addonResourceCount).toBe(42);
    expect(fire.servuoClasses).toEqual(expect.arrayContaining(['FirePaintingAddon', 'FirePaintingComponent', 'FirePaintingDeed']));
    expect(ship.servuoClasses).toEqual(expect.arrayContaining(['ShipPaintingAddon', 'ShipPaintingComponent', 'ShipPaintingDeed']));
    expect(messages).toEqual(expect.arrayContaining([
      'Scrolls of Transcendence have been placed in your backpack.',
      'Powder charges have been placed in your backpack.',
    ]));
  });

  it('BaseImprisonedMobile crystals release bonded ServUO pets and consume the crystal', () => {
    const messages = [];
    const user = world.createMobile({ x: 11, y: 11, map: 1, followers: 0, followersMax: 5 });
    user.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21, container: true, name: 'Backpack' });
    const crystal = createItem(world, {
      itemId: 0x1F19,
      parent: pack.serial,
      script: 'imprisoned-mobile',
      servuoClass: 'FerretImprisonedInCrystal',
      imprisonedServuoClass: 'FerretImprisonedInCrystal',
      imprisonedSummon: {
        kind: 'ShimmeringFerret',
        name: 'a shimmering ferret',
        body: 0x0117,
        skills: { 26: 1000, 27: 1000, 43: 1000, 1: 1000 },
        servuoClasses: ['ShimmeringFerret', 'Ferret', 'BaseCreature'],
      },
    });
    const aiAttach = [];
    const script = buildImprisonedMobile({ ai: { attach: (...args) => aiAttach.push(args) } });

    script.onCreate(world, crystal);
    expect(script.onUse(world, crystal, user)).toBe(true);

    expect(world.items.has(crystal.serial)).toBe(false);
    const pet = [...world.mobiles.values()].find((m) => m.kind === 'ShimmeringFerret');
    expect(pet).toMatchObject({
      name: 'a shimmering ferret',
      body: 0x0117,
      controlMaster: user.serial,
      controlOrder: 'follow',
      bonded: true,
      deleteOnRelease: true,
      _summonedFromCrystal: true,
    });
    expect(user.followers).toBe(1);
    expect(aiAttach[0]?.[1]).toBe('pet');
    expect(messages).toEqual(expect.arrayContaining([
      'It seems to accept you as master.',
      'Your pet has bonded with you!',
    ]));
  });

  it('cleanup addon containers credit Clean Up Britannia and stamp ServUO context-menu classes', () => {
    const messages = [];
    const account = {};
    const user = world.createMobile({ x: 12, y: 12, map: 1 });
    user.client = { account, sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const altar = createItem(world, {
      itemId: 0x2A9B,
      x: 12,
      y: 12,
      z: 0,
      map: 1,
      script: 'cleanup-addon-container',
      servuoClass: 'SacrificialAltarAddon',
      cleanupAddonType: 'SacrificialAltarAddon',
    });
    const dropped = createItem(world, {
      itemId: 0x0EED,
      x: 12,
      y: 12,
      z: 0,
      map: 1,
      amount: 500,
      name: 'gold coins',
    });
    const script = buildCleanupAddonContainer({
      systems: {
        cleanup: {
          turnIn(acc, w, item) {
            acc.cleanupPoints = (acc.cleanupPoints | 0) + 5;
            destroyItem(w, item.serial);
            return 5;
          },
        },
      },
    });

    script.onCreate(world, altar);
    expect(script.onDrop(world, altar, dropped, user)).toBe(true);

    expect(account.cleanupPoints).toBe(5);
    expect(world.items.has(dropped.serial)).toBe(false);
    expect(altar).toMatchObject({ container: true, gumpId: 0x0009, movable: false });
    expect(altar.servuoClasses).toEqual(expect.arrayContaining([
      'SacrificialAltarAddon',
      'BaseAddonContainer',
      'CleanupArray',
      'AppraiseforCleanup',
    ]));
    expect(messages).toEqual(expect.arrayContaining([
      'The item will be deleted in three minutes.',
      'The altar accepts the sacrifice. (+5 Cleanup Britannia points)',
    ]));
  });

  it('AnkhOfSacrifice toggles karma lock and blocks positive karma gains', () => {
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1 });
    mob.karma = 100;
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const ankh = createItem(world, { itemId: 0x1D98, x: 1, y: 1, z: 0, map: 1, script: 'ankh-of-sacrifice' });
    const script = buildAnkhOfSacrifice({});

    script.onCreate(world, ankh);
    expect(script.onUse(world, ankh, mob)).toBe(true);
    expect(mob.karmaLocked).toBe(true);
    expect(adjustKarma(mob, 250)).toBe(100);
    expect(adjustKarma(mob, -50)).toBe(50);

    expect(script.onUse(world, ankh, mob)).toBe(true);
    expect(mob.karmaLocked).toBe(false);
    expect(adjustKarma(mob, 250)).toBe(300);
    expect(ankh.servuoClasses).toEqual(expect.arrayContaining(['LockKarmaEntry', 'AnkhResurrectGump']));
    expect(messages).toContain('Your karma has been locked. Your karma can no longer be raised.');
  });

  it('AnkhOfSacrifice resurrects ghosts through confirmation and starts cooldown', () => {
    const messages = [];
    const resurrected = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1, ghost: true, dead: true, hp: 0, hpMax: 50 });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const ankh = createItem(world, { itemId: 0x1D98, x: 1, y: 1, z: 0, map: 1, script: 'ankh-of-sacrifice' });
    const script = buildAnkhOfSacrifice({
      corpse: {
        resurrectMobile: (_world, target) => {
          resurrected.push(target.serial);
          target.ghost = false;
          target.dead = false;
          target.hp = 25;
        },
      },
      gumps: {
        send: (_state, _gump, cb) => cb({ buttonId: 1 }),
      },
    });

    script.onCreate(world, ankh);
    expect(script.onUse(world, ankh, mob)).toBe(true);

    expect(resurrected).toEqual([mob.serial]);
    expect(mob.ghost).toBe(false);
    expect(mob.ankhNextUseAt).toBeGreaterThan(Date.now());
    expect(messages).toContain('You have been resurrected.');
  });

  it('AquariumFishingNet catches a live creature into an empty fish bowl', () => {
    const calls = [];
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1, skills: { 19: 50 } });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, container: true, name: 'Backpack' });
    const bowl = createItem(world, {
      itemId: 0x241C,
      parent: pack.serial,
      script: 'fish-bowl',
      servuoClass: 'FishBowl',
      container: true,
      gumpId: 0x003D,
    });
    const net = createItem(world, {
      itemId: 0x0DC8,
      parent: pack.serial,
      script: 'aquarium-fishing-net',
      servuoClass: 'AquariumFishingNet',
    });
    const oldRandom = Math.random;
    Math.random = () => 0;
    try {
      const script = buildAquariumFishingNet({
        world,
        items: { createItem, destroyItem, setItemParent },
        skillGain: { tryGain: (...args) => calls.push(args) },
      });

      expect(script.onUse(world, net, mob)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    const fish = [...world.items.values()].find((it) => it.aquariumFish);
    expect(fish).toMatchObject({ parent: bowl.serial, servuoClass: 'MinocBlueFish' });
    expect(world.items.has(net.serial)).toBe(false);
    expect(calls.map((c) => c.slice(1))).toEqual([[19, 10, 100]]);
    expect(messages).toContain('A live creature jumps into the fish bowl in your pack!');
  });

  it('aquarium exposes ServUO context actions and gives aquarium rewards', () => {
    const messages = [];
    const mob = world.createMobile({ x: 1, y: 1, map: 1, accessLevel: 1 });
    mob.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const pack = createItem(world, { itemId: 0x0E75, parent: mob.serial, layer: 21, container: true, name: 'Backpack' });
    const tank = createItem(world, { itemId: 0x3060, x: 1, y: 1, z: 0, map: 1, script: 'aquarium' });
    let sends = 0;
    const script = buildAquarium({
      world,
      items: { createItem, destroyItem, setItemParent },
      gumps: {
        send: (_state, _gump, cb) => {
          sends++;
          if (sends === 1) cb({ buttonId: 2 });
        },
      },
    });

    script.onCreate(world, tank);
    tank.aquarium.fish = Array.from({ length: 30 }, (_, i) => ({
      kind: `fish-${i}`,
      name: `Fish ${i}`,
      itemId: 0x3B0A,
      hue: 0,
      addedAt: Date.now(),
    }));
    tank.aquarium.rewardAvailable = true;

    const oldRandom = Math.random;
    Math.random = () => 0.78;
    try {
      expect(script.onUse(world, tank, mob)).toBe(true);
    } finally {
      Math.random = oldRandom;
    }

    const reward = [...world.items.values()].find((it) => it.parent === pack.serial && it.servuoClass === 'Shell');
    expect(reward).toMatchObject({ kind: 'aquarium-decoration', aquariumDecoration: true, labelNumber: 1074598 });
    expect(tank.aquarium.rewardAvailable).toBe(false);
    expect(tank.servuoClasses).toEqual(expect.arrayContaining(['CollectRewardEntry', 'ViewEventEntry', 'GMAddFood', 'GMForceEvaluate']));
    expect(messages).toContain('You receive a reward: A Shell.');
  });

  it('fish bowl stamps ServUO container metadata on create', () => {
    const bowl = createItem(world, { itemId: 0x241C, x: 0, y: 0, z: 0, map: 1 });
    const script = buildFishBowl({});

    script.onCreate(world, bowl);

    expect(bowl).toMatchObject({
      container: true,
      gumpId: 0x003D,
      capacity: 1,
      labelNumber: 1074499,
      servuoClass: 'FishBowl',
    });
    expect(bowl.servuoClasses).toContain('RemoveCreature');
  });

  it('hitching post stables a targeted pet and claims it through ClaimListGump', () => {
    const messages = [];
    const packets = [];
    const owner = world.createMobile({
      name: 'owner',
      x: 10,
      y: 10,
      map: 1,
      followers: 1,
      followersMax: 5,
      skills: { 3: 1000, 36: 1000, 40: 1000 },
    });
    owner.client = {
      sendSystemMessage: (msg) => messages.push(msg),
      send: (pkt) => packets.push(pkt),
    };
    owner.followers = 1;
    owner.followersMax = 5;
    owner.skills = { 3: 1000, 36: 1000, 40: 1000 };
    const pet = world.createMobile({
      name: 'Rover',
      kind: 'dog',
      body: 0x00D9,
      x: 11,
      y: 10,
      map: 1,
      controlMaster: owner.serial,
      controlSlots: 1,
      hp: 20,
      hpMax: 20,
    });
    pet.kind = 'dog';
    pet.controlMaster = owner.serial;
    pet.controlSlots = 1;
    const post = createItem(world, { itemId: 0x14E7, x: 10, y: 10, z: 0, map: 1, script: 'hitching-post' });
    const buttons = [1, 100];
    const script = buildHitchingPost({
      world,
      targeting: { request: (_state, cb) => cb({ serial: pet.serial }) },
      gumps: { send: (_state, gump, cb) => {
        expect(gump.texts).toContain('Hitching Post');
        cb({ buttonId: buttons.shift() });
      } },
      protocol: {
        removeEntity: (serial) => ({ remove: serial }),
        mobileIncoming: (mob) => ({ incoming: mob.serial }),
      },
      ai: { attach: () => {}, detach: () => {} },
    });

    script.onCreate(world, post);
    expect(post.servuoClasses).toEqual(expect.arrayContaining([
      'DungeonHitchingPost',
      'StableEntry',
      'StableTarget',
      'ClaimListGump',
      'ClaimAllEntry',
    ]));

    expect(script.onUse(world, post, owner)).toBe(true);
    expect(world.mobiles.has(pet.serial)).toBe(false);
    expect(owner.stabled).toHaveLength(1);
    expect(owner.stabled[0]).toMatchObject({ name: 'Rover', kind: 'dog', controlSlots: 1 });
    expect(owner.followers).toBe(0);

    expect(script.onUse(world, post, owner)).toBe(true);
    expect(owner.stabled).toHaveLength(0);
    const claimed = [...world.mobiles.values()].find((m) => m.name === 'Rover');
    expect(claimed).toMatchObject({
      kind: 'dog',
      controlMaster: owner.serial,
      controlOrder: 'follow',
      x: owner.x,
      y: owner.y,
    });
    expect(owner.followers).toBe(1);
    expect(messages).toContain('Rover is now stabled.');
    expect(messages).toContain('Rover returns to your side.');
  });

  it('craft addon power tool accepts matching non-runic tool charges', () => {
    const messages = [];
    const crafter = world.createMobile({ x: 3, y: 3, map: 1 });
    crafter.client = { sendSystemMessage: (msg) => messages.push(msg), send: () => {} };
    const station = createItem(world, {
      itemId: 0x9C1A,
      x: 3,
      y: 3,
      z: 0,
      map: 1,
      script: 'smithing-press',
      toolUsesRemaining: 4990,
      toolMaxUses: 5000,
    });
    const tool = createItem(world, {
      itemId: 0x13E3,
      parent: crafter.serial,
      kind: 'tool',
      toolKind: 'smith',
      usesRemaining: 12,
    });
    const script = buildSmithingPress({
      world,
      protocol: { playSound: (pkt) => pkt, worldItemSA: () => null },
    });

    script.onCreate(world, station);
    const partial = script.onDrop(world, station, tool, crafter);
    expect(partial).toEqual({ handled: true, consumeHeld: false });
    expect(station.toolUsesRemaining).toBe(5000);
    expect(tool.usesRemaining).toBe(2);
    expect(world.items.has(tool.serial)).toBe(true);

    station.toolUsesRemaining = 4998;
    expect(script.onDrop(world, station, tool, crafter)).toBe(true);
    expect(station.toolUsesRemaining).toBe(5000);
    expect(world.items.has(tool.serial)).toBe(false);
    expect(station.servuoClasses).toEqual(expect.arrayContaining([
      'CraftAddon',
      'AddonToolComponent',
      'ToolDropComponent',
    ]));
    expect(messages).toContain('Charges have been added to the power tool.');
  });

  it('spinning wheel uses ServUO SpinTimer graphics and stops on tick', () => {
    const mob = world.createMobile({ x: 4, y: 4, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    const wheel = createItem(world, { itemId: 0x1015, x: 4, y: 4, z: 0, map: 1, script: 'spinning-wheel' });
    const script = buildSpinningWheel({
      protocol: { worldItemSA: () => null },
      events: { emit: () => {} },
    });

    script.onCreate(world, wheel);
    expect(wheel.servuoClasses).toEqual(expect.arrayContaining([
      'ISpinningWheel',
      'SpinTimer',
      'SpinningwheelSouthAddon',
    ]));
    expect(script.onUse(world, wheel, mob)).toBe(true);
    expect(wheel.itemId).toBe(0x1016);
    expect(wheel._spinningWheelSpinningUntil).toBeGreaterThan(Date.now());

    wheel._spinningWheelSpinningUntil = Date.now() - 1;
    expect(script.onTick(world, wheel)).toBe(true);
    expect(wheel.itemId).toBe(0x1015);
    expect(wheel._spinningWheelSpinningUntil).toBe(0);
  });

  it('banner stamps ServUO facing and demolition helpers', () => {
    const banner = createItem(world, { itemId: 0x15AE, x: 2, y: 2, z: 0, map: 1, script: 'banner' });
    const script = buildBanner({});

    script.onCreate(world, banner);

    expect(banner).toMatchObject({ movable: false, forceShowProperties: true, servuoClass: 'Banner' });
    expect(banner.servuoClasses).toEqual(expect.arrayContaining([
      'Banner',
      'BannerDeed',
      'FacingGump',
      'RewardDemolitionGump',
      'IDyable',
      'IRewardItem',
    ]));
  });

  it('switch applies XmlSpawner target properties to its linked item', () => {
    const lever = createItem(world, { itemId: 0x108C, x: 0, y: 0, z: 0, map: 1 });
    const target = createItem(world, { itemId: 0x1000, x: 1, y: 0, z: 0, map: 1 });
    lever.target1Serial = target.serial;
    lever.target1Property = 'Name/opened/Hue/1150';
    const script = buildSwitch({
      systems: { xmlSpawner },
      protocol: { worldItemSA: () => null, playSound: () => null },
      combat: {},
      log: () => {},
    });

    expect(script.onUse(world, lever, world.createMobile({ x: 0, y: 0, map: 1 }))).toBe(true);
    expect(target.name).toBe('opened');
    expect(target.hue).toBe(1150);
    expect(lever._xmlLeverState).toBe(1);
  });

  it('xml-tile-trap applies enter and exit property actions', () => {
    const trap = createItem(world, { itemId: 0x1BC3, x: 3, y: 4, z: 0, map: 1 });
    const target = createItem(world, { itemId: 0x1000, x: 3, y: 4, z: 0, map: 1 });
    const mob = world.createMobile({ name: 'runner', x: 3, y: 4, map: 1 });
    mob.client = { sendSystemMessage: () => {}, send: () => {} };
    trap.target1Serial = target.serial;
    trap.target1Property = 'Name/entered/Hue/45';
    trap.target0Serial = target.serial;
    trap.target0Property = 'Name/exited/Hue/12';
    const script = buildXmlTileTrap({
      world,
      systems: { xmlSpawner },
      protocol: { worldItemSA: () => null, playSound: () => null },
      combat: {},
      log: () => {},
    });

    script.onWalkOn(world, trap, mob);
    expect(target.name).toBe('entered');
    expect(target.hue).toBe(45);
    expect(trap._xmlTrapInside).toBe(true);

    script.onWalkOff(world, trap, mob);
    expect(target.name).toBe('exited');
    expect(target.hue).toBe(12);
    expect(trap._xmlTrapInside).toBe(false);
  });
});
