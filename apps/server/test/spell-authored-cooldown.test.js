import { afterEach, describe, expect, it } from 'vitest';
import { dispatchCastFromMacro } from '../src/net/handlers.js';
import { registerSpell, unregisterSpell } from '../src/systems/spells/registry.js';

const SPELL_ID = 9988;
afterEach(() => unregisterSpell(SPELL_ID));

describe('server-authored spell cooldown', () => {
  it('cannot be shortened below the spell definition by Faster Cast Recovery', () => {
    registerSpell({
      id: SPELL_ID, name: 'Cooldown Audit', school: 'custom', skillId: 26,
      minSkill: 0, mana: 0, delayMs: 0, cooldownMs: 5000,
      requiresTarget: false, effect() {},
    });
    const mobile = {
      serial: 1, hp: 100, hpMax: 100, mana: 100, manaMax: 100,
      x: 10, y: 10, z: 0, map: 1, skills: { 26: 120 },
      client: { send() {}, sendSystemMessage() {} },
    };
    const world = { mobiles: new Map([[1, mobile]]), items: new Map() };
    const before = Date.now();
    dispatchCastFromMacro({
      mobile,
      account: { accessLevel: 'Player' },
      ctx: {
        world,
        handlers: {},
        attributes: { effective: () => ({ fasterCastRecovery: 6 }) },
      },
      supportsNodeUO: () => false,
      send() {},
      sendSystemMessage() {},
    }, SPELL_ID);
    expect(mobile._castReadyAt).toBeGreaterThanOrEqual(before + 5000);
  });
});
