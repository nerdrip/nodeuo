import { describe, it, expect, vi } from 'vitest';
import { start, tick, stop, isFollowing } from '../src/world/path-follower.js';

vi.mock('../src/world/pathfind.js', () => ({
  findPath: ({ sx, sy, gx, gy }) => {
    // Trivial mock — straight-line tiles between start and goal.
    const out = [];
    let x = sx, y = sy;
    while (x !== gx || y !== gy) {
      if (x < gx) x++; else if (x > gx) x--;
      if (y < gy) y++; else if (y > gy) y--;
      out.push({ x, y, z: 0 });
      if (out.length > 50) break;
    }
    return out;
  },
}));

const fakeWorld = { facets: { 1: { tiles: [] } } };

describe('PathFollower', () => {
  it('start binds a path to the mob', () => {
    const mob = { serial: 1, x: 0, y: 0, z: 0, map: 1 };
    const target = { serial: 2, x: 3, y: 3 };
    expect(start(fakeWorld, mob, target)).toBe(true);
    expect(isFollowing(mob)).toBe(true);
    expect(mob._pathFollower.path.length).toBeGreaterThan(0);
  });

  it('tick consumes one tile per stepDelayMs', () => {
    const mob = { serial: 1, x: 0, y: 0, z: 0, map: 1 };
    const target = { serial: 2, x: 2, y: 0 };
    start(fakeWorld, mob, target, { stepDelayMs: 100 });
    expect(mob.x).toBe(0);
    tick(fakeWorld, mob, target, 200);
    expect(mob.x).toBe(1);
    // Second tick at same time — too soon for next step.
    tick(fakeWorld, mob, target, 200);
    expect(mob.x).toBe(1);
    // After stepDelayMs more.
    tick(fakeWorld, mob, target, 350);
    expect(mob.x).toBe(2);
  });

  it('stop clears the follower state', () => {
    const mob = { serial: 1, x: 0, y: 0, z: 0, map: 1 };
    start(fakeWorld, mob, { serial: 2, x: 1, y: 0 });
    stop(mob);
    expect(isFollowing(mob)).toBe(false);
  });

  it('re-plans when target drifts > threshold', () => {
    const mob = { serial: 1, x: 0, y: 0, z: 0, map: 1 };
    const target = { serial: 2, x: 3, y: 0 };
    start(fakeWorld, mob, target, { stepDelayMs: 100 });
    expect(mob._pathFollower.lastGoalX).toBe(3);
    // Move the target far away — next tick should re-plan.
    target.x = 10;
    target.y = 8;
    tick(fakeWorld, mob, target, 200);
    expect(mob._pathFollower.lastGoalX).toBe(10);
  });
});
