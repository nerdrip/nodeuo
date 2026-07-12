// FAZA DH/DI — virtue invocation hooks (Honor damage + Sacrifice push).

import { describe, it, expect } from 'vitest';
import { honorDamageMultiplier, honorOnKill, _HONOR_CONST } from '../../scripts/src/commands/combat/honor.js';
import { spendVirtue, awardVirtue } from '../src/systems/rewards/virtues.js';

describe('honor invocation hooks (FAZA DH)', () => {
  it('honorDamageMultiplier returns 1.20 for the honoured target only', () => {
    const attacker = { _honoredTargetSerial: 0x1234 };
    const honoured = { serial: 0x1234 };
    const other    = { serial: 0x5678 };
    expect(honorDamageMultiplier(attacker, honoured)).toBeCloseTo(1.20);
    expect(honorDamageMultiplier(attacker, other)).toBe(1.0);
    expect(honorDamageMultiplier({}, honoured)).toBe(1.0);
  });

  it('honorOnKill refunds 2× spent honor + clears the bond', () => {
    const killer = {
      _honoredTargetSerial: 0xABCD,
      _honoredCost: _HONOR_CONST.HONOR_COST,
    };
    const victim = { serial: 0xABCD };
    const api = {
      systems: { virtues: { awardVirtue } },
    };
    honorOnKill(api, killer, victim);
    expect(killer.virtues.honor).toBe(_HONOR_CONST.HONOR_COST * _HONOR_CONST.HONOR_REWARD_MULT);
    expect(killer._honoredTargetSerial).toBeUndefined();
  });

  it('spendVirtue auto-pushes new state to client (#76)', () => {
    const sent = [];
    const mob = {
      virtues: { honor: 5000 },
      client: { send: (b) => sent.push(b), supportsNodeUO: () => true },
    };
    spendVirtue(mob, 'honor', 100);
    expect(mob.virtues.honor).toBe(4900);
    expect(sent.length).toBe(1);
    expect(sent[0][0]).toBe(0xBF);
  });
});
