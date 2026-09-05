import { describe, expect, it } from 'vitest';

import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import { createScriptGameApi } from '../src/script-game-api.js';
import { createWorldQueryApi } from '../src/world/query-api.js';
import { createWorldOpsApi } from '../src/world/ops-api.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';
import {
  bid, consign, forceSettle, lotById, reclaim,
} from '../src/systems/economy/auction-house.js';
import * as ultimaStore from '../src/systems/economy/ultima-store.js';
import * as veteranRewards from '../src/systems/rewards/veteran-rewards.js';

function playerWithPack(world, name, gold = 0) {
  const mob = world.createMobile({ name, body: 0x190, x: 10, y: 10, z: 0, map: 1, isPlayer: true });
  const pack = createItem(world, {
    itemId: 0x0E75, parent: mob.serial, layer: 21, name: `${name}'s backpack`,
    x: 0, y: 0, z: 0, map: 1,
  });
  if (gold > 0) createItem(world, {
    itemId: 0x0EED, parent: pack.serial, amount: gold, name: 'gold coins',
    x: 0, y: 0, z: 0, map: 1,
  });
  return { mob, pack };
}

function packContents(world, pack) {
  const serials = world._childrenByParent.get(pack.serial) ?? [];
  return Array.from(serials, (serial) => world.items.get(serial)).filter(Boolean);
}

function packGold(world, pack) {
  return packContents(world, pack)
    .filter((item) => [0x0EED, 0x0EEE, 0x0EEF].includes(item.itemId))
    .reduce((sum, item) => sum + (item.amount ?? 1), 0);
}

describe('economy lifecycle audit', () => {
  it('delivers every Ultima Store entry and debits only after delivery', () => {
    const world = new World();
    const { mob, pack } = playerWithPack(world, 'collector');
    const game = createScriptGameApi({
      world, query: createWorldQueryApi(world), ops: createWorldOpsApi(world),
    });
    const account = { _sovereigns: 10_000 };

    for (const entry of ultimaStore.catalogue()) {
      const before = account._sovereigns;
      const result = ultimaStore.buy(account, mob, entry.id, { world, game });
      expect(result.ok, entry.id).toBe(true);
      expect(result.spawned.parent, entry.id).toBe(pack.serial);
      expect(result.spawned.definitionId, entry.id).toBeTruthy();
      expect(account._sovereigns, entry.id).toBe(before - entry.cost);
    }

    const failedAccount = { _sovereigns: 100 };
    expect(ultimaStore.buy(failedAccount, mob, 'silver-cuff', { world: null }).ok).toBe(false);
    expect(failedAccount._sovereigns).toBe(100);
  });

  it('uses the durable account created timestamp and can roll back failed reward delivery', () => {
    const now = Date.UTC(2026, 8, 5);
    const account = { created: new Date(now - 13 * veteranRewards.VETERAN_CONST.MS_PER_MONTH).toISOString() };
    expect(veteranRewards.tierForAccount(account, now)).toBe(2);
    expect(veteranRewards.availableCredits(account, now)).toBe(2);
    const result = veteranRewards.redeem(account, 'ethereal-horse', now);
    expect(result.ok).toBe(true);
    expect(veteranRewards.availableCredits(account, now)).toBe(1);
    expect(veteranRewards.rollbackRedemption(account, result.reward)).toBe(true);
    expect(veteranRewards.availableCredits(account, now)).toBe(2);

    const rewards = [...new Set(Object.values(veteranRewards.VETERAN_CONST.REWARDS_BY_TIER).flat())];
    expect(rewards.every((reward) => veteranRewards.spawnConfig(reward))).toBe(true);
  });

  it('escrows real backpack gold, refunds outbids, and settles item plus payout atomically', () => {
    const world = new World();
    const seller = playerWithPack(world, 'seller', 10);
    const first = playerWithPack(world, 'first', 200);
    const winner = playerWithPack(world, 'winner', 300);
    const item = createItem(world, {
      itemId: 0x13B2, parent: seller.pack.serial, name: 'runic bow',
      x: 0, y: 0, z: 0, map: 1, slayer: 'dragon', attributes: { damageIncrease: 25 },
    });

    const listed = consign(world, seller.mob, item, { startingBid: 100, buyoutPrice: 150 });
    expect(listed.ok).toBe(true);
    expect(packGold(world, seller.pack)).toBe(8);
    expect(world.items.has(item.serial)).toBe(false);

    expect(bid(world, first.mob, listed.lotId, 100).ok).toBe(true);
    expect(packGold(world, first.pack)).toBe(100);
    expect(bid(world, winner.mob, listed.lotId, 200).ok).toBe(true);
    expect(packGold(world, first.pack)).toBe(200);
    expect(packGold(world, winner.pack)).toBe(150);

    const lot = lotById(world, listed.lotId);
    expect(lot.status).toBe('sold');
    expect(lot.currentBid).toBe(150);
    expect(lot.payoutDelivered).toBe(true);
    expect(lot.itemDelivered).toBe(true);
    expect(packGold(world, seller.pack)).toBe(158);
    expect(packContents(world, winner.pack).find((owned) => owned.name === 'runic bow')).toMatchObject({
      slayer: 'dragon', attributes: { damageIncrease: 25 },
    });
  });

  it('persists open lots and allows delayed reclaim without duplicating delivery', () => {
    const source = new World();
    const seller = source.createMobile({ name: 'seller', body: 0x190, gold: 10, isPlayer: true });
    const item = createItem(source, {
      itemId: 0x0F51, parent: seller.serial, name: 'auction dagger', x: 0, y: 0, z: 0, map: 1,
    });
    const listed = consign(source, seller, item, { startingBid: 100 });
    expect(listed.ok).toBe(true);

    const restored = new World();
    restoreWorld(restored, JSON.parse(JSON.stringify(snapshotWorld(source))));
    expect(lotById(restored, listed.lotId)).toMatchObject({ status: 'open', item: { name: 'auction dagger' } });

    expect(forceSettle(restored, listed.lotId)).toMatchObject({ ok: true, returnedToConsigner: false });
    const restoredSeller = restored.mobiles.get(seller.serial);
    const pack = createItem(restored, {
      itemId: 0x0E75, parent: restoredSeller.serial, layer: 21, name: 'backpack',
      x: 0, y: 0, z: 0, map: 1,
    });
    expect(reclaim(restored, restoredSeller, listed.lotId)).toEqual({ ok: true, items: 1, gold: 0 });
    expect(reclaim(restored, restoredSeller, listed.lotId)).toEqual({ ok: true, items: 0, gold: 0 });
    expect(packContents(restored, pack).filter((owned) => owned.name === 'auction dagger')).toHaveLength(1);
  });
});
