import { describe, it, expect } from 'vitest';
import { Spawner } from '../src/spawner.js';
import { World } from '../src/world/world.js';

describe('Spawner', () => {
  it('spawns up to maxCount then stops, and respawns after a death', () => {
    const world = new World();
    let created = 0;
    const factory = (w, kind, pos) => {
      created++;
      return w.createMobile({ name: `${kind}#${created}`, x: pos.x, y: pos.y, z: pos.z, map: pos.map });
    };
    const sp = new Spawner(world, factory);
    const g = sp.add({
      id: 'test',
      map: 1,
      rect: { x1: 0, y1: 0, x2: 5, y2: 5 },
      maxCount: 3,
      respawnMs: [0, 0],
      kinds: ['orc'],
    });

    for (let i = 0; i < 10; i++) sp.tick();
    expect(g.spawnedSerials.size).toBe(3);
    expect(created).toBe(3);

    // Kill one.
    const dead = [...g.spawnedSerials][0];
    world.removeMobile(dead);
    sp.tick();
    expect(g.spawnedSerials.size).toBe(3);
    expect(created).toBe(4);
  });

  it('tracks only the kinds that the factory produces', () => {
    const world = new World();
    const factory = (w, kind, pos) => {
      if (kind === 'skip') return null;
      return w.createMobile({ name: kind, x: pos.x, y: pos.y, z: pos.z, map: pos.map });
    };
    const sp = new Spawner(world, factory);
    const g = sp.add({
      id: 'mixed',
      map: 1,
      rect: { x1: 0, y1: 0, x2: 5, y2: 5 },
      maxCount: 5,
      respawnMs: [0, 0],
      kinds: ['skip'],
    });
    for (let i = 0; i < 10; i++) sp.tick();
    expect(g.spawnedSerials.size).toBe(0);
  });
});
