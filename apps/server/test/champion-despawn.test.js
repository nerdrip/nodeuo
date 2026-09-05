// BUGFIX #36 (PHASE BT): ChampionAltar.stop() / boss-cleanup must call
// the `despawn` dep so observers receive a removeEntity for every mob
// the altar nukes. Otherwise nearby clients keep stale sprites until
// they walk 18 tiles away. The status broadcaster also fires on every
// state change for the new champion-bar UI.

import { describe, it, expect, beforeEach } from 'vitest';
import { ChampionAltar } from '../src/systems/bosses/champion.js';

function makeWorld() {
  const world = { mobiles: new Map(), items: new Map() };
  world.destroyMobile = (serial) => world.mobiles.delete(serial);
  return world;
}

describe('ChampionAltar despawn + status hooks (PHASE BT)', () => {
  /** @type {ReturnType<typeof makeWorld>} */ let w;
  /** @type {number[]} */ let despawned;
  /** @type {any[]} */ let broadcasts;
  /** @type {ChampionAltar} */ let altar;

  const cfg = {
    name: 'test', map: 1, cx: 100, cy: 100, cz: 0, radius: 4,
    tiers: [
      { kinds: ['mob1'], capAlive: 3, killsToAdvance: 2 },
      { kinds: ['mob2'], capAlive: 2, killsToAdvance: 1 },
    ],
    bossKind: 'boss',
  };

  beforeEach(() => {
    w = makeWorld();
    despawned = [];
    broadcasts = [];
    let nextSerial = 1;
    altar = new ChampionAltar(w, cfg, {
      spawnFactory: (world, kind, pos) => {
        const m = {
          serial: nextSerial++, name: kind, body: 0x0001,
          x: pos.x, y: pos.y, z: pos.z, map: pos.map,
          hp: 100, hpMax: 100,
        };
        world.mobiles.set(m.serial, m);
        return m;
      },
      despawn: (_world, serial) => { despawned.push(serial); },
      broadcastStatus: (_world, _cfg, status) => { broadcasts.push(status); },
    });
  });

  it('start() broadcasts initial status', () => {
    altar.start();
    expect(broadcasts.length).toBeGreaterThan(0);
    expect(broadcasts.at(-1).active).toBe(true);
  });

  it('tick() spawns mobs to capAlive then broadcasts', () => {
    altar.start();
    broadcasts.length = 0;
    altar.tick();
    expect(altar.spawned.size).toBe(3);
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it('killed mobs trigger tier advance and re-broadcast', () => {
    altar.start();
    altar.tick();
    expect(altar.tier).toBe(0);
    // Kill all spawned mobs by zeroing hp.
    for (const s of altar.spawned) w.mobiles.get(s).hp = 0;
    broadcasts.length = 0;
    altar.tick();
    // Tier 0 needs 2 kills; we just delivered 3, so we advance.
    expect(altar.tier).toBe(1);
    expect(broadcasts.length).toBeGreaterThan(0);
  });

  it('stop() despawns every spawned mob via the dep callback', () => {
    altar.start();
    altar.tick();
    const spawnedSerials = [...altar.spawned];
    expect(spawnedSerials.length).toBeGreaterThan(0);
    altar.stop();
    // Every spawned mob got a despawn broadcast.
    for (const s of spawnedSerials) {
      expect(despawned).toContain(s);
    }
    // And was removed from world.mobiles.
    for (const s of spawnedSerials) {
      expect(w.mobiles.has(s)).toBe(false);
    }
  });

  it('stop() despawns the boss too', () => {
    altar.start();
    // Force boss spawn directly.
    altar.tier = cfg.tiers.length;
    altar.spawnBoss();
    expect(altar.boss).toBeGreaterThan(0);
    const bossSerial = altar.boss;
    altar.stop();
    expect(despawned).toContain(bossSerial);
  });

  it('stop() with no `despawn` dep still uses the mobile lifecycle', () => {
    const legacy = new ChampionAltar(w, cfg, {
      spawnFactory: () => ({ serial: 99, hp: 100, hpMax: 100 }),
      // no despawn dep on purpose
    });
    legacy.start();
    legacy.spawned.add(99);
    w.mobiles.set(99, { serial: 99, hp: 100 });
    expect(() => legacy.stop()).not.toThrow();
    expect(w.mobiles.has(99)).toBe(false);
  });
});
