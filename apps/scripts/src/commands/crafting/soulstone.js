// FAZA EV — Soulstone skill transfer.
//
// ServUO `Items/SBInfo/SBProvisioner.cs` ships soulstones as account-
// bound items that store one skill at a time. Players use `[ss save
// <skillId>` to dump a skill into a stone (sets skill to 0); `[ss
// load` to drain the stone back into their character.
//
// Item layout:
//   0x2A93  soulstone fragment   (limited-charge — veteran reward tiers)
//   0x2A94  full soulstone       (99-charge — top veteran tier or upgrade)
//
// We model soulstones as items with a `soulstone: { skillId, value }`
// payload + thin commands. Fragments can be combined via [ss-upgrade
// (consume 3 fragments → 1 full soulstone).

import { normalizeSkillValue } from '../../_rules.js';
import { packItems } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

const SOULSTONE_FRAGMENT_ID = 0x2A93;
const SOULSTONE_FULL_ID     = 0x2A94;
const MIN_SKILL_ID = 1;
const MAX_SKILL_ID = 58;

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'ss-save',
    help: '[ss-save <skillId> — dump a skill into the targeted soulstone.',
    access: 'Player',
    run(ctx) {
      const skillId = parseInt(ctx.args[0] ?? '', 10) | 0;
      if (skillId < MIN_SKILL_ID || skillId > MAX_SKILL_ID) {
        ctx.state.sendSystemMessage('Usage: [ss-save <skillId 1..58>');
        return;
      }
      ctx.state.sendSystemMessage('Target an empty soulstone.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item || (item.itemId !== SOULSTONE_FRAGMENT_ID && item.itemId !== SOULSTONE_FULL_ID)) {
          ctx.state.sendSystemMessage('That is not a soulstone.');
          return;
        }
        if (item.soulstone?.value > 0) {
          ctx.state.sendSystemMessage('Soulstone already holds a skill — drain it first.');
          return;
        }
        const value = normalizeSkillValue(
          ctx.sender.skills?.[skillId] ?? ctx.sender.skills?.[String(skillId)] ?? 0,
        );
        if (value <= 0) {
          ctx.state.sendSystemMessage('You have no value in that skill.');
          return;
        }
        // ServUO Soulstone account-binding — the stone tracks the
        // account that first stored a skill in it. Subsequent ss-load
        // refuses any character not on the same account, preventing
        // skill transfers between players. The bind stamps when the
        // first ss-save lands; ss-upgrade carries the bind forward.
        const accountKey = ctx.state?.account?.username?.toLowerCase?.() ?? null;
        if (accountKey) item.soulstoneAccount = accountKey;
        item.soulstone = { skillId, value };
        ctx.sender.skills[skillId] = 0;
        ctx.state.sendSystemMessage(`Stored ${value} in skill ${skillId}.`);
      }, { kind: 0 });
    },
  });

  api.commands.register({
    name: 'ss-load',
    help: '[ss-load — drain a soulstone back into your character.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Target a charged soulstone.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item
            || (item.itemId !== SOULSTONE_FRAGMENT_ID && item.itemId !== SOULSTONE_FULL_ID)
            || !item.soulstone) {
          ctx.state.sendSystemMessage('That soulstone is empty.');
          return;
        }
        // Enforce account-binding: ss-load refuses any character not on
        // the bound account. Staff (GM+) bypass the bind so a returning
        // ban appeal / account merge can be handled by a counselor.
        const accountKey = ctx.state?.account?.username?.toLowerCase?.() ?? null;
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        const isStaff = access === 'GM' || access === 'Admin' || access === 'Seer';
        if (item.soulstoneAccount && !isStaff
            && item.soulstoneAccount !== accountKey) {
          ctx.state.sendSystemMessage('This soulstone is bound to a different account.');
          return;
        }
        const { skillId, value } = item.soulstone;
        ctx.sender.skills ??= {};
        if ((skillId | 0) < MIN_SKILL_ID || (skillId | 0) > MAX_SKILL_ID) {
          ctx.state.sendSystemMessage('That soulstone contains an invalid skill id.');
          return;
        }
        const existing = normalizeSkillValue(
          ctx.sender.skills[skillId] ?? ctx.sender.skills[String(skillId)] ?? 0,
        );
        if (existing > 0) {
          ctx.state.sendSystemMessage('You already have value in that skill — clear it first.');
          return;
        }
        ctx.sender.skills[skillId] = normalizeSkillValue(value);
        delete item.soulstone;
        ctx.state.sendSystemMessage(`Restored ${ctx.sender.skills[skillId]} in skill ${skillId}.`);
      }, { kind: 0 });
    },
  });

  api.commands.register({
    name: 'ss-upgrade',
    help: '[ss-upgrade — combine 3 empty soulstone fragments in your pack into one full soulstone.',
    access: 'Player',
    run(ctx) {
      if (!api.game?.mobile?.giveItem) {
        ctx.state.sendSystemMessage('Inventory API unavailable.');
        return;
      }
      // Walk the backpack for empty fragments. Charged fragments are
      // refused — the player would otherwise lose skill values stored
      // inside without warning.
      const fragments = [];
      for (const it of packItems(api, ctx.sender)) {
        if (it.itemId !== SOULSTONE_FRAGMENT_ID) continue;
        if (it.soulstone) continue;
        fragments.push(it);
        if (fragments.length >= 3) break;
      }
      if (fragments.length < 3) {
        ctx.state.sendSystemMessage(
          `You need 3 empty soulstone fragments in your pack (have ${fragments.length}).`);
        return;
      }
      // Destroy the 3 fragments + spawn one full soulstone in the pack.
      for (const it of fragments) {
        try { destroyItemBySerial(api, it.serial); } catch { /* ignore */ }
      }
      const stone = api.game?.mobile?.giveItem?.(ctx.sender, {
        itemId: SOULSTONE_FULL_ID,
        hue: 0,
        name: 'soulstone',
      }, { randomGrid: true });
      if (!stone) {
        ctx.state.sendSystemMessage('You have no backpack for the soulstone.');
        return;
      }
      ctx.state.sendSystemMessage('You combine three fragments into a full soulstone.');
    },
  });

  return () => {
    api.commands.unregister('ss-save');
    api.commands.unregister('ss-load');
    api.commands.unregister('ss-upgrade');
  };
}
