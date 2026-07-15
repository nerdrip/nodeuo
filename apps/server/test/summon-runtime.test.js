import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { summonOne } from '../../scripts/src/spells/_summon-helpers.js';
import { desiredAiForMob } from '../../scripts/src/npcs/ai/aggressive.js';

describe('runtime summon pipeline', () => {
  it('keeps owned summons on pet AI during deferred monster reconciliation', () => {
    expect(desiredAiForMob({
      controlled: true,
      controlMaster: 0x1001,
      aiBehavior: 'mage',
    }, { ai: 'mage' })).toBe('pet');
  });

  it('creates a controlled daemon, attaches pet AI and accounts follower slots', () => {
    vi.useFakeTimers();
    try {
      const world = new World();
      const packets = [];
      const messages = [];
      const caster = world.createMobile({
        name: 'Mage', body: 0x0190, x: 100, y: 100, z: 0, map: 1,
        followers: 0, followersMax: 5, skills: { 26: 100 },
      });
      caster.client = { send: (pkt) => packets.push(pkt), sendSystemMessage: (m) => messages.push(m) };
      const attached = [];
      const daemonTemplate = { kind: 'daemon', name: 'a daemon', body: 9, hp: 320, str: 130, notoriety: 6 };
      const api = {
        world,
        monsters: { get: (kind) => kind === 'daemon' ? daemonTemplate : null },
        ctx: {
          spawnFactory: (w, kind, spot) => {
            const mob = w.createMobile({ ...daemonTemplate, ...spot });
            mob.kind = kind;
            return mob;
          },
        },
        ai: { attach: (mob, behavior, state) => attached.push({ mob, behavior, state }) },
        protocol: {
          playSound: () => new Uint8Array([0x54]),
          mobileMoving: () => new Uint8Array([0x77]),
          removeEntity: () => new Uint8Array([0x1D]),
        },
      };
      const mob = summonOne(api, {
        sender: caster,
        state: { sendSystemMessage: (m) => messages.push(m) },
      }, { kind: 'daemon', soundId: 0x216 });

      expect(mob).toBeTruthy();
      expect(mob).toMatchObject({
        kind: 'daemon', summoned: true, controlled: true,
        controlMaster: caster.serial, controlOrder: 'follow', notoriety: 1,
        aiBehavior: 'pet', petCommand: 'follow',
      });
      expect(mob.summonedUntil).toBe(Date.now() + 400_000);
      expect(caster.followers).toBe(1);
      expect(attached).toHaveLength(1);
      expect(attached[0]).toMatchObject({ behavior: 'pet' });
      expect(messages).toContain('You summon a daemon.');
      expect(packets.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('places the summon on the selected legal tile and refuses an occupied tile', () => {
    vi.useFakeTimers();
    try {
      const world = new World();
      const messages = [];
      const caster = world.createMobile({
        name: 'Mage', body: 0x0190, x: 100, y: 100, z: 0, map: 1,
        followers: 0, followersMax: 5, skills: { 26: 100 },
      });
      caster.client = { send() {}, sendSystemMessage: (m) => messages.push(m) };
      const daemonTemplate = { kind: 'daemon', name: 'a daemon', body: 9, hp: 320 };
      const api = {
        world,
        monsters: { get: () => daemonTemplate },
        game: { movement: { findStandingZ: (_map, _x, _y, z) => z } },
        ctx: {
          spawnFactory: (w, kind, spot) => {
            const mob = w.createMobile({ ...daemonTemplate, ...spot });
            mob.kind = kind;
            return mob;
          },
        },
        ai: { attach() {} },
        protocol: { mobileMoving: () => new Uint8Array([0x77]), removeEntity: () => new Uint8Array([0x1D]) },
      };
      const selected = { x: 104, y: 103, z: 7, map: 1 };
      const summoned = summonOne(api, {
        sender: caster, target: selected,
        state: { sendSystemMessage: (m) => messages.push(m) },
      }, { kind: 'daemon' });
      expect(summoned).toMatchObject(selected);

      const blocked = summonOne(api, {
        sender: caster, target: selected,
        state: { sendSystemMessage: (m) => messages.push(m) },
      }, { kind: 'daemon' });
      expect(blocked).toBeNull();
      expect(messages).toContain('There is no room for the summoned creature.');
    } finally {
      vi.useRealTimers();
    }
  });
});
