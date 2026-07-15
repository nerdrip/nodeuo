import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { checkRecallCast, teleportToRune, travelAllowed } from '../../scripts/src/spells/rune-helpers.js';
import teleport from '../../scripts/src/spells/magery/circle3/teleport.js';

function apiWith(world, overrides = {}) {
  return {
    world,
    regions: {
      allowGate: () => true,
      at: () => [],
    },
    game: { movement: { findStandingZ: (_map, _x, _y, z) => z } },
    combat: { animate() {} },
    protocol: {
      EffectKind: { FromSource: 0 },
      huedEffect: () => new Uint8Array(),
      playSound: () => new Uint8Array(),
      mobileUpdate: () => new Uint8Array(),
      mobileMoving: () => new Uint8Array(),
      removeEntity: () => new Uint8Array(),
    },
    ...overrides,
  };
}

describe('spell travel safety', () => {
  it('rejects source and destination regions that forbid magical travel', () => {
    const blocked = apiWith(new World(), {
      regions: {
        allowGate: (_map, x) => x !== 110,
        at: (_map, x) => x === 100 ? [{ noRecall: true }] : [],
      },
    });
    const caster = { x: 100, y: 100, z: 0, map: 1, str: 100 };
    expect(checkRecallCast(blocked, caster, {})).toContain('prevents travel from');
    expect(travelAllowed(blocked, 1, 110, 100)).toBe(false);
  });

  it('recall refuses an impassable destination without moving the mobile', () => {
    const world = new World();
    const caster = world.createMobile({ name: 'Mage', x: 100, y: 100, z: 0, map: 1 });
    const api = apiWith(world, {
      game: { movement: { findStandingZ: () => null } },
    });
    expect(teleportToRune(api, caster, { x: 105, y: 105, z: 0, map: 1 })).toBe(false);
    expect(caster).toMatchObject({ x: 100, y: 100, z: 0, map: 1 });
  });

  it('Teleport rejects a protected destination before effects or movement', () => {
    const world = new World();
    const caster = world.createMobile({ name: 'Mage', x: 100, y: 100, z: 0, map: 1, str: 100 });
    const messages = [];
    let animated = false;
    const api = apiWith(world, {
      regions: { allowGate: (_map, x) => x !== 105, at: () => [] },
      combat: { animate: () => { animated = true; } },
    });
    teleport.cast(api, {
      sender: caster,
      state: { sendSystemMessage: (line) => messages.push(line) },
    }, { x: 105, y: 100, z: 0, map: 1 });
    expect(caster.x).toBe(100);
    expect(animated).toBe(false);
    expect(messages.at(-1)).toContain('prevents travel to');
  });
});
