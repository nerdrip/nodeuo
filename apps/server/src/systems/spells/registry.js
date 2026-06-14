// Spell registry — kept separate from the cast dispatcher so domain files
// (chivalry.js, magery.js, …) can import `registerSpell` without forming
// a circular dependency with `./index.js` (which itself imports domains).

/**
 * @typedef {import('./index.js').SpellDef} SpellDef
 */

/** @type {Map<number, SpellDef>} */
const registry = new Map();

export function registerSpell(def) { registry.set(def.id, def); }
export function getSpell(id)      { return registry.get(id); }
export function allSpells()       { return Array.from(registry.values()); }
export function spellsBySchool(s) {
  return Array.from(registry.values()).filter((sp) => sp.school === s);
}
