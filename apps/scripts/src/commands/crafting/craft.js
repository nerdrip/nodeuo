// `[craft <recipe-name-or-id>` — generic crafting dispatcher exposing
// all 9 ServUO crafting subsystems (Blacksmithing, Tailoring, Alchemy,
// Carpentry, Fletching, Inscription, Cooking, Tinkering, Cartography,
// plus Masonry / Glassblowing / Runic). Looks up the recipe by name
// (case-insensitive substring) or numeric id, then routes through
// `crafting.craft({ ... })` with an itemStore wired to api.items.
//
// Without this command the entire recipe registry was unreachable
// from gameplay — recipes built but no UI / packet ever called them.
//
// Usage:
//   [craft dagger              — first recipe with "dagger" in the name
//   [craft 1001                — recipe by numeric id
//   [craft list                — list recipes for the player's highest
//                                qualifying skill
//   [craft list smithing       — list recipes for the named skill

import { normalizeSkillValue } from '../../_rules.js';
import { mobileBySerial } from '../../_entities.js';
import { packItems } from '../../_inventory.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

/** Map skill-name aliases to ServUO skill ids. */
const SKILL_ALIAS = {
  smith: 8, smithing: 8, blacksmith: 8, blacksmithing: 8,
  tailor: 35, tailoring: 35,
  alch: 1, alchemy: 1,
  carp: 12, carpentry: 12,
  fletch: 9, fletching: 9, bowcraft: 9,
  inscribe: 24, inscription: 24,
  cook: 14, cooking: 14,
  tinker: 38, tinkering: 38,
  carto: 13, cartography: 13,
  mason: 0, masonry: 0,            // 0 = unknown id; runtime checks recipe
  // Glassblowing — ServUO parity: backed by Alchemy (skill 1).
  glass: 1, glassblowing: 1, glassblow: 1,
};

/** Tool itemId by toolKind — minimal mapping covering the kinds the
 *  recipe registry actually uses. Bug-hunt #7 bonus. */
const TOOL_KIND_ITEM_IDS = {
  smith:       [0x13E3, 0x13E4, 0x102A],   // smith hammer / sledge / hammer
  tinker:      [0x1EBC, 0x1EB8],           // tinker tool / pliers
  fletcher:    [0x1022, 0x1023],           // fletcher tools
  fletching:   [0x1022, 0x1023],
  carpenter:   [0x1034, 0x1101],           // saw / hammer-and-chisel
  carp:        [0x1034, 0x1101],
  tailor:      [0x0F9D, 0x0F9F],           // sewing kit / scissors
  cook:        [0x097F],                   // skillet
  inscribe:    [0x0FBE, 0x0FBF],           // inkwell variants
  // Glassblowing — ServUO uses the Glass Blower's Pipe (0x182D).
  glass:       [0x182D],
  glassblowing:[0x182D],
  glassblow:   [0x182D],
};

function findCraftingTool(api, mob, toolKind) {
  if (!toolKind) return null;
  const ids = TOOL_KIND_ITEM_IDS[(toolKind ?? '').toLowerCase()] ?? null;
  if (!ids) return null;
  for (const it of packItems(api, mob)) {
    if (!ids.includes(it.itemId)) continue;
    // Looks like a tool — wrap it as ctx.tool so crafting/index.js
    // decrements its `tool.charges` and destroys at 0.
    if (it.tool?.charges == null) it.tool = { charges: 50, ...(it.tool ?? {}) };
    return { serial: it.serial, tool: it };
  }
  return null;
}

function findIngredientsInPack(api, mob, itemId, count) {
  // Walk world.items for items whose parent chain ends at the mob's
  // backpack and whose itemId matches. Returns total quantity available
  // and the matching item refs.
  const matches = [];
  let total = 0;
  for (const it of packItems(api, mob)) {
    if ((it.itemId | 0) !== (itemId | 0)) continue;
    matches.push(it);
    total += it.amount ?? 1;
    if (total >= count) break;
  }
  return { matches, total };
}

function buildItemStore(api) {
  const world = api.world;
  return {
    checkIngredients(crafter, inputs) {
      for (const ing of inputs ?? []) {
        const { total } = findIngredientsInPack(api, crafter, ing.itemId, ing.count);
        if (total < ing.count) return false;
      }
      return true;
    },
    consumeIngredients(crafter, inputs, ratio) {
      const r = Math.max(0, Math.min(1, ratio ?? 1));
      for (const ing of inputs ?? []) {
        const need = Math.ceil(ing.count * r);
        if (need <= 0) continue;
        const { matches } = findIngredientsInPack(api, crafter, ing.itemId, ing.count);
        let remaining = need;
        for (const it of matches) {
          if (remaining <= 0) break;
          const have = it.amount ?? 1;
          if (have <= remaining) {
            destroyItemBySerial(api, it.serial);
            remaining -= have;
          } else {
            it.amount = have - remaining;
            // Broadcast amount change so containers refresh.
            try { api.broadcast?.itemUpdate?.(world, it); } catch { /* advisory */ }
            remaining = 0;
          }
        }
        if (remaining > 0) return false;
      }
      return true;
    },
    spawnItem({ itemId, amount, container, crafter, quality }) {
      const created = createItem(api, world, {
        itemId, hue: 0, amount: amount ?? 1, parent: container,
        crafter,
        quality,
      });
      return created ?? null;
    },
    destroyItem(serial) { destroyItemBySerial(api, serial); },
  };
}

function listRecipes(ctx, skillId, crafting) {
  const recipes = skillId != null ? crafting.recipesForSkill(skillId) : crafting.allRecipes();
  if (!recipes.length) {
    ctx.state.sendSystemMessage('No recipes registered for that skill.');
    return;
  }
  ctx.state.sendSystemMessage(`${recipes.length} recipe(s):`);
  // Cap to 30 to avoid spamming the client.
  for (const r of recipes.slice(0, 30)) {
    ctx.state.sendSystemMessage(
      `  #${r.id} ${r.name} — skill ${r.skillId} (${r.minSkill}-${r.maxSkill})`,
    );
  }
  if (recipes.length > 30) {
    ctx.state.sendSystemMessage(`  ... and ${recipes.length - 30} more.`);
  }
}

function skillValue(mob, skillId) {
  if (!skillId) return 0;
  const raw = mob?.skills?.[skillId] ?? mob?.skills?.[String(skillId)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.commands?.register) return () => {};
  const crafting = api.systems?.crafting;
  if (!crafting) {
    api.log?.('craft: crafting system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'craft',
    help: '[craft <recipe-name|id|list [skill]> — craft a registered recipe.',
    access: 'Player',
    run(ctx) {
      // `commands.dispatch` sets `ctx.args` to a tokenised array (e.g.
      // `['gump', 'carpentry']`) when invoked via a multi-token line
      // like `[craft gump carpentry`; the legacy path also called
      // `craft.run(ctx)` with a pre-joined string. Normalise so the
      // rest of the body can keep the simple `.trim() / .startsWith()`
      // shape it already uses.
      const arg = (Array.isArray(ctx.args) ? ctx.args.join(' ') : (ctx.args ?? '')).trim();
      if (arg.toLowerCase().startsWith('gump')) {
        const rest = arg.slice(4).trim().toLowerCase();
        const skillId = rest ? SKILL_ALIAS[rest] ?? null : null;
        const recipes = skillId != null ? crafting.recipesForSkill(skillId) : crafting.allRecipes();
        // Filter to a sensible cap and serialize as `id|name|skill|min|max`.
        const rows = recipes.slice(0, 80).map((r) =>
          `${r.id}|${r.name}|${r.skillId}|${r.minSkill}|${r.maxSkill}`,
        ).join(';');
        const skillVal = skillValue(ctx.sender, skillId);
        ctx.state.sendSystemMessage?.(
          `@@OPEN_CRAFT_GUMP@@${rest || 'all'}|${skillVal.toFixed(1)}|${rows}`,
        );
        return;
      }
      if (!arg || arg.toLowerCase().startsWith('list')) {
        const rest = arg.slice(4).trim().toLowerCase();
        const skillId = rest ? SKILL_ALIAS[rest] ?? null : null;
        return listRecipes(ctx, skillId, crafting);
      }
      let recipe = null;
      const numeric = Number.parseInt(arg, 10);
      if (Number.isFinite(numeric) && /^\d+$/.test(arg)) {
        recipe = crafting.getRecipe(numeric);
      }
      if (!recipe) {
        const lower = arg.toLowerCase();
        recipe = crafting.allRecipes().find((r) => r.name.toLowerCase() === lower)
              ?? crafting.allRecipes().find((r) => r.name.toLowerCase().includes(lower));
      }
      if (!recipe) {
        ctx.state.sendSystemMessage(`No recipe matching "${arg}".`);
        return;
      }
      // Bug-hunt #7 bonus: pass the crafting tool so its charges
      // decrement on success. Without `ctx.tool`, regular (non-runic)
      // tools never crumbled.
      const tool = findCraftingTool(api, ctx.sender, recipe.toolKind);
      // ServUO `CraftItem.Craft` — canonical apply-timer pattern:
      //   t = 0      → PlaySound(GetCraftPlaySound())        // initial tick
      //   t = Delay  → CompleteCraft (resolve + result msg)
      // The previous synchronous resolution skipped the delay window,
      // so [craft felt instant + the player heard one sound on result
      // instead of one sound at the start. Now we emit at t=0 and
      // schedule the actual `craft()` call after the per-skill Delay
      // (CRAFT_DELAY_MS). Per-crafter `_craftBusyUntil` stamp blocks
      // re-entry so you can't stack five [craft commands in 100ms.
      const now = Date.now();
      if ((ctx.sender._craftBusyUntil ?? 0) > now) {
        ctx.state.sendSystemMessage('You are still working on a craft.');
        return;
      }
      const delayMs = crafting.CRAFT_DELAY_MS[(recipe.toolKind ?? '').toLowerCase()] ?? 1500;
      ctx.sender._craftBusyUntil = now + delayMs;
      crafting.emitCraftSfx(ctx.sender, recipe.toolKind);
      const senderRef = ctx.sender;
      const stateRef = ctx.state;
      const worldRef = ctx.world;
      const recipeRef = recipe;
      const toolRef = tool;
      setTimeout(() => {
        senderRef._craftBusyUntil = 0;
        // Drop the craft if the player vanished mid-timer (logout,
        // disconnect, death without resurrection). `mobiles.has` is
        // the canonical "still in world" check.
        if (!mobileBySerial(api, senderRef)) return;
        const result = crafting.craft({
          recipeId: recipeRef.id,
          crafter: senderRef,
          world: worldRef,
          itemStore: buildItemStore(api),
          tool: toolRef,
          emitSfx: false,            // already emitted at t=0
        });
        if (result.ok) {
          stateRef.sendSystemMessage(
            `${result.exceptional ? 'Exceptional ' : ''}${recipeRef.name} crafted` +
            (result.resource && result.resource !== 'iron' ? ` (${result.resource})` : '') + '.',
          );
        } else {
          const reason = ({
            'unknown-recipe': 'Recipe not found.',
            'low-skill': `You lack the skill to craft ${recipeRef.name}.`,
            'insufficient-materials': 'You lack the required materials.',
            'failed': 'You failed to craft the item.',
          })[result.reason] ?? `Craft failed (${result.reason}).`;
          stateRef.sendSystemMessage(reason);
        }
      }, delayMs);
    },
  });
  return () => api.commands.unregister?.('craft');
}
