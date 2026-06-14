// FAZA DG / bugfix #75: resurrect must broadcast healthUpdate to
// observers; resurrector earns Compassion virtue.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { resurrectMobile } from '../src/corpse.js';

describe('resurrectMobile broadcast (FAZA DG / #75)', () => {
  it('ships 0xA1 healthUpdate to nearby observers', () => {
    const w = new World();
    const subject = w.createMobile({
      name: 'subject', body: 0x192, x: 100, y: 100, z: 0, map: 1,
      hp: 0, hpMax: 50,
    });
    subject.ghost = true;
    subject.client = { send: () => {}, sendSystemMessage: () => {} };
    const sent = [];
    const observer = w.createMobile({
      name: 'witness', body: 0x190, x: 102, y: 100, z: 0, map: 1,
    });
    observer.client = { send: (b) => sent.push(b) };
    resurrectMobile(w, subject);
    expect(sent.some((b) => b[0] === 0xA1)).toBe(true);
  });

  it('awards Compassion to the resurrector when it is another mobile', () => {
    const w = new World();
    const dead = w.createMobile({
      name: 'dead', body: 0x192, x: 0, y: 0, z: 0, map: 1, hp: 0, hpMax: 50,
    });
    dead.ghost = true;
    const helper = w.createMobile({
      name: 'helper', body: 0x190, x: 0, y: 0, z: 0, map: 1,
    });
    helper.client = { send: () => {}, sendSystemMessage: () => {} };
    resurrectMobile(w, dead, helper);
    expect(helper.virtues?.compassion ?? 0).toBeGreaterThan(0);
  });

  it('self-resurrect grants no virtue', () => {
    const w = new World();
    const mob = w.createMobile({
      name: 'self', body: 0x192, x: 0, y: 0, z: 0, map: 1, hp: 0, hpMax: 50,
    });
    mob.ghost = true;
    mob.client = { send: () => {}, sendSystemMessage: () => {} };
    resurrectMobile(w, mob, mob);
    expect(mob.virtues?.compassion ?? 0).toBe(0);
  });
});
