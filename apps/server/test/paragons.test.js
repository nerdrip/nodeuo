// PHASE CY — paragon mob templates. ServUO ML elite-creature flag with
// ×4 HP, ×2 str, orange hue, "a paragon …" name prefix.

import { describe, it, expect } from 'vitest';
import {
  paragonize, unparagonize, maybeParagon, paragonLootMultiplier,
  broadcastParagonChange, _PARAGON_CONST,
} from '../src/systems/paragons.js';
import { World } from '../src/world/world.js';

describe('paragons (PHASE CY)', () => {
  it('paragonize sets the orange hue + name prefix + stat multipliers', () => {
    // Audit #43 P2-2 — paragons now use ServUO canon scalars
    // (HP×5, Str×1.05, Dex×1.20, Int×1.20, ...). Was HP×4/Str×2.
    const mob = { name: 'a wolf', hue: 0, hp: 60, hpMax: 60, str: 30 };
    paragonize(mob);
    expect(mob.paragon).toBe(true);
    expect(mob.hue).toBe(_PARAGON_CONST.PARAGON_HUE);
    expect(mob.name).toBe('a paragon a wolf');
    expect(mob.hpMax).toBe(60 * 5);
    expect(mob.hp).toBe(mob.hpMax);
    expect(mob.str).toBe(Math.floor(30 * 1.05));
  });

  it('paragonize is idempotent — second call doesn\'t double-buff', () => {
    const mob = { name: 'a wolf', hue: 0, hp: 60, hpMax: 60, str: 30 };
    paragonize(mob);
    const hpAfterFirst = mob.hpMax;
    paragonize(mob);
    expect(mob.hpMax).toBe(hpAfterFirst);  // no double application
  });

  it('unparagonize restores the originals', () => {
    const mob = { name: 'a wolf', hue: 0x1A, hp: 60, hpMax: 60, str: 30 };
    paragonize(mob);
    unparagonize(mob);
    expect(mob.paragon).toBe(false);
    expect(mob.hue).toBe(0x1A);
    expect(mob.name).toBe('a wolf');
    expect(mob.hpMax).toBe(60);
    expect(mob.str).toBe(30);
  });

  it('maybeParagon respects tameable / boss / controlMaster filters', () => {
    const tame = { name: 'wolf', hp: 100, hpMax: 100, str: 30 };
    expect(maybeParagon(tame, { tameable: true }, { force: true })).toBe(false);
    expect(tame.paragon).toBeFalsy();

    const boss = { name: 'lich lord', hp: 800, hpMax: 800, str: 90 };
    expect(maybeParagon(boss, { boss: true }, { force: true })).toBe(false);

    const pet = { name: 'rex', hp: 100, hpMax: 100, str: 30, controlMaster: 0x1234 };
    expect(maybeParagon(pet, {}, { force: true })).toBe(false);
  });

  it('maybeParagon force=true bypasses random roll', () => {
    const mob = { name: 'orc', hp: 120, hpMax: 120, str: 40 };
    expect(maybeParagon(mob, { tameable: false }, { force: true })).toBe(true);
    expect(mob.paragon).toBe(true);
  });

  it('paragonLootMultiplier returns 1.5 for paragon, 1.0 for normal', () => {
    expect(paragonLootMultiplier({ paragon: true })).toBe(1.5);
    expect(paragonLootMultiplier({})).toBe(1.0);
    expect(paragonLootMultiplier(null)).toBe(1.0);
  });

  // PHASE DB / bugfix #70: retroactive paragonize must re-broadcast
  // mobileIncoming so observer clients see the new orange hue + name
  // immediately. Without this the change only became visible after the
  // mob's next movement packet.
  it('broadcastParagonChange ships 0x78 to nearby observers (#70)', () => {
    const w = new World();
    const target = w.createMobile({
      name: 'a wolf', body: 0xE1, x: 100, y: 100, z: 0, map: 1,
      hp: 60, hpMax: 60, str: 30,
    });
    paragonize(target);
    const observerSent = [];
    const observer = w.createMobile({
      name: 'witness', body: 0x190, x: 102, y: 100, z: 0, map: 1,
    });
    observer.client = { send: (b) => observerSent.push(b) };
    const farSent = [];
    const far = w.createMobile({
      name: 'far', body: 0x190, x: 5000, y: 5000, z: 0, map: 1,
    });
    far.client = { send: (b) => farSent.push(b) };
    const fakeApi = {
      protocol: {
        mobileIncoming: (e) => new Uint8Array([0x78, (e.serial >> 24) & 0xFF, e.hue & 0xFF]),
      },
    };
    broadcastParagonChange(fakeApi, w, target);
    expect(observerSent.length).toBe(1);
    expect(observerSent[0][0]).toBe(0x78);
    expect(farSent.length).toBe(0);
  });

  it('broadcastParagonChange is a no-op without protocol.mobileIncoming', () => {
    const w = new World();
    const target = w.createMobile({
      name: 'orc', body: 0xB1, x: 0, y: 0, z: 0, map: 1, hp: 50, hpMax: 50,
    });
    expect(() => broadcastParagonChange({ protocol: {} }, w, target)).not.toThrow();
  });
});
