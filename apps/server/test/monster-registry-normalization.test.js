import { describe, expect, it } from 'vitest';
import { MonsterRegistry } from '../src/world/monsters.js';
import { NpcRegistry } from '../src/world/npcs.js';
import { World } from '../src/world/world.js';

describe('MonsterRegistry ServUO taming normalization', () => {
  it('keys independent definitions by definitionId while allowing a shared bodyId', () => {
    const monsters = new MonsterRegistry();
    monsters.register({ definitionId: 'green-dragon', name: 'green dragon', bodyId: 0x003b, hue: 70 });
    monsters.register({ definitionId: 'black-dragon', name: 'black dragon', bodyId: 0x003b, hue: 1109 });

    expect(monsters.get('green-dragon')).toMatchObject({
      definitionId: 'green-dragon', kind: 'green-dragon', bodyId: 0x003b, body: 0x003b, hue: 70,
    });
    expect(monsters.get('black-dragon')).toMatchObject({ definitionId: 'black-dragon', hue: 1109 });
    expect(monsters.get(0x003b)).toBeUndefined();
    expect(monsters.variants(0x003b).map((row) => row.definitionId)).toEqual(['green-dragon', 'black-dragon']);
  });

  it('uses the same canonical identity model for non-hostile NPC definitions', () => {
    const npcs = new NpcRegistry();
    npcs.register({ definitionId: 'red-banker', name: 'Marta', bodyId: 0x0191, hue: 33, behavior: 'banker' });
    npcs.register({ definitionId: 'blue-healer', name: 'Anna', bodyId: 0x0191, hue: 88, behavior: 'healer' });
    expect(npcs.get('red-banker')).toMatchObject({ definitionId: 'red-banker', bodyId: 0x0191, hue: 33, script: 'banker' });
    expect(npcs.get('blue-healer')).toMatchObject({ definitionId: 'blue-healer', bodyId: 0x0191, hue: 88, script: 'healer' });
    expect(npcs.variants(0x0191)).toHaveLength(2);
  });

  it('keeps canonical mobile identity on runtime instances without coupling it to body art', () => {
    const world = new World();
    const red = world.createMobile({ definitionId: 'red-wisp', bodyId: 0x003a, hue: 33 });
    const blue = world.createMobile({ definitionId: 'blue-wisp', bodyId: 0x003a, hue: 88 });
    expect(red).toMatchObject({ definitionId: 'red-wisp', kind: 'red-wisp', bodyId: 0x003a, body: 0x003a, hue: 33 });
    expect(blue).toMatchObject({ definitionId: 'blue-wisp', kind: 'blue-wisp', bodyId: 0x003a, body: 0x003a, hue: 88 });
  });

  it('normalizes extracted Tamable and tenths-based MinTameSkill fields', () => {
    const monsters = new MonsterRegistry();
    const source = {
      kind: 'giant-beetle', name: 'a giant beetle', body: 0x0317,
      tamable: true, minTameSkill: 700,
    };
    monsters.register(source);

    const cfg = monsters.get('giant-beetle');
    expect(cfg).toMatchObject({
      tameable: true,
      tamable: true,
      tameMinSkill: 70,
      tameMaxSkill: 100,
    });
    expect(source.tameable).toBeUndefined(); // registry does not mutate data input
  });

  it('preserves explicitly authored min/max ranges', () => {
    const monsters = new MonsterRegistry();
    monsters.register({
      kind: 'horse', name: 'a horse', body: 0x00C8,
      tameable: true, tameMinSkill: 0, tameMaxSkill: 30,
    });
    expect(monsters.get('horse')).toMatchObject({ tameMinSkill: 0, tameMaxSkill: 30 });
  });
});
