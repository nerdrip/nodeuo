// Imbue recipe scroll — double-click teaches the recipe to the
// player's account. Mirrors ServUO RecipeScroll.OnDoubleClick.
//
// On-account flag `account.recipes` is a Set of unlocked recipe keys.
// `[imbue` reads it before allowing high-tier crafts that gate on
// recipe unlock.

import { consumeOne } from '../_shared/consume.js';
import { isInPack } from '../../../_inventory.js';
import { normalizeSkillValue } from '../../../_rules.js';

const SPECIALIST_MANUALS = Object.freeze({
  glassblowing: { skillId: 1, skillName: 'Alchemy' },
  masonry: { skillId: 12, skillName: 'Carpentry' },
});

export default function buildImbueRecipeScrollScript(api) {
  return {
    name: 'imbue-recipe-scroll',
    onUse(world, item, user) {
      const key = item.recipeUnlock;
      if (!key) {
        user?.client?.sendSystemMessage?.('This scroll is blank.');
        return true;
      }
      if (!isInPack({ ...api, world }, item, user)) {
        user?.client?.sendSystemMessage?.('That manual must be in your backpack.');
        return true;
      }
      const manual = SPECIALIST_MANUALS[key];
      if (manual) {
        const rawSkill = user?.skills?.[manual.skillId] ?? user?.skills?.[String(manual.skillId)] ?? 0;
        if (normalizeSkillValue(rawSkill) < 100) {
          user?.client?.sendSystemMessage?.(`Only a Grandmaster ${manual.skillName} crafter can learn from this manual.`);
          return true;
        }
      }
      const account = user?.client?.account ?? user?.account;
      if (!account) {
        user?.client?.sendSystemMessage?.('No account context.');
        return true;
      }
      account.recipes ??= new Set();
      if (Array.isArray(account.recipes)) account.recipes = new Set(account.recipes);
      if (account.recipes.has(key)) {
        user.client.sendSystemMessage?.('You already know this recipe.');
        return true;
      }
      account.recipes.add(key);
      user.client.sendSystemMessage?.(`You commit the ${item.name ?? 'recipe'} to memory.`);
      // Recipe scroll consumed.
      consumeOne(api ?? {}, world, item, user);
      return true;
    },
  };
}
