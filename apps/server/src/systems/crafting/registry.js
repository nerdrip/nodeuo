// Craft-recipe registry — separated from the dispatcher so domain files
// (blacksmithing.js, tailoring.js, …) can import `registerRecipe` without
// circular dependencies.

/** @type {Map<number, import('./index.js').CraftRecipe>} */
const registry = new Map();
const bySkill = new Map();
const bySkillCategory = new Map();

export function registerRecipe(r) {
  if (!r || !Number.isSafeInteger(r.id) || r.id <= 0) throw new TypeError('recipe requires a positive integer id');
  if (!String(r.name ?? '').trim()) throw new TypeError(`recipe ${r.id} requires a name`);
  if (!Number.isSafeInteger(r.outputItemId) || r.outputItemId <= 0 || r.outputItemId > 0xffff) {
    throw new TypeError(`recipe ${r.id} has invalid outputItemId`);
  }
  if (!Array.isArray(r.inputs)) throw new TypeError(`recipe ${r.id} requires an inputs array`);
  for (const input of r.inputs) {
    if (!Number.isSafeInteger(input?.itemId) || input.itemId <= 0 || input.itemId > 0xffff
      || !Number.isSafeInteger(input?.count) || input.count <= 0) {
      throw new TypeError(`recipe ${r.id} has an invalid ingredient`);
    }
  }
  const previous = registry.get(r.id);
  if (previous) {
    const same = previous.name === r.name && previous.outputItemId === r.outputItemId
      && previous.skillId === r.skillId;
    if (same) return false; // idempotent script reload
    throw new Error(`recipe id ${r.id} already belongs to ${previous.name}`);
  }
  const frozen = Object.freeze({
    ...r,
    inputs: Object.freeze(r.inputs.map((input) => Object.freeze({ ...input }))),
  });
  registry.set(frozen.id, frozen);
  const skill = frozen.skillId | 0;
  const skillRows = bySkill.get(skill) ?? [];
  skillRows.push(frozen);
  bySkill.set(skill, skillRows);
  const categoryKey = `${skill}:${frozen.category ?? 'Other'}`;
  const categoryRows = bySkillCategory.get(categoryKey) ?? [];
  categoryRows.push(frozen);
  bySkillCategory.set(categoryKey, categoryRows);
  return true;
}
export function getRecipe(id)        { return registry.get(id); }
export function allRecipes()         { return Array.from(registry.values()); }
export function recipesForSkill(id)  { return [...(bySkill.get(id | 0) ?? [])]; }
export function recipesByCategory(skillId, category) {
  return [...(bySkillCategory.get(`${skillId | 0}:${category ?? 'Other'}`) ?? [])];
}

export function recipeCatalogDiagnostics() {
  const issues = [];
  const names = new Map();
  for (const recipe of registry.values()) {
    const key = recipe.name.trim().toLowerCase();
    if (names.has(key)) issues.push({ severity: 'warning', recipeId: recipe.id, kind: 'duplicate-name', detail: recipe.name });
    else names.set(key, recipe.id);
    if ((recipe.minSkill | 0) > (recipe.maxSkill | 0)) {
      issues.push({ severity: 'error', recipeId: recipe.id, kind: 'skill-range', detail: `${recipe.minSkill}>${recipe.maxSkill}` });
    }
    if (!recipe.toolKind) issues.push({ severity: 'info', recipeId: recipe.id, kind: 'tool-unspecified', detail: recipe.name });
  }
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    recipes: registry.size,
    skills: bySkill.size,
    categories: bySkillCategory.size,
    issues,
  };
}
