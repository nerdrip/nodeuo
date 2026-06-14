// Utility skill commands — `[track`, `[lore`, `[id`, `[heal-pet`,
// `[provoke`, `[peace`, `[discord`, `[snoop`, `[spiritspeak`,
// `[meditate`. Each is a small skill-driven activity that fills out
// the rest of the canonical UO skill catalogue.
//
// These are deliberately compact — every command applies the same
// shape (target → range/role check → opposed roll → effect + skill
// gain) so you can read the lot quickly. Damage-dealing/spell-like
// behaviour stays in the spell modules; this file is for non-magic
// skills.

import { normalizeSkillValue } from '../../_rules.js';
import { childrenOf, findBackpack } from '../../_inventory.js';
import { allMobiles, allItems } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';

const SKILLS = {
  TRACKING: 39,
  ANIMAL_LORE: 3,
  ITEM_ID: 4,
  VETERINARY: 40,
  PROVOCATION: 23,
  PEACEMAKING: 10,
  DISCORDANCE: 16,
  SNOOPING: 29,
  SPIRIT_SPEAK: 33,
  MEDITATION: 47,
};

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

function distance(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

// FAZA FQ: bard instrument gate. ServUO bard skills require an
// instrument in the player's pack (lute 0x0EB1, lap harp 0x0EB2,
// drum 0x0E9C, tambourine 0x0E9D). BUGFIX #108: peace/provoke/
// discord were callable without any instrument — the skill cap was
// supposed to be gated by the instrument's quality (perfect lutes
// give 100% skill, broken lutes 50%). We bring the irreducible
// gate: presence-or-fail.
const BARD_INSTRUMENT_IDS = new Set([0x0EB1, 0x0EB2, 0x0E9C, 0x0E9D, 0x0E9E]);
function findInstrument(api, mob) {
  // FAZA HP / BUGFIX #130: walk parent chain so an instrument inside
  // a sub-bag (a "music kit" pouch) still counts. Same fix-pattern
  // as findReagent (FAZA DW #91). Plus pick the highest-quality
  // instrument so a perfect lute outranks a worn one.
  const ownedSerials = new Set([mob.serial >>> 0]);
  for (let depth = 0; depth < 4; depth++) {
    let added = false;
    for (const it of allItems(api)) {
      if (ownedSerials.has(it.parent >>> 0) && !ownedSerials.has(it.serial >>> 0)) {
        ownedSerials.add(it.serial >>> 0);
        added = true;
      }
    }
    if (!added) break;
  }
  let best = null, bestQ = -1;
  for (const it of allItems(api)) {
    if (!ownedSerials.has(it.parent >>> 0)) continue;
    if (!BARD_INSTRUMENT_IDS.has(it.itemId)) continue;
    // ServUO `BaseInstrument.Quality`: 0 = Low, 1 = Regular, 2 = Exceptional.
    const q = (it.instrumentQuality ?? 1) | 0;
    if (q > bestQ) { bestQ = q; best = it; }
  }
  return best;
}

// FAZA HP: instrument-quality skill modifier. Mirrors ServUO
// `BaseInstrument.GetEffectiveSkill`: Exceptional → +20% effective
// skill, Low → -20%, Regular → unchanged.
export function instrumentSkillMul(item) {
  const q = item?.instrumentQuality ?? 1;
  if (q >= 2) return 1.2;
  if (q <= 0) return 0.8;
  return 1.0;
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};
  const proto = api.protocol;

  // [track — list every mobile within ~12 tiles + their distance.
  api.commands.register({
    name: 'track', help: '[track — scan for nearby creatures.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const skill = skillOf(mob, SKILLS.TRACKING);
      const range = 6 + Math.floor(skill / 12); // 6..16 at GM
      const found = [];
      for (const m of allMobiles(api)) {
        if (m === mob) continue;
        if (m.map !== mob.map) continue;
        const d = distance(m, mob);
        if (d > range) continue;
        if (m.hidden && skillOf(mob, SKILLS.TRACKING) < 50) continue;
        found.push({ name: m.name ?? m.kind ?? '?', d });
      }
      found.sort((a, b) => a.d - b.d);
      ctx.state.sendSystemMessage(
        found.length === 0
          ? 'You see no creatures nearby.'
          : ['Nearby creatures:', ...found.slice(0, 10).map((f) => `  ${f.name} (${f.d} tiles)`)].join('\n'),
      );
      api.skillGain?.tryGain?.(mob, SKILLS.TRACKING, 50);
    },
  });

  // [lore — target a creature, dump its stats.
  api.commands.register({
    name: 'lore', help: '[lore — inspect a target creature.', access: 'Player',
    run(ctx) {
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const m = mobileBySerial(api, picked.serial >>> 0);
        if (!m) return;
        const lines = [
          `Creature: ${m.name ?? m.kind ?? '?'}`,
          `  HP: ${m.hp ?? 0}/${m.hpMax ?? 0}`,
          `  STR ${m.str ?? 0}  DEX ${m.dex ?? 0}  INT ${m.int ?? 0}`,
          `  Notoriety: ${m.notoriety ?? 1}`,
          m.controlMaster ? `  Owner: 0x${(m.controlMaster >>> 0).toString(16)}` : '  Wild',
        ];
        ctx.state.sendSystemMessage(lines.join('\n'));
        api.skillGain?.tryGain?.(ctx.sender, SKILLS.ANIMAL_LORE, 50);
      }, { kind: 0 });
    },
  });

  // [id — target an item, dump its template/itemId.
  api.commands.register({
    name: 'id', help: '[id — identify an item.', access: 'Player',
    run(ctx) {
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it) return;
        const tplName = it.template ?? '?';
        ctx.state.sendSystemMessage(
          `Item ${it.name ?? '?'} — itemId 0x${(it.itemId | 0).toString(16)}, template=${tplName}`,
        );
        api.skillGain?.tryGain?.(ctx.sender, SKILLS.ITEM_ID, 50);
      }, { kind: 0 });
    },
  });

  // [heal-pet — Veterinary. Heals an adjacent owned pet 30+skill/4 hp.
  api.commands.register({
    name: 'heal-pet', help: '[heal-pet — bandage an adjacent pet.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let pet = null;
      for (const m of allMobiles(api)) {
        if ((m.controlMaster >>> 0) !== (mob.serial >>> 0)) continue;
        if (distance(m, mob) > 1) continue;
        pet = m; break;
      }
      if (!pet) { ctx.state.sendSystemMessage('No pet adjacent.'); return; }
      // FAZA DK: bonded ghost pets can be revived by vet. Unbonded pets
      // stay dead and the master must wait for a shrine. BUGFIX #79:
      // before this, vet on a ghost pet just refilled its HP without
      // clearing the ghost flag — the pet stayed visually-ghost and
      // unable to fight, an infuriating dead-end after a tough fight.
      if (pet.ghost) {
        if (!pet.bonded) {
          ctx.state.sendSystemMessage('That pet has no soul-bond — only bonded pets can be revived.');
          return;
        }
        if (api.ctx?.corpse?.resurrectMobile) {
          api.ctx.corpse.resurrectMobile(api.world, pet, mob);
          ctx.state.sendSystemMessage(`${pet.name ?? 'your pet'} returns to your side.`);
        }
        api.skillGain?.tryGain?.(mob, SKILLS.VETERINARY, 80);
        return;
      }
      const heal = 20 + Math.floor(skillOf(mob, SKILLS.VETERINARY) / 4);
      pet.hp = Math.min(pet.hpMax ?? 50, (pet.hp ?? 0) + heal);
      ctx.state.sendSystemMessage(`You patch ${pet.name ?? 'your pet'} for ${heal}.`);
      api.skillGain?.tryGain?.(mob, SKILLS.VETERINARY, 60);
    },
  });

  // [peace — Peacemaking. Calms hostile mobs in radius for 10s.
  api.commands.register({
    name: 'peace', help: '[peace — calm hostile mobs in 8 tiles.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const instrument = findInstrument(api, mob);
      if (!instrument) {
        ctx.state.sendSystemMessage('You need an instrument in your pack.');
        return;
      }
      const skill = skillOf(mob, SKILLS.PEACEMAKING) * instrumentSkillMul(instrument);
      const chance = Math.min(0.95, Math.max(0.05, skill / 100));
      let calmed = 0;
      for (const m of allMobiles(api)) {
        if (m === mob) continue;
        if (m.map !== mob.map || distance(m, mob) > 8) continue;
        if ((m.notoriety ?? 1) < 4) continue;
        if (Math.random() >= chance) continue;
        api.statusEffects?.apply?.(m, { name: 'peace', durationMs: 10_000 });
        calmed++;
      }
      ctx.state.sendSystemMessage(`You calm ${calmed} foe(s).`);
      api.skillGain?.tryGain?.(mob, SKILLS.PEACEMAKING, 50);
    },
  });

  // [provoke — pit two adjacent hostile mobs against each other.
  api.commands.register({
    name: 'provoke', help: '[provoke — make foes fight each other.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const instrument = findInstrument(api, mob);
      if (!instrument) {
        ctx.state.sendSystemMessage('You need an instrument in your pack.');
        return;
      }
      const provokeSkillMul = instrumentSkillMul(instrument);
      api.targeting?.request?.(ctx.state, (a) => {
        if (!a?.serial) return;
        api.targeting?.request?.(ctx.state, (b) => {
          if (!b?.serial) return;
          const m1 = mobileBySerial(api, a.serial >>> 0);
          const m2 = mobileBySerial(api, b.serial >>> 0);
          if (!m1 || !m2 || m1 === m2) return;
          const skill = skillOf(mob, SKILLS.PROVOCATION) * provokeSkillMul;
          if (Math.random() * 100 < skill) {
            // Set m1's combat target to m2 by attaching aggressive AI.
            api.ai?.attach?.(m1, 'aggressive', { kind: m1.kind, targetSerial: m2.serial >>> 0 });
            api.ai?.attach?.(m2, 'aggressive', { kind: m2.kind, targetSerial: m1.serial >>> 0 });
            ctx.state.sendSystemMessage('They fall upon each other.');
          } else {
            ctx.state.sendSystemMessage('They ignore your goading.');
          }
          api.skillGain?.tryGain?.(mob, SKILLS.PROVOCATION, 60);
        }, { kind: 0 });
      }, { kind: 0 });
    },
  });

  // [discord — debuff target's combat for 30s.
  api.commands.register({
    name: 'discord', help: '[discord — sour notes weaken a foe.', access: 'Player',
    run(ctx) {
      const instrument = findInstrument(api, ctx.sender);
      if (!instrument) {
        ctx.state.sendSystemMessage('You need an instrument in your pack.');
        return;
      }
      const discordSkillMul = instrumentSkillMul(instrument);
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target) return;
        const skill = skillOf(ctx.sender, SKILLS.DISCORDANCE) * discordSkillMul;
        if (Math.random() * 100 >= skill) {
          ctx.state.sendSystemMessage('They shrug off your dirge.');
        } else {
          api.statusEffects?.apply?.(target, { name: 'discord', durationMs: 30_000 });
          ctx.state.sendSystemMessage('Discord settles into them.');
        }
        api.skillGain?.tryGain?.(ctx.sender, SKILLS.DISCORDANCE, 60);
      }, { kind: 0 });
    },
  });

  // [snoop — peek at target's pack (just print contents to journal).
  api.commands.register({
    name: 'snoop', help: '[snoop — sneak a peek inside a target\'s pack.', access: 'Player',
    run(ctx) {
      api.targeting?.request?.(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const victim = mobileBySerial(api, picked.serial >>> 0);
        if (!victim) return;
        const skill = skillOf(ctx.sender, SKILLS.SNOOPING);
        if (Math.random() * 100 >= skill) {
          ctx.state.sendSystemMessage('They catch you peeking.');
          victim.client?.sendSystemMessage?.(`${ctx.sender.name ?? 'Someone'} tries to peek into your pack.`);
        } else {
          const pack = findBackpack(api, victim);
          if (!pack) { ctx.state.sendSystemMessage('They have no pack.'); return; }
          const contents = [];
          for (const it of childrenOf(api, pack)) {
            contents.push(it.name ?? `0x${it.itemId.toString(16)}`);
          }
          ctx.state.sendSystemMessage(
            contents.length === 0
              ? 'Their pack is empty.'
              : `Contents: ${contents.slice(0, 10).join(', ')}${contents.length > 10 ? '…' : ''}`,
          );
        }
        api.skillGain?.tryGain?.(ctx.sender, SKILLS.SNOOPING, 60);
      }, { kind: 0 });
    },
  });

  // [spiritspeak — channel from a corpse: drains it, gain mana.
  api.commands.register({
    name: 'spiritspeak', help: '[spiritspeak — commune with a nearby corpse for mana.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      let corpse = null;
      for (const it of allItems(api)) {
        if (it.itemId !== 0x2006) continue;
        if (it.map !== mob.map) continue;
        if (distance(it, mob) > 2) continue;
        corpse = it; break;
      }
      if (!corpse) { ctx.state.sendSystemMessage('No corpse adjacent.'); return; }
      const skill = skillOf(mob, SKILLS.SPIRIT_SPEAK);
      const mana = Math.min(mob.manaMax ?? 50, (mob.mana ?? 0) + 4 + Math.floor(skill / 12));
      mob.mana = mana;
      if (mob.client && proto.manaUpdate) {
        mob.client.send(proto.manaUpdate({ serial: mob.serial, current: mana, max: mob.manaMax ?? 50 }));
      }
      ctx.state.sendSystemMessage('The dead share their wisdom.');
      api.skillGain?.tryGain?.(mob, SKILLS.SPIRIT_SPEAK, 50);
    },
  });

  // [meditate — accelerate mana regen for 30s.
  api.commands.register({
    name: 'meditate', help: '[meditate — focus your spirit to recover mana faster.', access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      api.statusEffects?.apply?.(mob, { name: 'meditation', durationMs: 30_000 });
      ctx.state.sendSystemMessage('You enter a meditative trance.');
      api.skillGain?.tryGain?.(mob, SKILLS.MEDITATION, 50);
    },
  });

  return () => {
    for (const c of [
      'track','lore','id','heal-pet','peace','provoke','discord','snoop','spiritspeak','meditate',
    ]) api.commands.unregister(c);
  };
}
