import { describe, expect, it } from 'vitest';
import { SectorIndex } from '../src/world/sectors.js';

describe('sector mobile query snapshots', () => {
  it('keeps sector order and refreshes membership after moves and removals', () => {
    const sectors = new SectorIndex();
    const first = { serial: 1, map: 1, x: 16, y: 16 };
    const second = { serial: 2, map: 1, x: 17, y: 16 };
    const third = { serial: 3, map: 1, x: 24, y: 16 };
    sectors.addMobile(first);
    sectors.addMobile(second);
    sectors.addMobile(third);
    const near = () => [...sectors.mobileSerialsNear(1, 17, 16, 8)];

    expect(near()).toEqual([1, 2, 3]);
    first.x = 18;
    sectors.moveMobile(first); // Same sector: cached membership remains valid.
    expect(near()).toEqual([1, 2, 3]);
    first.x = 32;
    sectors.moveMobile(first);
    expect(near()).toEqual([2, 3]);
    sectors.removeMobile(second.serial);
    expect(near()).toEqual([3]);
    sectors.addMobile({ serial: 4, map: 1, x: 18, y: 16 });
    expect(near()).toEqual([4, 3]);
    expect([...sectors.mobileSerialsNear(0, 17, 16, 8)]).toEqual([]);
  });

  it('counts only consumed candidates when a query is stopped early', () => {
    const sectors = new SectorIndex();
    sectors.addMobile({ serial: 1, map: 0, x: 16, y: 16 });
    sectors.addMobile({ serial: 2, map: 0, x: 17, y: 16 });
    const before = sectors.stats().queries;
    const iterator = sectors.mobileSerialsNear(0, 16, 16, 0);
    expect(iterator.next().value).toBe(1);
    iterator.return();
    const after = sectors.stats().queries;
    expect(after.calls - before.calls).toBe(1);
    expect(after.candidates - before.candidates).toBe(1);
    expect([...sectors.mobileSerialsNear(0, 16, 16, 0)]).toEqual([1, 2]);
  });

  it('matches live Set iteration when mobiles change between yields', () => {
    const sectors = new SectorIndex();
    for (const serial of [1, 2, 3]) {
      sectors.addMobile({ serial, map: 0, x: 16, y: 16 });
    }
    const iterator = sectors.mobileSerialsNear(0, 16, 16, 0);
    expect(iterator.next().value).toBe(1);
    sectors.removeMobile(2);
    sectors.addMobile({ serial: 4, map: 0, x: 16, y: 16 });
    expect([...iterator]).toEqual([3, 4]);

    const second = sectors.mobileSerialsNear(0, 16, 16, 0);
    expect(second.next().value).toBe(1);
    sectors.removeMobile(1);
    sectors.addMobile({ serial: 1, map: 0, x: 16, y: 16 });
    expect([...second]).toEqual([3, 4, 1]);
    expect([...sectors.mobileSerialsNear(0, 16, 16, 0)]).toEqual([3, 4, 1]);
  });
});
