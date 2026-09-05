// `[powerscroll` and `[statscroll` — admin commands that simulate
// consuming a power-scroll (raises a single skill cap by 5/10/15/20)
// or a stat-scroll (raises STR/DEX/INT cap by 5..25).
//
// We track caps in two new fields on the mobile:
//   `skillCaps` — { [skillId]: number }    default 100, max 120 with +20
//   `statCaps`  — { str, dex, int }         default 100, max 125 with +25
//
// The skill-gain headroom uses the existing hardcoded 120 ceiling, so
// raising a cap purely informational for now (PHASE P part 2 will plug
// per-mob caps into the gain formula). Boss drops + champion rewards
// route through this same code so a player who beats a champ altar
// gets the same +5/+10 they'd get on retail.

import { packItems } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';

const POWER_AMOUNTS = [5, 10, 15, 20];
const STAT_AMOUNTS = [5, 10, 15, 20, 25];

export default function register(api) {
  if (!api.commands || !api.game?.mobile?.giveItem) return () => {};

  api.commands.register({
    name: 'powerscroll',
    help: '[powerscroll <skillId> <5|10|15|20> — raise own skill cap.',
    access: 'Admin',
    run(ctx) {
      const skillId = Number(ctx.args[0] ?? 0) | 0;
      const amount = Number(ctx.args[1] ?? 0) | 0;
      if (skillId <= 0 || skillId > 58) {
        ctx.state.sendSystemMessage('Bad skill id (1..58).');
        return;
      }
      if (!POWER_AMOUNTS.includes(amount)) {
        ctx.state.sendSystemMessage(`Amount must be one of ${POWER_AMOUNTS.join(', ')}.`);
        return;
      }
      ctx.sender.skillCaps ??= {};
      const old = ctx.sender.skillCaps[skillId] ?? 100;
      const next = Math.min(120, old + amount);
      ctx.sender.skillCaps[skillId] = next;
      const skill = api.skills?.byId?.get?.(skillId);
      ctx.state.sendSystemMessage(
        `${skill?.name ?? `Skill ${skillId}`} cap: ${old} → ${next}.`,
      );
    },
  });

  api.commands.register({
    name: 'statscroll',
    help: '[statscroll <str|dex|int> <5..25> — raise own stat cap.',
    access: 'Admin',
    run(ctx) {
      const stat = String(ctx.args[0] ?? '').toLowerCase();
      const amount = Number(ctx.args[1] ?? 0) | 0;
      if (!['str','dex','int'].includes(stat)) {
        ctx.state.sendSystemMessage('Stat must be str|dex|int.');
        return;
      }
      if (!STAT_AMOUNTS.includes(amount)) {
        ctx.state.sendSystemMessage(`Amount must be one of ${STAT_AMOUNTS.join(', ')}.`);
        return;
      }
      ctx.sender.statCaps ??= { str: 100, dex: 100, int: 100 };
      const old = ctx.sender.statCaps[stat];
      const next = Math.min(125, old + amount);
      ctx.sender.statCaps[stat] = next;
      ctx.state.sendSystemMessage(`${stat.toUpperCase()} cap: ${old} → ${next}.`);
    },
  });

  // PHASE DT — `[ps-combine` combines two power scrolls of the same
  // skill at the same tier into one of the next tier. ServUO's
  // `Skills/PowerScrollDeed.cs` has a similar combine path (used for
  // tournament rewards). Tiers: +5 → +10 → +15 → +20 → max.
  // Power-scroll items live as ordinary items with a `powerScroll`
  // payload `{ skillId, amount }`. We find two matching scrolls in
  // the player's pack and merge them.
  api.commands.register({
    name: 'ps-combine',
    help: '[ps-combine <skillId> — combine two same-tier power scrolls into the next tier.',
    access: 'Player',
    run(ctx) {
      const skillId = Number(ctx.args[0] ?? 0) | 0;
      if (skillId <= 0) {
        ctx.state.sendSystemMessage('Usage: [ps-combine <skillId>');
        return;
      }
      const matches = [];
      for (const it of packItems(api, ctx.sender)) {
        const ps = it.powerScroll;
        if (!ps || ps.skillId !== skillId) continue;
        matches.push({ item: it, amount: ps.amount });
      }
      if (matches.length < 2) {
        ctx.state.sendSystemMessage('You need two power scrolls of the same skill.');
        return;
      }
      // Group by amount and find a pair.
      matches.sort((a, b) => a.amount - b.amount);
      const a = matches[0];
      const b = matches.find((m) => m !== a && m.amount === a.amount);
      if (!b) {
        ctx.state.sendSystemMessage('You need two scrolls of the SAME tier.');
        return;
      }
      const tierIdx = POWER_AMOUNTS.indexOf(a.amount);
      const nextAmount = POWER_AMOUNTS[tierIdx + 1];
      if (nextAmount == null) {
        ctx.state.sendSystemMessage('You cannot combine scrolls beyond the maximum tier.');
        return;
      }
      if (!api.game.inventory?.findBackpack?.(ctx.sender)) {
        ctx.state.sendSystemMessage('You have no backpack for the new scroll.');
        return;
      }
      // Audit #33 P1 #5 — destroyItem instead of raw delete so reverse
      // indices + sectors + lifecycle hooks all clean up.
      destroyItemBySerial(api, a.item.serial);
      destroyItemBySerial(api, b.item.serial);
      if (ctx.sender.client && api.protocol?.removeEntity) {
        ctx.sender.client.send(api.protocol.removeEntity(a.item.serial));
        ctx.sender.client.send(api.protocol.removeEntity(b.item.serial));
      }
      const fresh = api.game?.mobile?.giveItem?.(ctx.sender, {
        itemId: 0x14EF,
        name: `power scroll +${nextAmount}`,
        hue: 0x481,
      }, { randomGrid: true });
      if (!fresh) {
        ctx.state.sendSystemMessage('You have no backpack for the new scroll.');
        return;
      }
      fresh.powerScroll = { skillId, amount: nextAmount };
      ctx.state.sendSystemMessage(
        `Two +${a.amount} scrolls fused into one +${nextAmount} scroll.`,
      );
    },
  });

  return () => {
    api.commands.unregister('powerscroll');
    api.commands.unregister('statscroll');
    api.commands.unregister('ps-combine');
  };
}
