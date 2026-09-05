import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import {
  WorldVerificationService,
  compareStateCheckpoints,
  fingerprintWorld,
  scanWorldInvariants,
} from '../src/systems/state-verification.js';

describe('deterministic world verification', () => {
  it('produces stable fingerprints independent of insertion order', () => {
    const a = new World(); const b = new World();
    a.mobiles.set(2, { serial: 2, name: 'b', x: 1, y: 2, z: 0, map: 1 });
    a.mobiles.set(1, { serial: 1, name: 'a', x: 1, y: 2, z: 0, map: 1 });
    b.mobiles.set(1, { serial: 1, name: 'a', x: 1, y: 2, z: 0, map: 1 });
    b.mobiles.set(2, { serial: 2, name: 'b', x: 1, y: 2, z: 0, map: 1 });
    expect(fingerprintWorld(a)).toEqual(fingerprintWorld(b));
    b.mobiles.get(2).x = 9;
    expect(fingerprintWorld(a).state).not.toBe(fingerprintWorld(b).state);
  });

  it('finds cross-map serial collisions, container cycles and invalid gold', () => {
    const world = new World();
    world.mobiles.set(1, { serial: 1, x: 0, y: 0, z: 0, map: 0, gold: -1 });
    world.items.set(1, { serial: 1, amount: 1, parent: 2 });
    world.items.set(2, { serial: 2, amount: 1, parent: 1 });
    world._childrenByParent = new Map([[2, new Set([1])], [1, new Set([2])]]);
    const result = scanWorldInvariants(world);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'serial-collision', 'negative-gold', 'container-cycle',
    ]));
  });

  it('accepts the zero parent sentinel used by ground items', () => {
    const world = new World();
    world.items.set(5, { serial: 5, amount: 1, parent: 0, x: 10, y: 10, z: 0, map: 0 });
    expect(scanWorldInvariants(world)).toMatchObject({ ok: true, issues: [] });
  });

  it('compares named checkpoints for replay verification', () => {
    const world = new World();
    const service = new WorldVerificationService(world);
    const before = service.checkpoint('before');
    const same = service.checkpoint('same');
    expect(compareStateCheckpoints(before, same).ok).toBe(true);
    world.mobiles.set(3, { serial: 3, x: 0, y: 0, z: 0, map: 0 });
    const after = service.checkpoint('after');
    expect(service.compare(before.id, after.id).ok).toBe(false);
  });
});
