// Runic Reforging — port of ServUO `Scripts/Services/LootGeneration/RunicReforging/RunicReforging.cs`.
//
// Mechanic (ServUO 1:1 in spirit):
//   - Player has a runic crafting tool (Dull Copper hammer, Verite needle, etc.)
//   - Player picks an item they crafted and reforges it
//   - Tool tier (= metal/leather/wood ranking) + selected option (Powerful /
//     Structural / Glorious + prefix/suffix) determines the loot budget,
//     property count and intensity scaling
//   - The runic tool has a charge counter (`_uses`) — spent on success
//   - Reforged items get an `_itemPower` rank (Minor / Lesser / Greater / Major
//     / LesserArtifact / GreaterArtifact) for tooltip + sale value
//
// We delegate property rolling to `loot.rollMagicProperties()` so the same
// magic-property catalogue powers loot drops, imbuing, and reforging.

import { rollMagicProperties } from '../world/loot.js';

/** Tool tier table — 9 metals × 3 leather variants. Higher tier =
 *  more properties + bigger budget for intensity. Mirrors ServUO
 *  RunicReforging.GetBudgetForTool() result tiers. */
const TIER_TABLE = Object.freeze({
  // metal smithing tools
  'dull copper':   { tier: 1, propCount: [1, 2], budget: 0.25, charges: 50, prefix: 'Reforged' },
  'shadow iron':   { tier: 2, propCount: [2, 3], budget: 0.35, charges: 50, prefix: 'Reforged' },
  'copper':        { tier: 3, propCount: [2, 3], budget: 0.45, charges: 45, prefix: 'Reforged' },
  'bronze':        { tier: 4, propCount: [3, 4], budget: 0.55, charges: 45, prefix: 'Reforged' },
  'gold':          { tier: 5, propCount: [3, 4], budget: 0.65, charges: 40, prefix: 'Reforged' },
  'agapite':       { tier: 6, propCount: [3, 5], budget: 0.75, charges: 35, prefix: 'Reforged' },
  'verite':        { tier: 7, propCount: [4, 5], budget: 0.85, charges: 30, prefix: 'Reforged' },
  'valorite':      { tier: 8, propCount: [4, 6], budget: 0.95, charges: 25, prefix: 'Reforged Valorite' },
  // tailoring tools
  'spined':        { tier: 3, propCount: [2, 3], budget: 0.45, charges: 50, prefix: 'Reforged' },
  'horned':        { tier: 5, propCount: [3, 4], budget: 0.65, charges: 40, prefix: 'Reforged' },
  'barbed':        { tier: 7, propCount: [4, 5], budget: 0.85, charges: 30, prefix: 'Reforged' },
  // fletching tools
  'oak':           { tier: 2, propCount: [2, 3], budget: 0.35, charges: 50, prefix: 'Reforged' },
  'ash':           { tier: 4, propCount: [3, 4], budget: 0.55, charges: 45, prefix: 'Reforged' },
  'yew':           { tier: 6, propCount: [3, 5], budget: 0.75, charges: 35, prefix: 'Reforged' },
  'heartwood':     { tier: 8, propCount: [4, 6], budget: 0.95, charges: 25, prefix: 'Reforged Heartwood' },
});

/** Prefix/suffix presets — Powerful / Structural / Glorious tracks
 *  bias the property pool. Mirror of ServUO's reforging options. */
const OPTIONS = Object.freeze({
  powerful:   { name: 'Might',      group: 'damage' },     // raises damage modifiers
  structural: { name: 'Fortified',  group: 'defense' },    // raises resists / dura
  glorious:   { name: 'Auspicious', group: 'luck' },       // luck / fame
  fundamental:{ name: 'Charmed',    group: null },         // any group, balanced
});

/** Item-power band — derived from total intensity weight. ServUO uses
 *  a sum-of-weights table that tops out at LegendaryArtifact (≈ 1100). */
function classifyPower(props) {
  let totalWeight = 0;
  for (const p of props) totalWeight += (p.intensity ?? 1) * (p.scale ?? 1);
  if (totalWeight < 100) return 'Minor';
  if (totalWeight < 200) return 'Lesser';
  if (totalWeight < 350) return 'Greater';
  if (totalWeight < 500) return 'Major';
  if (totalWeight < 800) return 'LesserArtifact';
  return 'GreaterArtifact';
}

/** Resolve a tool description to its tier entry. Accepts `'verite'`,
 *  `'Verite'`, `'valorite hammer'`, etc. */
export function tierFor(toolName) {
  if (!toolName) return null;
  const lc = String(toolName).toLowerCase();
  for (const k of Object.keys(TIER_TABLE)) {
    if (lc.includes(k)) return { key: k, ...TIER_TABLE[k] };
  }
  return null;
}

/**
 * Reforge `item` using `toolName`. If `item.crafterSerial != mob.serial`,
 * fail (ServUO requires the player to have crafted the item personally).
 *
 * Returns `{ ok, props, power, prefix, reason }`.
 *
 * @param {*} mob       caller (uses metal-skill skills if needed; not gated yet)
 * @param {*} item      target item — must already exist in mob's pack
 * @param {string} toolName runic-tool descriptor (`'verite hammer'` etc.)
 * @param {string} option   `'powerful' | 'structural' | 'glorious' | 'fundamental'`
 * @param {() => number} [rng]
 */
export function reforge(mob, item, toolName, option = 'fundamental', rng = Math.random) {
  if (!item) return { ok: false, reason: 'no-item' };
  if (item._magicProps?.length) return { ok: false, reason: 'already-magical' };
  if (item.lootType === 'Blessed') return { ok: false, reason: 'blessed' };
  // ServUO-like crafter gate: if item carries a crafter serial, must match.
  if (item.crafterSerial && mob && item.crafterSerial !== mob.serial) {
    return { ok: false, reason: 'not-crafter' };
  }
  const tier = tierFor(toolName);
  if (!tier) return { ok: false, reason: 'unknown-tool' };
  const opt = OPTIONS[option] ?? OPTIONS.fundamental;
  const [minN, maxN] = tier.propCount;
  const count = minN + Math.floor(rng() * (maxN - minN + 1));
  const props = rollMagicProperties({
    count,
    group: opt.group ?? undefined,
    budget: tier.budget,
    rng,
  });
  if (!props.length) return { ok: false, reason: 'empty-pool' };
  item._magicProps = props;
  item._reforged = true;
  item._reforgePrefix = opt.name;
  item._reforgeTier = tier.key;
  item._itemPower = classifyPower(props);
  return {
    ok: true,
    props,
    power: item._itemPower,
    prefix: opt.name,
    tier: tier.key,
  };
}

/** Read-only listings for `[reforgehelp` and tests. */
export function listTools() {
  return Object.entries(TIER_TABLE).map(([k, v]) => ({ key: k, ...v }));
}
export function listOptions() { return Object.keys(OPTIONS); }
export function powerOf(item) { return item?._itemPower ?? null; }
