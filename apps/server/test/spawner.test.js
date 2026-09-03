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

  it('honors enabled, schedule and player-count conditions without mutating paused groups', () => {
    const world = new World();
    const factory = (w, kind, pos) => w.createMobile({ name: kind, ...pos });
    const sp = new Spawner(world, factory);
    const mondayNoon = Date.UTC(2026, 6, 13, 12, 0, 0);
    const group = sp.add({
      id: 'scheduled', map: 1, rect: { x1: 10, y1: 10, x2: 12, y2: 12 },
      maxCount: 1, respawnMs: [0, 0], kinds: ['rat'], enabled: false,
      schedule: { days: [1], startHour: 10, endHour: 14 }, regionConditions: { minPlayers: 1, maxPlayers: 2 },
    });
    group.nextSpawnAt = 0;
    sp.tick(mondayNoon);
    expect(group.spawnedSerials.size).toBe(0);
    group.enabled = true;
    sp.tick(mondayNoon);
    expect(group.spawnedSerials.size).toBe(0);
    const player = world.createMobile({ name: 'player', x: 11, y: 11, z: 0, map: 1 });
    player.client = {};
    sp.tick(mondayNoon);
    expect(group.spawnedSerials.size).toBe(1);
    expect(world.mobiles.get([...group.spawnedSerials][0])).toMatchObject({ homeRange: 10, roaming: 'home' });
  });

  it('atomically resets definitions, tracked mobs and every lookup index', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    const group = spawner.add({
      id: 'wipe-me', map: 1, rect: { x1: 16, y1: 16, x2: 20, y2: 20 },
      maxCount: 1, respawnMs: [0, 0], kinds: ['rat'],
    });
    group.nextSpawnAt = 0;
    spawner.tick();
    const spawned = [...group.spawnedSerials][0];

    const result = spawner.reset();

    expect(result).toEqual({ groupsRemoved: 1, trackedMobilesRemoved: 1 });
    expect(world.mobiles.has(spawned)).toBe(false);
    expect(spawner.groups.size).toBe(0);
    expect(spawner._groupsBySector.size).toBe(0);
    expect(spawner._sectorsByGroup.size).toBe(0);
    expect(spawner._globalGroups.size).toBe(0);
    expect([...spawner.groupsNear(1, 18, 18, 4)]).toEqual([]);
    expect(spawner.validateIndex()).toMatchObject({ ok: true, missing: [], orphaned: [] });
  });

  it('preserves live tracking across definition edits and script hot reload', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    const first = spawner.add({
      id: 'reload-safe', map: 1, rect: { x1: 1, y1: 1, x2: 2, y2: 2 },
      maxCount: 1, respawnMs: [0, 0], kinds: ['rat'],
    });
    first.nextSpawnAt = 0;
    spawner.tick();
    const serial = [...first.spawnedSerials][0];

    const edited = spawner.add({
      id: 'reload-safe', map: 1, rect: { x1: 3, y1: 3, x2: 4, y2: 4 },
      maxCount: 2, respawnMs: [1000, 2000], kinds: ['rat'],
    });
    expect([...edited.spawnedSerials]).toEqual([serial]);

    spawner.remove('reload-safe', { preserveRuntime: true });
    const reloaded = spawner.add({
      id: 'reload-safe', map: 1, rect: { x1: 3, y1: 3, x2: 4, y2: 4 },
      maxCount: 2, respawnMs: [1000, 2000], kinds: ['rat'],
    });
    expect([...reloaded.spawnedSerials]).toEqual([serial]);
    expect(spawner.validateIndex()).toMatchObject({ ok: true });
  });
});
