// Legacy Inscription command. The generic crafting transaction remains the
// single authoritative path for resources, mana, skill checks and output.

import { itemBySerial } from '../../_entities.js';
import { isInPack } from '../../_inventory.js';

function copyBook(api, ctx) {
  if (!api.targeting?.request || !api.spellbooks?.get) {
    ctx.state.sendSystemMessage('Spellbook copying is unavailable.');
    return;
  }
  ctx.state.sendSystemMessage('Target the source spellbook.');
  api.targeting.request(ctx.state, (first) => {
    const sourceItem = itemBySerial(api, first?.serial);
    const source = sourceItem && isInPack(api, sourceItem, ctx.sender)
      ? api.spellbooks.get(sourceItem.serial) : null;
    if (!source) {
      ctx.state.sendSystemMessage('That is not one of your spellbooks.');
      return;
    }
    ctx.state.sendSystemMessage('Target the destination spellbook.');
    api.targeting.request(ctx.state, (second) => {
      const targetItem = itemBySerial(api, second?.serial);
      const target = targetItem && isInPack(api, targetItem, ctx.sender)
        ? api.spellbooks.get(targetItem.serial) : null;
      if (!target || target.serial === source.serial || target.offset !== source.offset) {
        ctx.state.sendSystemMessage('Choose a different, compatible spellbook in your pack.');
        return;
      }
      api.spellbooks.register({ ...target, content: source.content });
      api.spellbooks.sendContent?.(ctx.state, target.serial);
      ctx.state.sendSystemMessage('You copy the known spells into the destination book.');
    });
  });
}

export default function register(api) {
  if (!api.commands?.register) return () => {};
  api.commands.register({
    name: 'inscribe',
    help: '[inscribe [spell-name|copy-book] — open Inscription or write a known spell.',
    access: 'Player',
    run(ctx) {
      const arg = (Array.isArray(ctx.args) ? ctx.args.join(' ') : (ctx.args ?? '')).trim();
      if (arg.toLowerCase() === 'copy-book') return copyBook(api, ctx);
      if (!arg) {
        api.commands.dispatch('craft gump inscription', ctx);
        return;
      }
      const spells = api.systems?.spells?.allSpells?.() ?? [];
      const query = arg.toLowerCase();
      const spell = spells.find((entry) => entry.name.toLowerCase() === query)
        ?? spells.find((entry) => entry.name.toLowerCase().includes(query));
      if (!spell) {
        ctx.state.sendSystemMessage(`Unknown spell "${arg}".`);
        return;
      }
      const recipe = api.systems?.crafting?.allRecipes?.()
        .find((entry) => entry.requiresSpell === spell.id);
      if (!recipe) {
        ctx.state.sendSystemMessage(`${spell.name} has no craftable scroll.`);
        return;
      }
      api.commands.dispatch(`craft ${recipe.id}`, ctx);
    },
  });
  return () => api.commands.unregister('inscribe');
}
