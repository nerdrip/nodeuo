// PHASE BV — Shrine resurrection: ghost adjacency check, HP/mana/stam
// restoration, fullRestore vs default policy. Plus regression for
// bugfix #38: corpse spawnedAt now persists.

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { killMobile } from '../src/corpse.js';
import * as corpseModule from '../src/corpse.js';
import { placeShrine, resurrectAtShrine } from '../src/systems/shrines.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';

describe('Shrine resurrection (PHASE BV)', () => {
  /** @type {World} */ let w;
  /** @type {any} */ let mob;
  /** @type {any} */ let shrine;

  beforeEach(() => {
    w = new World();
    mob = w.createMobile({ name: 'tester', body: 0x0190, x: 100, y: 100, z: 0, map: 1 });
    mob.hp = mob.hpMax = 50;
    mob.mana = mob.manaMax = 50;
    mob.stam = mob.stamMax = 50;
    mob.client = { send: () => {}, sendSystemMessage: () => {} };
    killMobile(w, mob);
    shrine = placeShrine({ items: { createItem } }, w, {
      name: 'TestShrine', x: 100, y: 100, z: 0, map: 1,
    });
  });

  it('rejects living mobiles', () => {
    mob.ghost = false;
    mob.body = 0x0190;
    expect(resurrectAtShrine(w, corpseModule, mob, shrine)).toBe(false);
  });

  it('rejects ghosts more than 2 tiles away', () => {
    mob.x = 110; mob.y = 100;
    expect(resurrectAtShrine(w, corpseModule, mob, shrine)).toBe(false);
    expect(mob.ghost).toBe(true);
  });

  it('resurrects an adjacent ghost (default = half HP, no mana, full stam)', () => {
    mob.x = 101; mob.y = 100;
    expect(resurrectAtShrine(w, corpseModule, mob, shrine)).toBe(true);
    expect(mob.ghost).toBe(false);
    expect(mob.hp).toBe(25);                     // half of 50
    expect(mob.mana).toBe(0);
    expect(mob.stam).toBe(50);                    // full
  });

  it('fullRestore shrines bring back HP/mana/stam at full', () => {
    shrine.shrine.fullRestore = true;
    mob.x = 100; mob.y = 100;
    expect(resurrectAtShrine(w, corpseModule, mob, shrine)).toBe(true);
    expect(mob.hp).toBe(50);
    expect(mob.mana).toBe(50);
    expect(mob.stam).toBe(50);
  });

  it('rejects cross-map shrines', () => {
    shrine.map = 2;
    mob.x = 100; mob.y = 100;
    expect(resurrectAtShrine(w, corpseModule, mob, shrine)).toBe(false);
  });
});

describe('BUGFIX #38 — corpse spawnedAt persists across save/load', () => {
  it('round-trips corpse.spawnedAt through snapshotWorld / restoreWorld', () => {
    const w = new World();
    const mob = w.createMobile({ name: 'doomed', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.hp = mob.hpMax = 50;
    killMobile(w, mob);  // spawns a corpse
    const corpse = [...w.items.values()].find((it) => it.itemId === 0x2006);
    expect(corpse).toBeTruthy();
    const originalSpawnedAt = corpse.spawnedAt;
    expect(typeof originalSpawnedAt).toBe('number');

    const snap = snapshotWorld(w);
    const w2 = new World();
    restoreWorld(w2, snap);
    const corpse2 = [...w2.items.values()].find((it) => it.itemId === 0x2006);
    expect(corpse2).toBeTruthy();
    expect(corpse2.spawnedAt).toBe(originalSpawnedAt);
  });
});
