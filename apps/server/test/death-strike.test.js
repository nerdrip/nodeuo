import { afterEach, describe, expect, it, vi } from 'vitest';

import deathStrike from '../../scripts/src/spells/ninjitsu/death-strike.js';
import * as statusEffects from '../src/status-effects.js';
import { World } from '../src/world/world.js';

afterEach(() => vi.useRealTimers());

describe('Ninjitsu Death Strike', () => {
  it('uses the status scheduler and doubles delayed damage after movement', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const world = new World();
    const caster = world.createMobile({ name: 'Ninja', skills: { 54: 100 } });
    const target = world.createMobile({ name: 'Target', hp: 100, hpMax: 100 });
    const damage = vi.fn((_world, mob, amount) => { mob.hp -= amount; });
    const api = {
      world, statusEffects,
      combat: { damage, animate: vi.fn() },
      protocol: {
        huedEffect: () => new Uint8Array(),
        playSound: () => new Uint8Array(),
        EffectKind: { FromSource: 2 },
      },
    };
    deathStrike.cast(api, { sender: caster, state: { sendSystemMessage: vi.fn() } }, target);
    expect(statusEffects.has(target, 'death-strike')).toBe(true);

    statusEffects.tickAll(world, 104_999);
    expect(damage).not.toHaveBeenCalled();
    target._lastMoveAt = 100_001;
    statusEffects.tickAll(world, 105_000);

    expect(damage).toHaveBeenCalledWith(world, target, 48, caster);
    expect(statusEffects.has(target, 'death-strike')).toBe(false);
  });
});
