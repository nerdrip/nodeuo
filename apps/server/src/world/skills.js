// Skill registry.
//
// Holds the canonical metadata for the 58 classic UO skills (id, name,
// stat dependencies, optional gain rate). Mirrors ServUO's `SkillInfo`.
// Game-mechanics modules look up entries by id; the data file lives at
// `apps/scripts/src/data/config/skills.json` so writers can edit it without
// touching engine code.
//
// `id` is the wire-protocol skill id (1-based, matching `Skills.mul`).

/**
 * @typedef {Object} SkillEntry
 * @property {number} id
 * @property {string} name
 * @property {'STR'|'DEX'|'INT'} [primary]   primary stat for advancement
 * @property {'STR'|'DEX'|'INT'} [secondary] secondary stat (for compound checks)
 * @property {number} [gain]                 0..1, multiplier on default gain odds
 * @property {string} [group]                'combat' | 'magic' | 'craft' | 'misc'
 */

export class SkillRegistry {
  constructor() {
    /** @type {Map<number, SkillEntry>} */
    this.byId = new Map();
    /** @type {Map<string, SkillEntry>} */
    this.byName = new Map();
  }

  /** @param {SkillEntry} entry */
  register(entry) {
    if (!entry || typeof entry.id !== 'number') throw new Error('skill entry needs id');
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`skill ${entry.id} needs name`);
    }
    this.byId.set(entry.id, entry);
    this.byName.set(entry.name.toLowerCase(), entry);
  }

  unregister(id) {
    const e = this.byId.get(id);
    if (!e) return;
    this.byId.delete(id);
    this.byName.delete(e.name.toLowerCase());
  }

  get(id) { return this.byId.get(id); }
  find(name) { return this.byName.get(String(name).toLowerCase()); }
  ids() { return [...this.byId.keys()].sort((a, b) => a - b); }
  list() { return [...this.byId.values()].sort((a, b) => a.id - b.id); }
}
