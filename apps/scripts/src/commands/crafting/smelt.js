// FAZA DZ — `[smelt` ore→ingot conversion.
//
// ServUO `Items/Resources/Ores/BaseOre.cs`: dropping ore on a forge
// converts it to ingots at a 1:1 ratio (with skill-gated success).
// Without a forge proximity check, players could smelt anywhere.
// We model the same flow as a player command: stand within 2 tiles
// of any forge static (item id range 0x1985..0x199A) and run [smelt
// to convert all ore in your pack.

import { normalizeSkillValue } from '../../_rules.js';
import { packItems } from '../../_inventory.js';
import { allItems } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';

const SKILL_MINING = 46;
const FORGE_RANGE = 2;
// Forge graphic ids (anvil + lit forge variants from the Vendors atlas).
const FORGE_IDS = new Set([0x1985, 0x1986, 0x1987, 0x1988, 0x1995, 0x1996, 0x1997, 0x1998, 0x1999, 0x199A]);

function destroyWorldItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

export default function register(api) {
  if (!api.commands || !api.world || !api.game?.mobile?.giveItem) return () => {};

  api.commands.register({
    name: 'smelt',
    help: '[smelt — stand near a forge and convert ore to ingots.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      // Find a forge within range.
      let nearForge = false;
      const forges = api.game?.itemsNear?.(sender, { range: FORGE_RANGE })
        ?? api.query?.itemsNear?.(sender, FORGE_RANGE)
        ?? allItems(api);
      for (const it of forges) {
        if (!FORGE_IDS.has(it.itemId)) continue;
        if (it.parent) continue;
        if (it.map !== sender.map) continue;
        if (Math.abs(it.x - sender.x) > FORGE_RANGE) continue;
        if (Math.abs(it.y - sender.y) > FORGE_RANGE) continue;
        nearForge = true; break;
      }
      if (!nearForge) {
        ctx.state.sendSystemMessage('You must be within two paces of a forge.');
        return;
      }
      const skill = normalizeSkillValue(
        sender.skills?.[SKILL_MINING] ?? sender.skills?.[String(SKILL_MINING)] ?? 0,
      );
      const successChance = Math.min(0.95, Math.max(0.30, skill / 100));
      let totalConverted = 0;
      let totalLost = 0;
      for (const it of [...packItems(api, sender)]) {
        if (it.itemId !== 0x19B7) continue;       // iron ore graphic
        const amount = it.amount | 0;
        if (amount <= 0) continue;
        // ServUO: each ore in the stack rolls independently.
        let success = 0, fail = 0;
        for (let i = 0; i < amount; i++) {
          if (Math.random() < successChance) success += 1;
          else fail += 1;
        }
        // Consume the entire ore stack.
        destroyWorldItem(api, it);
        if (sender.client && api.protocol?.removeEntity) {
          sender.client.send(api.protocol.removeEntity(it.serial));
        }
        // Spawn ingot stack for successes.
        if (success > 0) {
          const ingot = api.game?.mobile?.giveItem?.(sender, {
            itemId: 0x1BF2,
            amount: success,
            name: 'iron ingot',
          }, { randomGrid: true });
          if (!ingot) {
            ctx.state.sendSystemMessage('You have no backpack for the ingots.');
            return;
          }
          totalConverted += success;
        }
        totalLost += fail;
      }
      if (totalConverted === 0 && totalLost === 0) {
        ctx.state.sendSystemMessage('You have no ore to smelt.');
        return;
      }
      ctx.state.sendSystemMessage(
        `Smelted ${totalConverted} ingot${totalConverted === 1 ? '' : 's'}.`
        + (totalLost > 0 ? ` (${totalLost} ore lost to inexperience.)` : ''),
      );
      api.skillGain?.tryGain?.(sender, SKILL_MINING, 50);
    },
  });

  return () => api.commands.unregister('smelt');
}
