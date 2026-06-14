// `[cast <spell>` — cast a Magery spell.
//
// Pipeline: mana check + deduction → reagent check + consumption → fizzle
// roll (skill-based) → optional target cursor → effect/damage/heal.
//
// Spell definitions live in `apps/scripts/src/spells/circle{1..8}/<name>.js`.
// This file is just the dispatcher: it knows how to spend resources, prompt
// for a target, and call into a spell's `cast` function.

import { SPELLS } from '../../spells/index.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import {
  consumeReagents, fizzleChance, magerySkill, SKILL_MAGERY,
} from '../../spells/_helpers.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol || !api.combat || !api.targeting) {
    api.log('commands/cast: protocol/combat/targeting missing; skipping');
    return () => {};
  }

  api.commands.register({
    name: 'cast',
    help: 'cast <name> — cast a magery spell (consumes mana + reagents)',
    access: 'Player',
    run(ctx, args) {
      const state = ctx.state;
      const caster = ctx.sender;
      if (!state?.mobile) return;
      const name = (args[0] ?? '').trim().toLowerCase();
      const spell = SPELLS[name];
      if (!spell) {
        state.sendSystemMessage(`Usage: [cast ${Object.keys(SPELLS).join('|')}`);
        return;
      }
      // FAZA AI — Chivalry uses Tithing Points instead of mana. Each
      // chiv spell carries a `tithe` cost (default 5); when the school
      // is 'chivalry' we consume from `caster.tithingPoints`. Other
      // schools fall through to the mana check.
      // FAZA FP: magic wand bypass — wand-driven casts skip mana,
      // tithing, and reagent gates. The lifecycle script sets
      // `_wandCast` on the caster for one tick.
      // FAZA HA: GM+ bypass — GameMasters and Admins skip every cost
      // check (mana, tithing, reagents). Mirrors ServUO `Mobile.cs::
      // CheckResources` short-circuit when AccessLevel >= GameMaster.
      // Allows staff to demo spells / debug without farming reagents.
      const wandCast = Boolean(caster._wandCast);
      const accessLevel = state?.account?.accessLevel ?? 'Player';
      const isStaff = accessLevel === 'GM' || accessLevel === 'Admin';
      const bypassCosts = wandCast || isStaff;
      // Faster Cast Recovery (FCR) — gates how soon after a cast the
      // mage can cast again. Base recovery is 1.0 s; each FCR point
      // shaves 0.25 s off the gate, capped at 6 (1.5 s). Mirrors
      // ServUO `Spell.GetCastRecovery`.
      if (!isStaff) {
        const now = Date.now();
        // Two separate gates:
        //   `_castInProgressUntil` — animation/delay window during the
        //     active cast. Cannot start a new cast at all while this is
        //     in the future (ServUO `Spell.IsCasting` short-circuit).
        //   `_nextCastAt` — Faster Cast Recovery — applies AFTER cast
        //     resolves; gates how soon you can BEGIN the next cast.
        if ((caster._castInProgressUntil ?? 0) > now) {
          state.sendSystemMessage('You must wait for the previous spell to take effect.');
          return;
        }
        const cd = caster._nextCastAt ?? 0;
        if (cd > now) {
          state.sendSystemMessage('You are too tired to cast another spell yet.');
          return;
        }
        // FCR recovery — base 1s minus 0.25s per FCR point, floor 0.25s.
        const fcr = Math.min(6, (api.attributes?.effective?.(caster)?.fasterCastRecovery | 0));
        const gate = Math.max(250, 1000 - fcr * 250);
        // FC cast delay — per-circle in ServUO. base 0.25s + circle*0.25s
        // minus FC (0.25s per point, floor 0.25s). At circle 1 with FC=0
        // → 0.5s. At circle 8 with FC=2 → 2.0s. Caps mirror ServUO.
        const fc  = Math.min(4, (api.attributes?.effective?.(caster)?.fasterCasting | 0));
        const circle = spell.circle ?? 1;
        const castMs = Math.max(250,
          Math.floor((0.25 + circle * 0.25 - fc * 0.25) * 1000));
        caster._castInProgressUntil = now + castMs;
        caster._nextCastAt = now + castMs + gate;
      }
      // AOS Lower Mana Cost / Lower Reagent Cost (capped at 40 % each).
      // Read the caster's effective magic-property attributes; if the
      // helper isn't bundled (test harness) the values stay 0.
      const _ea = api.attributes?.effective?.(caster) ?? {};
      const lmc = Math.min(40, (_ea.lowerManaCost | 0));
      const lrc = Math.min(50, (_ea.lowerReagentCost | 0));
      let manaMul = 1 - lmc / 100;
      // Necromancy Mind Rot — +50 % mana cost while the debuff is live.
      if ((caster._mindRotUntil ?? 0) > Date.now()) manaMul *= 1.5;
      const effectiveMana = Math.max(1, Math.floor((spell.mana ?? 0) * manaMul));
      if (!bypassCosts) {
        if (spell.school === 'chivalry') {
          const tithe = spell.tithe ?? 5;
          if ((caster.tithingPoints ?? 0) < tithe) {
            state.sendSystemMessage('You lack the tithing points to invoke this prayer.');
            return;
          }
          caster.tithingPoints = (caster.tithingPoints ?? 0) - tithe;
        } else if ((caster.mana ?? 0) < effectiveMana) {
          state.sendSystemMessage('Insufficient mana.');
          return;
        }
        // LRC roll — % chance per reagent slot to skip consumption.
        const skipReagents = Math.random() * 100 < lrc;
        if (!skipReagents) {
          const res = consumeReagents(api, caster, spell.reagents);
          if (!res.ok) {
            state.sendSystemMessage(`You lack the reagent: ${res.missing.replace(/^reagent-/, '')}.`);
            return;
          }
        }
      }
      if (!bypassCosts && spell.school !== 'chivalry') {
        caster.mana = (caster.mana ?? 0) - effectiveMana;
        if (caster.client) {
          caster.client.send(api.protocol.manaUpdate({
            serial: caster.serial, current: caster.mana, max: caster.manaMax ?? 50,
          }));
        }
      }
      // Skill check — mana and reagents are gone either way (matches OSI: a
      // low-skill mage who fizzles still loses materials, that's what makes
      // training Magery worth it). Effect only fires on success.
      // Difficulty for skill gain is the spell's midpoint — the bell curve
      // peaks where caster ≈ spell power, so casting higher-circle spells
      // accelerates training as you grow.
      const difficulty = (spell.minSkill + spell.maxSkill) / 2;
      const fizzled = Math.random() < fizzleChance(caster, spell);
      const award = api.combat.awardSkill ?? api.skillGain?.tryGain;
      if (fizzled) {
        state.sendSystemMessage('The spell fizzles.');
        // Even a fizzle teaches the mage *something* — at half rate.
        if (caster.skills && Math.random() < 0.5) award?.(caster, SKILL_MAGERY, difficulty);
        return;
      }
      if (caster.skills) award?.(caster, SKILL_MAGERY, difficulty);
      // Mysticism Spell Trigger — if the caster armed a wand earlier
      // with `[cast spell-trigger`, divert THIS spell into the wand
      // instead of firing it. The wand stores the spell name + 1
      // charge; subsequent uses of the wand fire the bound spell.
      if (caster._pendingSpellTrigger) {
        const wand = itemBySerial(api, caster._pendingSpellTrigger >>> 0);
        delete caster._pendingSpellTrigger;
        if (wand) {
          wand.magicSpell   = spell.name;
          wand.magicCharges = ((wand.magicCharges | 0) + 1);
          state.sendSystemMessage(`The wand absorbs the ${spell.name} spell.`);
          return;
        }
      }
      if (!spell.needsTarget) {
        spell.cast(api, ctx);
        return;
      }
      state.sendSystemMessage('Select a target.');
      // Location-targeted spells (teleport, fire-field, etc) hand the raw
      // {x,y,z} through; kind=1 tells the client to show the location reticle.
      const isLocation = spell.targetKind === 'location';
      api.targeting.request(state, (picked) => {
        if (!picked) { state.sendSystemMessage('Spell fizzled.'); return; }
        if (isLocation) { spell.cast(api, ctx, picked); return; }
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target) { state.sendSystemMessage('Invalid target.'); return; }
        spell.cast(api, ctx, target);
      }, { kind: isLocation ? 1 : 0 });
    },
  });
}

// Re-export so external callers (UI, AI) can introspect the spell list
// without reaching across the directory boundary.
export { SPELLS, SPELLS_BY_CIRCLE } from '../../spells/index.js';

// Exposed for the magerySkill helper when other commands need to read the
// caster's skill (e.g. mage-ai picking a circle to cast).
export { magerySkill };
