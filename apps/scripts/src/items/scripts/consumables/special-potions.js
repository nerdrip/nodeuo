import { applyPoison } from '../../../_poison.js';
import { allMobiles } from '../../../_spatial.js';
import { consumeOne } from '../_shared/consume.js';

const POTION_COOLDOWN_MS = 10_000;
const MINUTE = 60_000;

const EODON_EFFECTS = {
  barrab: {
    label: 'Barrab Hemolymph Concentrate',
    durationMs: 20 * MINUTE,
    timed: [
      { kind: 'attr', key: 'hitChanceIncrease', amount: 10, durationMs: 5 * MINUTE },
      { kind: 'attr', key: 'regenHits', amount: 10, durationMs: 10 * MINUTE },
    ],
    fields(now) {
      return {
        _eodonHitBonusUntil: now + (5 * MINUTE),
        _eodonHpRegenBonusUntil: now + (10 * MINUTE),
        _eodonHpRegenBonus: 100,
      };
    },
  },
  jukari: {
    label: 'Jukari Burn Poultice',
    durationMs: 20 * MINUTE,
    timed: [
      { kind: 'resist', key: 'fire', amount: 10, durationMs: 10 * MINUTE },
      { kind: 'attr', key: 'staminaIncrease', amount: 10, durationMs: 5 * MINUTE },
    ],
    fields(now) {
      return { _eodonStamBonusUntil: now + (5 * MINUTE) };
    },
  },
  kurak: {
    label: 'Kurak Ambusher\'s Essence',
    durationMs: 10 * MINUTE,
    timed: [],
    fields(now) {
      return { _eodonAmbushBonusUntil: now + (10 * MINUTE), _eodonAmbushBonus: 200 };
    },
  },
  barako: {
    label: 'Barako Draft of Might',
    durationMs: 20 * MINUTE,
    timed: [
      { kind: 'resist', key: 'physical', amount: 10, durationMs: 10 * MINUTE },
      { kind: 'resist', key: 'cold', amount: 5, durationMs: 10 * MINUTE },
    ],
  },
  urali: {
    label: 'Urali Trance Tonic',
    durationMs: 20 * MINUTE,
    timed: [
      { kind: 'attr', key: 'manaIncrease', amount: 10, durationMs: 5 * MINUTE },
    ],
    fields(now) {
      return {
        _eodonManaBonusUntil: now + (5 * MINUTE),
        _eodonManaTickUntil: now + (10 * MINUTE),
      };
    },
    tick(mob, now, data) {
      if (now > (mob._eodonManaTickUntil ?? 0)) return;
      if ((data.lastManaTickAt ?? 0) > now - 1000) return;
      data.lastManaTickAt = now;
      mob.mana = Math.min(mob.manaMax ?? 100, (mob.mana ?? 0) + 10);
    },
  },
  sakkhra: {
    label: 'Sakkhra Prophylaxis',
    durationMs: 20 * MINUTE,
    timed: [
      { kind: 'resist', key: 'poison', amount: 10, durationMs: 10 * MINUTE },
      { kind: 'resist', key: 'energy', amount: 5, durationMs: 10 * MINUTE },
    ],
  },
};

export class EodonPotionContext {
  constructor(effect, now, item, def, mods = []) {
    this.servuoClass = 'EodonPotionContext';
    this.effect = effect;
    this.startedAt = now;
    this.expiresAt = now + (item.eodonDurationMs ?? def.durationMs);
    this.mods = mods.map((mod) => ({ ...mod }));
  }
}

function send(user, text) {
  user?.client?.sendSystemMessage?.(text);
}

function potionReady(user) {
  const now = Date.now();
  const last = user?._lastPotionAt ?? 0;
  if (last > now - POTION_COOLDOWN_MS) {
    send(user, `You must wait ${Math.ceil((POTION_COOLDOWN_MS - (now - last)) / 1000)}s before drinking another potion.`);
    return false;
  }
  user._lastPotionAt = now;
  return true;
}

function dirty(mob, kind) {
  if (!mob) return;
  if (kind === 'attr') mob._attrBagDirty = true;
  else if (kind === 'resist') mob._resBagDirty = true;
}

function addTimedMod(mob, mod) {
  mob._eodonPotionMods ??= [];
  mob._eodonPotionMods.push(mod);
  dirty(mob, mod.kind);
}

function removeTimedMods(mob, effect) {
  if (!Array.isArray(mob?._eodonPotionMods)) return;
  let changedAttr = false;
  let changedResist = false;
  mob._eodonPotionMods = mob._eodonPotionMods.filter((mod) => {
    if (mod.effect !== effect) return true;
    changedAttr ||= mod.kind === 'attr';
    changedResist ||= mod.kind === 'resist';
    return false;
  });
  if (mob._eodonPotionMods.length === 0) delete mob._eodonPotionMods;
  if (changedAttr) dirty(mob, 'attr');
  if (changedResist) dirty(mob, 'resist');
}

function expireTimedMods(mob, now) {
  if (!Array.isArray(mob?._eodonPotionMods)) return;
  let changedAttr = false;
  let changedResist = false;
  mob._eodonPotionMods = mob._eodonPotionMods.filter((mod) => {
    if ((mod.expiresAt ?? 0) > now) return true;
    changedAttr ||= mod.kind === 'attr';
    changedResist ||= mod.kind === 'resist';
    return false;
  });
  if (mob._eodonPotionMods.length === 0) delete mob._eodonPotionMods;
  if (changedAttr) dirty(mob, 'attr');
  if (changedResist) dirty(mob, 'resist');
}

function cleanupEodonFields(mob, effect) {
  if (!mob) return;
  if (effect === 'barrab') {
    delete mob._eodonHitBonusUntil;
    delete mob._eodonHpRegenBonusUntil;
    delete mob._eodonHpRegenBonus;
  } else if (effect === 'jukari') {
    delete mob._eodonStamBonusUntil;
  } else if (effect === 'kurak') {
    delete mob._eodonAmbushBonusUntil;
    delete mob._eodonAmbushBonus;
  } else if (effect === 'urali') {
    delete mob._eodonManaBonusUntil;
    delete mob._eodonManaTickUntil;
  }
}

function removeEodonContext(mob, effect, data = {}) {
  removeTimedMods(mob, effect);
  cleanupEodonFields(mob, effect);
  if (mob?._eodonPotions) {
    delete mob._eodonPotions[effect];
    if (Object.keys(mob._eodonPotions).length === 0) delete mob._eodonPotions;
  }
  if (mob?._eodonPotionContexts) {
    delete mob._eodonPotionContexts[effect];
    if (Object.keys(mob._eodonPotionContexts).length === 0) delete mob._eodonPotionContexts;
  }
}

function applyEodon(user, item) {
  const effect = String(item.eodonEffect ?? '').toLowerCase();
  const def = EODON_EFFECTS[effect];
  if (!def) {
    send(user, 'Nothing happens.');
    return false;
  }
  const now = Date.now();
  user._eodonPotions ??= {};
  const existing = user._eodonPotions[effect];
  if (existing && (existing.expiresAt ?? 0) > now) {
    send(user, 'You are already under a similar effect.');
    return false;
  }

  const mods = [];
  for (const spec of def.timed ?? []) {
    const mod = {
      effect,
      kind: spec.kind,
      key: spec.key,
      amount: spec.amount,
      expiresAt: now + (spec.durationMs ?? def.durationMs),
    };
    addTimedMod(user, mod);
    mods.push(mod);
  }
  Object.assign(user, def.fields?.(now) ?? {});

  user._eodonPotions[effect] = {
    effect,
    startedAt: now,
    expiresAt: now + (item.eodonDurationMs ?? def.durationMs),
  };
  user._eodonPotionContexts ??= {};
  user._eodonPotionContexts[effect] = new EodonPotionContext(effect, now, item, def, mods);
  const data = { effect, mods, lastManaTickAt: now };
  apiApplyStatus(user, {
    name: `eodon:${effect}`,
    durationMs: item.eodonDurationMs ?? def.durationMs,
    tickIntervalMs: 1000,
    data,
    tick(mob, _world, tickNow) {
      expireTimedMods(mob, tickNow);
      def.tick?.(mob, tickNow, data);
    },
    onRemove(mob) {
      removeEodonContext(mob, effect, data);
    },
  });
  send(user, `You feel the effects of ${def.label}.`);
  return true;
}

let _statusApi = null;
function apiApplyStatus(mob, effect) {
  try { _statusApi?.apply?.(mob, effect); }
  catch { /* optional */ }
}

export function buildPoisonPotion(api) {
  return {
    name: 'potion-poison',
    onUse(world, item, user) {
      if (!user) return false;
      if (!potionReady(user)) return false;
      const level = Math.max(0, Math.min(4, item.poisonLevel ?? 1));
      applyPoison(api, user, level, item);
      user.poisonKind = item.poisonKind ?? user.poisonKind;
      send(user, 'You drink the poison.');
      consumeOne(api, world, item, user);
      return true;
    },
  };
}

export function buildEodonPotion(api) {
  _statusApi = api.statusEffects ?? null;
  return {
    name: 'eodon-potion',
    onCreate(_world, item) {
      item.servuoClasses ??= [item.servuoClass, 'EodonianPotion', 'EodonPotionContext']
        .filter(Boolean);
    },
    onUse(world, item, user) {
      if (!user) return false;
      if (!potionReady(user)) return false;
      if (!applyEodon(user, item)) {
        user._lastPotionAt = 0;
        return false;
      }
      consumeOne(api, world, item, user);
      return true;
    },
  };
}

export function buildEndlessDecanter(api) {
  return {
    name: 'endless-decanter',
    onUse(_world, item, user) {
      if (!user) return false;
      item.content ??= 'water';
      item.maxQuantity ??= 5;
      item.quantity ??= item.maxQuantity;
      if ((item.quantity | 0) <= 0 && !tryRefill(item, user)) return true;
      item.quantity = Math.max(0, (item.quantity | 0) - 1);
      send(user, 'You drink the water. Refreshing.');
      if ((item.quantity | 0) <= 0) tryRefill(item, user);
      return true;
    },
  };
}

export function buildAreaPotion(api) {
  itemApi = api;
  return {
    name: 'area-potion',
    onUse(world, item, user) {
      if (!user) return false;
      if ((user._paralyzedUntil ?? 0) > Date.now() || user.paralyzed) {
        send(user, 'You can not use that potion while paralyzed.');
        return false;
      }
      const finish = (picked = null) => {
        detonate(world, item, user, picked);
        consumeOne(api, world, item, user);
      };
      const state = user.client?.netState ?? user.client;
      if (api.targeting?.request && state) {
        send(user, 'Select where to throw the potion.');
        api.targeting.request(state, finish, { range: item.throwRange ?? 12 });
      } else {
        finish({ x: user.x, y: user.y, z: user.z, map: user.map });
      }
      return true;
    },
  };
}

function detonate(world, item, user, picked) {
  const x = picked?.x ?? user.x ?? item.x ?? 0;
  const y = picked?.y ?? user.y ?? item.y ?? 0;
  const map = picked?.map ?? user.map ?? item.map ?? 1;
  const radius = item.aoeRadius ?? 2;
  const [min, max] = Array.isArray(item.damage) ? item.damage : [item.aoeDamage ?? 8, item.aoeDamage ?? 8];
  const damage = Math.max(0, min + Math.floor(Math.random() * (Math.max(min, max) - min + 1)));
  let hit = 0;
  for (const mob of allMobiles({ ...itemApi, world })) {
    if (mob.map !== map) continue;
    if (Math.max(Math.abs((mob.x ?? 0) - x), Math.abs((mob.y ?? 0) - y)) > radius) continue;
    hit++;
    if (damage > 0) {
      try { itemApi.combat?.damage?.(world, mob, damage, user, item.damageType ?? { physical: 100 }); }
      catch {
        mob.hp = Math.max(0, (mob.hp ?? mob.hpMax ?? 1) - damage);
      }
    }
    if (item.statusEffect) {
      try { itemApi.statusEffects?.apply?.(mob, { name: item.statusEffect, durationMs: item.statusDurationMs ?? 4000 }); }
      catch { /* optional */ }
    }
  }
  send(user, hit > 0 ? 'The potion bursts on impact.' : 'The potion shatters harmlessly.');
}

let itemApi = {};

function tryRefill(item, user) {
  if (!item.linked && !item.Linked) {
    send(user, 'The decanter is empty.');
    return false;
  }
  const loc = item.linkLocation ?? item.LinkLocation;
  const map = item.linkMap ?? item.LinkMap ?? user.map;
  const dx = Math.abs((user.x ?? 0) - (loc?.x ?? user.x ?? 0));
  const dy = Math.abs((user.y ?? 0) - (loc?.y ?? user.y ?? 0));
  if (map !== user.map || Math.max(dx, dy) > 10) {
    send(user, 'The decanter cannot reach its linked water trough from here.');
    return false;
  }
  item.quantity = item.maxQuantity ?? 5;
  send(user, 'The decanter fills itself from the linked water trough.');
  return true;
}
