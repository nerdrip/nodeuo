import { describe, expect, it } from 'vitest';
import { MonsterRegistry } from '../src/world/monsters.js';

describe('MonsterRegistry ServUO taming normalization', () => {
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
