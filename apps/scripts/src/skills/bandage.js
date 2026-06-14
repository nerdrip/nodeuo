// `[bandage` — use a bandage to heal yourself or a target.
//
// ServUO bandages take ~5 seconds to apply and heal based on both Healing
// and Anatomy skills. Failing the Healing check burns the bandage without
// healing; succeeding heals a skill-scaled amount and awards skill gain on
// both Healing and Anatomy.
//
// The bandage is consumed up front (like reagents on a spell) to prevent
// double-use while the timer is ticking. A per-mobile "busy" flag blocks
// starting a second bandage mid-apply.

import { normalizeSkillValue } from '../_rules.js';
import { childrenOf, equipped, packItems } from '../_inventory.js';
import { mobileBySerial } from '../_entities.js';
import { destroyItemBySerial } from '../_items.js';

const SKILL_HEALING = 18;
const SKILL_ANATOMY = 2;
const BANDAGE_ITEM_ID = 0x0E21;
const ENHANCED_BANDAGE_HUE = 0x08A5;
const ENHANCED_BANDAGE_BONUS = 10;

// Audit #43 P2-7 — ServUO `Bandage.cs:718-746 GetDelay` scales by Dex:
//   self:  min(8, ceil(11 - dex/20))   capped ≥4 (so 4..8 seconds)
//   other: ceil(4 - dex/60)             capped ≥2 (so 2..4 seconds)
// Was: flat 5s for every case → 100-Dex healer takes 5s instead of 2s
// helping a friend; 30-Dex healer takes 5s instead of 10s self-healing.
function bandageDelayMs(caster, patient) {
  const dex = (caster?.dex ?? 50) | 0;
  if (!patient || patient === caster || patient.serial === caster?.serial) {
    return Math.max(4, Math.min(8, Math.ceil(11 - dex / 20))) * 1000;
  }
  return Math.max(2, Math.ceil(4 - dex / 60)) * 1000;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.protocol || !api.targeting || !api.templates) {
    api.log('commands/bandage: protocol/targeting/templates missing; skipping');
    return () => {};
  }

  function skillOf(mob, id) {
    if (!mob?.skills) return 0;
    return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
  }

  function isBandage(item) {
    if (!item || (item.amount | 0) <= 0) return false;
    const tpl = api.templates.get?.('bandage');
    const classes = [item.servuoClass, ...(item.servuoClasses ?? [])].filter(Boolean);
    return item.itemId === (tpl?.itemId ?? BANDAGE_ITEM_ID)
      || item.itemId === BANDAGE_ITEM_ID
      || item.tagId === 'bandage'
      || item.tagId === 'enhanced-bandage'
      || classes.includes('Bandage')
      || classes.includes('EnhancedBandage');
  }

  function bandageHealingBonus(item) {
    if (!item) return 0;
    const explicit = Number(item.bandageHealingBonus ?? 0);
    if (explicit > 0) return explicit;
    const classes = [item.servuoClass, ...(item.servuoClasses ?? [])].filter(Boolean);
    if (classes.includes('EnhancedBandage')) return ENHANCED_BANDAGE_BONUS;
    if (item.tagId === 'enhanced-bandage') return ENHANCED_BANDAGE_BONUS;
    if ((item.itemId | 0) === BANDAGE_ITEM_ID && (item.hue | 0) === ENHANCED_BANDAGE_HUE) {
      return ENHANCED_BANDAGE_BONUS;
    }
    if (/enhanced bandage/i.test(item.name ?? '')) return ENHANCED_BANDAGE_BONUS;
    return 0;
  }

  function isFirstAidBelt(item) {
    if (!item) return false;
    const classes = [item.servuoClass, ...(item.servuoClasses ?? [])].filter(Boolean);
    return item.firstAidBelt === true
      || item.script === 'first-aid-belt'
      || item.tagId === 'first-aid-belt'
      || item.tagId === 'khaldun-first-aid-belt'
      || classes.includes('FirstAidBelt')
      || classes.includes('KhaldunFirstAidBelt');
  }

  function equippedBeltHealingBonus(caster) {
    let best = 0;
    for (const item of equipped(api, caster)) {
      if (!isFirstAidBelt(item)) continue;
      best = Math.max(best, item.firstAidHealingBonus | 0);
    }
    return best;
  }

  function* beltBandages(caster) {
    for (const item of equipped(api, caster)) {
      if (!isFirstAidBelt(item)) continue;
      yield* childrenOf(api, item);
    }
  }

  function findBandage(caster) {
    let first = null;
    let enhanced = null;
    const consider = (it) => {
      if (!isBandage(it)) return;
      first ??= it;
      if (bandageHealingBonus(it) > 0) {
        enhanced = it;
      }
    };
    for (const it of beltBandages(caster)) {
      consider(it);
      if (enhanced) break;
    }
    if (!enhanced) {
      for (const it of packItems(api, caster)) {
        consider(it);
        if (enhanced) break;
      }
    }
    return enhanced ?? first;
  }

  function consumeOne(caster, stack) {
    stack.amount = (stack.amount | 0) - 1;
    if (stack.amount <= 0) {
      // BUGFIX #63 (FAZA CU): the previous path used
      // `world.items.delete(serial)` directly, bypassing `destroyItem`
      // — same class of bug as #30 in lifecycle scripts. onDestroy
      // hooks (and any future cleanup added to destroyItem) silently
      // skipped. Routes through the script facade so lifecycle hooks
      // stay centralized even when tests provide only a bare world.
      destroyItemBySerial(api, stack.serial);
      if (caster.client) caster.client.send(api.protocol.removeEntity(stack.serial));
    } else if (caster.client) {
      caster.client.send(api.protocol.containerContentUpdate({
        serial: stack.serial, itemId: stack.itemId,
        amount: stack.amount, hue: stack.hue ?? 0,
        gridX: stack.gridX ?? 0, gridY: stack.gridY ?? 0,
        gridLocation: stack.gridLocation ?? 0,
      }, stack.parent ?? caster.serial));
    }
  }

  // ServUO success formula: caster must pass a skill check against a difficulty
  // scaled from the patient's damage. We keep it simple: damage is all we have,
  // and difficulty is capped at 100 so a healer can always try.
  function successChance(caster, patient, healingBonus = 0) {
    const healing = skillOf(caster, SKILL_HEALING) + Math.max(0, healingBonus | 0);
    const anatomy = skillOf(caster, SKILL_ANATOMY);
    const hpMax = patient.hpMax ?? 50;
    const missing = Math.max(0, (hpMax - (patient.hp ?? 0)));
    // Higher missing HP = higher difficulty (it's "harder" to triage a near-dead
    // patient than to top off a scratch). Range roughly 10..100.
    const difficulty = Math.min(100, 10 + (missing / Math.max(1, hpMax)) * 90);
    const best = Math.max(healing, (healing + anatomy) / 2);
    if (best >= difficulty + 25) return 1;
    if (best <= difficulty - 25) return 0;
    return (best - (difficulty - 25)) / 50;
  }

  function healAmount(caster, healingBonus = 0) {
    const healing = skillOf(caster, SKILL_HEALING) + Math.max(0, healingBonus | 0);
    const anatomy = skillOf(caster, SKILL_ANATOMY);
    const base = Math.floor(healing / 4 + anatomy / 8);
    return Math.max(4, base + 1 + Math.floor(Math.random() * 4));
  }

  function applyBandage(caster, patient, state, context = null) {
    if (!caster || !patient) return;
    if (caster.map !== patient.map) {
      state?.sendSystemMessage?.('Your target is no longer here.');
      return;
    }
    const difficulty = 50;
    const award = api.combat?.awardSkill ?? api.skillGain?.tryGain;
    const healing = skillOf(caster, SKILL_HEALING);
    const anatomy = skillOf(caster, SKILL_ANATOMY);

    // ServUO `Items/Resource/Bandage.cs::BandageContext.EndHeal` branches:
    // (a) dead patient + healing>=80 + anatomy>=80 → resurrect prompt;
    // (b) poisoned → cure-poison check vs (healing+anatomy)-30;
    // (c) bleeding → clears `_bleedUntil`;
    // (d) otherwise → regular HP heal.

    // (a) Resurrect a corpse / ghost.
    if ((patient.hp ?? 0) <= 0 || patient.ghost) {
      if (healing < 80 || anatomy < 80) {
        state?.sendSystemMessage?.('You are not skilled enough to resurrect them.');
        return;
      }
      const success = Math.random() < Math.min(0.9, (healing + anatomy - 160) / 40);
      if (!success) {
        state?.sendSystemMessage?.('You fail to revive them.');
        if (caster.skills && Math.random() < 0.5) award?.(caster, SKILL_HEALING, difficulty);
        return;
      }
      const corpseSys = api.systems?.corpse ?? api.corpse;
      if (corpseSys?.resurrectMobile) {
        corpseSys.resurrectMobile(api.world, patient);
      } else if (api.combat?.resurrectMobile) {
        api.combat.resurrectMobile(api.world, patient);
      } else {
        // Last-ditch fallback — clear ghost flag + restore 1 HP. Server's
        // own res path will sweep on next 0x2C client request.
        patient.ghost = false;
        patient.hp = Math.max(1, Math.floor((patient.hpMax ?? 50) * 0.1));
      }
      // ServUO `BandageContext.EndHeal` resurrect branch plays BOTH the
      // 0x214 resurrection chime AND the generic 0x57 bandage heal SFX
      // before falling through. Two distinct samples, fired on the
      // patient (the chime first, then the wrap).
      try { api.combat?.playSoundNear?.(api.world, patient, 0x214); } catch { /* sfx advisory */ }
      try { api.combat?.playSoundNear?.(api.world, patient, 0x057); } catch { /* sfx advisory */ }
      state?.sendSystemMessage?.(
        caster === patient ? 'You are revived.' : `You revive ${patient.name ?? 'them'}.`,
      );
      if (caster.skills) {
        award?.(caster, SKILL_HEALING, difficulty);
        award?.(caster, SKILL_ANATOMY, difficulty);
      }
      return;
    }

    // (b) Poison cure — Audit #40 P2 #13 — ServUO `Bandage.cs:441-457`
    // uses Healing alone (NOT healing+anatomy) and requires both
    // skills ≥60 before even rolling. Formula:
    //   chance = (healing - 30) / 50 - lvl * 0.1 - slips * 0.02
    // Was: `(healing+anatomy)/100 - lvl*0.3` produced a steep curve
    // that gave low-skill medics 0% on Greater Poison while still
    // letting them roll on Deadly. The ServUO half-timer self-heal
    // poison/bleed check now runs in startApply() and reduces the
    // final heal through context.healedPoisonOrBleed.
    if (patient.poisoned) {
      const lvl = (patient.poisonLevel ?? 1) | 0;
      if (healing < 60 || anatomy < 60) {
        state?.sendSystemMessage?.('You don\'t have the skill to cure that poison.');
        if (caster.skills && Math.random() < 0.5) award?.(caster, SKILL_HEALING, difficulty);
        return;
      }
      const chance = Math.max(0, Math.min(1, ((healing - 30) / 50) - lvl * 0.1));
      if (Math.random() < chance) {
        patient.poisoned = false;
        patient.poisonLevel = 0;
        try { api.systems?.statusEffects?.clear?.(patient, 'poison'); }
        catch { /* advisory */ }
        try { api.combat?.playSoundNear?.(api.world, patient, 0x057); } catch { /* sfx advisory */ }
        state?.sendSystemMessage?.(
          caster === patient ? 'You cure yourself of poison.' : `You cure ${patient.name ?? 'them'} of poison.`,
        );
        if (caster.skills) {
          award?.(caster, SKILL_HEALING, difficulty);
          award?.(caster, SKILL_ANATOMY, difficulty);
        }
        return;
      }
      state?.sendSystemMessage?.('You fail to cure the poison.');
      if (caster.skills) {
        // Audit #43 P2-17 — ServUO awards BOTH Healing and Anatomy
        // skill on cure-fail. Was: only Healing → bandage cure-fail
        // grinder skipped Anatomy.
        if (Math.random() < 0.5) award?.(caster, SKILL_HEALING, difficulty);
        if (Math.random() < 0.5) award?.(caster, SKILL_ANATOMY, difficulty);
      }
      return;
    }

    // (c) Bleed clear — Splintering bleed proc / Mortal Strike bleed.
    if ((patient._bleedUntil ?? 0) > Date.now()) {
      patient._bleedUntil = 0;
      try { api.combat?.playSoundNear?.(api.world, patient, 0x057); } catch { /* sfx advisory */ }
      state?.sendSystemMessage?.('You staunch the bleeding.');
      if (caster.skills) award?.(caster, SKILL_HEALING, difficulty);
      return;
    }

    // (d) Standard heal — only after the above filters miss.
    if ((patient.hp ?? 0) >= (patient.hpMax ?? 50)) {
      state?.sendSystemMessage?.('That being is not in need of healing.');
      return;
    }
    const healingBonus = Math.max(0, context?.healingBonus | 0);
    if (Math.random() >= successChance(caster, patient, healingBonus)) {
      state?.sendSystemMessage?.('You fail to apply the bandages properly.');
      if (caster.skills && Math.random() < 0.5) award?.(caster, SKILL_HEALING, difficulty);
      return;
    }
    const midFactor = Math.max(0, context?.healedPoisonOrBleed | 0);
    const heal = midFactor > 0
      ? Math.max(1, Math.floor(healAmount(caster, healingBonus) / midFactor))
      : healAmount(caster, healingBonus);
    patient.hp = Math.min(patient.hpMax ?? 50, (patient.hp ?? 0) + heal);
    // ServUO `BandageContext.EndHeal` plays the heal SFX 0x057 on success.
    // User report 2026-05-19 "brakuje dźwięków jak ratuje się z kalectwa".
    try { api.combat?.playSoundNear?.(api.world, patient, 0x057); } catch { /* sfx advisory */ }
    if (patient.client) {
      patient.client.send(api.protocol.healthUpdate({
        serial: patient.serial, current: patient.hp, max: patient.hpMax ?? 50,
      }));
    }
    // Also refresh the healer's view of the patient.
    if (caster.client && caster !== patient) {
      caster.client.send(api.protocol.healthUpdate({
        serial: patient.serial, current: patient.hp, max: patient.hpMax ?? 50,
      }));
    }
    if (caster === patient) {
      state?.sendSystemMessage?.(`You heal yourself for ${heal}.`);
    } else {
      state?.sendSystemMessage?.(`You heal ${patient.name ?? 'your patient'} for ${heal}.`);
    }
    if (caster.skills) {
      award?.(caster, SKILL_HEALING, difficulty);
      award?.(caster, SKILL_ANATOMY, difficulty);
    }
  }

  /** Serials currently mid-bandage. Prevents stacking attempts. */
  const busy = new Set();

  /**
   * Start the ~5s apply timer. The bandage is already consumed. On resolve
   * we run the skill check + heal. If the caster disconnects mid-apply we
   * silently drop — state.mobile will still exist on the world, but there's
   * no one to notify.
   */
  function startApply(caster, patient, state, bandage = null) {
    busy.add(caster.serial);
    // Audit #43 P2-7 — DEX-scaled apply delay per ServUO.
    const applyMs = bandageDelayMs(caster, patient);
    const context = {
      healedPoisonOrBleed: 0,
      healingBonus: bandageHealingBonus(bandage) + equippedBeltHealingBonus(caster),
    };
    // Buff icon — pushes a "Healing" status badge to the caster's
    // HUD with the remaining-time countdown. Mirrors ServUO
    // `BandageContext.OnAdd` AddBuffPacket(BuffIcon.Healing).
    if (caster.client && api.protocol?.buffAdd) {
      try {
        caster.client.send(api.protocol.buffAdd({
          serial: caster.serial,
          name: 'healing',
          kind: 'buff',
          remainingMs: applyMs,
        }));
      } catch { /* protocol shape mismatch tolerated */ }
    }
    const canMidCheck = caster.serial === patient.serial
      && skillOf(caster, SKILL_HEALING) >= 80
      && skillOf(caster, SKILL_ANATOMY) >= 80;
    if (canMidCheck && applyMs >= 3000) {
      setTimeout(() => {
        if (!busy.has(caster.serial)) return;
        const liveCaster = mobileBySerial(api, caster.serial);
        const livePatient = mobileBySerial(api, patient.serial);
        if (!liveCaster || !livePatient) return;
        if (liveCaster.map !== livePatient.map) return;
        const poisoned = !!livePatient.poisoned;
        const bleeding = (livePatient._bleedUntil ?? 0) > Date.now();
        if (!poisoned && !bleeding) return;
        const healing = skillOf(liveCaster, SKILL_HEALING);
        const anatomy = skillOf(liveCaster, SKILL_ANATOMY);
        let chance = ((healing + anatomy) - 120) * 25;
        const poisonLevel = Math.max(1, livePatient.poisonLevel | 0);
        chance /= poisoned ? poisonLevel * 20 : 3 * 20;
        if (chance < Math.random() * 100) return;
        if (poisoned) {
          livePatient.poisoned = false;
          livePatient.poisonLevel = 0;
          context.healedPoisonOrBleed = poisonLevel;
          try { api.systems?.statusEffects?.clear?.(livePatient, 'poison'); }
          catch { /* advisory */ }
          state?.sendSystemMessage?.('The poison begins to fade under the bandage.');
        } else if (bleeding) {
          livePatient._bleedUntil = 0;
          livePatient._bleedDmg = 0;
          context.healedPoisonOrBleed = 3;
          state?.sendSystemMessage?.('You bind the wound and stop the bleeding.');
        }
      }, Math.floor(applyMs / 2)).unref?.();
    }

    setTimeout(() => {
      busy.delete(caster.serial);
      if (caster.client && api.protocol?.buffRemove) {
        try {
          caster.client.send(api.protocol.buffRemove({
            serial: caster.serial, name: 'healing',
          }));
        } catch { /* advisory */ }
      }
      // Bail out if the caster vanished from the world in the meantime.
      if (!mobileBySerial(api, caster.serial)) return;
      const stillAlive = mobileBySerial(api, patient.serial);
      if (!stillAlive) {
        state?.sendSystemMessage?.('Your patient is gone.');
        return;
      }
      try { applyBandage(caster, stillAlive, state, context); }
      catch (e) { console.error('[bandage] apply threw:', e); }
    }, applyMs).unref?.();
  }

  api.commands.register({
    name: 'bandage',
    help: '[bandage [self] — use a bandage; prompts for a target unless "self".',
    access: 'Player',
    run(ctx, args) {
      const state = ctx.state;
      const caster = ctx.sender;
      if (!state?.mobile) return;
      if (busy.has(caster.serial)) {
        state.sendSystemMessage('You are already applying a bandage.');
        return;
      }
      const stack = findBandage(caster);
      if (!stack) {
        state.sendSystemMessage('You have no clean bandages.');
        return;
      }
      const wantsSelf = (args[0] ?? '').trim().toLowerCase() === 'self';
      if (wantsSelf) {
        const used = stack;
        consumeOne(caster, stack);
        state.sendSystemMessage('You begin applying the bandages.');
        startApply(caster, caster, state, used);
        return;
      }
      state.sendSystemMessage('Who will you use the bandages on?');
      api.targeting.request(state, (picked) => {
        if (!picked || !picked.serial) {
          state.sendSystemMessage('Cancelled.');
          return;
        }
        const patient = mobileBySerial(api, picked.serial >>> 0);
        if (!patient) {
          state.sendSystemMessage('You cannot heal that.');
          return;
        }
        const used = stack;
        consumeOne(caster, stack);
        state.sendSystemMessage('You begin applying the bandages.');
        startApply(caster, patient, state, used);
      });
    },
  });

  return () => api.commands.unregister('bandage');
}
