import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { carveCorpse, killMobile } from '../src/corpse.js';

describe('corpse carving', () => {
  it('creates body-appropriate resources once and enforces range', () => {
    const world = new World();
    const wolf = world.createMobile({ name: 'a timber wolf', kind: 'timber-wolf', body: 0xE1, x: 10, y: 10, z: 0, map: 1 });
    wolf.hp = 10; wolf.hpMax = 10;
    const carver = world.createMobile({ name: 'hunter', body: 0x190, x: 10, y: 11, z: 0, map: 1 });
    const corpse = killMobile(world, wolf, carver);

    const first = carveCorpse(world, corpse, carver);
    expect(first.ok).toBe(true);
    expect(first.items.map((item) => item.name)).toContain('hides');
    expect(carveCorpse(world, corpse, carver)).toMatchObject({ ok: false, reason: 'already-carved' });

    const farCorpse = world.createItem({ itemId: 0x2006, x: 100, y: 100, z: 0, map: 1, amount: 0xE1 });
    expect(carveCorpse(world, farCorpse, carver)).toMatchObject({ ok: false, reason: 'out-of-range' });
  });
});
