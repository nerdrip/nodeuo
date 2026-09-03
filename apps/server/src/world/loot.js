// Loot table registry.
//
// Models ServUO's LootPack / LootPackEntry in a plain-data way. A loot
// table has a name and an array of entries. Rolling a table drops the
// resulting items into a container. Entries can:
//
//   - reference an item template by `template: 'gold'` (preferred)
//   - reference a raw graphic by `itemId: 0x1B72` for one-offs
//   - compose another table by `table: 'orc-common'`
//   - gate on probability via `chance: 0..1`
//   - pick a random amount via `amount: number | [lo, hi]`
//   - override `hue`, `name`
//
// Registries live outside the `World` because data is scripted at load-time
// and survives world save/load — serialized items don't need to reference
// their source table.

import { createItem } from './items.js';
import { getTemplate } from './templates.js';
import { resolveItemType } from './item-types.js';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// ---- Wave 10: magic-item base type pools --------------------------
//
// When a `{magicItem:{slot}}` loot entry omits an explicit template,
// we draw a random ServUO type from these slot-keyed pools and run it
// through `resolveItemType()` to recover the graphic. Keeps loot
// visually varied — a "magic weapon" drop isn't always the same item.
const MAGIC_BASE_POOLS = {
  weapon: [
    'Katana', 'Longsword', 'Halberd', 'Cutlass', 'Scimitar',
    'WarAxe', 'BattleAxe', 'Mace', 'Maul', 'Hatchet',
    'Dagger', 'Bow', 'CrossBow', 'HeavyCrossBow', 'CompositeBow',
    'WarHammer', 'WarMace', 'Pike', 'Spear', 'BlackStaff',
  ],
  armor: [
    'PlateChest', 'PlateArms', 'PlateLegs', 'PlateGloves', 'PlateHelm',
    'ChainChest', 'ChainLegs',
    'LeatherChest', 'LeatherArms', 'LeatherLegs', 'LeatherGloves', 'LeatherCap',
    'StuddedChest', 'StuddedArms', 'StuddedLegs', 'StuddedGloves',
    'WoodenShield', 'HeaterShield', 'BronzeShield', 'BuckleShield',
  ],
  jewelry: ['GoldRing', 'GoldBracelet', 'GoldNecklace', 'GoldEarrings'],
  clothing: ['Robe', 'Cloak', 'FancyShirt', 'LongPants', 'Doublet'],
};

// Magic items occasionally carry a faint magical hue. Sample from a
// short list at ~25% probability — leaves most rolls plain so true
// rares stand out visually.
const MAGIC_HUE_ROLL = [0, 0, 0, 0x47E, 0x4B5, 0x481, 0x44E];

// Wave 11: magic-item naming. UO's prefix/suffix table is folkloric —
// we capture the most recognisable mappings: prefix per top-budget
// tier, suffix per dominant attribute family. Picked deterministically
// (strongest prop drives suffix; total budget drives prefix).
const MAGIC_SUFFIX_BY_ATTR = {
  // AOS attributes
  AttackChance:        'Strikes',
  DefendChance:        'Warding',
  CastSpeed:           'Hastening',
  CastRecovery:        'Quickness',
  SpellDamage:         'Wizardry',
  LowerManaCost:       'Conservation',
  LowerRegCost:        'Frugality',
  WeaponDamage:        'Vanquishing',
  WeaponSpeed:         'Swiftness',
  HitChanceIncrease:   'Aim',
  DefenseChanceIncrease: 'Defense',
  DamageIncrease:      'Power',
  BonusHits:           'Sustenance',
  BonusStr:            'Might',
  BonusDex:            'Agility',
  BonusInt:            'Cunning',
  BonusStam:           'Vigor',
  BonusMana:           'Mind',
  RegenHits:           'Healing',
  RegenStam:           'Endurance',
  RegenMana:           'Meditation',
  // Weapon attributes
  HitFireball:         'Burning',
  HitLightning:        'Storms',
  HitMagicArrow:       'Force',
  HitHarm:             'Harm',
  HitDispel:           'Dispelling',
  HitLeechMana:        'Mana Leech',
  HitLeechHits:        'Vampire',
  HitLeechStam:        'Stamina Leech',
  HitManaDrain:        'Drain',
  HitColdArea:         'Frost',
  HitFireArea:         'Embers',
  HitEnergyArea:       'Voltage',
  HitPoisonArea:       'Plague',
  HitPhysicalArea:     'Concussion',
  HitLowerAttack:      'Distraction',
  HitLowerDefend:      'Sundering',
  HitSwarm:            'Insects',
  HitSparks:           'Sparks',
  HitFatigue:          'Weariness',
  SplinteringWeapon:   'Splinters',
  ReactiveParalyze:    'Paralysis',
  BalancedWeapon:      'Balance',
  // Misc + AOS supplemental
  Luck:                'Fortune',
  EnhancePotions:      'Alchemy',
  ReflectPhysical:     'Reflection',
  SoulCharge:          'Soul Binding',
  Fire:                'Flame',
  Cold:                'Glacier',
  Poison:              'Venom',
  Energy:              'Lightning',
  ResonancePhysical:   'Stoneshield',
  ResonanceFire:       'Pyric',
  ResonanceCold:       'Glacial',
  ResonancePoison:     'Pestilent',
  ResonanceEnergy:     'Galvanic',
  ResonanceKinetic:    'Kinetic',
  EaterPhysical:       'Bulwark',
  EaterFire:           'Fireeating',
  EaterCold:           'Frostbite',
  EaterPoison:         'Toxin',
  EaterEnergy:         'Voltaic',
  EaterDamage:         'Devouring',
  ResistPhysicalBonus: 'Plating',
  ResistFireBonus:     'Fire Eating',
  ResistColdBonus:     'Frost',
  ResistPoisonBonus:   'Antidote',
  ResistEnergyBonus:   'Insulation',
  UseBestSkill:        'Versatility',
  ResistPhysical:      'Plating',
  ResistFire:          'Fire Eating',
  ResistCold:          'Frost',
  ResistPoison:        'Antidote',
  ResistEnergy:        'Insulation',
  Slayer:              'Slaying',
  BattleLust:          'Bloodlust',
  BoneBreaker:         'Sundering',
};

const MAGIC_PREFIX_BY_BUDGET = [
  // [budgetThreshold, prefix]. First match wins, sorted high-to-low.
  [0.90, 'Lethal'],
  [0.75, 'Mighty'],
  [0.60, 'Stalwart'],
  [0.45, 'Sturdy'],
  [0.30, 'Forged'],
  [0.0,  null],          // no prefix for low-tier rolls
];

/**
 * Pretty-print an item id family as a human-readable noun. We don't
 * have access to the cliloc-driven label here (that's client-side),
 * but the slot pools already named things in PascalCase like
 * `LeatherChest`. Strip prefix/material to get the noun.
 */
function nounForType(typeName) {
  if (!typeName) return 'item';
  // CamelCase split + lowercase → "leather chest" → take the last word.
  const words = typeName.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/);
  return words[words.length - 1].toLowerCase();
}

function describeMagicItem(props, cfg, baseTypeName) {
  if (!Array.isArray(props) || !props.length) return null;
  // Strongest prop = highest intensity (excluding flags which are
  // categorical). Used to pick the suffix.
  const numericProps = props.filter((p) => !p.isFlag);
  const dominant = (numericProps.length ? numericProps : props)
    .reduce((best, p) => ((p.intensity ?? 0) > (best?.intensity ?? -1) ? p : best), null);
  const suffix = dominant ? MAGIC_SUFFIX_BY_ATTR[dominant.attribute] : null;

  const budget = cfg?.budget ?? 0.5;
  const prefix = (MAGIC_PREFIX_BY_BUDGET.find(([t]) => budget >= t) ?? [])[1] ?? null;

  const noun = nounForType(baseTypeName);
  const article = /^[aeiou]/i.test(prefix ?? noun) ? 'an' : 'a';
  const head = prefix ? `${article} ${prefix} ${noun}` : `${article} ${noun}`;
  return suffix ? `${head} of ${suffix}` : head;
}

// ---- Wave 7 follow-up: artifact & magic-property catalogs ---------
//
// Both files are produced by the ServUO extractors:
//   - apps/scripts/src/data/world/artifacts.json
//   - apps/scripts/src/data/config/magic-properties.json
// They're loaded lazily on first use so unit tests that don't hit the
// generator pay nothing.

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
// data/ was split into config/ and world/ on 2026-05-16. We load from
// each respective bucket; see apps/scripts/src/data/README.md.
const CONFIG_DIR = path.resolve(HERE, '..', '..', '..', 'scripts', 'src', 'data', 'config');
const WORLD_DIR  = path.resolve(HERE, '..', '..', '..', 'scripts', 'src', 'data', 'world');

let _artifactsCache = null;
let _magicPropsCache = null;

function loadArtifacts() {
  if (_artifactsCache !== null) return _artifactsCache;
  const file = path.join(WORLD_DIR, 'artifacts.json');
  if (!fs.existsSync(file)) { _artifactsCache = []; return _artifactsCache; }
  try { _artifactsCache = JSON.parse(fs.readFileSync(file, 'utf8')) ?? []; }
  catch (e) {
    console.warn(`[loot] artifacts.json load failed: ${e.message}`);
    _artifactsCache = [];
  }
  return _artifactsCache;
}

function loadMagicProperties() {
  if (_magicPropsCache !== null) return _magicPropsCache;
  const file = path.join(CONFIG_DIR, 'magic-properties.json');
  if (!fs.existsSync(file)) { _magicPropsCache = []; return _magicPropsCache; }
  try { _magicPropsCache = JSON.parse(fs.readFileSync(file, 'utf8')) ?? []; }
  catch (e) {
    console.warn(`[loot] magic-properties.json load failed: ${e.message}`);
    _magicPropsCache = [];
  }
  return _magicPropsCache;
}

export function allArtifacts() { return loadArtifacts(); }
export function allMagicProperties() { return loadMagicProperties(); }

/**
 * Pick a random artifact profile by weighted index. The extracted
 * artifacts file has no explicit weights — we treat each entry as
 * equally likely. Filter by `nameFilter` regex when caller wants a
 * thematic subset (e.g. /Bow|Crossbow/ for an archer drop).
 *
 * Returns the raw artifact entry (caller decides itemId via base type
 * lookup). Result has `_isArtifact = true` marker.
 */
// ---- Wave 13: artifact discovery broadcast hook -------------------
//
// Set by `main.js` (or any script) to a callback that takes the
// profile of a freshly-spawned unique artifact and announces it
// world-wide. Decoupled from this module so loot.js stays standalone
// (the unit tests don't have a working netstack).

let _onArtifactDiscovered = null;
export function setArtifactDiscoveryHook(fn) { _onArtifactDiscovered = fn; }

// ---- Artifact uniqueness tracking ---------------------------------
//
// A subset of UO artifacts are designated "one-per-shard" — once they
// drop, no further copy may spawn until the existing one is destroyed
// (or moved by an admin). ServUO tracks this through `IsArtifact` +
// `IsRandomItem` flags + an in-memory registry; we keep a parallel set
// of artifact NAMES that have already been spawned. Persistence is
// indirect: on world load, walk every item's `_artifact` field and
// re-populate the set, so a server restart doesn't reopen the gate.

const _spawnedArtifactNames = new Set();

export const artifactUniqueness = {
  /** Reset and rebuild from world state — call once after loadWorldSync. */
  rebuildFromWorld(world) {
    _spawnedArtifactNames.clear();
    if (!world?.items) return;
    for (const it of world.items.values()) {
      if (it._artifact) _spawnedArtifactNames.add(String(it._artifact));
    }
  },
  /** Mark a name as spawned. Caller normally goes through pickArtifact. */
  recordSpawn(name) { if (name) _spawnedArtifactNames.add(String(name)); },
  /** Forget a name (the item was destroyed). */
  release(name) { if (name) _spawnedArtifactNames.delete(String(name)); },
  has(name) { return _spawnedArtifactNames.has(String(name)); },
  size() { return _spawnedArtifactNames.size; },
  list() { return [..._spawnedArtifactNames].sort(); },
  clear() { _spawnedArtifactNames.clear(); },
};

// Wave 11: tier fallback chains. ServUO drops a low-tier artifact
// when its preferred tier is exhausted (e.g. shard hoarders sit on
// every TOTGreater drop). We model the same: when `unique:true` and
// the requested tier's eligible pool is empty, walk these chains.
const TIER_FALLBACKS = {
  greater:    ['lesser', 'equipment'],
  lesser:     ['equipment'],
  decorative: [],
  equipment:  [],
  despise:    ['lesser', 'equipment'],
  talisman:   [],
  tool:       [],
  consumable: [],
  // Stygian Abyss + Tokuno bins — populated by content/items/
  // sa-artifacts.js and tokuno-artifacts.js via registerItem.
  // Falls back to the generic 'lesser'/'equipment' pool if the
  // dedicated bin is empty.
  tokuno: ['lesser', 'equipment'],
  sa:     ['greater', 'lesser', 'equipment'],
};

// Wave 12: per-tier roll weight when a multi-tier pick spans more
// than one tier. Inside `pickArtifact({tier:['greater','lesser']})`
// each candidate is weighted by its tier — greater is rarer than
// lesser, both rarer than equipment. This bakes the boss-loot feel:
// a champion slot rolls 'lesser' most of the time but occasionally
// strikes 'greater'. ServUO Tokuno tier weighting follows the same
// 1:3:5 sketch.
const TIER_WEIGHTS = {
  greater:    1,
  lesser:     3,
  equipment:  5,
  despise:    2,
  decorative: 4,
  talisman:   3,
  tool:       3,
  consumable: 4,
};

function resolveTierChain(tier, fallback) {
  if (fallback === false) return Array.isArray(tier) ? tier : [tier];
  const root = Array.isArray(tier) ? tier : (tier ? [tier] : []);
  const seen = new Set(root);
  const chain = [...root];
  for (const t of root) {
    for (const next of TIER_FALLBACKS[t] ?? []) {
      if (!seen.has(next)) { seen.add(next); chain.push(next); }
    }
  }
  return chain;
}

/**
 * Pick an artifact profile.
 *
 * @param {() => number} [rng]
 * @param {RegExp|null}  [nameFilter]
 * @param {Object} [opts]
 * @param {boolean} [opts.unique]   skip names already present in
 *   `_spawnedArtifactNames` and record the chosen name on success.
 * @param {string|string[]} [opts.tier]   restrict to one or more tiers
 *   ('greater'|'lesser'|'equipment'|'decorative'|'despise'|'talisman'|
 *   'tool'|'consumable'). When omitted, every tier is eligible.
 * @param {boolean} [opts.fallback=true]  Wave 11: if the requested tier
 *   is exhausted (combined with `unique`), walk TIER_FALLBACKS to find
 *   a still-available next-best tier. Pass `false` to disable.
 */
export function pickArtifact(rng = Math.random, nameFilter = null,
                              { unique = false, tier, fallback = true } = {}) {
  const list = loadArtifacts();
  if (!list.length) return null;
  let pool0 = nameFilter ? list.filter((a) => nameFilter.test(a.name)) : list;
  // Wave 12: when `tier` is an array, two-stage weighted pick:
  //   stage 1: choose WHICH tier by TIER_WEIGHTS (greater 1, lesser 3,
  //            equipment 5 → greater is the rarest of these three)
  //   stage 2: uniform pick inside the chosen tier's eligible pool
  //
  // Per-entry weighting (the naive approach) collapses to "the tier
  // with most entries always wins" because `weight × poolSize` of
  // 'equipment' (5 × 502) dwarfs 'greater' (1 × 10). The two-stage
  // approach gives ~33% greater / ~50% lesser / ~17% equipment for
  // tier:['greater','lesser','equipment'] — closer to UO drop ratios.
  if (Array.isArray(tier) && tier.length > 1) {
    const buckets = new Map();
    for (const t of tier) buckets.set(t, []);
    for (const a of pool0) {
      const at = a.tier ?? 'equipment';
      if (buckets.has(at)) buckets.get(at).push(a);
    }
    if (unique) {
      for (const [t, arr] of buckets) {
        buckets.set(t, arr.filter((a) => !_spawnedArtifactNames.has(a.name)));
      }
    }
    // Drop empty tiers from the weighted choice.
    const tierEntries = [...buckets.entries()].filter(([, arr]) => arr.length > 0);
    if (tierEntries.length) {
      const weights = tierEntries.map(([t]) => TIER_WEIGHTS[t] ?? 1);
      const total = weights.reduce((s, w) => s + w, 0);
      let r = rng() * total;
      let bucketIdx = 0;
      for (; bucketIdx < weights.length - 1; bucketIdx++) {
        r -= weights[bucketIdx];
        if (r <= 0) break;
      }
      const arr = tierEntries[bucketIdx][1];
      const pick = arr[Math.floor(rng() * arr.length)];
      if (unique) _spawnedArtifactNames.add(pick.name);
      return pick;
    }
    // pool empty — fall through to single-tier chain logic via fallback
    if (!fallback) return null;
  }
  // Walk the tier chain — try the preferred tier first, then fall
  // back if (and only if) `fallback` is on AND `unique` exhausted it.
  const chain = tier ? resolveTierChain(tier, fallback) : [null];
  for (const t of chain) {
    let pool = pool0;
    if (t) pool = pool.filter((a) => (a.tier ?? 'equipment') === t);
    if (unique) pool = pool.filter((a) => !_spawnedArtifactNames.has(a.name));
    if (!pool.length) continue;
    const pick = pool[Math.floor(rng() * pool.length)];
    if (unique) _spawnedArtifactNames.add(pick.name);
    return pick;
  }
  return null;
}

/**
 * Roll a magic-item property bundle. Picks `count` distinct properties
 * from the table by weight and rolls each one's intensity scaled to
 * `budget` (0..1 normalised, default 0.5).
 *
 * Wave 9 balance pass:
 *   - intensity now respects a `budget` percentile so low-tier loot
 *     drops with `start..start+span*budget` while top-tier drops can
 *     reach `maxIntensity`. Without this every magic item came out
 *     mid-roll and rares felt indistinguishable from white drops.
 *   - boolean-flag attributes (`start === maxIntensity === 1`, e.g.
 *     BattleLust, BoneBreaker) bypass the scaling — they're either
 *     present or absent.
 *   - low-budget rolls clamp to start (`Math.ceil`) so cheap magic
 *     items don't accidentally roll +25 STR.
 *
 * @param {Object} opts
 * @param {number} [opts.count=3]      properties to roll
 * @param {string} [opts.group]        filter to this group (e.g. 'AosAttribute')
 * @param {number} [opts.budget=0.5]   intensity scaling 0..1
 * @param {() => number} [opts.rng]
 * @returns {Array<{ id, attribute, group, intensity, scale, cliloc, isFlag?:boolean }>}
 */
export function rollMagicProperties({
  count = 3, group, budget = 0.5, rng = Math.random,
} = {}) {
  const all = loadMagicProperties();
  if (!all.length) return [];
  const pool = group ? all.filter((p) => p.group === group) : all;
  if (!pool.length) return [];
  // Re-weight: low-budget rolls bias toward HIGH-weight (common) entries,
  // high-budget rolls flatten the curve so rare attribs become reachable.
  const adjustedWeights = pool.map((p) => {
    const base = p.weight || 1;
    // Budget 0 → square the weight (common only). Budget 1 → sqrt
    // (rare reachable). 0.5 → identity.
    const k = Math.max(0.25, Math.min(2, 2 * budget));
    return Math.max(1, Math.round(Math.pow(base, k)));
  });
  const totalWeight = adjustedWeights.reduce((s, w) => s + w, 0);
  const used = new Set();
  const out = [];
  // Cap retries so a small pool with collisions doesn't infinite-loop.
  for (let attempt = 0; attempt < count * 4 && out.length < count; attempt++) {
    let r = rng() * totalWeight;
    let pickIdx = 0;
    for (; pickIdx < pool.length; pickIdx++) {
      r -= adjustedWeights[pickIdx];
      if (r <= 0) break;
    }
    const pick = pool[Math.min(pickIdx, pool.length - 1)];
    if (used.has(pick.id)) continue;
    used.add(pick.id);
    // Boolean-flag attribute: present at intensity 1, never scaled.
    const isFlag = pick.start === 1 && pick.maxIntensity === 1;
    let intensity;
    if (isFlag) {
      intensity = 1;
    } else {
      // Scale by budget. The roll itself is uniform within
      // [start..effectiveMax], where effectiveMax tightens with low budget.
      const effectiveMax = Math.max(
        pick.start,
        Math.ceil(pick.start + (pick.maxIntensity - pick.start) * budget),
      );
      const span = Math.max(1, effectiveMax - pick.start + 1);
      intensity = pick.start + Math.floor(rng() * span);
    }
    out.push({
      id: pick.id,
      attribute: pick.attribute,
      group: pick.group,
      intensity,
      isFlag,
      scale: pick.scale ?? 1,
      cliloc: pick.cliloc,
    });
  }
  return out;
}

/**
 * @typedef {Object} LootEntry
 * @property {string}  [template]     item template name (e.g. 'gold')
 * @property {number}  [itemId]       raw graphic if no template
 * @property {number}  [hue]
 * @property {string}  [name]
 * @property {number|[number,number]} [amount]  literal or range
 * @property {number}  [chance]       0..1, default 1
 * @property {string}  [table]        compose another table by name
 */

/**
 * @typedef {Object} LootTable
 * @property {string}     name
 * @property {LootEntry[]} entries
 */

export class LootRegistry {
  constructor() {
    /** @type {Map<string, LootTable>} */
    this.tables = new Map();
  }

  /** @param {LootTable} table */
  register(table) {
    if (!table || typeof table.name !== 'string') throw new Error('loot table needs a name');
    if (!Array.isArray(table.entries)) throw new Error(`loot table ${table.name} needs entries[]`);
    this.tables.set(table.name, table);
  }

  unregister(name) { this.tables.delete(name); }
  get(name) { return this.tables.get(name); }
  names() { return [...this.tables.keys()].sort(); }

  /** Pure Monte-Carlo table preview. Never creates items or consumes uniques. */
  simulate(tableName, { trials = 10_000, rng = Math.random } = {}) {
    const count = Math.max(100, Math.min(100_000, trials | 0));
    if (!this.tables.has(tableName)) return { ok: false, error: `unknown loot table: ${tableName}` };
    const totals = new Map();
    const itemsPerRoll = new Map();
    const missingTables = new Set();
    const amountOf = (entry) => {
      if (Array.isArray(entry.amount)) {
        const lo = entry.amount[0] | 0, hi = entry.amount[1] | 0;
        return lo + Math.floor(rng() * (Math.max(lo, hi) - lo + 1));
      }
      return Math.max(1, entry.amount | 0 || 1);
    };
    const keyOf = (entry) => entry.template
      ? `template:${entry.template}`
      : entry.artifact ? `artifact:${entry.tier ?? entry.filter ?? 'any'}`
      : entry.magicItem ? `magic:${entry.magicItem.slot ?? entry.magicItem ?? 'any'}`
      : `item:0x${(entry.itemId | 0).toString(16)}`;
    const rollTable = (name, dropped, depth = 0) => {
      if (depth > 8) return;
      const table = this.tables.get(name);
      if (!table) { missingTables.add(name); return; }
      for (const entry of table.entries) {
        if (entry.chance !== undefined && rng() >= entry.chance) continue;
        if (entry.table) { rollTable(entry.table, dropped, depth + 1); continue; }
        const key = keyOf(entry); const amount = amountOf(entry);
        const stat = totals.get(key) ?? { key, rolls: 0, totalAmount: 0 };
        stat.rolls++; stat.totalAmount += amount; totals.set(key, stat); dropped.count++;
      }
    };
    for (let i = 0; i < count; i++) {
      const dropped = { count: 0 }; rollTable(tableName, dropped);
      itemsPerRoll.set(dropped.count, (itemsPerRoll.get(dropped.count) ?? 0) + 1);
    }
    return {
      ok: true, table: tableName, trials: count,
      drops: [...totals.values()].map((stat) => ({
        ...stat, dropRate: stat.rolls / count, averageAmountPerRoll: stat.totalAmount / count,
        averageStackWhenDropped: stat.totalAmount / stat.rolls,
      })).sort((a, b) => b.dropRate - a.dropRate),
      itemCountHistogram: [...itemsPerRoll].sort((a, b) => a[0] - b[0]).map(([items, rolls]) => ({ items, rolls, rate: rolls / count })),
      warnings: [...missingTables].map((name) => `Missing nested table: ${name}`),
    };
  }

  /**
   * Roll a named table into a container. Returns the list of created items.
   *
   * @param {import('./world.js').World} world
   * @param {import('./items.js').Item} container   target (must have a serial)
   * @param {string} tableName
   * @param {() => number} [rng]                    defaults to Math.random
   * @returns {import('./items.js').Item[]}
   */
  roll(world, container, tableName, rng = Math.random) {
    const out = [];
    this._rollInto(world, container, tableName, rng, out, 0);
    return out;
  }

  _rollInto(world, container, tableName, rng, out, depth) {
    if (depth > 8) throw new Error(`loot table recursion too deep near ${tableName}`);
    const t = this.tables.get(tableName);
    if (!t) return;
    for (const entry of t.entries) {
      if (entry.chance !== undefined && rng() >= entry.chance) continue;
      if (entry.table) {
        this._rollInto(world, container, entry.table, rng, out, depth + 1);
        continue;
      }
      // Wave 7 follow-up: artifact + magic-item entry types.
      if (entry.artifact) {
        const item = this._createArtifactItem(world, container, entry, rng);
        if (item) out.push(item);
        continue;
      }
      if (entry.magicItem) {
        const item = this._createMagicItem(world, container, entry, rng);
        if (item) out.push(item);
        continue;
      }
      const item = this._createEntryItem(world, container, entry, rng);
      if (item) out.push(item);
    }
  }

  /**
   * Spawn a random artifact. Entry shape:
   *   { artifact: true, chance?: number, filter?: string }
   *   filter is a regex on artifact.name (e.g. "Bow|Crossbow").
   *
   * The picked artifact profile is stamped onto the spawned item via
   * `_artifact` (string name) and `_magicProps` (skill bonuses + attrs).
   * The runtime tooltip / object-properties layer reads these to render
   * the artifact label.
   *
   * Falls back to template `entry.template` for the base graphic; if
   * absent we use itemId from the entry or 0x1F1C (a generic chest).
   */
  _createArtifactItem(world, container, entry, rng) {
    const filter = entry.filter ? new RegExp(entry.filter) : null;
    // Wave 8: `unique:true` on the entry asks for one-per-shard
    // semantics — pickArtifact will skip names already spawned in the
    // world and record the chosen name on success. With no eligible
    // candidates left, the roll silently no-ops (better than spawning
    // a duplicate the GMs would have to clean up).
    // Wave 10: `tier` filters by rarity tier ('greater'|'lesser'|...);
    // bosses pull from 'greater'+'lesser' pool, regular elites from
    // 'equipment', housing-rares from 'decorative'.
    // Wave 13: track the chosen tier (passed to discovery announcer).
    const profile = pickArtifact(rng, filter, {
      unique: !!entry.unique,
      tier: entry.tier,
    });
    // After spawning, fire the discovery hook for newsworthy drops
    // (greater + lesser uniques). The hook is set by main.js or a
    // script — we don't broadcast directly here to keep the loot
    // module decoupled from the netcode.
    if (profile && entry.unique && (profile.tier === 'greater' || profile.tier === 'lesser')) {
      try { _onArtifactDiscovered?.(profile); } catch (e) { console.warn('[loot] discovery hook threw', e); }
    }
    if (!profile) return null;
    const tmpl = entry.template ? getTemplate(entry.template) : null;
    // Wave 8: resolve artifact graphic via the type-name catalog.
    // Order: explicit entry override → template → resolve(profile.base)
    // → resolve(profile.name) → 0x1F1C sentinel.
    let itemId = entry.itemId ?? tmpl?.itemId;
    if (!Number.isFinite(itemId) && profile.base) {
      const r = resolveItemType(profile.base, { templateLookup: getTemplate });
      if (r) itemId = r.itemId;
    }
    if (!Number.isFinite(itemId)) {
      const r = resolveItemType(profile.name, { templateLookup: getTemplate });
      if (r) itemId = r.itemId;
    }
    if (!Number.isFinite(itemId)) itemId = 0x1F1C;
    const hue = entry.hue ?? 0;
    const item = createItem(world, {
      itemId, hue, amount: 1,
      name: profile.name,
      parent: container.serial,
      x: 0, y: 0, z: 0, map: container.map, movable: true,
    });
    if (item) {
      item._artifact = profile.name;
      item._magicProps = [
        ...(profile.skillBonuses ?? []).map((b) => ({ kind: 'skill', skill: b.skill, value: b.value })),
        ...Object.entries(profile.attributes ?? {}).map(([k, v]) => ({ kind: 'attr', attribute: k, intensity: v })),
        ...Object.entries(profile.weaponAttributes ?? {}).map(([k, v]) => ({ kind: 'weapon', attribute: k, intensity: v })),
        ...Object.entries(profile.armorAttributes ?? {}).map(([k, v]) => ({ kind: 'armor', attribute: k, intensity: v })),
      ];
      if (profile.resists) item._magicResists = profile.resists;
    }
    return item;
  }

  /**
   * Spawn a magic item with rolled affixes. Entry shape:
   *   { magicItem: { count?:3, group?:'AosAttribute', template?:string,
   *                  type?:string, slot?:'weapon'|'armor'|'jewelry' },
   *     chance?, hue?, amount? }
   *
   * Wave 10: when no template/type/itemId is given, randomise the base
   * graphic from a `slot`-keyed pool. Slot defaults to 'weapon'. UO
   * also commonly stamps a small chance of a faint magic hue.
   */
  _createMagicItem(world, container, entry, rng) {
    const cfg = entry.magicItem ?? {};
    const tmpl = cfg.template ? getTemplate(cfg.template) : null;
    let itemId = entry.itemId ?? tmpl?.itemId;
    /** @type {string | null} type name kept around for naming. */
    let baseTypeName = cfg.type ?? cfg.template ?? null;
    // Wave 8: type-name resolver fallback. Magic items often originate
    // from a ServUO type (e.g. magicItem.type:'CrossBow') rather than
    // an authored template.
    if (!Number.isFinite(itemId) && cfg.type) {
      const r = resolveItemType(cfg.type, { templateLookup: getTemplate });
      if (r) itemId = r.itemId;
    }
    // Wave 10: slot-keyed random base. Picks one type from a 6-deep
    // pool per slot using the type-name resolver so we don't need to
    // duplicate item ids. Result: a "magic weapon" drop on a champion
    // can come back as a katana, halberd, mace, scimitar, etc., not
    // always the same hardcoded heater shield.
    if (!Number.isFinite(itemId)) {
      const slot = cfg.slot ?? 'weapon';
      const pool = MAGIC_BASE_POOLS[slot] ?? MAGIC_BASE_POOLS.weapon;
      const pick = pool[Math.floor(rng() * pool.length)];
      baseTypeName = pick;
      const r = resolveItemType(pick, { templateLookup: getTemplate });
      if (r) itemId = r.itemId;
    }
    if (!Number.isFinite(itemId)) return null;
    const props = rollMagicProperties({
      count: cfg.count ?? 3,
      group: cfg.group,
      budget: cfg.budget ?? 0.5,
      rng,
    });
    // Wave 10: faint magic hue at ~25% (4 of 7 entries are 0).
    const rolledHue = entry.hue ?? MAGIC_HUE_ROLL[Math.floor(rng() * MAGIC_HUE_ROLL.length)];
    // Wave 11: pretty name from prefix/suffix word generation. Caller
    // can still force a literal `entry.name`.
    const generatedName = entry.name ?? describeMagicItem(props, cfg, baseTypeName);
    const item = createItem(world, {
      itemId, hue: rolledHue, amount: 1,
      name: generatedName,
      parent: container.serial,
      x: 0, y: 0, z: 0, map: container.map, movable: true,
    });
    if (item) {
      item._magicProps = props.map((p) => ({
        kind: 'attr',
        attribute: p.attribute, group: p.group,
        intensity: p.intensity, cliloc: p.cliloc,
        isFlag: !!p.isFlag,
      }));
      // Server parity #9 #4 — slayer affix roll on weapons. ServUO
      // `BaseRunicTool.GetRandomSlayer` ~5-10% per drop. Without this
      // the slayers system (3× multi on matching kind) was unused.
      // Limit to weapon-tagged drops to avoid armor "slaying" plate.
      const isWeapon = baseTypeName?.includes?.('sword')
        || baseTypeName?.includes?.('bow')
        || baseTypeName?.includes?.('axe')
        || baseTypeName?.includes?.('mace')
        || baseTypeName?.includes?.('dagger')
        || baseTypeName?.includes?.('spear')
        || (cfg.tier === 'artifact');
      if (isWeapon && rng() < 0.06) {
        const tags = ['silver', 'repond', 'fey', 'dragon', 'daemon', 'arachnid', 'reptile'];
        item.slayer = tags[Math.floor(rng() * tags.length)];
      }
      // Wave 12: spawn-with-unidentified flag. Players must run
      // ItemIdentification (skill 4) — `[identify <serial>` — to
      // reveal the property list. ServUO follows the same convention
      // for AOS magic items. `entry.identified === true` overrides
      // (used for vendor-bought magic items, GM tools, etc).
      item._unidentified = entry.identified !== true;
    }
    return item;
  }

  /**
   * RandomItemGenerator — port of ServUO `Services/LootGeneration/`.
   * Wraps roll() with difficulty + slayer-affinity scaling.
   *
   * opts:
   *   difficulty: 0..1 (0 = wildlife, 1 = peerless boss). Default 0.
   *               Scales gold drop ×(1+2*diff) and magic-item budget +0.5*diff.
   *   creatureKind: optional string ('dragon'|'orc'|...) — boosts slayer
   *                 affix chance on dropped weapons to the matching tag.
   *   bonusMagic: extra magic-item rolls to inject post-table.
   *   bonusArtifactChance: extra chance to spawn one artifact entry.
   */
  rollScaled(world, container, tableName, opts = {}, rng = Math.random) {
    const out = [];
    const difficulty = Math.max(0, Math.min(1, opts.difficulty ?? 0));
    const goldScalar = 1 + 2 * difficulty;
    const magicBudgetBonus = 0.5 * difficulty;
    // Patch entries before recursion: we walk the table once with a
    // shallow rewrite that clones gold/magic entries with scaled values.
    const t = this.tables.get(tableName);
    if (!t) return out;
    const scaled = { ...t, entries: t.entries.map((e) => {
      if (e.itemId === 0x0EED && typeof e.min === 'number' && typeof e.max === 'number') {
        return { ...e,
          min: Math.round(e.min * goldScalar),
          max: Math.round(e.max * goldScalar) };
      }
      if (e.magicItem) {
        const cfg = e.magicItem;
        return { ...e, magicItem: { ...cfg,
          budget: Math.min(1, (cfg.budget ?? 0.5) + magicBudgetBonus),
          count: Math.min(5, (cfg.count ?? 3) + Math.floor(difficulty * 2)) } };
      }
      return e;
    }) };
    // Inject extra bonus rolls.
    if (opts.bonusMagic) {
      for (let i = 0; i < opts.bonusMagic; i++) {
        scaled.entries.push({ chance: 1, magicItem: {
          slot: ['weapon','armor','jewelry'][Math.floor(rng()*3)],
          count: 3 + Math.floor(difficulty * 2),
          budget: Math.min(1, 0.5 + magicBudgetBonus),
        } });
      }
    }
    if (opts.bonusArtifactChance) {
      scaled.entries.push({ chance: opts.bonusArtifactChance, artifact: true,
        tier: difficulty > 0.85 ? ['greater','lesser'] : 'lesser' });
    }
    // Temporary register so _rollInto can recurse normally.
    const origName = `${tableName}::__scaled${(Math.random()*1e9)|0}`;
    this.tables.set(origName, { ...scaled, name: origName });
    try {
      this._rollInto(world, container, origName, rng, out, 0);
    } finally {
      this.tables.delete(origName);
    }
    // Slayer-kind affinity: if creatureKind given, retag rolled weapons
    // so the matching slayer family doubles in frequency.
    if (opts.creatureKind) {
      const kindToSlayer = {
        dragon: 'dragon', daemon: 'daemon', orc: 'repond', ogre: 'repond',
        troll: 'repond', undead: 'silver', spider: 'arachnid',
        scorpion: 'arachnid', snake: 'reptile', lizard: 'reptile',
        elemental: 'elemental', fey: 'fey',
      };
      const tag = kindToSlayer[opts.creatureKind];
      if (tag) {
        for (const it of out) {
          if (!it._magicProps) continue;
          // Re-roll slayer at higher chance for matching kind drops.
          if (!it.slayer && rng() < 0.25) it.slayer = tag;
        }
      }
    }
    return out;
  }

  _createEntryItem(world, container, entry, rng) {
    let amount = 1;
    if (Array.isArray(entry.amount)) {
      const [lo, hi] = entry.amount;
      amount = lo + Math.floor(rng() * Math.max(1, hi - lo + 1));
    } else if (typeof entry.amount === 'number') {
      amount = entry.amount;
    }
    if (amount <= 0) return null;

    let itemId = entry.itemId;
    let hue = entry.hue ?? 0;
    let name = entry.name;
    let templateData = {};
    if (entry.template) {
      const tmpl = getTemplate(entry.template);
      if (tmpl) {
        itemId = itemId ?? tmpl.itemId;
        if (entry.hue === undefined && tmpl.hue !== undefined) hue = tmpl.hue;
        if (!name && tmpl.label) name = tmpl.label;
        // A loot roll must preserve the gameplay identity, not just the art.
        // Otherwise two fragments sharing scroll art lose their unlock payload
        // and become inert after dropping from a creature.
        templateData = {
          definitionId: tmpl.definitionId,
          script: tmpl.script,
          kind: tmpl.kind,
          category: tmpl.category,
          stackable: tmpl.stackable,
          weight: tmpl.weight,
          spellcraftUnlock: tmpl.spellcraftUnlock,
          spellcraftXp: tmpl.spellcraftXp,
        };
      }
    }
    if (!Number.isFinite(itemId)) return null;
    return createItem(world, {
      ...templateData,
      itemId,
      hue,
      amount,
      name,
      parent: container.serial,
      x: 0, y: 0, z: 0,
      map: container.map,
      movable: true,
    });
  }
}
