import { describe, it, expect, beforeEach } from 'vitest';
import { worldBosses } from '../src/systems/bosses/world-boss.js';

const mkWorld = () => ({ mobiles: new Map() });

describe('world-boss', () => {
  beforeEach(() => {
    // Drop test bosses between cases (no public 'clear' — re-register
    // overwrites in place).
    worldBosses.unregister('test-boss');
  });

  it('spawns a registered boss when due', () => {
    const world = mkWorld();
    let calls = 0;
    worldBosses.register({
      id: 'test-boss',
      respawnMs: 1000,
      spawn(w) {
        calls++;
        const inst = { serial: 100 };
        w.mobiles.set(100, inst);
        return inst;
      },
    });
    worldBosses.tick(world);  // due immediately (nextRespawnAt = now)
    expect(calls).toBe(1);
    expect(world.mobiles.has(100)).toBe(true);
    // Idempotent: still alive → no extra spawn.
    worldBosses.tick(world);
    expect(calls).toBe(1);
  });

  it('respects cooldown after recordKill', () => {
    const world = mkWorld();
    let calls = 0;
    worldBosses.register({
      id: 'test-boss', respawnMs: 60_000,
      spawn(w) {
        calls++;
        const inst = { serial: 200 };
        w.mobiles.set(200, inst);
        return inst;
      },
    });
    worldBosses.tick(world);
    expect(calls).toBe(1);
    // Boss dies.
    world.mobiles.delete(200);
    worldBosses.recordKill('test-boss');
    // Tick immediately — should NOT respawn (cooldown).
    worldBosses.tick(world);
    expect(calls).toBe(1);
  });

  it('serialize / loadSnapshot round-trip', () => {
    worldBosses.register({ id: 'test-boss', respawnMs: 1000, spawn: () => null });
    worldBosses.recordKill('test-boss');
    const snap = worldBosses.serialize();
    expect(snap['test-boss']?.nextRespawnAt).toBeGreaterThan(Date.now());
    const t = snap['test-boss'].nextRespawnAt;
    worldBosses.loadSnapshot({ 'test-boss': { nextRespawnAt: t + 9999 } });
    const snap2 = worldBosses.serialize();
    expect(snap2['test-boss'].nextRespawnAt).toBe(t + 9999);
  });
});
