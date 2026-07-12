// FAZA BU — Bulk Order Deed lifecycle script + `[bod` admin command.
//
// Registers an item-script named `bulk-order-deed` that:
//   - on double-click, prints the BOD's status (label, progress, reward)
//   - clears its own state via onDestroy when the deed is consumed
// And adds `[bod <skill>` so testers can spawn a deed at their feet.

import { nearbyClients } from '../../_spatial.js';
import { bodsSystem } from '../../_bods.js';
import { createItem } from '../../_items.js';

const BOD_ITEM_ID = 0x14EF;   // scroll graphic — same family as the
                              // power-scrolls so the deed reads as
                              // "important paper" on the ground.

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  const bods = bodsSystem(api);
  if (!bods) {
    api.log?.('bulk-order-deeds: BOD system unavailable');
    return () => {};
  }

  api.itemScripts?.register?.({
    name: 'bulk-order-deed',
    onUse(_world, item, user) {
      const bod = item.bod;
      if (!bod) {
        user?.client?.sendSystemMessage?.('This deed is blank.');
        return true;
      }
      // Faza H.2 — large BODs open the rich overlay; small BODs keep
      // the text-dump (single-row content fits in chat fine).
      if (bod.large && user?.client?.sendSystemMessage) {
        const slots = (bod.slots ?? []).map((s) =>
          `${s.material ?? ''}|${s.done ? 1 : 0}|${(s.label ?? '').replace(/[|;]/g, '_')}`,
        ).join(';');
        const payload = [
          (item.serial >>> 0).toString(16),
          (bod.label ?? 'Large Bulk Order').replace(/[|;]/g, '_'),
          slots,
        ].join('||');
        user.client.sendSystemMessage(`@@OPEN_LARGEBOD_GUMP@@${payload}`);
        return true;
      }
      const lines = (bod.large ? formatLargeBod(bod) : bods.formatBod(bod)).split('\n');
      for (const line of lines) {
        user?.client?.sendSystemMessage?.(line);
      }
      return true;
    },
  });

  function formatLargeBod(bod) {
    const out = [
      `Large Bulk Order: ${bod.label}`,
      `  Skill: ${bod.skill}`,
      `  Material: ${bod.material}`,
      bod.exceptional ? '  Exceptional required' : '  Regular quality',
      `  Reward: ${bod.reward}`,
      '  Slots:',
    ];
    for (const s of bod.slots) {
      out.push(`    ${s.done ? '✓' : '·'} ${s.label}`);
    }
    return out.join('\n');
  }

  api.commands.register({
    name: 'addbod',
    help: '[addbod <skillId> — admin: spawn a small bulk-order deed (8=Smithy, 35=Tailor)',
    access: 'Admin',
    run(ctx) {
      const skillId = parseInt(ctx.args?.[0] ?? '8', 10);
      const bod = bods.makeRandomBOD(skillId);
      if (!bod) {
        ctx.state.sendSystemMessage(`No BOD catalogue for skill ${skillId}.`);
        return;
      }
      spawnBodAtSender(ctx, bod);
    },
  });

  api.commands.register({
    name: 'largebod',
    help: '[largebod <recipe> — spawn a large bulk-order deed. Recipes: '
        + Object.keys(bods._LARGE_BOD_RECIPES ?? {}).join(', '),
    run(ctx) {
      const key = (ctx.args?.[0] ?? '').toLowerCase();
      const bod = bods.makeLargeBOD(key);
      if (!bod) {
        ctx.state.sendSystemMessage(
          `Unknown large BOD: ${key}. Available: ${Object.keys(bods._LARGE_BOD_RECIPES ?? {}).join(', ')}`,
        );
        return;
      }
      spawnBodAtSender(ctx, bod);
    },
  });

  function spawnBodAtSender(ctx, bod) {
    const item = createItem(api, api.world, {
      itemId: BOD_ITEM_ID,
      x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
      name: bod.label,
      // Large BODs render in gold hue; exceptional small BODs blue.
      hue: bod.large ? 0x44E : (bod.exceptional ? 0x66D : 0x046),
    });
    item.script = 'bulk-order-deed';
    item.bod = bod;
    const wi = api.protocol?.worldItemSA?.({
      serial: item.serial, itemId: item.itemId, hue: item.hue,
      amount: item.amount ?? 1, x: item.x, y: item.y, z: item.z,
    });
    if (wi) {
      for (const m of nearbyClients(api.world, item)) m.client.send(wi);
    }
    ctx.state.sendSystemMessage(`Deed: ${bod.label}`);
  }

  return () => {
    api.commands.unregister('bod');
    api.commands.unregister('largebod');
  };
}
