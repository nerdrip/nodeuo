// Craft-recipe registry — separated from the dispatcher so domain files
// (blacksmithing.js, tailoring.js, …) can import `registerRecipe` without
// circular dependencies.

/** @type {Map<number, import('./index.js').CraftRecipe>} */
const registry = new Map();

export function registerRecipe(r)    { registry.set(r.id, r); }
export function getRecipe(id)        { return registry.get(id); }
export function allRecipes()         { return Array.from(registry.values()); }
export function recipesForSkill(id)  {
  return Array.from(registry.values()).filter((r) => r.skillId === id);
}
export function recipesByCategory(skillId, category) {
  return Array.from(registry.values())
    .filter((r) => r.skillId === skillId && r.category === category);
}
