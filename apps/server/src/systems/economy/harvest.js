// Harvest system — Mining + Lumberjacking + Fishing.
//
// Mirrors ServUO `Engines/Harvest/` (Definition + Vein + Bank + System).
// Each harvest definition declares:
//   • required tool (pickaxe / shovel / axe / fishing-pole)
//   • required skill + difficulty per resource tier
//   • base resource (stone slab, log, fish) and rare/special drop tables
//
// Resources are bucketed into "veins" — a vein is a specific tile
// coordinate with a finite resource pool. Once depleted, the vein
// regrows after a cooldown. This avoids the simpler "infinite per swing"
// model that dilutes resource value.
//
// API:
//   harvest.tryMining(mob, x, y, map)        → { ok, resource, amount, message }
//   harvest.tryLumberjacking(mob, x, y, map) → { ok, resource, amount, message }
//   harvest.tryFishing(mob, x, y, map)       → { ok, resource, amount, message }
//
// Resource ids are item-template strings — caller (use-tool handler) maps
// them to proper Item descriptors via `templates.itemFromKind(resource)`.

const SKILL_MINING        = 46;
const SKILL_LUMBERJACKING = 45;
const SKILL_FISHING       = 19;

// === MINING ============================================================

const MINING_ORE_TABLE = [
  // tier weight / skill required / resource id / colored bonus chance
  { skill:   0, weight: 50, resource: 'iron-ore',         colorChance: 0    },
  { skill:  65, weight: 22, resource: 'dull-copper-ore',  colorChance: 0.10 },
  { skill:  70, weight: 12, resource: 'shadow-iron-ore',  colorChance: 0.10 },
  { skill:  75, weight:  8, resource: 'copper-ore',       colorChance: 0.10 },
  { skill:  80, weight:  4, resource: 'bronze-ore',       colorChance: 0.10 },
  { skill:  85, weight:  2, resource: 'gold-ore',         colorChance: 0.10 },
  { skill:  90, weight:  1, resource: 'agapite-ore',      colorChance: 0.10 },
  { skill:  95, weight:  1, resource: 'verite-ore',       colorChance: 0.10 },
  { skill: 100, weight:  1, resource: 'valorite-ore',     colorChance: 0.10 },
];

const MINING_GEM_CHANCE = 0.05;
const MINING_GEMS = ['amethyst', 'citrine', 'diamond', 'emerald',
                     'ruby', 'sapphire', 'star-sapphire', 'tourmaline'];

function pickResourceTier(table, skill, rng) {
  const eligible = table.filter((t) => t.skill <= skill);
  const total = eligible.reduce((s, t) => s + t.weight, 0);
  let r = rng() * total;
  for (const t of eligible) { r -= t.weight; if (r <= 0) return t; }
  return eligible[0];
}

// Region-specific mining bonuses (ServUO `OreInfo` + region-mul lookup).
// Tile must overlap any of these region names to trigger. Caller passes
// `deps.regionName` from the per-mob region tracker. Bug-hunt #4 B5.
const MINING_REGION_BONUSES = {
  'Argent Mine':       { mul: 1.30, tierBoost: 0 },     // Shame surface — 30 % extra ore
  'Wrong Mine':        { mul: 1.20, tierBoost: 1 },     // Wrong — boosted tier (+1)
  'Hythloth Mine':     { mul: 1.20, tierBoost: 1 },     // Hythloth lava forge
  'Destard Mine':      { mul: 1.10, tierBoost: 1 },     // Destard reptile caves
  'Khaldun Mine':      { mul: 1.40, tierBoost: 0 },     // Khaldun crypt — biggest mul
};

export function tryMining(mob, x, y, map, deps = {}) {
  const sk = deps.effectiveSkill?.(mob, SKILL_MINING) ?? 0;
  if (sk < 1) return { ok: false, reason: 'no-skill', message: 'You have no idea how to mine.' };
  const rng = deps.rng ?? Math.random;
  // Region bonus lookup — caller passes `deps.regionName` if a region
  // tracker resolved one. Falls back to no-bonus path.
  const bonus = MINING_REGION_BONUSES[deps.regionName ?? ''] ?? null;
  const effectiveSkill = sk + (bonus?.tierBoost ?? 0) * 100;
  const tier = pickResourceTier(MINING_ORE_TABLE, effectiveSkill, rng);
  if (!tier) return { ok: false, reason: 'depleted', message: 'You find no ore here.' };

  // Skill-check: simple linear chance based on (skill - tier.skill) / 50.
  const chance = Math.min(0.95, Math.max(0.05, 0.20 + (sk - tier.skill) / 100));
  if (rng() > chance) {
    return { ok: false, reason: 'failed', message: 'You fail to find any ore worth keeping.' };
  }

  let amount = 1 + Math.floor(rng() * 3);
  if (bonus?.mul) amount = Math.max(1, Math.floor(amount * bonus.mul));
  const drops = [{ resource: tier.resource, amount }];

  if (rng() < MINING_GEM_CHANCE) {
    drops.push({ resource: MINING_GEMS[Math.floor(rng() * MINING_GEMS.length)], amount: 1 });
  }

  // Skill-gain hook for caller — they can roll tryGain themselves.
  return {
    ok: true,
    resource: tier.resource,
    amount,
    drops,
    skillId: SKILL_MINING,
    difficulty: tier.skill + 30,
    message: `You dig some ${tier.resource.replace(/-/g, ' ')}.`,
  };
}

// === LUMBERJACKING =====================================================

const LUMBER_LOG_TABLE = [
  { skill:   0, weight: 50, resource: 'log' },
  { skill:  65, weight: 18, resource: 'oak-log' },
  { skill:  80, weight:  8, resource: 'ash-log' },
  { skill:  90, weight:  6, resource: 'yew-log' },
  { skill: 100, weight:  4, resource: 'heartwood-log' },
  { skill: 100, weight:  2, resource: 'bloodwood-log' },
  { skill: 100, weight:  2, resource: 'frostwood-log' },
];

export function tryLumberjacking(mob, x, y, map, deps = {}) {
  const sk = deps.effectiveSkill?.(mob, SKILL_LUMBERJACKING) ?? 0;
  if (sk < 1) return { ok: false, reason: 'no-skill', message: 'You have no idea how to chop trees.' };
  const rng = deps.rng ?? Math.random;
  const tier = pickResourceTier(LUMBER_LOG_TABLE, sk, rng);
  if (!tier) return { ok: false, reason: 'depleted', message: 'No tree responds to your axe.' };

  const chance = Math.min(0.95, Math.max(0.05, 0.25 + (sk - tier.skill) / 100));
  if (rng() > chance) {
    return { ok: false, reason: 'failed', message: 'You hack at the tree but get nothing useful.' };
  }

  const amount = 1 + Math.floor(rng() * 4);
  const drops = [{ resource: tier.resource, amount }];

  // Server parity #8 #9 — Heartwood "special-harvest" bonus chain.
  // ServUO `Skills/Lumberjacking/Bonus/HeartwoodReward.cs`: when
  // chopping Heartwood/Bloodwood/Frostwood, 10% chance to also receive
  // a Heartwood Reward Bag (placeholder item — content/items can
  // override the visual). The bag itemId carries a randomised special
  // attribute when consumed; we attach it as `_heartwoodAttr` so the
  // open hook can apply Brittle/Antique/Etched/Resonant.
  if ((tier.resource === 'heartwood-log'
      || tier.resource === 'bloodwood-log'
      || tier.resource === 'frostwood-log') && rng() < 0.10) {
    const attrs = ['Brittle', 'Antique', 'Etched', 'Resonant', 'Auspicious'];
    drops.push({
      resource: 'heartwood-reward-bag',
      amount: 1,
      _heartwoodAttr: attrs[Math.floor(rng() * attrs.length)],
    });
  }

  return {
    ok: true,
    resource: tier.resource,
    amount,
    drops,
    skillId: SKILL_LUMBERJACKING,
    difficulty: tier.skill + 30,
    message: `You chop some ${tier.resource.replace(/-/g, ' ')}.`,
  };
}

// === FISHING ===========================================================

const FISH_TABLE = [
  { skill:  0, weight: 60, resource: 'fish' },
  { skill: 50, weight: 25, resource: 'big-fish' },
  { skill: 70, weight: 10, resource: 'rare-fish' },
  { skill: 90, weight:  4, resource: 'pearl-shell' },
  { skill:100, weight:  1, resource: 'sea-serpent-corpse' },  // triggers SeaSerpent encounter
];

const FISHING_MIB_CHANCE   = 0.005;     // Mostly Indecipherable Bottle
const FISHING_TRASH_CHANCE = 0.10;      // boots, tattered cloth

export function tryFishing(mob, x, y, map, deps = {}) {
  const sk = deps.effectiveSkill?.(mob, SKILL_FISHING) ?? 0;
  if (sk < 1) return { ok: false, reason: 'no-skill', message: 'You have no idea how to fish.' };
  const rng = deps.rng ?? Math.random;

  // Tile must be water — caller passes deps.tileKind('water', x, y, map).
  if (deps.tileKind && !deps.tileKind('water', x, y, map)) {
    return { ok: false, reason: 'no-water', message: 'You can fish only on water.' };
  }

  // 10% chance to drop trash regardless of skill.
  if (rng() < FISHING_TRASH_CHANCE) {
    const trash = ['old-boots', 'tattered-cloth', 'rusty-can', 'broken-bottle'][Math.floor(rng() * 4)];
    return {
      ok: true, resource: trash, amount: 1,
      drops: [{ resource: trash, amount: 1 }],
      skillId: SKILL_FISHING, difficulty: 0,
      message: `Your line snags some trash.`,
    };
  }

  // Rare MIB — Mostly Indecipherable Bottle (decoded via Cartography → SOS).
  // Bug-hunt server-parity #8 #5: was hardcoded (0,0,1) so every decoded
  // SOS pointed to Trammel origin. ServUO `MessageInABottle.cs::OnCreated`
  // rolls a random water tile on the caster's facet. We approximate by
  // randomising a coordinate in the catch facet's ocean rectangle —
  // higher-skill anglers get a deeper SOS (level scales with skill).
  if (rng() < FISHING_MIB_CHANCE) {
    const facet = map ?? 1;
    // Sosaria ocean spans roughly (0..5119, 0..4095). Land-collision is
    // the responsibility of the decode step; for now we ensure non-zero
    // coords that point into water for facets 0/1/3 (Trammel/Felucca/Ilshenar).
    const mx = 100 + Math.floor(rng() * 4900);
    const my = 100 + Math.floor(rng() * 3900);
    const level = sk >= 80 ? 4 : sk >= 50 ? 3 : sk >= 20 ? 2 : 1;
    return {
      ok: true, resource: 'message-in-bottle', amount: 1,
      drops: [{ resource: 'message-in-bottle', amount: 1, mib: { x: mx, y: my, map: facet, level } }],
      skillId: SKILL_FISHING, difficulty: 95,
      message: `Within your nets, you find a strange bottle.`,
    };
  }

  const tier = pickResourceTier(FISH_TABLE, sk, rng);
  if (!tier) return { ok: false, reason: 'failed', message: 'You catch nothing.' };

  const chance = Math.min(0.95, Math.max(0.10, 0.30 + (sk - tier.skill) / 100));
  if (rng() > chance) return { ok: false, reason: 'failed', message: 'Nothing bites your hook.' };

  if (tier.resource === 'sea-serpent-corpse') {
    // Caller spawns a SeaSerpent encounter in `deps.spawnSeaSerpent(mob, x, y, map)`.
    deps.spawnSeaSerpent?.(mob, x, y, map);
    return { ok: false, reason: 'encounter', message: 'A sea serpent rises from the water!' };
  }

  const amount = 1 + Math.floor(rng() * 2);
  return {
    ok: true, resource: tier.resource, amount,
    drops: [{ resource: tier.resource, amount }],
    skillId: SKILL_FISHING, difficulty: tier.skill + 20,
    message: `You catch some ${tier.resource.replace(/-/g, ' ')}.`,
  };
}

// Vein registry — track depleted tiles so consecutive swings on the same
// spot eventually return nothing until cooldown expires.
const _veinPools = new Map(); // key = `${map}|${x}|${y}|${kind}`
const VEIN_CAPACITY = 12;
const VEIN_REGEN_MS = 5 * 60 * 1000;

function _veinKey(kind, map, x, y) { return `${map}|${x}|${y}|${kind}`; }

export function consumeVein(kind, map, x, y, now = Date.now()) {
  const key = _veinKey(kind, map, x, y);
  let v = _veinPools.get(key);
  if (!v || (v.depletedAt && now - v.depletedAt > VEIN_REGEN_MS)) {
    v = { remaining: VEIN_CAPACITY, depletedAt: 0 };
    _veinPools.set(key, v);
  }
  if (v.remaining <= 0) return false;
  v.remaining--;
  if (v.remaining === 0) v.depletedAt = now;
  return true;
}

export function isVeinDepleted(kind, map, x, y, now = Date.now()) {
  const key = _veinKey(kind, map, x, y);
  const v = _veinPools.get(key);
  if (!v) return false;
  if (v.remaining > 0) return false;
  return now - v.depletedAt < VEIN_REGEN_MS;
}

export const HARVEST_CONST = Object.freeze({
  SKILL_MINING, SKILL_LUMBERJACKING, SKILL_FISHING,
  MINING_ORE_TABLE, LUMBER_LOG_TABLE, FISH_TABLE, MINING_GEMS,
});
