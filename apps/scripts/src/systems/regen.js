// Regen formulas — overrides the engine's built-in HP/mana/stam regen
// rates. Engine ships baked-in defaults; this script installs ServUO-
// canonical formulas so production shards can tune them by editing this
// file rather than recompiling the engine.

import { effectiveSkill, racialManaRegenMul } from '../_rules.js';

const SKILL_MEDITATION = 47;
const SKILL_FOCUS      = 51;
let readAttributes = () => ({});

function timedBonus(mob, untilKey, valueKey, now = Date.now()) {
  if ((mob?.[untilKey] ?? 0) > now) return Number(mob[valueKey]) || 0;
  if (mob?.[untilKey]) {
    mob[untilKey] = 0;
    mob[valueKey] = 0;
  }
  return 0;
}

function hpPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.hpMax ?? 50;
  if (mob.hp >= max) return 0;
  let mult = 1;
  // Camping `rested` buff and food `sated` buff each double HP regen.
  if (_hasEffect(mob, 'rested')) mult *= 2;
  if (_hasEffect(mob, 'sated'))  mult *= 2;
  const attrs = readAttributes(mob) ?? {};
  const flat = (attrs.regenHits | 0)
    + timedBonus(mob, '_restedUntil', '_restedRegen')
    + timedBonus(mob, 'hpRegenBonusUntil', 'hpRegenBonus')
    + timedBonus(mob, 'horrificBeastUntil', '_horrificHpRegen')
    + ((mob._toughnessUntil ?? 0) > Date.now() ? ((mob._toughnessRegen | 0) || 2) : 0)
    + ((mob._resilienceUntil ?? 0) > Date.now() ? 5 : 0);
  return Math.max(0.1, (max / 100) * mult + flat);
}

function stamPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.stamMax ?? mob.dex ?? 50;
  if ((mob.stam ?? 0) >= max) return 0;
  const attrs = readAttributes(mob) ?? {};
  const stonePenalty = mob._stoneForm ? 10 : 0;
  const resilience = (mob._resilienceUntil ?? 0) > Date.now() ? 5 : 0;
  return Math.max(0, (mob.dex ?? 50) / 50 + (attrs.regenStam | 0) + resilience - stonePenalty);
}

function manaPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.manaMax ?? mob.int ?? 50;
  if ((mob.mana ?? 0) >= max) return 0;
  const base = (mob.int ?? 50) / 50;
  const med = effectiveSkill(mob, SKILL_MEDITATION) / 100;
  const focus = effectiveSkill(mob, SKILL_FOCUS) / 200;
  const attrs = readAttributes(mob) ?? {};
  const lichBonus = (mob.lichFormUntil ?? 0) > Date.now() ? 13 : 0;
  const mysticBonus = timedBonus(mob, '_mysticTransformUntil', '_mysticTransformManaRegen');
  const spiritualityBonus = (mob._spiritualityUntil ?? 0) > Date.now() ? 5 : 0;
  const stonePenalty = mob._stoneForm ? 2 : 0;
  const resilience = (mob._resilienceUntil ?? 0) > Date.now() ? 5 : 0;
  return Math.max(0.2,
    base * (1 + med + focus) * racialManaRegenMul(mob)
      + (attrs.regenMana | 0) + lichBonus + mysticBonus + spiritualityBonus
      + resilience - stonePenalty);
}

function _hasEffect(mob, name) {
  const fx = mob?.effects;
  if (!fx) return false;
  const now = Date.now();
  if (fx instanceof Map) {
    const e = fx.get(name); if (!e) return false;
    return !e.expiresAt || e.expiresAt > now;
  }
  if (Array.isArray(fx)) {
    return fx.some((e) => e?.name === name && (!e.expiresAt || e.expiresAt > now));
  }
  const e = fx[name];
  return Boolean(e) && (!e.expiresAt || e.expiresAt > now);
}

export default async function register(api) {
  const mod = api.regen ?? api.systems?.regen;
  if (!mod?.setFormulas) {
    api.log?.('regen: setFormulas missing, skipping');
    return () => {};
  }
  readAttributes = api.attributes?.effectiveAttributes
    ?? api.worldAttributes?.effectiveAttributes
    ?? (() => ({}));
  mod.setFormulas({ hpPerSecond, manaPerSecond, stamPerSecond });
  api.log?.('regen: ServUO formulas installed');
  return () => {
    readAttributes = () => ({});
    mod.setFormulas({ hpPerSecond: null, manaPerSecond: null, stamPerSecond: null });
  };
}
