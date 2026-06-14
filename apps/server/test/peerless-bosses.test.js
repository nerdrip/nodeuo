import { describe, it, expect } from 'vitest';
import { tickBosses } from '../src/systems/bosses/peerless-bosses.js';

function worldWith(...mobs) {
  return { mobiles: new Map(mobs.map((m) => [m.serial, m])) };
}

describe('peerless boss mechanics', () => {
  it('Travesty spawns mirror images through the spawnNear hook', () => {
    const boss = {
      serial: 1,
      kind: 'travesty',
      name: 'Travesty',
      body: 0x0119,
      hp: 200,
      hpMax: 1000,
      _bossInited: true,
      _origBody: 0x0119,
      _origName: 'Travesty',
      _cooldown: { swap: 0, mirror: 0 },
      _mirrors: [],
    };
    const target = { serial: 2, client: {}, name: 'Tester', body: 0x0190, hp: 50, map: 1, x: 0, y: 0 };
    const spawns = [];

    tickBosses(worldWith(boss, target), 1000, {
      findTargetsInRange: () => [target],
      broadcastBodyChange: () => {},
      spawnNear: (_boss, spec) => {
        spawns.push(spec);
        return { serial: 100 + spawns.length };
      },
    });

    expect(boss.name).toBe('Travesty as Tester');
    expect(spawns).toHaveLength(3);
    expect(spawns.every((s) => s.kind === 'travesty-echo')).toBe(true);
  });

  it('Dark Father summons gibberlings through the spawnNear hook', () => {
    const boss = {
      serial: 1,
      kind: 'darkfather',
      name: 'Dark Father',
      hp: 900,
      hpMax: 1000,
      _bossInited: true,
      _cooldown: { summon: 0, frenzy: 0 },
      _minions: [],
      phase: 1,
    };
    const spawns = [];

    tickBosses(worldWith(boss), 1000, {
      isAlive: () => false,
      spawnNear: (_boss, spec) => {
        spawns.push(spec);
        return { serial: 200 + spawns.length };
      },
    });

    expect(spawns).toHaveLength(1);
    expect(spawns[0].kind).toBe('gibberling');
    expect(boss._minions).toHaveLength(1);
  });

  it('Lord Oaks spawns catalogued parasitic roots below half health', () => {
    const boss = {
      serial: 1,
      kind: 'lord-oaks',
      name: 'Lord Oaks',
      hp: 400,
      hpMax: 1000,
      _bossInited: true,
      _lastHeal: 0,
      _roots: [],
    };
    const kinds = [];

    tickBosses(worldWith(boss), 1000, {
      spawnNearby: (_boss, kind) => {
        kinds.push(kind);
        return { serial: 300 + kinds.length };
      },
      findNearbyByKind: () => null,
    });

    expect(kinds).toEqual(['parasitic-root']);
    expect(boss._roots).toHaveLength(1);
  });
});
