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
import { itemBySerial, mobileBySerial } from '../../_entities.js';
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
  mason: 12, masonry: 12,          // learned Carpentry branch
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
  alchemy:     [0x0E9B],                   // mortar and pestle
  alch:        [0x0E9B],
  carto:       [0x0FBF],                   // scribe/mapmaker pen
  cartography: [0x0FBF],
  mason:       [0x12B3],                   // mallet and chisel
  masonry:     [0x12B3],
  inscribe:    [0x0FBE, 0x0FBF],           // inkwell variants
  // Glassblowing — ServUO uses the Glass Blower's Pipe (0x182D).
  glass:       [0x0E8A, 0x182D],           // blowpipe; second id is legacy content
  glassblowing:[0x0E8A, 0x182D],
  glassblow:   [0x0E8A, 0x182D],
};

const SPECIALIST_BRANCH = Object.freeze({
  mason: 'mason', masonry: 'mason',
  glass: 'glassblowing', glassblowing: 'glassblowing', glassblow: 'glassblowing',
});

function recipesForSelection(crafting, selector) {
  if (!selector) return crafting.allRecipes();
  const branch = SPECIALIST_BRANCH[selector];
  if (branch) return crafting.allRecipes().filter((recipe) => recipe.toolKind === branch);
  const skillId = SKILL_ALIAS[selector];
  return skillId != null ? crafting.recipesForSkill(skillId) : crafting.allRecipes();
}

const CRAFT_MATERIALS = Object.freeze({
  iron:          { hue: 0x000, skillReq: 0 },
  'dull-copper': { hue: 0x973, skillReq: 650 },
  shadow:        { hue: 0x966, skillReq: 700 },
  copper:        { hue: 0x96D, skillReq: 750 },
  bronze:        { hue: 0x972, skillReq: 800 },
  gold:          { hue: 0x8A5, skillReq: 850 },
  agapite:       { hue: 0x979, skillReq: 900 },
  verite:        { hue: 0x89F, skillReq: 950 },
  valorite:      { hue: 0x8AB, skillReq: 990 },
});

export function findCraftingTool(api, mob, toolKind) {
  if (!toolKind) return null;
  const ids = TOOL_KIND_ITEM_IDS[(toolKind ?? '').toLowerCase()] ?? null;
  if (!ids) return null;
  for (const it of packItems(api, mob)) {
    if (!ids.includes(it.itemId)) continue;
    // Crafting expects the actual item: item.tool.charges + item.serial.
    if (it.tool?.charges == null) it.tool = { charges: 50, ...(it.tool ?? {}) };
    return it;
  }
  return null;
}

export function validateRecipeAccess(api, crafter, recipe) {
  const spellId = recipe?.requiresSpell;
  if (!spellId) return true;
  if (!api.spellbooks?.knows) return 'spellbook-unavailable';
  // Authored Mysticism ids are zero-based at 677..692, while the classic UO
  // spellbook packet is one-based at 678..693. Translate only at this wire
  // boundary; changing authored ids would break the NodeUO spell catalogue.
  const bookSpellId = recipe.category === 'Mysticism' ? spellId + 1 : spellId;
  for (const item of packItems(api, crafter)) {
    if (!item?.spellbook && ![0x0E3B, 0x0EFA, 0x2253, 0x2D9D].includes(item?.itemId | 0)) continue;
    if (api.spellbooks.knows(item.serial, bookSpellId)) return true;
  }
  return 'spell-not-known';
}

export function buildItemStore(api) {
  const world = api.world;
  const reserve = (crafter, inputs, ratio = 1) => {
    const r = Math.max(0, Math.min(1, ratio ?? 1));
    const takes = new Map();
    for (const ing of inputs ?? []) {
      let remaining = Math.ceil((ing.count | 0) * r);
      if (remaining <= 0) continue;
      for (const it of packItems(api, crafter)) {
        if ((it.itemId | 0) !== (ing.itemId | 0)) continue;
        if (ing.hue != null && (it.hue | 0) !== (ing.hue | 0)) continue;
        const already = takes.get(it.serial) ?? 0;
        const available = Math.max(0, (it.amount ?? 1) - already);
        const take = Math.min(available, remaining);
        if (take > 0) takes.set(it.serial, already + take);
        remaining -= take;
        if (remaining <= 0) break;
      }
      if (remaining > 0) return null;
    }
    let committed = false;
    return {
      commit() {
        if (committed) return false;
        for (const [serial, amount] of takes) {
          const item = itemBySerial(api, serial);
          if (!item || (item.amount ?? 1) < amount) return false;
        }
        committed = true;
        for (const [serial, amount] of takes) {
          const item = itemBySerial(api, serial);
          const have = item.amount ?? 1;
          if (have === amount) destroyItemBySerial(api, serial);
          else {
            item.amount = have - amount;
            try { api.broadcast?.itemUpdate?.(world, item); } catch { /* advisory */ }
          }
        }
        return true;
      },
    };
  };
  return {
    checkIngredients(crafter, inputs) {
      return reserve(crafter, inputs, 1) != null;
    },
    reserveIngredients: reserve,
    consumeIngredients(crafter, inputs, ratio) {
      return reserve(crafter, inputs, ratio)?.commit() ?? false;
    },
    spawnItem({ itemId, amount, container, crafter, quality, hue = 0, ...metadata }) {
      const created = createItem(api, world, {
        itemId, hue, amount: amount ?? 1, parent: container,
        crafter,
        quality,
        ...metadata,
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

function recipeByArg(crafting, arg) {
  const value = String(arg ?? '').trim();
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric) && /^\d+$/.test(value)) return crafting.getRecipe(numeric);
  const lower = value.toLowerCase();
  return crafting.allRecipes().find((r) => r.name.toLowerCase() === lower)
      ?? crafting.allRecipes().find((r) => r.name.toLowerCase().includes(lower));
}

function supportsWorkbench(api, state) {
  const capability = api.nodeUO?.features?.CraftingWorkbench;
  return !!capability && !!state?.supportsNodeUO?.(capability);
}

function sendProgress(state, recipeId, done, total, status, message = '') {
  state.sendSystemMessage?.(
    `@@CRAFT_PROGRESS@@${recipeId | 0}|${done | 0}|${total | 0}|${status}|${encodeURIComponent(message)}`,
  );
}

function resultMessage(recipe, result) {
  if (result.ok) {
    return `${result.exceptional ? 'Exceptional ' : ''}${recipe.name} crafted` +
      (result.resource && result.resource !== 'iron' ? ` (${result.resource})` : '') + '.';
  }
  return ({
    'unknown-recipe': 'Recipe not found.',
    'low-skill': `You lack the skill to craft ${recipe.name}.`,
    'material-skill': 'You lack the skill required for the selected material.',
    'recipe-locked': `You have not learned the recipe for ${recipe.name}.`,
    'spell-not-known': `Your spellbook does not contain the spell for ${recipe.name}.`,
    'spellbook-unavailable': 'The spellbook service is unavailable.',
    'insufficient-materials': 'You lack the required materials.',
    'no-mana': 'You lack the mana required for this recipe.',
    'failed': 'You failed to craft the item.',
    'missing-tool': `You need the correct tool to craft ${recipe.name}.`,
    'tool-worn-out': 'That crafting tool is worn out.',
    'output-failed': 'The crafted item could not be placed; no resources were consumed.',
  })[result.reason] ?? `Craft failed (${result.reason}).`;
}

const accountSaveTimers = new WeakMap();
function scheduleAccountSave(state) {
  const db = state?.ctx?.accounts;
  if (!db?.saveSync || accountSaveTimers.has(db)) return;
  const timer = setTimeout(() => {
    accountSaveTimers.delete(db);
    try { db.saveSync(); }
    catch (error) { console.error('[craft] account metadata save failed:', error?.message); }
  }, 1000);
  timer.unref?.();
  accountSaveTimers.set(db, timer);
}

function recordCraftingHistory(state, recipe, result) {
  const account = state?.account;
  if (!account) return;
  account.craftHistory ??= [];
  account.craftHistory.unshift({
    recipeId: recipe.id, name: recipe.name, at: new Date().toISOString(),
    exceptional: !!result.exceptional, resource: result.resource ?? 'iron',
  });
  account.craftHistory.splice(50);
  scheduleAccountSave(state);
}

/** Schedule exactly one authoritative craft commit. The timer owns no
 * inventory state: resources and the tool are revalidated in the callback,
 * so logout/cancel cannot leave a half-reserved stack behind. */
function scheduleAttempt(api, crafting, ctx, recipe, onComplete) {
  const now = Date.now();
  if ((ctx.sender._craftBusyUntil ?? 0) > now) return false;
  const delayMs = crafting.CRAFT_DELAY_MS[(recipe.toolKind ?? '').toLowerCase()] ?? 1500;
  ctx.sender._craftBusyUntil = now + delayMs;
  crafting.emitCraftSfx(ctx.sender, recipe.toolKind);
  const senderRef = ctx.sender;
  const stateRef = ctx.state;
  const worldRef = ctx.world;
  setTimeout(() => {
    senderRef._craftBusyUntil = 0;
    if (!mobileBySerial(api, senderRef) || stateRef._closed
      || (senderRef.client != null && senderRef.client !== stateRef)) {
      return onComplete?.({ ok: false, reason: 'disconnected' });
    }
    const tool = findCraftingTool(api, senderRef, recipe.toolKind);
    const requireTool = !!TOOL_KIND_ITEM_IDS[(recipe.toolKind ?? '').toLowerCase()];
    const result = crafting.craft({
      recipeId: recipe.id,
      crafter: senderRef,
      world: worldRef,
      itemStore: buildItemStore(api),
      tool,
      requireTool,
      validateAccess: (candidate) => validateRecipeAccess(api, senderRef, candidate),
      emitSfx: false,
      material: senderRef._craftMaterial ?? null,
    });
    stateRef.sendSystemMessage(resultMessage(recipe, result));
    if (result.ok) {
      recordCraftingHistory(stateRef, recipe, result);
      api.events?.emit?.('craft:completed', {
        player: senderRef, crafter: senderRef, recipe, result,
      });
    }
    onComplete?.(result);
  }, delayMs);
  return true;
}

function startBatch(api, crafting, ctx, recipe, requested) {
  if (!supportsWorkbench(api, ctx.state)) {
    ctx.state.sendSystemMessage('Batch crafting requires the negotiated NodeUO workbench; crafting one item instead.');
    scheduleAttempt(api, crafting, ctx, recipe);
    return;
  }
  if (ctx.sender._craftQueue) {
    ctx.state.sendSystemMessage('A crafting queue is already active.');
    return;
  }
  const total = Math.max(1, Math.min(50, requested | 0));
  const queue = { recipeId: recipe.id, total, done: 0, cancelled: false };
  ctx.sender._craftQueue = queue;
  const finish = (status, message) => {
    if (ctx.sender._craftQueue === queue) ctx.sender._craftQueue = null;
    sendProgress(ctx.state, recipe.id, queue.done, total, status, message);
  };
  const step = () => {
    if (queue.cancelled) return finish('cancelled', `Cancelled after ${queue.done}/${total}`);
    if (queue.done >= total) return finish('complete', `Completed ${queue.done}/${total}`);
    sendProgress(ctx.state, recipe.id, queue.done, total, 'working', `Crafting ${queue.done + 1}/${total}`);
    if (!scheduleAttempt(api, crafting, ctx, recipe, (result) => {
      if (result?.ok) queue.done += 1;
      if (!result?.ok && result?.reason !== 'failed') {
        return finish('failed', resultMessage(recipe, result));
      }
      step();
    })) finish('failed', 'The crafter is already busy.');
  };
  step();
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
      if (arg.toLowerCase().startsWith('favorite ')) {
        if (!supportsWorkbench(api, ctx.state)) {
          ctx.state.sendSystemMessage('Server-side crafting favorites require the NodeUO workbench.');
          return;
        }
        const recipe = recipeByArg(crafting, arg.slice(9));
        if (!recipe) { ctx.state.sendSystemMessage('Recipe not found.'); return; }
        const account = ctx.state.account;
        if (!account) return;
        account.craftFavorites = account.craftFavorites instanceof Set
          ? account.craftFavorites : new Set(account.craftFavorites ?? []);
        const selected = account.craftFavorites.has(recipe.id);
        if (selected) account.craftFavorites.delete(recipe.id);
        else account.craftFavorites.add(recipe.id);
        scheduleAccountSave(ctx.state);
        ctx.state.sendSystemMessage(`${recipe.name} ${selected ? 'removed from' : 'added to'} server favorites.`);
        return;
      }
      if (arg.toLowerCase() === 'favorites') {
        const ids = [...(ctx.state.account?.craftFavorites ?? [])];
        ctx.state.sendSystemMessage(ids.length ? `Craft favorites: ${ids.join(', ')}` : 'No server crafting favorites.');
        return;
      }
      if (arg.toLowerCase() === 'history') {
        const rows = ctx.state.account?.craftHistory ?? [];
        ctx.state.sendSystemMessage(rows.length ? 'Recent crafts:' : 'No server crafting history.');
        for (const row of rows.slice(0, 10)) {
          ctx.state.sendSystemMessage(`  #${row.recipeId} ${row.name}${row.exceptional ? ' (exceptional)' : ''} — ${row.at}`);
        }
        return;
      }
      if (arg.toLowerCase() === 'cancel') {
        const queue = ctx.sender._craftQueue;
        if (!queue) ctx.state.sendSystemMessage('No crafting queue is active.');
        else {
          queue.cancelled = true;
          ctx.state.sendSystemMessage('The crafting queue will stop after the current attempt.');
        }
        return;
      }
      if (arg.toLowerCase().startsWith('material ')) {
        const name = arg.slice(9).trim().toLowerCase();
        const material = CRAFT_MATERIALS[name];
        if (!material) {
          ctx.state.sendSystemMessage(`Unknown material. Choose: ${Object.keys(CRAFT_MATERIALS).join(', ')}.`);
          return;
        }
        ctx.sender._craftMaterial = { name, ...material };
        ctx.state.sendSystemMessage(`Crafting material selected: ${name}.`);
        return;
      }
      if (arg.toLowerCase().startsWith('gump')) {
        const rest = arg.slice(4).trim().toLowerCase();
        const skillId = rest ? SKILL_ALIAS[rest] ?? null : null;
        const recipes = recipesForSelection(crafting, rest);
        const rich = supportsWorkbench(api, ctx.state);
        // The first five fields remain backwards compatible. Skill values on
        // the wire are human-facing (0.0–120.0), while recipes store tenths.
        // The largest authored branch is Inscription (97 recipes). The old
        // cap of 80 silently hid its final Mysticism entries from the visual
        // workbench. 256 remains comfortably below the packet guard while
        // making every individual craft branch complete.
        const rows = recipes.slice(0, 256).map((r) =>
          [
            r.id, String(r.name).replace(/[|;]/g, ' '), r.skillId,
            (r.minSkill / 10).toFixed(1), (r.maxSkill / 10).toFixed(1),
            ...(rich ? [
              encodeURIComponent(r.category ?? 'Other'), r.outputItemId ?? 0, r.outputCount ?? 1,
              encodeURIComponent(r.toolKind ?? ''),
              (r.inputs ?? []).slice(0, 16).map((i) => `${i.itemId | 0}:${i.count | 0}:`).join(','),
              Math.max(0, Math.min(1, ((skillValue(ctx.sender, r.skillId) * 10) - r.minSkill) /
                Math.max(1, r.maxSkill - r.minSkill))).toFixed(4),
              Math.max(0, Number(r.exceptionalChance ?? 0)).toFixed(4),
              (r.inputs ?? []).some((i) => (i.itemId | 0) === 0x1BF2)
                ? Object.entries(CRAFT_MATERIALS).map(([name, m]) =>
                  `${encodeURIComponent(name)}:${m.hue}:${m.skillReq / 10}`).join(',')
                : '',
            ] : []),
          ].join('|'),
        ).join(';');
        const skillVal = skillValue(ctx.sender, skillId);
        ctx.state.sendSystemMessage?.(
          `@@OPEN_CRAFT_GUMP@@${rest || 'all'}|${skillVal.toFixed(1)}|${rows}`,
        );
        return;
      }
      if (arg.toLowerCase().startsWith('batch ')) {
        const [, recipeArg = '', qtyRaw = '1'] = arg.match(/^batch\s+(\S+)\s*(\d*)/i) ?? [];
        const recipe = recipeByArg(crafting, recipeArg);
        if (!recipe) {
          ctx.state.sendSystemMessage(`No recipe matching "${recipeArg}".`);
          return;
        }
        startBatch(api, crafting, ctx, recipe, Number.parseInt(qtyRaw, 10) || 1);
        return;
      }
      if (!arg || arg.toLowerCase().startsWith('list')) {
        const rest = arg.slice(4).trim().toLowerCase();
        const selected = recipesForSelection(crafting, rest);
        if (rest && SPECIALIST_BRANCH[rest]) {
          if (!selected.length) ctx.state.sendSystemMessage('No recipes registered for that branch.');
          else {
            ctx.state.sendSystemMessage(`${selected.length} recipe(s):`);
            for (const recipe of selected.slice(0, 30)) {
              ctx.state.sendSystemMessage(
                `  #${recipe.id} ${recipe.name} — skill ${recipe.skillId} (${recipe.minSkill}-${recipe.maxSkill})`,
              );
            }
          }
          return;
        }
        const skillId = rest ? SKILL_ALIAS[rest] ?? null : null;
        return listRecipes(ctx, skillId, crafting);
      }
      const recipe = recipeByArg(crafting, arg);
      if (!recipe) {
        ctx.state.sendSystemMessage(`No recipe matching "${arg}".`);
        return;
      }
      // Bug-hunt #7 bonus: pass the crafting tool so its charges
      // decrement on success. Without `ctx.tool`, regular (non-runic)
      // tools never crumbled.
      // ServUO `CraftItem.Craft` — canonical apply-timer pattern:
      //   t = 0      → PlaySound(GetCraftPlaySound())        // initial tick
      //   t = Delay  → CompleteCraft (resolve + result msg)
      // The previous synchronous resolution skipped the delay window,
      // so [craft felt instant + the player heard one sound on result
      // instead of one sound at the start. Now we emit at t=0 and
      // schedule the actual `craft()` call after the per-skill Delay
      // (CRAFT_DELAY_MS). Per-crafter `_craftBusyUntil` stamp blocks
      // re-entry so you can't stack five [craft commands in 100ms.
      if (!scheduleAttempt(api, crafting, ctx, recipe)) {
        ctx.state.sendSystemMessage('You are still working on a craft.');
      }
    },
  });
  return () => api.commands.unregister?.('craft');
}
