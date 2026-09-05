// Monster template registry.
//
// Analogous to ItemTemplate but for mobiles. Scripts declare creature types
// by plain data (the JSON under apps/scripts/src/data/config/monsters.json), then
// `npcs/aggressive.js` looks up by definitionId when `[spawnmob` or the global
// spawn factory fires.
//
// Fields mirror ServUO's BaseCreature props (body, hue, hits, stats,
// behavior tuning) without the class hierarchy.

/**
 * @typedef {Object} MonsterTemplate
 * @property {string} definitionId         stable gameplay key (e.g. 'orc')
 * @property {string} name                 display name
 * @property {number} bodyId               animation body id (presentation only)
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
    const definitionId = String(tmpl?.definitionId ?? tmpl?.kind ?? '').trim();
    if (!definitionId) throw new Error('monster template needs definitionId');
    const bodyId = Number(tmpl?.bodyId ?? tmpl?.body);
    if (!Number.isInteger(bodyId) || bodyId < 0 || bodyId > 0xFFFF) {
      throw new Error(`monster ${definitionId} missing valid bodyId`);
    }
    // ServUO extraction sources use all of `Tamable`, `MinTameSkill`
    // and older NodeUO's authored `tameable/tameMinSkill` spellings.
    // Normalize once at the registry boundary so taming, paragons,
    // admin filters and spawn factories cannot disagree.
    const normalized = {
      ...tmpl,
      definitionId,
      kind: definitionId, // compatibility alias for existing commands / AI
      bodyId,
      body: bodyId,       // UO wire/rendering alias; never a registry key
      script: tmpl.script ?? tmpl.behavior ?? tmpl.ai ?? 'aggressive',
    };
    normalized.tameable = !!(tmpl.tameable ?? tmpl.tamable);
    normalized.tamable = normalized.tameable; // compatibility for old scripts
    const rawMin = tmpl.tameMinSkill ?? tmpl.tameSkill ?? tmpl.minTameSkill;
    if (rawMin != null) {
      const n = Number(rawMin) || 0;
      normalized.tameMinSkill = n > 120 ? n / 10 : n;
      const rawMax = tmpl.tameMaxSkill;
      if (rawMax != null) {
        const m = Number(rawMax) || 0;
        normalized.tameMaxSkill = m > 120 ? m / 10 : m;
      } else {
        // Linear chance model: ordinary creatures reach certainty around
        // GM skill; end-game creatures remain challenging near 120.
        normalized.tameMaxSkill = Math.max(100, normalized.tameMinSkill + 20);
      }
    }
    this.unregister(normalized.definitionId);
    this.templates.set(normalized.definitionId, normalized);
    const aliases = new Set([
      normalized.servuoClass,
      ...(Array.isArray(normalized.servuoClasses) ? normalized.servuoClasses : []),
    ].filter(Boolean));
    for (const alias of aliases) {
      this.aliases.set(String(alias), normalized);
      this.aliases.set(String(alias).toLowerCase(), normalized);
    }
    this.aliasesByKind.set(normalized.definitionId, aliases);
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

  /** Authoring helper only: several independent definitions may share a body. */
  variants(bodyId) {
    const id = Number(bodyId);
    return [...this.templates.values()].filter((template) => template.bodyId === id);
  }
}
