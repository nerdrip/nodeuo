// FAZY EF-FH compact test sweep — covers new systems shipped this
// session (insurance, slayers, sigils, world-bosses).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  insureItem, collectInsuredItems, chargeInsurance,
  _INSURANCE_CONST,
} from '../src/systems/economy/insurance.js';
import { slayerMultiplier, listSlayerKinds } from '../src/systems/slayers.js';
import {
  registerArena, getArena, _resetArenasForTest,
} from '../src/systems/bosses/peerless.js';
import {
  registerBoss, recordBossKill, canSpawnBoss, timeUntilBoss,
  _resetBossesForTest,
} from '../src/systems/bosses/world-bosses.js';
import {
  registerSigil, pickup, drop, tickCorruption,
  _resetForTest as _resetSigilsForTest,
} from '../src/systems/pvp/sigils.js';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';

describe('insurance system (PHASE EJ/EU)', () => {
  it('insureItem flags a worn item', () => {
    const mob = { serial: 0x1234 };
    const item = { layer: 5 };
    insureItem(mob, item);
    expect(item.insured).toBe(true);
    expect(item.insuredBy).toBe(0x1234);
  });

  it('insureItem rejects items not on a layer', () => {
    expect(insureItem({ serial: 1 }, { layer: 0 })).toBe(null);
  });

  it('chargeInsurance debits gold + defaults underfunded items', () => {
    const mob = { gold: 1500 };
    const items = [{ layer: 5 }, { layer: 6 }, { layer: 7 }];
    items.forEach((it) => insureItem(mob, it));
    const r = chargeInsurance(mob, items);
    // 600 × 3 = 1800. Have 1500 → 2 charged (1200), 1 defaulted.
    expect(r.charged).toBe(_INSURANCE_CONST.INSURE_COST * 2);
    expect(r.defaulted).toBe(1);
    expect(mob.gold).toBe(300);
    // Defaulted item lost its insurance.
    expect(items.filter((i) => !i.insured).length).toBe(1);
  });

  it('collectInsuredItems pulls only worn-and-insured items', () => {
    const w = new World();
    const player = w.createMobile({ name: 'p', body: 0x190, x: 0, y: 0, z: 0, map: 1 });
    const worn = createItem(w, { itemId: 0x1517, parent: player.serial, layer: 5, x: 0, y: 0, z: 0, map: 1 });
    insureItem(player, worn);
    const packed = createItem(w, { itemId: 0x1517, parent: player.serial, layer: 0, x: 0, y: 0, z: 0, map: 1 });
    insureItem(player, packed);  // ignored — layer 0
    const collected = collectInsuredItems(w, player);
    expect(collected.length).toBe(1);
    expect(collected[0].serial).toBe(worn.serial);
  });
});

describe('slayer matrix (PHASE EW)', () => {
  it('triples damage on matching slayer/kind', () => {
    expect(slayerMultiplier({ slayer: 'silver' }, { kind: 'lich' })).toBe(3);
    expect(slayerMultiplier({ slayer: 'dragon' }, { kind: 'dragon' })).toBe(3);
  });

  it('returns 1.0 for unmatched slayer', () => {
    expect(slayerMultiplier({ slayer: 'silver' }, { kind: 'dragon' })).toBe(1);
    expect(slayerMultiplier({}, { kind: 'lich' })).toBe(1);
  });

  it('lists 7 canonical slayer kinds', () => {
    expect(listSlayerKinds().length).toBe(7);
  });
});

describe('peerless arenas (PHASE DD)', () => {
  beforeEach(() => _resetArenasForTest());

  it('registerArena binds + getArena returns the def', () => {
    registerArena({ name: 't', requiredKeys: ['k1'], bossKind: 'boss',
      spawnAt: { x: 0, y: 0, z: 0, map: 1 }, teleportTo: { x: 0, y: 0, z: 0, map: 1 } });
    expect(getArena('t')?.bossKind).toBe('boss');
  });
});

describe('world-bosses respawn timer (PHASE EY)', () => {
  beforeEach(() => _resetBossesForTest());

  it('canSpawnBoss is true initially, false after kill, true after cooldown', () => {
    registerBoss('harrower', { cooldownMs: 1000 });
    expect(canSpawnBoss('harrower', 0)).toBe(true);
    recordBossKill('harrower', 5_000);
    expect(canSpawnBoss('harrower', 5_500)).toBe(false);
    expect(canSpawnBoss('harrower', 6_000)).toBe(true);
  });

  it('timeUntilBoss reports seconds until ready', () => {
    registerBoss('doppel', { cooldownMs: 10_000 });
    recordBossKill('doppel', 100_000);
    expect(timeUntilBoss('doppel', 105_000)).toBe(5_000);
    expect(timeUntilBoss('doppel', 200_000)).toBe(0);
  });
});

describe('faction sigils (PHASE EI)', () => {
  beforeEach(() => _resetSigilsForTest());

  it('pickup blocks if already held by another mob', () => {
    registerSigil('britain', 100, 100, 1);
    const r1 = pickup('britain', 0xAAAA, 1000);
    expect(r1.ok).toBe(true);
    const r2 = pickup('britain', 0xBBBB, 2000);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('already-held');
  });

  it('drop releases the carrier', () => {
    registerSigil('minoc', 200, 200, 1);
    pickup('minoc', 0xAAAA, 1000);
    expect(drop('minoc', 0xBBBB).ok).toBe(false); // wrong carrier
    expect(drop('minoc', 0xAAAA).ok).toBe(true);
  });

  it('tickCorruption marks owner after the cooldown holds', () => {
    // Audit #43 P1-5 — corruption period is 10 hours per ServUO
    // `Sigil.cs:17`. Was 10 min.
    registerSigil('trinsic', 0, 0, 1);
    pickup('trinsic', 0xAAAA, 0);
    const corrupted = tickCorruption(11 * 60 * 60_000, () => 'true-britannian');
    expect(corrupted.length).toBe(1);
    expect(corrupted[0].owner).toBe('true-britannian');
  });
});
