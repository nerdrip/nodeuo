// Item templates + AI scheduler basic tests.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { registerTemplate, spawn, useItem, _resetTemplatesForTest, templateNames } from '../src/world/templates.js';
import { AIScheduler } from '../src/world/ai.js';
import { MonsterRegistry } from '../src/world/monsters.js';

describe('item templates', () => {
  beforeEach(() => _resetTemplatesForTest());
  afterEach(() => _resetTemplatesForTest());

  it('spawns with defaults and overrides', () => {
    registerTemplate({ name: 'torch', itemId: 0x0A25, label: 'a torch', hue: 0 });
    const world = new World();
    const item = spawn(world, 'torch', { x: 100, y: 200, z: 0, hue: 7 });
    expect(item.itemId).toBe(0x0A25);
    expect(item.x).toBe(100);
    expect(item.hue).toBe(7);
    expect(item.name).toBe('a torch');
  });

  it('invokes onUse via useItem', () => {
    let used = 0;
    registerTemplate({
      name: 'lever',
      itemId: 0x108C,
      onUse() { used++; },
    });
    const world = new World();
    const item = spawn(world, 'lever', { x: 0, y: 0, z: 0 });
    const mob = world.createMobile({ name: 'Tester' });
    expect(useItem(world, item, mob)).toBe(true);
    expect(used).toBe(1);
  });

  it('useItem on non-templated items returns false', () => {
    const world = new World();
    const item = world.items.get(0) ?? { serial: 0, itemId: 0, template: undefined };
    expect(useItem(world, { ...item, template: undefined }, { name: 't' })).toBe(false);
  });

  it('templateNames reflects registrations', () => {
    registerTemplate({ name: 'a', itemId: 1 });
    registerTemplate({ name: 'b', itemId: 2 });
    expect(templateNames()).toEqual(['a', 'b']);
  });

  it('resolves ServUO aliases for spawning without polluting template names', () => {
    registerTemplate({ name: 'gift-box', itemId: 0x232A, servuoClasses: ['GiftBox', 'GiftBoxRectangle'] });
    const world = new World();
    const item = spawn(world, 'GiftBox', { x: 1, y: 2, z: 0 });
    expect(item.itemId).toBe(0x232A);
    expect(templateNames()).toEqual(['gift-box']);
  });
});

describe('monster templates', () => {
  it('resolves ServUO mobile aliases without adding duplicate kind names', () => {
    const monsters = new MonsterRegistry();
    monsters.register({ kind: 'coconut-crab', name: 'coconut crab', body: 1510, servuoClasses: ['CoconutCrab', 'HungryCoconutCrab'] });
    expect(monsters.get('CoconutCrab')?.kind).toBe('coconut-crab');
    expect(monsters.get('hungrycoconutcrab')?.kind).toBe('coconut-crab');
    expect(monsters.kinds()).toEqual(['coconut-crab']);
  });
});

describe('AIScheduler', () => {
  it('ticks bound mobiles and honors detach', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'Crier', x: 100, y: 100 });
    let ticks = 0;
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
    });
    ai.registerBehavior({ name: 'counter', tick: () => ticks++ });
    ai.attach(mob, 'counter');
    ai._tickAll();
    ai._tickAll();
    expect(ticks).toBe(2);
    ai.detach(mob);
    ai._tickAll();
    expect(ticks).toBe(2);
  });

  it('skips binding for missing mobiles without throwing', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'Ghost' });
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
    });
    ai.registerBehavior({ name: 'noop', tick() {} });
    ai.attach(mob, 'noop');
    world.removeMobile(mob.serial);
    expect(() => ai._tickAll()).not.toThrow();
    expect(ai.bindings.has(mob.serial)).toBe(false);
  });

  it('unregisterBehavior detaches bound mobiles', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'A' });
    const ai = new AIScheduler(world, {
      mobileMovingPacket: () => new Uint8Array(),
      unicodeSpeechPacket: () => new Uint8Array(),
    });
    ai.registerBehavior({ name: 'x', tick() {} });
    ai.attach(mob, 'x');
    ai.unregisterBehavior('x');
    expect(ai.bindings.has(mob.serial)).toBe(false);
  });
});
