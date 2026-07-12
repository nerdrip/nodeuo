import { describe, expect, it } from 'vitest';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';
import { World } from '../src/world/world.js';
import { stampStealable } from '../../scripts/src/items/definitions/stealable-pool.js';

describe('monster stealable pools', () => {
  it('maps a paragon base kind onto its ServUO-style stealable pool', () => {
    const mob = { kind: 'dragon', paragon: true };
    stampStealable(mob);
    expect(mob._stealableLoot).toBe(true);
    expect(mob._stealablePool.length).toBeGreaterThan(0);
    expect(mob._stealablePool).not.toBe(mob._stealablePool.slice());
  });

  it('persists the remaining per-creature pool across restart', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'a dragon' });
    mob.kind = 'dragon';
    mob.paragon = true;
    stampStealable(mob);
    mob._stealablePool.shift();

    const restored = new World();
    restoreWorld(restored, JSON.parse(JSON.stringify(snapshotWorld(world))));
    expect(restored.mobiles.get(mob.serial)._stealablePool).toEqual(mob._stealablePool);
    expect(restored.mobiles.get(mob.serial)._stealableLoot).toBe(true);
  });
});
