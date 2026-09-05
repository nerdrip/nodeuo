import { describe, expect, it, vi } from 'vitest';

import registerGuard from '../../scripts/src/npcs/ai/guard-ai.js';

describe('town guard AI', () => {
  it('executes nearby criminals and ignores innocent players', () => {
    const guard = { serial: 1, x: 100, y: 100, map: 1, hp: 200 };
    const criminal = {
      serial: 2, x: 101, y: 100, map: 1, hp: 75,
      client: {}, criminalUntil: 10_000,
    };
    const innocent = { serial: 3, x: 100, y: 101, map: 1, hp: 75, client: {} };
    const world = { mobiles: new Map([[1, guard], [2, criminal], [3, innocent]]) };
    let behavior;
    const damage = vi.fn();
    const api = {
      world,
      combat: { damage, animate: vi.fn() },
      ai: {
        registerBehavior(value) { behavior = value; },
        unregisterBehavior() {},
        attach() {},
        stepMobile() { return true; },
      },
    };

    registerGuard(api);
    const state = behavior.initState();
    behavior.tick({
      world, now: 1_000,
      broadcastMove: vi.fn(), broadcastSpeech: vi.fn(),
    }, guard, state);

    expect(state.targetSerial).toBe(criminal.serial);
    expect(damage).toHaveBeenCalledWith(world, criminal, 75, expect.objectContaining({ attacker: guard }));
    expect(guard).toMatchObject({ invulnerable: true, isGuard: true });
  });

  it('reattaches a persisted guard once the behavior module loads', () => {
    const guard = { serial: 4, aiBehavior: 'guard', x: 0, y: 0, map: 1 };
    const attach = vi.fn();
    registerGuard({
      world: { mobiles: new Map([[guard.serial, guard]]) },
      combat: {},
      ai: { registerBehavior() {}, unregisterBehavior() {}, attach },
    });
    expect(attach).toHaveBeenCalledWith(guard, 'guard');
  });
});
