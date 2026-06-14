export const NOTO = Object.freeze({
  Innocent: 1,
  Ally: 2,
  Animal: 3,
  Criminal: 4,
  Enemy: 5,
  Murderer: 6,
  Invulnerable: 7,
});

export function notorietySystem(api) {
  return api?.notoriety ?? api?.systems?.notoriety ?? null;
}

export function adjustKarma(api, mob, delta) {
  const fn = notorietySystem(api)?.adjustKarma;
  if (typeof fn === 'function') return fn(mob, delta);
  if (!mob) return 0;
  mob.karma = Math.max(-10000, Math.min(10000, (mob.karma | 0) + (delta | 0)));
  return mob.karma;
}

export function adjustFame(api, mob, delta) {
  const fn = notorietySystem(api)?.adjustFame;
  if (typeof fn === 'function') return fn(mob, delta);
  if (!mob) return 0;
  mob.fame = Math.max(0, Math.min(10000, (mob.fame | 0) + (delta | 0)));
  return mob.fame;
}

export function recomputeNotoriety(api, mob, now = Date.now()) {
  const fn = notorietySystem(api)?.recomputeNotoriety;
  if (typeof fn === 'function') return fn(mob, now);
  return mob?.notoriety ?? NOTO.Animal;
}

export function viewerNotoriety(api, target, viewer, world = api?.world ?? null) {
  const fn = notorietySystem(api)?.viewerNotoriety;
  if (typeof fn === 'function') return fn(target, viewer, world);
  return target?.notoriety ?? NOTO.Innocent;
}

export function flagCriminal(api, mob, durationMs, now) {
  const fn = notorietySystem(api)?.flagCriminal;
  if (typeof fn === 'function') {
    return durationMs == null ? fn(mob) : fn(mob, durationMs, now);
  }
  return false;
}

export function flagBeneficialOnCriminal(api, caster, target, now) {
  const fn = notorietySystem(api)?.flagBeneficialOnCriminal;
  if (typeof fn === 'function') {
    return now == null ? fn(caster, target) : fn(caster, target, now);
  }
  return false;
}

export function onCriminalFlag(api, fn) {
  const register = notorietySystem(api)?.onCriminalFlag;
  if (typeof register === 'function') return register(fn);
  return () => {};
}

export function decayMurders(api, world = api?.world, now = Date.now()) {
  const fn = notorietySystem(api)?.decayMurders;
  if (typeof fn === 'function') return fn(world, now);
  return 0;
}
