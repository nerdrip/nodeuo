import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem, destroyItem } from '../src/world/items.js';
import buildGreenThorns, {
  applyGreenThornsEffect, buildGreenThornsSolenHole, greenThornsTerrain,
  SERVUO_GREEN_THORNS_CLASSES,
} from '../../scripts/src/items/scripts/consumables/green-thorns.js';

function apiFor(world) {
  return {
    world,
    items: { createItem, destroyItem },
    monsters: { get: () => null },
    ai: { attach: vi.fn() },
  };
}

describe('ServUO green thorns functional port', () => {
  it('uses the canonical five terrain groups', () => {
    expect(greenThornsTerrain(0x71)).toBe('dirt');
    expect(greenThornsTerrain(0x09)).toBe('furrows');
    expect(greenThornsTerrain(0x9C4)).toBe('swamp');
    expect(greenThornsTerrain(0x10C)).toBe('snow');
    expect(greenThornsTerrain(0x16)).toBe('sand');
    expect(greenThornsTerrain(0x8000)).toBeNull();
  });

  it('spawns all five outcomes in the native world model', () => {
    const world = new World();
    const api = apiFor(world);
    const from = world.createMobile({ name: 'gardener', body: 0x190, x: 100, y: 100, z: 0, map: 1 });
    const at = { x: 101, y: 100, z: 0, map: 1 };

    expect(applyGreenThornsEffect(api, world, 'dirt', at, from)).toMatchObject({ ok: true, spawned: 8 });
    expect([...world.items.values()].filter((item) => item.stackable)).toHaveLength(8);
    expect(applyGreenThornsEffect(api, world, 'furrows', at, from)).toMatchObject({ ok: true, spawned: 1 });
    expect(applyGreenThornsEffect(api, world, 'swamp', at, from)).toMatchObject({ ok: true, spawned: 1 });
    expect(applyGreenThornsEffect(api, world, 'snow', at, from)).toMatchObject({ ok: true, spawned: 4 });
    expect(applyGreenThornsEffect(api, world, 'sand', at, from)).toMatchObject({ ok: true, spawned: 1 });
    expect([...world.mobiles.values()].filter((mob) => mob !== from)).toHaveLength(6);
    expect([...world.items.values()].some((item) => item.script === 'green-thorns-solen-hole')).toBe(true);
  });

  it('publishes the ServUO effect identities and expires temporary holes', () => {
    const world = new World();
    const api = apiFor(world);
    expect(buildGreenThorns(api).servuoClasses).toEqual(SERVUO_GREEN_THORNS_CLASSES);
    const hole = createItem(world, { itemId: 0x913, expiresAt: Date.now() - 1 });
    buildGreenThornsSolenHole(api).onTick(world, hole);
    expect(world.items.has(hole.serial)).toBe(false);
  });
});
