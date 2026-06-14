export function normalizeSkillValue(value) {
  const n = Number(value) || 0;
  return n > 120 ? n / 10 : n;
}

export function effectiveSkill(mob, skillId) {
  if (!mob || !mob.skills) return 0;
  const direct = mob.skills[skillId];
  if (typeof direct === 'number') return normalizeSkillValue(direct);
  const str = mob.skills[String(skillId)];
  return typeof str === 'number' ? normalizeSkillValue(str) : 0;
}

export function raceOf(mob) {
  if (!mob || !mob.client) return null;
  const body = mob.body | 0;
  if (body === 0x25D || body === 0x25E) return 'elf';
  if (body === 0x29A || body === 0x29B || body === 0x666 || body === 0x667) return 'gargoyle';
  if (body === 0x190 || body === 0x191) return 'human';
  return null;
}

export function racialManaRegenMul(mob) {
  return raceOf(mob) === 'elf' ? 1.2 : 1;
}
