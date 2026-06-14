// Crafting engine — recipe registry + `craft()` dispatcher. Individual
// crafting skills register their recipes from sibling files.
//
// Design split vs ServUO:
//   ServUO: one `CraftItem` per recipe, stored in a `CraftSystem` tree.
//           Heavy OOP, per-item success formulas.
//   Us:     flat registry keyed by recipe id, recipes are plain objects.
//           `craft()` handles the full pipeline (skill check, ingredients,
//           success roll, exceptional roll, consume + spawn).

import { effectiveSkill } from '../../combat-formulas.js';
import { getRecipe, registerRecipe, allRecipes, recipesForSkill, recipesByCategory } from './registry.js';
import { recordCraftForBods } from '../economy/bods.js';
import { findRunicTool, applyRunicTier } from './runic.js';
import { playSound } from '@uo/protocol';

// Per-tool crafting SFX, verified against ServUO `Scripts/Services/Craft/
// Def*.cs::PlayCraftEffect`. Each CraftSystem ships an EffectSound id
// played by `CraftItem.InternalTimer` mid-craft (every tick except the
// last). Our craft() is synchronous, so we emit ONE sample per attempt
// — the same clip the canonical timer would emit on its first tick.
// User report 2026-05-19 "przy craftingu chyba nie ma dźwięków".
//   smith        → 0x02A  DefBlacksmithy
//   tinker       → 0x23B  DefTinkering  (NOT 0x241 — that's a hue test)
//   fletcher     → 0x055  DefBowFletching
//   carp/mason   → 0x23D  DefCarpentry / DefMasonry
//   tailor       → 0x248  DefTailoring
//   alchemy      → 0x242  DefAlchemy
//   glassblowing → 0x02B  DefGlassblowing (bellows — different from alchemy)
//   inscribe     → 0x249  DefInscription
//   carto        → 0x249  DefCartography
//   cooking      → (none) DefCooking ships an empty override (no SFX)
// Unknown / missing toolKind → no sound (silent fallback, never errors).
const CRAFT_TOOL_SFX = {
  smith:        0x02A,
  blacksmith:   0x02A,
  tinker:       0x23B,
  fletcher:     0x055,
  fletching:    0x055,
  carpenter:    0x23D,
  carp:         0x23D,
  mason:        0x23D,
  masonry:      0x23D,
  tailor:       0x248,
  tailoring:    0x248,
  alchemy:      0x242,
  alch:         0x242,
  glass:        0x02B,
  glassblow:    0x02B,
  glassblowing: 0x02B,
  inscribe:     0x249,
  inscription:  0x249,
  carto:        0x249,
  cartography:  0x249,
};

export function emitCraftSfx(crafter, toolKind) {
  if (!crafter?.client) return;
  const id = CRAFT_TOOL_SFX[(toolKind ?? '').toLowerCase()];
  if (!id) return;
  try {
    crafter.client.send(playSound({
      soundId: id, mode: 0, volume: 0xFF,
      x: crafter.x, y: crafter.y, z: crafter.z,
    }));
  } catch { /* sfx advisory */ }
}

// Per-skill apply-timer delay, mirroring ServUO `Def*.cs::Delay`. The
// [craft command schedules result resolution this many ms after the
// player clicks, with one PlayCraftEffect emitted at t=0 (the
// "initial PlaySound" in `CraftItem.Craft`). Single-item crafts only
// — batch quantity-N crafts would tick the SFX every Delay ms, which
// we don't model.
export const CRAFT_DELAY_MS = {
  smith:        1750, blacksmith:  1750,
  tailor:       1500, tailoring:   1500,
  carpenter:    1500, carp:        1500,
  mason:         700, masonry:      700,
  alchemy:      1500, alch:        1500,
  glass:        1500, glassblow:   1500, glassblowing: 1500,
  inscribe:     1000, inscription: 1000,
  carto:        1000, cartography: 1000,
  tinker:       1000, tinkering:   1000,
  fletcher:     1500, fletching:   1500,
  cook:         1000, cooking:     1000,
};
import {
  extractedRecipesForSkill, extractedRecipeSkills, extractedRecipeCount,
} from './extracted-recipes.js';

export { getRecipe, registerRecipe, allRecipes, recipesForSkill, recipesByCategory };
export { extractedRecipesForSkill, extractedRecipeSkills, extractedRecipeCount };

/**
 * BUGFIX #37 (FAZA BU): the ServUO original craft() set
 * `container: ctx.crafter.backpack` on every spawned item, but our
 * `Mobile` shape has no `.backpack` field — inventories are kept
 * implicitly via `item.parent === mob.serial && item.layer === 21`.
 * Letting `undefined` flow through caused crafted items to land at
 * world (0,0,0) instead of the crafter's pack (or to silently fail
 * when the itemStore implementation didn't tolerate a null parent).
 * `resolveBackpack(world, mob)` walks the mobile's worn items and
 * returns the layer-21 container's serial, with a `null` fallback so
 * isolated unit tests that don't model a backpack still work.
 */
function resolveBackpack(world, mob) {
  if (mob?.backpack) return mob.backpack; // stub-friendly override
  if (!world?.items) return null;
  for (const it of world.items.values()) {
    if (it.parent === mob.serial && (it.layer ?? 0) === 21) return it.serial;
  }
  return null;
}

/**
 * @typedef {Object} Ingredient
 * @property {number} itemId
 * @property {number} count
 */

/**
 * @typedef {Object} CraftRecipe
 * @property {number} id
 * @property {string} name
 * @property {string} category
 * @property {number} skillId
 * @property {number} minSkill
 * @property {number} maxSkill
 * @property {number} outputItemId
 * @property {number} outputCount
 * @property {Ingredient[]} inputs
 * @property {number} [exceptionalChance]
 */

/**
 * @typedef {Object} CraftContext
 * @property {import('../../world/world.js').Mobile} crafter
 * @property {import('../../world/world.js').World} world
 * @property {Object} itemStore  must expose
 *   `consumeIngredients(crafter, list, ratio): boolean` and
 *   `spawnItem({ itemId, amount, container, crafter, quality })`.
 */

/**
 * Attempt to craft a recipe.
 *
 * @param {CraftContext & { recipeId: number }} ctx
 */
export function craft(ctx) {
  const recipe = getRecipe(ctx.recipeId);
  if (!recipe) return { ok: false, reason: 'unknown-recipe' };

  const skill = effectiveSkill(ctx.crafter, recipe.skillId) * 10;
  if (skill < recipe.minSkill) return { ok: false, reason: 'low-skill' };

  // Recipe-scroll gate — high-tier recipes flagged `requiresRecipe`
  // need the account-level unlock from a consumed scroll. Without
  // this any maxed crafter could make endgame items. ServUO
  // `CraftItem.RequiresRecipe`. Account binding comes from the
  // crafter's net state (offline crafting via [craft impossible).
  if (recipe.requiresRecipe) {
    const account = ctx.crafter?.client?.account ?? ctx.crafter?.account ?? null;
    const recipes = account?.recipes;
    const key = recipe.requiresRecipe === true ? `recipe:${recipe.id}` : recipe.requiresRecipe;
    const known = recipes instanceof Set ? recipes.has(key)
                : Array.isArray(recipes) ? recipes.includes(key)
                : false;
    if (!known) return { ok: false, reason: 'recipe-locked' };
  }

  const span = Math.max(1, recipe.maxSkill - recipe.minSkill);
  const pSuccess = Math.max(0, Math.min(1, (skill - recipe.minSkill) / span));

  // BUGFIX #94 (FAZA DZ): the original fail path called
  // consumeIngredients(0.5) WITHOUT checking the return — meaning a
  // crafter who didn't have the materials at all (e.g. ran out
  // mid-stream of a [craft loop) was told "failed" but kept all
  // their ingots. We now run the materials check FIRST so the
  // success and failure branches are both gated on the same
  // ingredient guarantee, then apply the half-refund on fail.
  const have = ctx.itemStore?.checkIngredients?.(ctx.crafter, recipe.inputs)
            ?? ctx.itemStore?.consumeIngredients?.(ctx.crafter, recipe.inputs, 0);
  if (!have) return { ok: false, reason: 'insufficient-materials' };

  // Audit #35 P2 #6 — recipe-declared mana cost gate. Inscription
  // recipes ship with `manaCost` per ServUO `DefInscription.SetManaReq`.
  // Skip when running from a test fixture without mana fields.
  if ((recipe.manaCost | 0) > 0 && Number.isFinite(ctx.crafter?.mana)) {
    if ((ctx.crafter.mana | 0) < (recipe.manaCost | 0)) {
      return { ok: false, reason: 'no-mana' };
    }
    ctx.crafter.mana = Math.max(0, ctx.crafter.mana - (recipe.manaCost | 0));
  }

  if (Math.random() > pSuccess) {
    ctx.itemStore?.consumeIngredients?.(ctx.crafter, recipe.inputs, 0.5);
    // ServUO `BaseTool.OnFailedCraft` debits one charge on failure too.
    // Without this the SUCCESS branch was the only path that ticked
    // down the hammer/saw/kit — a 50% crafter got full charge value
    // while a perfect crafter exhausted the tool. Charge the tool now
    // (before the early return) so failures cost the same as successes.
    if (ctx.tool && Number.isFinite(ctx.tool.charges)) {
      ctx.tool.charges -= 1;
      if (ctx.tool.charges <= 0) {
        ctx.itemStore?.destroyItem?.(ctx.tool.serial);
      }
    }
    if (ctx.emitSfx !== false) emitCraftSfx(ctx.crafter, recipe.toolKind);
    return { ok: false, reason: 'failed' };
  }

  const consumed = ctx.itemStore?.consumeIngredients?.(ctx.crafter, recipe.inputs, 1);
  if (!consumed) return { ok: false, reason: 'insufficient-materials' };

  // ServUO `CraftItem.cs:1268 GetExceptionalChance` scales the chance
  // linearly with skill above min, plus +5% per crafter-bonus item
  // (talisman / apron). The previous gate required `skill >= maxSkill`
  // AND a flat random < exceptionalChance — at mid-skill no exceptional
  // ever rolled. Now: scale by progress through the recipe band.
  const expBase = recipe.exceptionalChance ?? 0;
  let exceptionalChance = 0;
  if (expBase > 0) {
    const progress = Math.max(0, Math.min(1, (skill - recipe.minSkill) / Math.max(1, span)));
    exceptionalChance = expBase * progress;
    // Talisman + apron bonus stack +5% each, capped per ServUO.
    const tal = ctx.crafter?._equipment?.find?.((p) => p?.talisman?.crafterBonus);
    if (tal?.talisman?.crafterBonus) exceptionalChance += 0.05;
    if (ctx.crafter?._wearingApron)  exceptionalChance += 0.05;
  }
  const isExceptional = exceptionalChance > 0 && Math.random() < exceptionalChance;

  const item = ctx.itemStore?.spawnItem?.({
    itemId: recipe.outputItemId,
    amount: recipe.outputCount,
    container: resolveBackpack(ctx.world, ctx.crafter),
    crafter: ctx.crafter.name,
    // Server parity #13 #5 — stamp crafter serial so `runic-reforging`
    // can gate "only the original crafter may rework" + a future
    // "signed by" engraving renders the right owner.
    crafterSerial: ctx.crafter.serial,
    quality: isExceptional ? 'exceptional' : 'regular',
  });
  // Runic-tool overlay: when the crafter has a matching runic hammer /
  // sewing kit / fletcher tool in pack, consume one charge and bump
  // the item's hue + stat bonuses to that tier (dull-copper → valorite,
  // plus blaze/ice/toxic). Without this all crafted gear was iron-tier
  // forever — there was no progression past the base recipe stats.
  const tool = findRunicTool(ctx.world, ctx.crafter, recipe.toolKind ?? 'smith');
  if (item && tool) {
    applyRunicTier(item, tool.tier);
    tool.tool.runicTool.charges -= 1;
    if (tool.tool.runicTool.charges <= 0) {
      ctx.itemStore?.destroyItem?.(tool.tool.serial);
    }
  }
  // Audit #34 P2 #6 — `recipe.onCraft(item)` post-craft hook. Lets a
  // recipe stamp item-specific fields the registry can't express (e.g.
  // tinker keys getting a random `key.keyId` to bind to a future lock,
  // cartography maps getting `treasureLevel`). Recipes opt in by
  // setting `onCraft` on the registry entry.
  if (item && typeof recipe.onCraft === 'function') {
    try { recipe.onCraft(item, { ctx, recipe, isExceptional }); }
    catch (e) { console.error('[craft] onCraft hook threw:', e); }
  }
  // Heartwood reward attribute — server parity #9. The crafter opened
  // a Heartwood Reward Bag earlier (within 1h) and stamped a special
  // attribute on themselves; first exceptional carpentry/fletching
  // craft after that consumes the slot and writes the attr onto the
  // result as a magic property. Mirrors ServUO `HeartwoodReward`.
  if (item && isExceptional && ctx.crafter?._pendingHeartwoodAttr
      && (ctx.crafter._pendingHeartwoodUntil ?? 0) > Date.now()) {
    const attr = ctx.crafter._pendingHeartwoodAttr;
    if (!Array.isArray(item._magicProps)) item._magicProps = [];
    item._magicProps.push({ kind: 'flag', attribute: attr, isFlag: true });
    ctx.crafter._pendingHeartwoodAttr = null;
    ctx.crafter._pendingHeartwoodUntil = 0;
    ctx.crafter.client?.sendSystemMessage?.(
      `The heartwood imbues your work with the ${attr} property.`,
    );
  }
  // Regular (non-runic) crafting tool charge decrement. ServUO
  // `BaseTool.OnSuccessfulCraft`. Items with `tool: { charges: N }`
  // (smith hammer, tinker kit, sewing kit, fletching tool) lose one
  // charge per success and crumble at 0. Bug-hunt #4 C.
  if (ctx.tool && ctx.tool.tool && Number.isFinite(ctx.tool.tool.charges)) {
    ctx.tool.tool.charges -= 1;
    if (ctx.tool.tool.charges <= 0) {
      ctx.itemStore?.destroyItem?.(ctx.tool.serial);
      ctx.crafter?.client?.sendSystemMessage?.('Your crafting tool crumbles to pieces.');
    }
  }
  // FAZA BU: notify any matching bulk-order deeds in the crafter's pack.
  // Failures (above) deliberately don't count — the deed only credits
  // *successful* crafts, exceptional-required deeds gate further on
  // the `isExceptional` roll.
  if (ctx.emitSfx !== false) emitCraftSfx(ctx.crafter, recipe.toolKind);
  recordCraftForBods(ctx.world, ctx.crafter, recipe, isExceptional);
  // Achievements bump — `crafts` counter for every success, plus
  // `exceptionals` when the bonus rolls. Late-bind via the
  // `_achievementsModule` so the engine stays unit-testable.
  if (_achievementsModule && ctx.crafter?.client?.account) {
    const acc = ctx.crafter.client.account;
    try {
      const unlocks = [];
      unlocks.push(..._achievementsModule.progress(acc, 'crafts', 1));
      if (isExceptional) unlocks.push(..._achievementsModule.progress(acc, 'exceptionals', 1));
      for (const u of unlocks) {
        ctx.crafter.client.sendSystemMessage?.(
          `★ Achievement unlocked: ${u.achievement.name}` +
          (u.grantedTitle ? ` (title: ${u.grantedTitle})` : '')
        );
      }
    } catch { /* advisory */ }
  }
  return { ok: true, item, exceptional: isExceptional, resource: tool?.tier ?? 'iron' };
}

// Late-bound achievements module — main.js calls `setAchievementsModule`
// to wire after both modules are loaded (avoids circular import).
let _achievementsModule = null;
export function setAchievementsModule(mod) { _achievementsModule = mod ?? null; }

// Crafting recipes (alchemy, blacksmithing, carpentry, cartography, cooking,
// fletching, glassblowing, inscription, masonry, tailoring, tinkering) live
// in apps/scripts/src/crafting/ and self-register through the script runtime.
// The dispatcher + registry above is engine-only; it knows nothing about
// specific recipes, just how to validate + run a registered CraftRecipe.
