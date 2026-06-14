// `[reforge <option> [serial]` — apply a Runic Reforging pass to a
// targeted item. Mirrors ServUO's `Skills/Imbuing/RunicReforging.cs`
// option flow (Powerful / Structural / Glorious / Fundamental). Tool
// tier is taken from the player's pack — first runic-tagged item we
// can find. With `[reforgeforce <toolName>` GM can override the tool.
//
// Usage:
//   [reforge powerful           — target an item, use the highest runic
//                                 tool the player owns
//   [reforge structural <ser>   — explicit serial
//   [reforgeforce verite powerful <serial>  — GM, force a tool tier
//   [reforgetools               — list known runic tool keys
//
// Cooldown: 8s (busy at the forge). Failure consumes the tool charge
// regardless. Success consumes one charge AND attaches `_magicProps`.

import { resolveItemArg } from '../_targeting-helpers.js';
import { packItems } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';

const COOLDOWN_MS = 8_000;

function findRunicToolInPack(api, mob, listTools) {
  // ServUO finds tools by class name (`Tool.Resource` member). We
  // tag pack items with `_runicTool: 'verite'` (set by smithy crafts);
  // pick the highest tier.
  const tools = listTools();
  const known = new Map(tools.map((t) => [t.key, t]));
  let best = null, bestTier = -1;
  for (const it of packItems(api, mob)) {
    const key = it._runicTool;
    if (!key || !known.has(key)) continue;
    const t = known.get(key);
    if (t.tier > bestTier) { best = { ...t, item: it }; bestTier = t.tier; }
  }
  return best;
}

export default function register(api) {
  if (!api.commands || !api.world || !api.systems?.runicReforging) return () => {};
  const { commands } = api;
  const reforgingSys = api.systems.runicReforging;
  const cooldowns = new Map();

  function gateCooldown(ctx) {
    const now = Date.now();
    const last = cooldowns.get(ctx.sender) ?? 0;
    if (now - last < COOLDOWN_MS) {
      ctx.state.sendSystemMessage('You are still busy at the anvil. Wait a moment.');
      return false;
    }
    cooldowns.set(ctx.sender, now);
    return true;
  }

  commands.register({
    name: 'reforge',
    help: '[reforge <option> [serial] — reforge an item using your runic tool. Options: powerful, structural, glorious, fundamental.',
    access: 'Player',
    run(ctx) {
      const args = ctx.args ?? [];
      const option = (args[0] ?? '').toLowerCase();
      if (!option || !reforgingSys.listOptions().includes(option)) {
        ctx.state.sendSystemMessage(
          `Usage: [reforge <${reforgingSys.listOptions().join('|')}> [serial]`,
        );
        return;
      }
      if (!gateCooldown(ctx)) return;
      resolveItemArg(api, { ...ctx, args: args }, 1, (item) => {
        if (!item) return;
        const tool = findRunicToolInPack(api, ctx.sender, reforgingSys.listTools);
        if (!tool) {
          ctx.state.sendSystemMessage(
            'You need a runic crafting tool in your backpack. Tag one with `_runicTool` (smith craft).',
          );
          return;
        }
        const res = reforgingSys.reforge(ctx.sender, item, tool.key, option);
        if (!res.ok) {
          ctx.state.sendSystemMessage(`Reforge failed: ${res.reason}.`);
          return;
        }
        // Spend a charge.
        tool.item._uses = Math.max(0, ((tool.item._uses ?? tool.charges) | 0) - 1);
        if (tool.item._uses <= 0) {
          destroyItemBySerial(api, tool.item.serial);
          ctx.state.send?.(api.protocol?.removeEntity?.(tool.item.serial));
          ctx.state.sendSystemMessage('Your runic tool crumbles to dust.');
        }
        ctx.state.sendSystemMessage(
          `Reforged with ${tool.key} → ${res.power} (${res.props.length} props, prefix=${res.prefix}).`,
        );
        for (const p of res.props) {
          ctx.state.sendSystemMessage(
            `  • ${p.attribute}${p.isFlag ? '' : ' ' + p.intensity}`,
          );
        }
      }, { promptText: 'Target the item to reforge.' });
    },
  });

  commands.register({
    name: 'reforgeforce',
    help: '[reforgeforce <tool> <option> <serial> — GM-only forced reforge bypassing pack lookup.',
    access: 'GM',
    run(ctx) {
      const args = ctx.args ?? [];
      const tool = args[0];
      const option = (args[1] ?? '').toLowerCase();
      if (!tool || !option) {
        ctx.state.sendSystemMessage('Usage: [reforgeforce <tool> <option> <serial>');
        return;
      }
      resolveItemArg(api, { ...ctx, args: args }, 2, (item) => {
        if (!item) return;
        const res = reforgingSys.reforge(ctx.sender, item, tool, option);
        if (!res.ok) {
          ctx.state.sendSystemMessage(`Forced reforge failed: ${res.reason}`);
          return;
        }
        ctx.state.sendSystemMessage(
          `Forced reforge: ${res.power} (${res.props.length} props).`,
        );
      }, { promptText: 'Target the item to force-reforge.' });
    },
  });

  commands.register({
    name: 'reforgetools',
    help: '[reforgetools — list known runic tool keys.',
    access: 'Player',
    run(ctx) {
      const tools = reforgingSys.listTools();
      ctx.state.sendSystemMessage(`Runic tools (${tools.length}):`);
      for (const t of tools) {
        ctx.state.sendSystemMessage(
          `  ${t.key.padEnd(14)} tier=${t.tier} props=${t.propCount[0]}-${t.propCount[1]} budget=${t.budget} charges=${t.charges}`,
        );
      }
    },
  });

  return () => {
    commands.unregister('reforge');
    commands.unregister('reforgeforce');
    commands.unregister('reforgetools');
  };
}
