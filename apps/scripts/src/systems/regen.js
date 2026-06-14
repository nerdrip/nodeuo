// Regen formulas — overrides the engine's built-in HP/mana/stam regen
// rates. Engine ships baked-in defaults; this script installs ServUO-
// canonical formulas so production shards can tune them by editing this
// file rather than recompiling the engine.

import { effectiveSkill, racialManaRegenMul } from '../_rules.js';

const SKILL_MEDITATION = 47;
const SKILL_FOCUS      = 51;

function hpPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.hpMax ?? 50;
  if (mob.hp >= max) return 0;
  let mult = 1;
  // Camping `rested` buff and food `sated` buff each double HP regen.
  if (_hasEffect(mob, 'rested')) mult *= 2;
  if (_hasEffect(mob, 'sated'))  mult *= 2;
  return Math.max(0.1, (max / 100) * mult);
}

function stamPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.stamMax ?? mob.dex ?? 50;
  if ((mob.stam ?? 0) >= max) return 0;
  return Math.max(0.5, (mob.dex ?? 50) / 50);
}

function manaPerSecond(mob) {
  if ((mob.hp ?? 0) <= 0 || mob.ghost) return 0;
  const max = mob.manaMax ?? mob.int ?? 50;
  if ((mob.mana ?? 0) >= max) return 0;
  const base = (mob.int ?? 50) / 50;
  const med = effectiveSkill(mob, SKILL_MEDITATION) / 100;
  const focus = effectiveSkill(mob, SKILL_FOCUS) / 200;
  return Math.max(0.2, base * (1 + med + focus) * racialManaRegenMul(mob));
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
  mod.setFormulas({ hpPerSecond, manaPerSecond, stamPerSecond });
  api.log?.('regen: ServUO formulas installed');
  return () => mod.setFormulas({});
}
