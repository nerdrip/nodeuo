// Regression tests for S-03: death/resurrection must infer gender from the
// mobile's live body id (or `sex` flag) rather than the `mob.female`
// attribute that was never set anywhere in the codebase. The old code
// produced male ghosts and male-resurrected bodies for every female player.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { killMobile, resurrectMobile } from '../src/corpse.js';

const MALE_ALIVE     = 0x0190;
const FEMALE_ALIVE   = 0x0191;
const MALE_GHOST     = 0x0192;
const FEMALE_GHOST   = 0x0193;

function makePlayer(world, body) {
  const mob = world.createMobile({ name: 'tester', body, hue: 0, x: 10, y: 10, z: 0, map: 1 });
  mob.hpMax = 50;
  mob.hp = 50;
  // Stub .client so killMobile takes the player-death branch (no world delete)
  // but don't emit packets.
  mob.client = { send: () => {}, sendSystemMessage: () => {} };
  return mob;
}

describe('killMobile — gender-aware ghost body', () => {
  it('turns a male body into a male ghost', () => {
    const w = new World();
    const mob = makePlayer(w, MALE_ALIVE);
    killMobile(w, mob);
    expect(mob.body).toBe(MALE_GHOST);
    expect(mob.ghost).toBe(true);
  });

  it('turns a female body into a female ghost', () => {
    const w = new World();
    const mob = makePlayer(w, FEMALE_ALIVE);
    killMobile(w, mob);
    expect(mob.body).toBe(FEMALE_GHOST);
  });

  it('honours mob.sex=1 when the body id is ambiguous', () => {
    const w = new World();
    const mob = makePlayer(w, MALE_ALIVE);
    mob.sex = 1; // marked female via account flag
    killMobile(w, mob);
    expect(mob.body).toBe(FEMALE_GHOST);
  });
});

describe('resurrectMobile — gender-aware living body', () => {
  it('resurrects a male ghost back to the male human body', () => {
    const w = new World();
    const mob = makePlayer(w, MALE_ALIVE);
    killMobile(w, mob);
    resurrectMobile(w, mob);
    expect(mob.body).toBe(MALE_ALIVE);
    expect(mob.ghost).toBe(false);
    expect(mob.hp).toBeGreaterThan(0);
  });

  it('resurrects a female ghost back to the female human body', () => {
    const w = new World();
    const mob = makePlayer(w, FEMALE_ALIVE);
    killMobile(w, mob);
    resurrectMobile(w, mob);
    expect(mob.body).toBe(FEMALE_ALIVE);
  });
});
