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

  it('adopts persisted spawned mobiles on boot instead of duplicating them', () => {
    const world = new World();
    const restored = world.createMobile({ name: 'restored rat', x: 1, y: 1, z: 0, map: 1 });
    restored.spawnerId = 'persisted-group';
    let created = 0;
    const spawner = new Spawner(world, (w, kind, pos) => {
      created++;
      return w.createMobile({ name: kind, ...pos });
    });
    const group = spawner.add({
      id: 'persisted-group', map: 1, rect: { x1: 0, y1: 0, x2: 2, y2: 2 },
      maxCount: 1, respawnMs: [0, 0], kinds: ['rat'], nextSpawnAt: 0,
    });

    expect([...group.spawnedSerials]).toEqual([restored.serial]);
    spawner.tick();
    expect(created).toBe(0);
    expect(spawner.runtimeSnapshot().trackedMobiles).toBe(1);
  });

  it('despawns tracked mobiles when a generated definition is removed', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    const group = spawner.add({
      id: 'generated', map: 1, rect: { x1: 1, y1: 1, x2: 2, y2: 2 },
      maxCount: 1, respawnMs: [0, 0], kinds: ['vendor'],
    });
    group.nextSpawnAt = 0;
    spawner.tick();
    const serial = [...group.spawnedSerials][0];
    const pack = world.createItem({ itemId: 0x0e75, parent: serial });
    const nested = world.createItem({ itemId: 0x0eed, parent: pack.serial });

    spawner.remove('generated', { despawn: true });

    expect(world.mobiles.has(serial)).toBe(false);
    expect(world.items.has(pack.serial)).toBe(false);
    expect(world.items.has(nested.serial)).toBe(false);
    expect(spawner.groups.has('generated')).toBe(false);
    expect(spawner._mobileToGroup.has(serial)).toBe(false);
    expect(spawner.validateIndex()).toMatchObject({ ok: true });
  });

  it('despawns selected facets without deleting their definitions', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    const first = spawner.add({ id: 'fel', map: 1, rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, maxCount: 1, respawnMs: [0, 0], kinds: ['rat'] });
    const second = spawner.add({ id: 'tram', map: 2, rect: { x1: 1, y1: 1, x2: 2, y2: 2 }, maxCount: 1, respawnMs: [0, 0], kinds: ['rat'] });
    first.nextSpawnAt = 0; second.nextSpawnAt = 0;
    spawner.tick();
    const survivor = [...second.spawnedSerials][0];

    expect(spawner.despawnWhere((group) => group.map === 1)).toEqual({ groupsMatched: 1, mobilesRemoved: 1 });
    expect(spawner.groups.size).toBe(2);
    expect(first.spawnedSerials.size).toBe(0);
    expect(world.mobiles.has(survivor)).toBe(true);
    expect(second.spawnedSerials.size).toBe(1);
  });

  it('checks only due groups and immediately refills a released slot', () => {
    const world = new World();
    let created = 0;
    const spawner = new Spawner(world, (w, kind, pos) => {
      created++;
      return w.createMobile({ name: kind, ...pos });
    });
    const sleeping = spawner.add({
      id: 'sleeping', map: 1, rect: { x1: 1, y1: 1, x2: 2, y2: 2 },
      maxCount: 1, respawnMs: [60_000, 60_000], kinds: ['rat'],
      nextSpawnAt: 90_000,
    });
    const due = spawner.add({
      id: 'due', map: 1, rect: { x1: 3, y1: 3, x2: 4, y2: 4 },
      maxCount: 1, respawnMs: [60_000, 60_000], kinds: ['orc'],
      nextSpawnAt: 1_000,
    });

    spawner.tick(1_000);
    expect(created).toBe(1);
    expect(sleeping.spawnedSerials.size).toBe(0);
    const serial = [...due.spawnedSerials][0];
    expect(spawner.runtimeSnapshot()).toMatchObject({ groupsChecked: 1, trackedMobiles: 1 });

    world.removeMobile(serial);
    spawner.tick(61_000);
    expect(created).toBe(2);
    expect(due.spawnedSerials.size).toBe(1);
  });

  it('supports real direct spawns, listings and runtime density changes', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    const direct = spawner.spawn('banker', { x: 10, y: 20, z: 0, map: 1 });
    expect(direct).toMatchObject({ name: 'banker', kind: 'banker', x: 10, y: 20 });

    const group = spawner.add({
      id: 'density', map: 1, rect: { x1: 1, y1: 1, x2: 2, y2: 2 },
      maxCount: 2, respawnMs: [0, 0], kinds: ['rat'],
    });
    expect(spawner.list()).toContain(group);
    expect(spawner.setDensity(2)).toBe(2);
    for (let i = 0; i < 5; i++) { group.nextSpawnAt = 0; spawner.tick(); }
    expect(group.spawnedSerials.size).toBe(4);
    expect(spawner.runtimeSnapshot()).toMatchObject({ densityFactor: 2 });
  });

  it('does not scan thousands of sleeping spawn definitions', () => {
    const world = new World();
    const spawner = new Spawner(world, (w, kind, pos) => w.createMobile({ name: kind, ...pos }));
    let due = null;
    for (let i = 0; i < 7_000; i++) {
      const group = spawner.add({
        id: `bulk-${i}`, map: 1, rect: { x1: 0, y1: 0, x2: 1, y2: 1 },
        maxCount: 1, respawnMs: [60_000, 60_000], kinds: ['rat'],
        nextSpawnAt: 100_000,
      });
      if (i === 6_999) due = group;
    }

    spawner.tick(1_000);
    expect(spawner.runtimeSnapshot()).toMatchObject({ groups: 7_000, groupsChecked: 0 });
    due.nextSpawnAt = 0;
    spawner.tick(1_000);
    expect(spawner.runtimeSnapshot()).toMatchObject({ groupsChecked: 1, groupsSpawned: 1 });
  });
});
