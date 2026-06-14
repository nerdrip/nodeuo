// `[vet` — Veterinary skill. Heals pets / friendly creatures using
// bandages. ServUO Skills/Veterinary.cs: each successful application
// heals 5..15 + Vet/15 HP, fizzles if the target is human (only
// Healing skill applies to players). Burns 1 bandage on success;
// keeps it on resist (fizzle).

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { destroyItemBySerial } from '../_items.js';
import { sendToClientsNear } from '../_spatial.js';
import { mobileBySerial } from '../_entities.js';

const SKILL_VETERINARY = 40;
const SKILL_ANIMAL_LORE =  3;
const COOLDOWN_MS = 10_000;
const cooldown = new WeakMap();

function readSkill(mob, id) {
  if (!mob.skills) return 0;
  const raw = mob.skills[id] ?? mob.skills[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.targeting || !api.skillGain || !api.world) return () => {};

  api.commands.register({
    name: 'vet',
    help: '[vet — bandage-heal a pet or animal.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const now = Date.now();
      const last = cooldown.get(mob) ?? 0;
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You must wait before bandaging again.');
        return;
      }
      // Simple pack-search for a bandage (UO art id 0x0E21).
      const bandage = findInPack(api, mob, (it) => it.itemId === 0x0E21);
      if (!bandage) {
        ctx.state.sendSystemMessage('You have no bandages.');
        return;
      }
      ctx.state.sendSystemMessage('Heal which animal?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target) return;
        // Restrict to non-human bodies — humans heal via [bandage / Healing.
        const isHuman = target.body === 0x0190 || target.body === 0x0191;
        if (isHuman) {
          ctx.state.sendSystemMessage('Use the Healing skill on humans.');
          return;
        }
        if ((target.hp ?? 0) >= (target.hpMax ?? 0)) {
          ctx.state.sendSystemMessage('That creature is already at full health.');
          return;
        }
        cooldown.set(mob, now);
        // Skill check: Veterinary primary, Animal Lore as a 50% bonus.
        const vet  = readSkill(mob, SKILL_VETERINARY);
        const lore = readSkill(mob, SKILL_ANIMAL_LORE);
        const score = vet + lore * 0.5;
        const success = Math.random() * 100 < score;
        if (!success) {
          ctx.state.sendSystemMessage('You failed to heal the animal.');
          api.skillGain.tryGain?.(mob, SKILL_VETERINARY, 0.6);
          return;
        }
        const heal = 5 + Math.floor(Math.random() * 11) + Math.floor(vet / 15);
        target.hp = Math.min(target.hpMax ?? target.hp, (target.hp | 0) + heal);
        // Consume one bandage from the stack.
        if ((bandage.amount | 0) > 1) {
          bandage.amount -= 1;
          try { api.broadcast?.itemUpdate?.(api.world, bandage); } catch { /* advisory */ }
        } else {
          destroyItemBySerial(api, bandage);
        }
        ctx.state.sendSystemMessage(`You heal the ${target.name ?? 'creature'} for ${heal} hit points.`);
        api.skillGain.tryGain?.(mob, SKILL_VETERINARY, 1.0);
        // Broadcast updated HP.
        if (api.protocol?.healthUpdate) {
          const pkt = api.protocol.healthUpdate({
            serial: target.serial, current: target.hp, max: target.hpMax ?? target.hp,
          });
          sendToClientsNear(api, target, pkt);
        }
      });
    },
  });

  return () => api.commands.unregister('vet');
}
