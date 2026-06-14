import { describe, it, expect } from 'vitest';
import { checkAndGrantDailyReward, DAILY_GIFTS } from '../src/systems/rewards/daily-login.js';
import { World } from '../src/world/world.js';

function mkWorld() {
  const items = new Map();
  let nextSerial = 1000;
  const _childrenByParent = new Map();
  const world = {
    items,
    _childrenByParent,
    createItem(spec) {
      const it = { serial: nextSerial++, ...spec };
      items.set(it.serial, it);
      if (it.parent != null) {
        const set = _childrenByParent.get(it.parent) ?? new Set();
        set.add(it.serial);
        _childrenByParent.set(it.parent, set);
      }
      return it;
    },
  };
  return world;
}
function mkMob() {
  const mob = { serial: 1, name: 'tester', sentMsgs: [] };
  mob.client = { sendSystemMessage(s) { mob.sentMsgs.push(s); } };
  return mob;
}
function mkAccount() {
  return { username: 'tester', lastDailyAt: 0, dailyStreak: 0 };
}

describe('daily-login', () => {
  it('grants reward + bumps streak on first eligible login', () => {
    const world = mkWorld();
    const mob = mkMob();
    const pack = world.createItem({ itemId: 0x0E76, parent: mob.serial, layer: 21 });
    const acc = mkAccount();
    const res = checkAndGrantDailyReward(world, mob, acc);
    expect(res?.granted).toBe(true);
    expect(res?.streak).toBe(1);
    expect(acc.lastDailyAt).toBeGreaterThan(0);
    expect(acc.dailyStreak).toBe(1);
    // Some item exists inside the pack.
    let hasChild = false;
    for (const it of world.items.values()) {
      if (it.parent === pack.serial) { hasChild = true; break; }
    }
    expect(hasChild).toBe(true);
    expect(mob.sentMsgs.some(m => m.startsWith('Daily login reward'))).toBe(true);
  });

  it('grants through real World.createItem without losing method binding', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'tester', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    mob.sentMsgs = [];
    mob.client = { sendSystemMessage(s) { mob.sentMsgs.push(s); } };
    const pack = world.createItem({
      itemId: 0x0E75,
      parent: mob.serial,
      layer: 21,
      container: true,
      name: 'Backpack',
    });
    const acc = mkAccount();
    const res = checkAndGrantDailyReward(world, mob, acc);
    expect(res?.granted).toBe(true);
    expect([...world.items.values()].some((it) => it.parent === pack.serial)).toBe(true);
  });

  it('is idempotent on same-day relog', () => {
    const world = mkWorld();
    const mob = mkMob();
    world.createItem({ itemId: 0x0E76, parent: mob.serial, layer: 21 });
    const acc = mkAccount();
    expect(checkAndGrantDailyReward(world, mob, acc)?.granted).toBe(true);
    expect(checkAndGrantDailyReward(world, mob, acc)).toBeNull();
  });

  it('resets streak when gap > 36h', () => {
    const world = mkWorld();
    const mob = mkMob();
    world.createItem({ itemId: 0x0E76, parent: mob.serial, layer: 21 });
    const acc = mkAccount();
    acc.lastDailyAt = Date.now() - (3 * 24 * 60 * 60 * 1000); // 3 days ago
    acc.dailyStreak = 9;
    const res = checkAndGrantDailyReward(world, mob, acc);
    expect(res?.granted).toBe(true);
    expect(res?.streak).toBe(1); // reset
  });

  it('no pack → no grant', () => {
    const world = mkWorld();
    const mob = mkMob();
    const acc = mkAccount();
    expect(checkAndGrantDailyReward(world, mob, acc)).toBeNull();
  });

  it('gift table covers 7 days', () => {
    expect(DAILY_GIFTS.length).toBe(7);
  });
});
