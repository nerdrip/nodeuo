import { afterEach, describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { rollDamage } from '../src/combat-formulas.js';
import { regenTick, setFormulas } from '../src/regen.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';
import { invokeVirtue } from '../src/systems/rewards/virtues.js';
import * as mlq from '../src/systems/quests/mlquests.js';
import registerRegen from '../../scripts/src/systems/regen.js';
import horrificBeast from '../../scripts/src/spells/necro/horrific-beast.js';
import telekinesis from '../../scripts/src/spells/magery/circle3/telekinesis.js';
import { applySpellDamage } from '../../scripts/src/spells/_helpers.js';

afterEach(() => {
  setFormulas({ hpPerSecond: null, manaPerSecond: null, stamPerSecond: null });
  mlq.clearAll();
});

function protocolStub() {
  const packet = () => new Uint8Array([1]);
  return {
    EffectKind: { FromSource: 0 }, huedEffect: packet, playSound: packet,
    mobileUpdate: packet, mobileMoving: packet,
  };
}

describe('spell effects and regeneration audit', () => {
  it('Horrific Beast has its canonical body, combat/regen bonuses and cleanup', () => {
    const world = new World();
    const sent = [];
    const caster = world.createMobile({ body: 0x190, str: 0, x: 1, y: 1, z: 0, map: 1 });
    caster.client = { send: (packet) => sent.push(packet) };
    let effect;
    horrificBeast.cast({
      world, protocol: protocolStub(),
      statusEffects: { apply: (_mob, value) => { effect = value; } },
    }, { sender: caster, state: { sendSystemMessage: vi.fn() } });

    expect(caster.body).toBe(0x2EA);
    expect(caster._horrificDamageBonus).toBe(25);
    expect(caster._horrificHpRegen).toBe(20);
    expect(caster.horrificBeastUntil).toBeGreaterThan(Date.now());
    expect(rollDamage(caster, { armor: 0 }, () => 0)).toBeGreaterThan(1);

    effect.onRemove(caster);
    expect(caster.body).toBe(0x190);
    expect(caster.horrificBeastUntil).toBe(0);
    expect(caster._horrificDamageBonus).toBe(0);
    expect(caster._horrificHpRegen).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('consumes equipment and timed regen fields and restores defaults on unload', async () => {
    const cleanup = await registerRegen({
      regen: { setFormulas },
      attributes: { effectiveAttributes: () => ({ regenHits: 2, regenMana: 2, regenStam: 2 }) },
      log: vi.fn(),
    });
    const now = Date.now();
    const mob = {
      serial: 1, hp: 1, hpMax: 100, mana: 1, manaMax: 100, stam: 1, stamMax: 100,
      str: 50, dex: 50, int: 50, skills: {},
      _restedUntil: now + 10_000, _restedRegen: 2,
      hpRegenBonusUntil: now + 10_000, hpRegenBonus: 4,
      horrificBeastUntil: now + 10_000, _horrificHpRegen: 20,
      _mysticTransformUntil: now + 10_000, _mysticTransformManaRegen: 3,
      _spiritualityUntil: now + 10_000,
    };
    regenTick({ mobiles: new Map([[1, mob]]) }, 1_000);
    expect(mob.hp).toBeGreaterThanOrEqual(30);
    expect(mob.mana).toBeGreaterThanOrEqual(12);
    expect(mob.stam).toBeGreaterThanOrEqual(4);

    cleanup();
    const plain = { ...mob, serial: 2, hp: 1, mana: 1, stam: 1,
      _restedUntil: 0, hpRegenBonusUntil: 0, horrificBeastUntil: 0,
      _mysticTransformUntil: 0, _spiritualityUntil: 0, _regenAcc: null };
    regenTick({ mobiles: new Map([[2, plain]]) }, 1_000);
    expect(plain.hp).toBe(2);
  });

  it('Telekinesis dispatches item use and refuses locked/trapped bypasses', () => {
    const world = new World();
    const caster = world.createMobile({ x: 1, y: 1, z: 0, map: 1 });
    const item = world.createItem({ itemId: 1, x: 3, y: 1, z: 0, map: 1 });
    const messages = [];
    const useItem = vi.fn(() => true);
    const api = {
      world, protocol: protocolStub(), combat: { animate: vi.fn() },
      templates: { useItem },
    };
    const ctx = { sender: caster, state: { sendSystemMessage: (text) => messages.push(text) } };
    telekinesis.cast(api, ctx, item);
    expect(useItem).toHaveBeenCalledWith(world, item, caster);
    expect(messages.at(-1)).toMatch(/manipulate/i);

    item.locked = true;
    telekinesis.cast(api, ctx, item);
    expect(useItem).toHaveBeenCalledTimes(1);
    expect(messages.at(-1)).toMatch(/locked/i);
  });

  it('applies equipment, Reaper Form and Mystic Transformation spell-damage bonuses', () => {
    const api = {
      attributes: { effectiveAttributes: () => ({ spellDamageIncrease: 20 }) },
      combat: { damage: vi.fn() }, world: {},
    };
    const plain = { int: 0, skills: { 17: 100 } };
    const transformed = {
      int: 0, skills: { 17: 100 }, _reaperForm: true, _reaperSDI: 10,
      _mysticTransformUntil: Date.now() + 10_000, _mysticTransformDmgBonus: 20,
    };
    const target = { skills: {} };
    expect(applySpellDamage(api, target, 100, transformed, { circle: 1 }))
      .toBeGreaterThan(applySpellDamage(api, target, 100, plain, { circle: 1 }));
  });
});

describe('virtue and Mondain quest audit', () => {
  it('invokes virtues case-insensitively, enforces full timestamps, and consumes Honor in combat', () => {
    const mob = { str: 0, skills: {}, virtues: { honor: 500 } };
    const now = Date.now();
    const first = invokeVirtue(mob, 'honor', null, now);
    expect(first).toMatchObject({ ok: true, effect: 'embrace' });
    expect(mob.virtues.honor).toBe(400);
    expect(rollDamage(mob, { armor: 0 }, () => 0)).toBe(2);
    expect(mob._honorEmbraceUntil).toBe(0);
    expect(invokeVirtue(mob, 'Honor', null, now + 1).reason).toBe('cooldown');
  });

  it('enforces ML prerequisite chains, active-state reasons, skill points and case-insensitive talk', () => {
    mlq.registerQuest({ id: 'first', unique: false,
      objectives: [{ type: 'talk', keyword: 'Thanks' }],
      rewards: [{ type: 'skill', skillId: 22, points: 3 }] });
    mlq.registerQuest({ id: 'second', requires: 'first', chain: 'sample',
      objectives: [{ type: 'slay', kind: 'rat', count: 1 }], rewards: [] });
    const mob = { skills: { 22: 10 } };
    expect(mlq.offer(mob, 'second')).toMatchObject({
      ok: false, reason: 'prerequisite-not-complete', requires: 'first',
    });
    expect(mlq.offer(mob, 'first').ok).toBe(true);
    expect(mlq.offer(mob, 'first').reason).toBe('already-active');
    mlq.trackTalk(mob, 0, 'THANKS');
    expect(mlq.turnIn(mob, 'first')).toHaveLength(1);
    expect(mob.skills[22]).toBe(13);
    expect(mlq.offer(mob, 'second').ok).toBe(true);
    expect(mlq.getQuest('second')).toMatchObject({ chain: 'sample', requires: 'first' });
    expect(mlq.listActive(mob).map((row) => row.title)).toEqual(['first', 'second']);
  });

  it('persists ML quest progress and active regeneration effect payloads', () => {
    const before = new World();
    const mob = before.createMobile({ name: 'Auditor' });
    mob.mlQuests = [{ id: 'q', progress: { 'slay:rat': 2 }, completed: false }];
    mob._chainQuests = { chain: { stage: 2, counters: { x: 1 } } };
    mob.horrificBeastUntil = Date.now() + 20_000;
    mob._horrificDamageBonus = 25;
    mob._horrificHpRegen = 20;
    mob._restedUntil = Date.now() + 20_000;
    mob._restedRegen = 2;

    const after = new World();
    restoreWorld(after, JSON.parse(JSON.stringify(snapshotWorld(before))));
    expect(after.mobiles.get(mob.serial)).toMatchObject({
      mlQuests: mob.mlQuests, _chainQuests: mob._chainQuests,
      _horrificDamageBonus: 25, _horrificHpRegen: 20, _restedRegen: 2,
    });
  });
});
