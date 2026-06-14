// `[beg` — Begging skill against a target mobile. On success, target
// "donates" a small amount of gold to caster. Failure makes the target
// uncomfortable (system message). Cooldown 30s per target so begging
// isn't spammable.

import { adjustKarma } from '../_notoriety.js';
import { normalizeSkillValue } from '../_rules.js';
import { findBackpack, packItems } from '../_inventory.js';
import { mobileBySerial } from '../_entities.js';
import { destroyItemBySerial } from '../_items.js';

const SKILL_BEGGING = 7;
const HUMAN_BODIES = new Set([0x190, 0x191, 0x192, 0x193]);
const GOLD_PILE_ID = 0x0EED;
const BEG_REWARDS = [
  { itemId: 0x097F, name: "beggar's cheese wedge", amount: 1 },
  { itemId: 0x171F, name: "beggar's dates", amount: 1 },
  { itemId: 0x15F9, name: "beggar's stew", amount: 1 },
  { itemId: 0x0C77, name: "beggar's turnip", amount: 1 },
  { itemId: 0x09C8, name: "beggar's bottle of wine", amount: 1 },
  { itemId: 0x0A25, name: "beggar's lantern", amount: 1 },
  { itemId: 0x0EED, name: 'gold', amount: 1 },
];

const COOLDOWN_MS = 8_000;
const cooldown = new WeakMap();
const lastTargetTimes = new WeakMap(); // mob → Map<targetSerial, ms>

export default function register(api) {
  if (!api.targeting || !api.protocol || !api.items) return () => {};

  api.commands.register({
    name: 'beg',
    help: '[beg — implore a target for coin.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Wait before begging again.');
        return;
      }
      ctx.state.sendSystemMessage('Beg from whom?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target || target === mob) return;
        // Per-target rate-limit so the same NPC can't be milked.
        let perTarget = lastTargetTimes.get(mob);
        if (!perTarget) { perTarget = new Map(); lastTargetTimes.set(mob, perTarget); }
        const perLast = perTarget.get(target.serial) ?? 0;
        if (now - perLast < 30_000) {
          ctx.state.sendSystemMessage('That one is tired of you.');
          return;
        }
        // Only beg from human NPCs. ServUO Begging.cs requires
        // `Body.IsHuman && client == null` — players are not begging
        // targets, and only humanoid bodies hand out coin.
        if (target.client || !HUMAN_BODIES.has(target.body | 0)) {
          ctx.state.sendSystemMessage('You cannot beg from that.');
          return;
        }
        cooldown.set(mob, now);
        perTarget.set(target.serial, now);
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_BEGGING] ?? mob.skills?.[String(SKILL_BEGGING)] ?? 0,
        );
        const chance = Math.min(0.85, Math.max(0.15, skill / 100));
        // ServUO Begging.cs:135-156 — bad-karma roll: 50%-karma/8570 chance
        // the NPC refuses outright + applies -40 karma penalty.
        const badKarma = Math.max(0, 0.5 - (mob.karma | 0) / 8570);
        if (Math.random() < badKarma) {
          ctx.state.sendSystemMessage('They look at you with disdain.');
          adjustKarma(api, mob, -40);
          return;
        }

        if (Math.random() < chance) {
          // Cap by NPC fame (Fame/2500) like ServUO. Falls back to a
          // skill-based curve for fame-less spawns.
          const fameCap = Math.max(1, ((target.fame | 0) / 2500) | 0);
          const skillRoll = 1 + Math.floor(Math.random() * (3 + Math.floor(skill / 10)));
          const want = Math.min(skillRoll, fameCap || skillRoll);
          // Walk the target's pack via reverse-index, find a gold pile,
          // and CONSUME from it — no minting. ServUO uses
          // `theirPack.ConsumeUpTo(typeof(Gold), toConsume)`.
          let toConsume = want;
          const targetPack = findBackpack(api, target);
          if (targetPack) {
            for (const it of [...packItems(api, target)]) {
              if (toConsume <= 0) break;
              if (it.itemId !== GOLD_PILE_ID) continue;
              const take = Math.min(it.amount | 0, toConsume);
              if (take <= 0) continue;
              it.amount -= take;
              toConsume -= take;
              if (it.amount <= 0) {
                destroyItemBySerial(api, it.serial);
              } else if (api.items?.updateItem) {
                api.items.updateItem(api.world, it);
              } else {
                try { api.broadcast?.itemUpdate?.(api.world, it); } catch { /* advisory */ }
              }
            }
          }
          const got = want - toConsume;
          if (got <= 0) {
            const reward = BEG_REWARDS[Math.floor(Math.random() * BEG_REWARDS.length)];
            const item = api.game?.mobile?.giveItem?.(mob, { ...reward }, { randomGrid: true });
            if (!item) {
              ctx.state.sendSystemMessage('They have nothing you can carry.');
              return;
            }
            ctx.state.sendSystemMessage(`${target.name ?? 'They'} say, "Here, take this..."`);
            adjustKarma(api, mob, -40);
            return;
          }
          const gold = api.game?.mobile?.giveItem?.(mob, {
            itemId: GOLD_PILE_ID,
            amount: got,
            name: 'gold',
          }, { randomGrid: true });
          if (!gold) {
            ctx.state.sendSystemMessage('You have no backpack for the gold.');
            return;
          }
          ctx.state.sendSystemMessage(`${target.name ?? 'They'} hand you ${got} gold.`);
          // Begging is a low-honour deed — ServUO awards -40 karma per
          // success (capped). Stops players from skill-grinding it on
          // every shopkeeper for free profit.
          adjustKarma(api, mob, -40);
        } else {
          ctx.state.sendSystemMessage('They turn away in disgust.');
        }
        api.skillGain?.tryGain?.(mob, SKILL_BEGGING, 50);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('beg');
}
