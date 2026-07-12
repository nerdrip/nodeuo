export const MOUNT_ABILITIES = Object.freeze([
  { id: 'sprint', label: 'Sprint', minLevel: 0, stamina: 10, cooldownMs: 12_000, description: '4 seconds of faster mounted running.' },
  { id: 'second-wind', label: 'Second Wind', minLevel: 1, stamina: 0, cooldownMs: 30_000, description: 'Restores rider and mount stamina.' },
  { id: 'sure-footed', label: 'Sure-footed', minLevel: 2, stamina: 8, cooldownMs: 20_000, description: 'Brief resistance to forced dismount.' },
  { id: 'battle-charge', label: 'Battle Charge', minLevel: 3, stamina: 15, cooldownMs: 15_000, description: 'Empowers the next hit by 25%.' },
]);

export function mountedPet(world, rider) {
  return rider?.mountedFrom ? world?.mobiles?.get?.(rider.mountedFrom >>> 0) ?? null : null;
}

export function abilitiesForMount(pet, now = Date.now()) {
  const cooldowns = pet?.mountAbilityCooldowns ?? {};
  return MOUNT_ABILITIES.filter((ability) => (pet?.petLevel | 0) >= ability.minLevel).map((ability) => ({
    ...ability, readyAt: cooldowns[ability.id] ?? 0,
    remainingMs: Math.max(0, (cooldowns[ability.id] ?? 0) - now),
  }));
}

export function useMountAbility(world, rider, abilityId, now = Date.now()) {
  const pet = mountedPet(world, rider);
  if (!pet || (pet.controlMaster >>> 0) !== (rider?.serial >>> 0)) return { ok: false, error: 'You are not riding your controlled mount.' };
  const ability = abilitiesForMount(pet, now).find((entry) => entry.id === abilityId);
  if (!ability) return { ok: false, error: 'That mount has not unlocked this ability.' };
  if (ability.remainingMs > 0) return { ok: false, error: `${ability.label} is ready in ${(ability.remainingMs / 1000).toFixed(1)}s.` };
  if ((rider.stam ?? 0) < ability.stamina) return { ok: false, error: 'You are too fatigued.' };
  rider.stam = Math.max(0, (rider.stam | 0) - ability.stamina);
  pet.mountAbilityCooldowns ??= {};
  pet.mountAbilityCooldowns[ability.id] = now + ability.cooldownMs;
  switch (ability.id) {
    case 'sprint': rider._mountSprintUntil = now + 4_000; break;
    case 'second-wind': {
      rider.stam = Math.min(rider.stamMax ?? 100, (rider.stam | 0) + 35);
      pet.stam = Math.min(pet.stamMax ?? pet.dex ?? 100, (pet.stam | 0) + 35); break;
    }
    case 'sure-footed': rider._mountSurefootedUntil = now + 6_000; break;
    case 'battle-charge': rider._mountChargeUntil = now + 8_000; break;
  }
  return { ok: true, ability, pet };
}
