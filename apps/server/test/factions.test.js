// FAZA BY — faction membership + bugfix #41 (same-faction Ally).

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import {
  joinFaction, leaveFaction, recordFactionKill, rankOf, FACTIONS,
} from '../src/systems/pvp/factions.js';
import { viewerNotoriety, NOTO } from '../src/notoriety.js';

function makeMob(world, name) {
  return world.createMobile({ name, body: 0x190, x: 0, y: 0, z: 0, map: 1 });
}

describe('factions (FAZA BY)', () => {
  it('joinFaction validates the key', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    expect(joinFaction(a, 'council')).toBe(true);
    expect(joinFaction(a, 'council')).toBe(false);  // idempotent
    expect(joinFaction(a, 'nonsense')).toBe(false); // bad key
    expect(a.faction).toBe('council');
  });

  it('leaveFaction clears membership; reset zeroes kills', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    joinFaction(a, 'minax');
    a.factionKills = 3;
    leaveFaction(a);
    expect(a.faction).toBeUndefined();
    expect(a.factionKills).toBe(3);     // preserved by default
    joinFaction(a, 'truebrits');
    leaveFaction(a, { reset: true });
    expect(a.factionKills).toBe(0);
  });

  it('recordFactionKill credits opposing-faction PvP only', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    const b = makeMob(w, 'b');
    joinFaction(a, 'council');
    joinFaction(b, 'minax');
    expect(recordFactionKill(a, b)).toBe(true);
    expect(a.factionKills).toBe(1);
    // Same faction → no credit
    joinFaction(b, 'council');
    expect(recordFactionKill(a, b)).toBe(false);
    // Unfactioned victim → no credit
    leaveFaction(b);
    expect(recordFactionKill(a, b)).toBe(false);
  });

  it('rankOf gates by kill thresholds', () => {
    const m1 = { factionKills: 0 };
    const m2 = { factionKills: 5 };
    const m3 = { factionKills: 75 };
    const m4 = { factionKills: 500 };
    expect(rankOf(m1).rank).toBe(1);
    expect(rankOf(m2).rank).toBe(2);
    expect(rankOf(m3).rank).toBe(4);
    expect(rankOf(m4).rank).toBe(5);
  });

  it('FACTIONS constant lists the four canonical UO factions', () => {
    expect(Object.keys(FACTIONS).sort()).toEqual(
      ['council', 'minax', 'shadowlords', 'truebrits'].sort(),
    );
  });
});

describe('BUGFIX #41 — same-faction Ally in viewerNotoriety', () => {
  it('two same-faction members see each other as Ally (green)', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    const b = makeMob(w, 'b');
    a.client = {};   // tag both as players so murder logic short-circuits
    b.client = {};
    a.notoriety = NOTO.Innocent;
    b.notoriety = NOTO.Innocent;
    joinFaction(a, 'council');
    joinFaction(b, 'council');
    expect(viewerNotoriety(b, a, w)).toBe(NOTO.Ally);
    expect(viewerNotoriety(a, b, w)).toBe(NOTO.Ally);
  });

  it('opposing-faction members still resolve as Enemy', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    const b = makeMob(w, 'b');
    a.client = {}; b.client = {};
    a.notoriety = NOTO.Innocent;
    b.notoriety = NOTO.Innocent;
    joinFaction(a, 'minax');
    joinFaction(b, 'truebrits');
    expect(viewerNotoriety(b, a, w)).toBe(NOTO.Enemy);
  });

  it('unfactioned vs factioned falls through to default notoriety', () => {
    const w = new World();
    const a = makeMob(w, 'a');
    const b = makeMob(w, 'b');
    a.client = {}; b.client = {};
    a.notoriety = NOTO.Innocent;
    b.notoriety = NOTO.Innocent;
    joinFaction(a, 'council');
    // b has no faction
    expect(viewerNotoriety(b, a, w)).toBe(NOTO.Innocent);
  });
});
