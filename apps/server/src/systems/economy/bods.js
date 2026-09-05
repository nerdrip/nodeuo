import { setItemParent, destroyItem as destroyWorldItem } from '../../world/items.js';

// PHASE BU — Bulk Order Deeds (BODs).
//
// ServUO reference: Scripts/Engines/BulkOrders/SmallBOD.cs +
// LargeBODGump.cs. We implement Small BODs only for MVP — Large BODs
// (combine N small ones for premium reward) come once Small ones are
// played in.
//
// BOD shape (`item.bod`):
//   {
//     skill:       number,   // skill id (1..58)
//     itemId:      number,   // target output art id
//     quantity:    number,   // total to craft (10 / 15 / 20)
//     progress:    number,   // count delivered so far (0..quantity)
//     exceptional: boolean,  // requires exceptional quality
//     material:    string,   // 'iron'|'dull copper'|... (regular = 'iron')
//     reward:      string,   // brief reward description
//   }
//
// Two tiny APIs:
//   `makeRandomBOD(skillId)` — fresh deed with skill-appropriate target
//   `recordCraftForBods(world, crafter, recipe, exceptional)` — advance
//                                                                progress on every
//                                                                matching deed
// in the crafter's backpack. Called from the craft pipeline.
//
// The lifecycle script (apps/scripts/src/items/bulk-order-deeds.js)
// drives onUse (show progress) and onPickUp (system-message).

/** @typedef {{skill:number,itemId:number,quantity:number,progress:number,exceptional:boolean,material:string,reward:string}} BulkOrder */

const QUANTITIES = [10, 15, 20];
const MATERIALS  = ['iron', 'dull copper', 'shadow iron', 'copper', 'bronze', 'gold', 'agapite', 'verite', 'valorite'];

function destroyBodItem(world, serial, deps = {}) {
  const fn = typeof deps.destroyItem === 'function' ? deps.destroyItem : destroyWorldItem;
  try { fn(world, serial); }
  catch { /* already gone */ }
}

/**
 * Skill → list of plausible target art ids (subset of the smithing /
 * tailoring catalogues). Trimmed to the entries we actually have in
 * `apps/server/src/systems/crafting/blacksmithing.js` etc., so a deed
 * always references something a player can craft.
 */
const SKILL_TARGETS = {
  // Blacksmithy (8)
  8: [
    { itemId: 0x0F51, label: 'Dagger' },
    { itemId: 0x0F61, label: 'Longsword' },
    { itemId: 0x143B, label: 'Maul' },
    { itemId: 0x140A, label: 'Helmet' },
    { itemId: 0x1415, label: 'Plate Chest' },
    { itemId: 0x1411, label: 'Plate Legs' },
    { itemId: 0x13EE, label: 'Ring Arms' },
  ],
  // Tailoring (35)
  35: [
    { itemId: 0x153D, label: 'Skirt' },
    { itemId: 0x1517, label: 'Shirt' },
    { itemId: 0x1F03, label: 'Robe' },
    { itemId: 0x152C, label: 'Cloak' },
  ],
};

/**
 * Pick a random integer in [0, n).
 */
function ri(n) { return Math.floor(Math.random() * n); }

/**
 * Generate a fresh BOD for `skillId`. Returns null when the skill has
 * no target catalogue (callers should fall back to another skill or
 * skip the offer).
 *
 * @param {number} skillId
 * @returns {BulkOrder | null}
 */
export function makeRandomBOD(skillId) {
  const catalog = SKILL_TARGETS[skillId];
  if (!catalog || catalog.length === 0) return null;
  const target = catalog[ri(catalog.length)];
  const quantity = QUANTITIES[ri(QUANTITIES.length)];
  // 25% chance the deed asks for an exceptional run.
  const exceptional = Math.random() < 0.25;
  // 60% iron, 40% chance of a colour material from the chain.
  const material = Math.random() < 0.6 ? 'iron' : MATERIALS[1 + ri(MATERIALS.length - 1)];
  const reward = makeRewardLabel(quantity, exceptional, material);
  return {
    skill: skillId,
    itemId: target.itemId,
    quantity,
    progress: 0,
    exceptional,
    material,
    reward,
    label: `${quantity} ${exceptional ? 'exceptional ' : ''}${target.label}` +
           (material !== 'iron' ? ` (${material})` : ''),
  };
}

function makeRewardLabel(quantity, exceptional, material) {
  let pts = quantity;
  if (exceptional) pts *= 2;
  if (material !== 'iron') pts *= 2;
  if (pts >= 60) return 'Gold + recipe scroll';
  if (pts >= 40) return 'Gold pile';
  return 'Small gold reward';
}

/**
 * Update every BOD in `crafter`'s backpack that matches `recipe`'s
 * output. Caller is expected to know whether the craft was exceptional;
 * we honour the BOD's own `exceptional` and `material` constraints.
 *
 * BUGFIX #73 (PHASE DE): the previous implementation ignored
 * `bod.material`, so a deed asking for "20 valorite plate chest"
 * advanced on plain iron crafts. That trivialised every coloured-
 * material BoD and let players farm valorite-tier rewards with bulk
 * iron ingots.
 *
 * @param {*} world
 * @param {*} crafter
 * @param {{outputItemId:number, skillId:number, material?:string}} recipe
 * @param {boolean} exceptional
 * @returns {number}  number of BODs that advanced (0+)
 */
export function recordCraftForBods(world, crafter, recipe, exceptional) {
  if (!world?.items || !crafter) return 0;
  const recipeMaterial = recipe.material ?? 'iron';
  let advanced = 0;
  // Walk pack via reverse parent index — typical pack has ~30 items;
  // saves the 110k full walk on each successful craft.
  const idx = world._childrenByParent?.get?.(crafter.serial);
  const iter = idx
    ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === crafter.serial);
  for (const it of iter) {
    if (!it.parent || it.parent !== crafter.serial) continue;
    const bod = it.bod;
    if (!bod) continue;
    if (bod.skill !== recipe.skillId) continue;
    if (bod.itemId !== recipe.outputItemId) continue;
    if (bod.exceptional && !exceptional) continue;
    if ((bod.material ?? 'iron') !== recipeMaterial) continue;
    if (bod.progress >= bod.quantity) continue;
    bod.progress += 1;
    advanced += 1;
    if (bod.progress >= bod.quantity) {
      crafter.client?.sendSystemMessage?.(
        `Bulk order complete: ${bod.label}. Reward: ${bod.reward}.`,
      );
      tryAdvanceLargeBod(world, crafter, it);
    }
  }
  return advanced;
}

/**
 * PHASE DE — Large BODs.
 *
 * A large BOD bundles 4-6 small BODs of related items (e.g. a "Plate
 * Mail Set" needs Helm + Chest + Legs + Ring Arms small BODs). The
 * large deed lives in the player's pack and tracks `slots[]` — each
 * slot points to a child small-BOD `serial`. When a child completes
 * we mark its slot done; when every slot is done the large BOD itself
 * fills out its reward.
 *
 * Large BOD shape (`item.bod`):
 *   {
 *     large: true,
 *     skill: number,
 *     label: string,
 *     slots: [
 *       { itemId: number, label: string, smallBodSerial: number|null,
 *         done: boolean },
 *       ...
 *     ],
 *     material: string,
 *     exceptional: boolean,
 *     reward: string,
 *   }
 *
 * The large deed is created via `makeLargeBOD(skillId, kind)` where
 * `kind` is one of LARGE_BOD_RECIPES. Players bind their existing
 * small deeds via `bindSmallToLarge(largeBod, smallItem)`.
 */

const LARGE_BOD_RECIPES = {
  // Blacksmithy (8) — plate-mail set
  'plate-set': {
    skill: 8,
    label: 'Plate Mail Set',
    slots: [
      { itemId: 0x140A, label: 'Helmet' },
      { itemId: 0x1415, label: 'Plate Chest' },
      { itemId: 0x1411, label: 'Plate Legs' },
      { itemId: 0x13EE, label: 'Ring Arms' },
    ],
    reward: 'Runic hammer (gold or higher)',
  },
  // Blacksmithy (8) — weapons assortment
  'weapons-set': {
    skill: 8,
    label: 'Weapons Assortment',
    slots: [
      { itemId: 0x0F51, label: 'Dagger' },
      { itemId: 0x0F61, label: 'Longsword' },
      { itemId: 0x143B, label: 'Maul' },
    ],
    reward: 'Power scroll + ingot pile',
  },
  // Tailoring (35) — wardrobe
  'wardrobe': {
    skill: 35,
    label: 'Tailored Wardrobe',
    slots: [
      { itemId: 0x153D, label: 'Skirt' },
      { itemId: 0x1517, label: 'Shirt' },
      { itemId: 0x1F03, label: 'Robe' },
      { itemId: 0x152C, label: 'Cloak' },
    ],
    reward: 'Sewing kit (runic) + cloth bolts',
  },
  // Tailoring (35) — leather set
  'leather-set': {
    skill: 35,
    label: 'Leather Armor Set',
    slots: [
      { itemId: 0x13CC, label: 'Leather Tunic' },
      { itemId: 0x13CB, label: 'Leather Leggings' },
      { itemId: 0x13C6, label: 'Leather Gloves' },
      { itemId: 0x13CD, label: 'Leather Arms' },
    ],
    reward: 'Runic sewing kit (spined+)',
  },
  // Tailoring (35) — studded set
  'studded-set': {
    skill: 35,
    label: 'Studded Armor Set',
    slots: [
      { itemId: 0x13DB, label: 'Studded Tunic' },
      { itemId: 0x13DA, label: 'Studded Leggings' },
      { itemId: 0x13D5, label: 'Studded Gloves' },
      { itemId: 0x13DC, label: 'Studded Arms' },
    ],
    reward: 'Runic sewing kit (horned+)',
  },
  // Blacksmithy (8) — chainmail
  'chainmail-set': {
    skill: 8,
    label: 'Chainmail Set',
    slots: [
      { itemId: 0x13BB, label: 'Chain Coif' },
      { itemId: 0x13BF, label: 'Chain Tunic' },
      { itemId: 0x13BE, label: 'Chain Leggings' },
    ],
    reward: 'Runic hammer (verite+)',
  },
  // Blacksmithy (8) — ringmail
  'ringmail-set': {
    skill: 8,
    label: 'Ringmail Set',
    slots: [
      { itemId: 0x13EC, label: 'Ring Tunic' },
      { itemId: 0x13F1, label: 'Ring Leggings' },
      { itemId: 0x13F0, label: 'Ring Gloves' },
      { itemId: 0x13EE, label: 'Ring Arms' },
    ],
    reward: 'Runic hammer (agapite+)',
  },
  // Bowcraft/Fletching (9) — bowyer
  'bow-set': {
    skill: 9,
    label: 'Bowyer Set',
    slots: [
      { itemId: 0x13B2, label: 'Bow' },
      { itemId: 0x0F50, label: 'Crossbow' },
      { itemId: 0x13FD, label: 'Heavy Crossbow' },
      { itemId: 0x26C2, label: 'Composite Bow' },
    ],
    reward: 'Runic fletcher (oak+)',
  },
  // Inscription (24) — magery scroll set
  'scroll-set': {
    skill: 24,
    label: 'Scroll Set',
    slots: [
      { itemId: 0x1F2D, label: 'Magic Arrow Scroll' },
      { itemId: 0x1F2E, label: 'Heal Scroll' },
      { itemId: 0x1F30, label: 'Lightning Scroll' },
      { itemId: 0x1F31, label: 'Energy Bolt Scroll' },
    ],
    reward: 'Power scroll (10%) + 1000gp',
  },
};

// =====================================================================
//  BOD reward catalog — concrete itemIds the world.createItem path can
//  spawn when a small or large BOD is turned in. ServUO has full reward
//  tables in `BulkRewardCalculator.cs`; we ship a focused subset that
//  covers each skill family. Reward is rolled by tier.
// =====================================================================

const BOD_REWARD_CATALOG = {
  // Blacksmithy (skill 8)
  8: {
    common:  [{ itemId: 0x1BEF, name: 'iron ingots', amount: 50 }],
    uncommon:[{ itemId: 0x14F0, name: 'crafted runic blueprint' }],
    rare:    [{ itemId: 0x13E3, name: 'gold runic hammer', material: 'gold' }],
    legendary:[{ itemId: 0x13E3, name: 'valorite runic hammer', material: 'valorite' }],
    powerScrollSkill: 8,
  },
  // Tailoring (skill 35)
  35: {
    common:  [{ itemId: 0x1766, name: 'cloth bolts', amount: 20 }],
    uncommon:[{ itemId: 0x14F0, name: 'sewing kit' }],
    rare:    [{ itemId: 0x13E4, name: 'horned runic sewing kit', material: 'horned' }],
    legendary:[{ itemId: 0x13E4, name: 'barbed runic sewing kit', material: 'barbed' }],
    powerScrollSkill: 35,
  },
  // Bowcraft/Fletching (skill 9)
  9: {
    common:  [{ itemId: 0x1BD7, name: 'boards', amount: 30 }],
    uncommon:[{ itemId: 0x102C, name: 'carpentry tools' }],
    rare:    [{ itemId: 0x13E1, name: 'oak runic fletcher', material: 'oak' }],
    legendary:[{ itemId: 0x13E1, name: 'frostwood runic fletcher', material: 'frostwood' }],
    powerScrollSkill: 9,
  },
  // Inscription (skill 24)
  24: {
    common:  [{ itemId: 0x0E34, name: 'blank scrolls', amount: 30 }],
    uncommon:[{ itemId: 0x14F0, name: 'rune deed' }],
    rare:    [{ itemId: 0x14F0, name: 'recipe scroll' }],
    legendary:[{ itemId: 0x1F4C, name: 'major recipe scroll' }],
    powerScrollSkill: 24,
  },
};

/**
 * Roll a reward bundle from the catalog. Tier is decided by quantity +
 * exceptional + material. Returns an array of `{itemId, amount?, name?}`
 * entries the caller spawns into the player's pack.
 */
export function rollBodReward(bod) {
  const cat = BOD_REWARD_CATALOG[bod.skill];
  if (!cat) return [{ itemId: 0x0EED, name: 'gold', amount: 100 }];
  let tier = 'common';
  if (bod.exceptional && bod.material !== 'iron') tier = 'rare';
  else if (bod.exceptional || bod.material !== 'iron') tier = 'uncommon';
  if (bod.large && bod.exceptional && (bod.material === 'valorite' || bod.material === 'barbed')) tier = 'legendary';
  return cat[tier] ?? cat.common ?? [];
}

export const _BOD_REWARD_CATALOG = BOD_REWARD_CATALOG;

/**
 * Build a Large BOD payload for the given recipe key. Returns null if
 * the recipe is unknown.
 *
 * @param {keyof typeof LARGE_BOD_RECIPES} recipeKey
 * @returns {object|null}
 */
export function makeLargeBOD(recipeKey) {
  const recipe = LARGE_BOD_RECIPES[recipeKey];
  if (!recipe) return null;
  // Match small-BOD style: 25% exceptional, 40% coloured material.
  const exceptional = Math.random() < 0.25;
  const material = Math.random() < 0.6 ? 'iron' : MATERIALS[1 + ri(MATERIALS.length - 1)];
  return {
    large: true,
    skill: recipe.skill,
    label: `${recipe.label}${exceptional ? ' (Exceptional)' : ''}`,
    slots: recipe.slots.map((s) => ({
      itemId: s.itemId, label: s.label,
      smallBodSerial: null, done: false,
    })),
    material,
    exceptional,
    reward: recipe.reward,
  };
}

/**
 * Attach a small BOD to a slot in a large BOD. Both must have matching
 * skill / item / material / exceptional; the small BOD must already be
 * complete (otherwise the player could front-load progress).
 *
 * @param {object} largeBod    large BOD's payload
 * @param {object} smallItem   the small BOD item (with `.bod`)
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function bindSmallToLarge(largeBod, smallItem) {
  const small = smallItem?.bod;
  if (!largeBod?.large) return { ok: false, reason: 'not-large' };
  if (!small) return { ok: false, reason: 'small-has-no-bod' };
  if (small.skill !== largeBod.skill) return { ok: false, reason: 'skill-mismatch' };
  if (small.progress < small.quantity) return { ok: false, reason: 'small-incomplete' };
  if ((small.material ?? 'iron') !== largeBod.material) return { ok: false, reason: 'material-mismatch' };
  if (Boolean(small.exceptional) !== Boolean(largeBod.exceptional)) {
    return { ok: false, reason: 'exceptional-mismatch' };
  }
  const slot = largeBod.slots.find((s) => !s.done && s.itemId === small.itemId);
  if (!slot) return { ok: false, reason: 'no-matching-slot' };
  slot.smallBodSerial = smallItem.serial;
  slot.done = true;
  return { ok: true };
}

/**
 * Whether every slot of a large BOD is filled.
 * @param {object} largeBod
 */
export function isLargeBodComplete(largeBod) {
  return Boolean(largeBod?.large) && largeBod.slots.every((s) => s.done);
}

/**
 * Internal: the small BOD just completed. If the crafter is also
 * holding a matching large BOD with an empty slot, auto-bind. We do
 * this on completion (rather than each craft) so the small deed has
 * an opportunity to match across all the large BODs in the pack.
 */
function tryAdvanceLargeBod(world, crafter, smallItem) {
  // Reverse parent index — walks ~30 pack entries instead of all 110k.
  // Called from recordCraftForBods on every successful craft.
  const idx = world._childrenByParent?.get?.(crafter.serial);
  const iter = idx
    ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === crafter.serial);
  for (const candidate of iter) {
    const lb = candidate.bod;
    if (!lb?.large) continue;
    const r = bindSmallToLarge(lb, smallItem);
    if (r.ok) {
      crafter.client?.sendSystemMessage?.(
        `Bound to large bulk order: ${lb.label}.`,
      );
      if (isLargeBodComplete(lb)) {
        crafter.client?.sendSystemMessage?.(
          `Large bulk order complete: ${lb.label}. Reward: ${lb.reward}.`,
        );
      }
      return;
    }
  }
}

export const _LARGE_BOD_RECIPES = LARGE_BOD_RECIPES;

/**
 * Format a BOD as multi-line status text. Used by the lifecycle
 * `onUse` handler when the player double-clicks the deed.
 *
 * @param {BulkOrder} bod
 */
export function formatBod(bod) {
  return [
    `Bulk Order Deed: ${bod.label}`,
    `  Skill: ${bod.skill}`,
    `  Material: ${bod.material}`,
    bod.exceptional ? '  Exceptional required' : '  Regular quality',
    `  Progress: ${bod.progress}/${bod.quantity}`,
    `  Reward: ${bod.reward}`,
  ].join('\n');
}

export const _SKILL_TARGETS = SKILL_TARGETS;
export const _QUANTITIES = QUANTITIES;

// ---------- BulkOrderBook -------------------------------------------------
//
// ServUO `Items/BulkOrders/BulkOrderBook.cs`. A container item with up
// to 500 slots, each slot either a small or large BOD record. Players
// drop their deeds into the book to free up backpack space and so the
// vendor turn-in code can iterate the lot in one go.
//
// We model the book as a regular container item (gumpId set) plus a
// `bookSlots` capability cap. `addBodToBook(book, deedItem)` moves the
// deed inside (parent reassignment); `removeBodFromBook` is the inverse.
//
// The book's contents are indexable / sortable via `listBookEntries(book)`
// returning a flat array sorted by skill → quantity → material.

const BOOK_CAPACITY = 500;

/**
 * Drop a deed item into a BOD book. Validates capacity + that the item
 * is actually a deed.
 *
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function addBodToBook(world, book, deedItem) {
  if (!book || !book.bodBook) return { ok: false, reason: 'not-a-book' };
  if (!deedItem?.bod) return { ok: false, reason: 'not-a-bod' };
  const count = countBookEntries(world, book);
  if (count >= BOOK_CAPACITY) return { ok: false, reason: 'book-full' };
  setItemParent(world, deedItem, book.serial);
  return { ok: true };
}

export function removeBodFromBook(world, book, deedSerial, dropTo) {
  if (!book?.bodBook) return { ok: false, reason: 'not-a-book' };
  const deed = world.items.get(deedSerial);
  if (!deed || deed.parent !== book.serial) return { ok: false, reason: 'not-in-book' };
  if (dropTo) {
    setItemParent(world, deed, dropTo.parent ?? null);
    deed.x = dropTo.x; deed.y = dropTo.y; deed.z = dropTo.z;
    if (dropTo.map != null) deed.map = dropTo.map;
  }
  return { ok: true, deed };
}

export function countBookEntries(world, book) {
  if (!world?.items) return 0;
  let n = 0;
  for (const it of world.items.values()) {
    if (it.parent === book.serial && it.bod) n++;
  }
  return n;
}

export function listBookEntries(world, book) {
  if (!world?.items) return [];
  const out = [];
  for (const it of world.items.values()) {
    if (it.parent !== book.serial) continue;
    if (!it.bod) continue;
    out.push(it);
  }
  out.sort((a, b) => {
    const ab = a.bod, bb = b.bod;
    if (ab.skill !== bb.skill) return ab.skill - bb.skill;
    if ((ab.quantity ?? 0) !== (bb.quantity ?? 0)) {
      return (bb.quantity ?? 0) - (ab.quantity ?? 0);
    }
    return String(ab.material ?? '').localeCompare(String(bb.material ?? ''));
  });
  return out;
}

export const BOD_BOOK_CAPACITY = BOOK_CAPACITY;

// ---------- Vendor turn-in ----------------------------------------------
//
// `tryTurnInBod(world, vendor, player, deedItem)` — called from the
// vendor speech handler when a player says "deliver" or "turn in" near
// a vendor. ServUO `Mobiles/NPCs/BodVendor.cs::OnDoubleClick`.
//
// Rules:
//   - vendor.bodAcceptsSkill must include deed's skill (else "I don't
//     deal in this kind of work")
//   - deed must be complete (progress >= quantity, or large all-bound)
//   - reward selection: `bod.reward` is a label; we credit gold +
//     optionally drop a tagged reward item into the player's pack
//
// We fire `events.emit('bod:turnedIn', { player, deed, vendor })` so
// scripts can hook achievement / tracking.

export function tryTurnInBod(world, vendor, player, deedItem, deps = {}) {
  if (!deedItem?.bod) return { ok: false, reason: 'not-a-bod' };
  const bod = deedItem.bod;
  // Skill gate.
  const acceptsSkill = vendor?.bodAcceptsSkill;
  if (acceptsSkill && Array.isArray(acceptsSkill) && !acceptsSkill.includes(bod.skill)) {
    return { ok: false, reason: 'wrong-skill' };
  }
  // Completion gate.
  if (bod.large) {
    if (!isLargeBodComplete(bod)) return { ok: false, reason: 'large-incomplete' };
  } else {
    if ((bod.progress ?? 0) < (bod.quantity ?? 0)) return { ok: false, reason: 'incomplete' };
  }
  // Compute gold reward — quantity × material multiplier × exceptional bonus.
  const matMul = bod.material === 'iron' ? 1
               : (MATERIALS.indexOf(bod.material ?? 'iron') + 1) || 1;
  const exMul = bod.exceptional ? 2 : 1;
  const baseUnits = bod.large
    ? bod.slots.reduce((n, s) => n + (s.done ? 1 : 0), 0) * 5
    : (bod.quantity ?? 10);
  const goldReward = baseUnits * 25 * matMul * exMul;
  // Credit gold + remove the deed.
  if (typeof deps.giveGold === 'function') {
    deps.giveGold(world, player, goldReward);
  } else if (typeof player.gold === 'number') {
    player.gold = (player.gold | 0) + goldReward;
  }
  destroyBodItem(world, deedItem.serial, deps);
  // Cascading: drop bound small deeds when finishing a large.
  if (bod.large && Array.isArray(bod.slots)) {
    for (const slot of bod.slots) {
      if (slot.smallBodSerial) {
        destroyBodItem(world, slot.smallBodSerial, deps);
      }
    }
  }
  player.client?.sendSystemMessage?.(
    `Bulk order accepted. ${goldReward} gold paid. ${bod.reward}`,
  );
  deps.events?.emit?.('bod:turnedIn', { player, vendor, bod, gold: goldReward });
  return { ok: true, gold: goldReward };
}

// ---- Reward selection -----------------------------------------------------
//
// ServUO BulkOrderInfo splits the reward pool into 5 buckets based on
// `points`. Bucket selection happens at turn-in time; the player picks
// one option from the bucket via a gump (we surface via system message
// + `[bod-reward <slot>` follow-up command for now, until the gump
// asset is shipped).

/**
 * Score one BOD's reward bucket. Returns 0..4 (low → high).
 * 0  small (< 30 pts)     — small gold pile
 * 1  medium (30..49)      — sturdy ingots / cloth bundle
 * 2  good (50..79)        — runic tool (basic)
 * 3  great (80..119)      — recipe scroll / coloured tool
 * 4  amazing (120+)       — top-tier runic + bonus
 */
export function bodRewardTier(bod) {
  let pts = bod.quantity | 0;
  if (bod.exceptional) pts *= 2;
  const matIdx = Math.max(0, MATERIALS.indexOf(bod.material ?? 'iron'));
  pts += matIdx * 8;
  if (bod.large) pts *= 1.5;
  if (pts >= 120) return 4;
  if (pts >= 80)  return 3;
  if (pts >= 50)  return 2;
  if (pts >= 30)  return 1;
  return 0;
}

/**
 * Per-tier reward catalogues. Each entry: itemId / hue / amount / name.
 * Selected randomly when the player claims (the gump would let them
 * pick; we randomize as a compromise until the UI lands).
 */
const REWARD_POOLS = [
  // Tier 0 — small gold pile (always 100..200 gp).
  [{ itemId: 0x0EED, hue: 0, amountRange: [100, 200], name: 'gold' }],
  // Tier 1 — ingots / cloth bundle.
  [
    { itemId: 0x1BEF, hue: 0, amountRange: [10, 20], name: 'iron ingot' },
    { itemId: 0x1766, hue: 0, amountRange: [5, 10], name: 'bolt of cloth' },
    { itemId: 0x0EED, hue: 0, amountRange: [400, 800], name: 'gold' },
  ],
  // Tier 2 — runic tool (basic dull-copper / spined leather).
  [
    { itemId: 0x13E3, hue: 0x973, name: 'dull copper runic hammer', amount: 1, charges: 30 },
    { itemId: 0x13E4, hue: 0x21E, name: 'spined leather runic sewing kit', amount: 1, charges: 30 },
    { itemId: 0x0EED, hue: 0, amountRange: [1500, 3000], name: 'gold' },
  ],
  // Tier 3 — recipe scroll / coloured runic tool.
  [
    { itemId: 0x13E3, hue: 0x966, name: 'shadow iron runic hammer', amount: 1, charges: 25 },
    { itemId: 0x14F0, hue: 0x47E, name: 'recipe scroll', amount: 1 },
    { itemId: 0x0EED, hue: 0, amountRange: [5000, 8000], name: 'gold' },
  ],
  // Tier 4 — top-tier (valorite-class).
  [
    { itemId: 0x13E3, hue: 0x8AB, name: 'valorite runic hammer', amount: 1, charges: 20 },
    { itemId: 0x14F0, hue: 0x97B, name: 'rare crafting recipe', amount: 1 },
    { itemId: 0x0EED, hue: 0, amountRange: [15000, 25000], name: 'gold' },
  ],
];

/**
 * Materialize a reward in `player`'s pack and destroy the deed.
 * Returns the item created (or null if no items module available).
 */
export function claimBodReward(world, player, deedItem, deps = {}) {
  if (!deedItem?.bod) return null;
  const bod = deedItem.bod;
  if (!bod.large && (bod.progress ?? 0) < (bod.quantity ?? 0)) return null;
  if (bod.large && !isLargeBodComplete(bod)) return null;
  const tier = bodRewardTier(bod);
  const pool = REWARD_POOLS[tier] ?? REWARD_POOLS[0];
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const amount = pick.amountRange
    ? pick.amountRange[0] + Math.floor(Math.random() * (pick.amountRange[1] - pick.amountRange[0] + 1))
    : (pick.amount ?? 1);
  const createItem = deps.createItem;
  let reward = null;
  if (createItem) {
    reward = createItem(world, {
      itemId: pick.itemId, hue: pick.hue ?? 0, amount,
      parent: player.serial, name: pick.name,
    });
    if (reward && pick.charges) reward.charges = pick.charges;
  }
  destroyBodItem(world, deedItem.serial, deps);
  player.client?.sendSystemMessage?.(
    reward
      ? `BOD reward claimed: ${amount}× ${pick.name}.`
      : `BOD reward claimed (tier ${tier}).`,
  );
  return reward;
}
