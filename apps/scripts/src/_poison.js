export function poisonSystem(api) {
  return api?.poison ?? api?.systems?.poison ?? null;
}

export function applyPoison(api, target, level, source) {
  const fn = poisonSystem(api)?.applyPoison;
  if (typeof fn === 'function') return fn(target, level, source);
  if (!api?.statusEffects?.apply || !target) return false;
  const existingLevel = target.poisoned ? (target.poisonLevel | 0) : -1;
  if (existingLevel >= (level | 0)) return true;
  target.poisoned = true;
  target.poisonLevel = level | 0;
  target._poisonExpiresAt = Date.now() + 20_000;
  api.statusEffects.apply(target, {
    name: 'poison',
    durationMs: 20_000,
    tickIntervalMs: 2_000,
    data: { level: target.poisonLevel, sourceSerial: source?.serial },
    tick(mob, world) {
      const dmg = 2 + ((mob.poisonLevel | 0) * 2);
      if (api.combat?.damage) api.combat.damage(world ?? api.world, mob, dmg, source);
      else mob.hp = Math.max(0, (mob.hp ?? 1) - dmg);
    },
    onRemove(mob) {
      mob.poisoned = false;
      mob.poisonLevel = 0;
      mob._poisonExpiresAt = 0;
    },
  });
  return true;
}

export function setPoisonTable(api, table) {
  const fn = poisonSystem(api)?.setPoisonTable;
  if (typeof fn !== 'function') return false;
  fn(table);
  return true;
}
