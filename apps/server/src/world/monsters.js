// Monster template registry.
//
// Analogous to ItemTemplate but for mobiles. Scripts declare creature types
// by plain data (the JSON under apps/scripts/src/data/config/monsters.json), then
// `npcs/aggressive.js` looks up by kind when `[spawnmob` or the global
// spawn factory fires.
//
// Fields mirror ServUO's BaseCreature props (body, hue, hits, stats,
// behavior tuning) without the class hierarchy.

/**
 * @typedef {Object} MonsterTemplate
 * @property {string} kind                 registry key (e.g. 'orc')
 * @property {string} name                 display name
 * @property {number} body                 animation body id
 * @property {number} [hue]
 * @property {number} hp
 * @property {number} str
 * @property {number} [dex]
 * @property {number} [int]
 * @property {number} notoriety            1=innocent, 5=enemy, 6=murderer
 * @property {number} [aggroRange]
 * @property {number} [attackInterval]
 * @property {[number, number]} [gold]     gold pile min..max
 * @property {string} [loot]               loot table name
 * @property {string} [behavior]           AI behavior to attach (default 'aggressive')
 */

export class MonsterRegistry {
  constructor() {
    /** @type {Map<string, MonsterTemplate>} */
    this.templates = new Map();
    /** @type {Map<string, MonsterTemplate>} */
    this.aliases = new Map();
    /** @type {Map<string, Set<string>>} */
    this.aliasesByKind = new Map();
  }

  /** @param {MonsterTemplate} tmpl */
  register(tmpl) {
    if (!tmpl || typeof tmpl.kind !== 'string') throw new Error('monster template needs kind');
    if (!Number.isFinite(tmpl.body)) throw new Error(`monster ${tmpl.kind} missing body`);
    this.unregister(tmpl.kind);
    this.templates.set(tmpl.kind, tmpl);
    const aliases = new Set([
      tmpl.servuoClass,
      ...(Array.isArray(tmpl.servuoClasses) ? tmpl.servuoClasses : []),
    ].filter(Boolean));
    for (const alias of aliases) {
      this.aliases.set(String(alias), tmpl);
      this.aliases.set(String(alias).toLowerCase(), tmpl);
    }
    this.aliasesByKind.set(tmpl.kind, aliases);
  }

  unregister(kind) {
    const aliases = this.aliasesByKind.get(kind);
    if (aliases) {
      for (const alias of aliases) {
        this.aliases.delete(String(alias));
        this.aliases.delete(String(alias).toLowerCase());
      }
      this.aliasesByKind.delete(kind);
    }
    this.templates.delete(kind);
  }

  get(kind) {
    const key = String(kind ?? '');
    return this.templates.get(key) ?? this.aliases.get(key) ?? this.aliases.get(key.toLowerCase());
  }

  kinds() { return [...this.templates.keys()].sort(); }
}
