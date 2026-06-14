// NPC template registry.
//
// Sibling of MonsterRegistry but for non-hostile, scripted townsfolk —
// vendors, guards, quest-givers, ambient NPCs. Mirrors how ServUO splits
// `BaseCreature` (monsters.json) from `BaseVendor`/`BaseHumanoid`
// (npcs.json).
//
// Behaviour for an NPC kind is wired by scripts (apps/scripts/src/npcs/),
// which read this registry to find spawn-time defaults: body, hue, name,
// title, etc. The raw data lives in `apps/scripts/src/data/config/npcs.json`.

/**
 * @typedef {Object} NpcTemplate
 * @property {string} kind                 registry key (e.g. 'town-crier')
 * @property {string} name                 display name (or first name)
 * @property {string} [title]              shown after name on overhead/paperdoll
 * @property {number} body                 0x190 male / 0x191 female / animal id
 * @property {number} [hue]
 * @property {number} [hp]                 default 50
 * @property {number} [str]
 * @property {number} [dex]
 * @property {number} [int]
 * @property {number} [notoriety]          default 1 (Innocent)
 * @property {string} [vocation]           'crier' | 'guard' | 'beggar' | 'merchant' | …
 * @property {string} [behavior]           AI behaviour name (default: 'wander' or 'idle')
 * @property {Array<{itemId:number, layer:number, hue?:number}>} [outfit]  starter equipment
 * @property {{ table?: string, gold?: [number, number] }} [drops]         on death
 */

export class NpcRegistry {
  constructor() {
    /** @type {Map<string, NpcTemplate>} */
    this.templates = new Map();
  }

  /** @param {NpcTemplate} tmpl */
  register(tmpl) {
    if (!tmpl || typeof tmpl.kind !== 'string') throw new Error('npc template needs kind');
    if (!Number.isFinite(tmpl.body)) throw new Error(`npc ${tmpl.kind} missing body`);
    this.templates.set(tmpl.kind, tmpl);
  }

  unregister(kind) { this.templates.delete(kind); }
  get(kind) { return this.templates.get(kind); }
  kinds() { return [...this.templates.keys()].sort(); }
}
