// Imbue recipe scroll — double-click teaches the recipe to the
// player's account. Mirrors ServUO RecipeScroll.OnDoubleClick.
//
// On-account flag `account.recipes` is a Set of unlocked recipe keys.
// `[imbue` reads it before allowing high-tier crafts that gate on
// recipe unlock.

import { consumeOne } from '../_shared/consume.js';

export default function buildImbueRecipeScrollScript(api) {
  return {
    name: 'imbue-recipe-scroll',
    onUse(world, item, user) {
      const key = item.recipeUnlock;
      if (!key) {
        user?.client?.sendSystemMessage?.('This scroll is blank.');
        return true;
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
