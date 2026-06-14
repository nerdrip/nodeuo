// Information skills — `[anatomy`, `[armslore`, `[evalint`, `[tasteid`.
// Each lets the player target a mobile/item and prints details
// proportional to their skill level. Mirrors ServUO's
// Skills/{Anatomy,ArmsLore,EvalInt,TasteID}.cs.

import { normalizeSkillValue } from '../../_rules.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';

const SKILL_ANATOMY  = 2;
const SKILL_ARMSLORE = 5;
const SKILL_EVALINT  = 17;
const SKILL_TASTEID  = 37;

function describeMobByAnatomy(target, skill) {
  // ServUO buckets at every 10 skill points. Below 50 only crude ranges.
  const str = target.str | 0;
  const dex = target.dex | 0;
  const stam = target.stam | 0;
  const sb = (n, lo, hi) => n < lo ? 'feeble' : n < hi ? 'unremarkable' : 'mighty';
  if (skill < 50) return `${target.name ?? 'creature'} looks ${sb(str, 30, 80)}.`;
  if (skill < 80) return `${target.name ?? 'creature'} — Str ~${Math.round(str / 10) * 10}, Dex ~${Math.round(dex / 10) * 10}.`;
  return `${target.name ?? 'creature'} — Str ${str}, Dex ${dex}, Stamina ${stam}/${target.stamMax | 0}.`;
}

function describeWeaponByLore(item, skill) {
  if (!item.weapon) {
    if (item.armor) return `${item.name ?? 'piece'} — armor rating ${item.armor.ar | 0}.`;
    return `${item.name ?? 'item'} is not a weapon or armor.`;
  }
  const w = item.weapon;
  if (skill < 50) return `${item.name ?? 'weapon'} — looks ordinary.`;
  if (skill < 80) return `${item.name ?? 'weapon'} — damage roughly ${w.minDmg | 0}-${w.maxDmg | 0}, speed ${w.speed | 0}.`;
  const dur = item.durability != null ? `, durability ${item.durability}/${item.durabilityMax ?? '?'}` : '';
  const slayer = item.slayer ? `, slayer (${item.slayer})` : '';
  return `${item.name ?? 'weapon'} — dmg ${w.minDmg | 0}-${w.maxDmg | 0}, speed ${w.speed | 0}${dur}${slayer}.`;
}

function describeMana(target, skill) {
  const mana = target.mana | 0;
  const max  = target.manaMax | 0;
  const intel = target.intel | 0;
  if (skill < 30) return `${target.name ?? 'creature'} appears mentally ordinary.`;
  if (skill < 70) return `${target.name ?? 'creature'} — mana ~${Math.round(mana / 5) * 5}/${max}.`;
  return `${target.name ?? 'creature'} — Int ${intel}, Mana ${mana}/${max}.`;
}

function describeFood(item, skill) {
  if (item.poison) {
    return skill > 60
      ? `It is laced with ${['lesser', 'normal', 'greater', 'deadly', 'lethal'][item.poison.level | 0]} poison.`
      : 'It tastes off — possibly poisoned.';
  }
  return 'It seems edible.';
}

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  function infoCmd(name, skillId, help, handler) {
    api.commands.register({
      name, help, access: 'Player',
      run(ctx) {
        const sender = ctx.sender;
        const rawSkill = sender.skills?.[skillId] ?? sender.skills?.[String(skillId)] ?? 0;
        const skill = normalizeSkillValue(rawSkill);
        if (skill < 1) {
          ctx.state.sendSystemMessage(`You have no skill in that.`);
          return;
        }
        ctx.state.sendSystemMessage('Select a target.');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked) return;
          const sub = picked.serial
            ? (mobileBySerial(api, picked.serial) ?? itemBySerial(api, picked.serial))
            : null;
          if (!sub) { ctx.state.sendSystemMessage('Invalid target.'); return; }
          ctx.state.sendSystemMessage(handler(sub, skill));
        });
      },
    });
  }

  infoCmd('anatomy', SKILL_ANATOMY, '[anatomy — appraise a creature\'s build.', describeMobByAnatomy);
  infoCmd('armslore', SKILL_ARMSLORE, '[armslore — inspect a weapon or armor piece.', describeWeaponByLore);
  infoCmd('evalint', SKILL_EVALINT, '[evalint — gauge a target\'s mana / intellect.', describeMana);
  infoCmd('tasteid', SKILL_TASTEID, '[tasteid — taste-test food or drink for poison.', describeFood);

  return () => {
    api.commands.unregister('anatomy');
    api.commands.unregister('armslore');
    api.commands.unregister('evalint');
    api.commands.unregister('tasteid');
  };
}
