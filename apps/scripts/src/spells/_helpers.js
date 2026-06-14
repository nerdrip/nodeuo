// Shared spell helpers. Each function takes `api` as its first argument so
// the per-spell modules stay declarative — they only describe what the spell
// does, not how to walk the world or push packets.
//
// Kept deliberately small: anything that is one-off (e.g. a unique sound id,
// a unique gfx) lives inline in the spell file.

import { reveal } from '../_visibility.js';
import { descendantsOf as inventoryDescendantsOf, equipped as equippedItems } from '../_inventory.js';
import {
  nearbyClients,
  nearbyItems,
  nearbyMobiles,
  sendToClientsNear as sendSpatialToClientsNear,
} from '../_spatial.js';
import { normalizeSkillValue } from '../_rules.js';
import { destroyItemBySerial } from '../_items.js';
import { destroyMobileBySerial } from '../_mobiles.js';

export const SKILL_MAGERY = 26;
export const SKILL_RESIST = 27;
export const SKILL_EVAL_INT = 17;
// Skill IDs sourced from apps/scripts/src/data/config/skills.json (1-based, the
// canonical wire id). Earlier passes used Necromancy=32 and Mysticism=60
// which collided with Archery and an out-of-range slot — fixed here so
// fizzleChance reads the right skill column for each school.
export const SKILL_NECROMANCY = 50;
export const SKILL_SPIRIT_SPEAK = 33;
export const SKILL_CHIVALRY = 52;
export const SKILL_BUSHIDO = 53;
export const SKILL_NINJITSU = 54;
export const SKILL_SPELLWEAVING = 55;
export const SKILL_MYSTICISM = 56;
const SPELL_DIFFICULTY_BY_CIRCLE = [0, 10, 25, 40, 55, 70, 85, 100, 110];

function destroyConsumedItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

export function* clientsNear(api, world, center, range = 18, self = null) {
  yield* nearbyClients(api?.world ? api : world, center, self, range);
}

export function* mobilesNear(api, center, range = 18, self = null) {
  yield* nearbyMobiles(api, center, self, range);
}

export function* itemsNear(api, center, range = 18) {
  yield* nearbyItems(api, center, range);
}

function sendToClientsNear(api, world, center, packet, range = 18, self = null) {
  return sendSpatialToClientsNear(api?.world ? api : world, center, packet, self, range);
}

function* descendantsOf(api, parentSerial) {
  yield* inventoryDescendantsOf(api, parentSerial);
}

function spellFocusingOffset(api, caster, target) {
  if (!caster || !target) return 0;
  let sash = null;
  for (const item of equippedItems(api, caster)) {
    if (item?.spellFocusing) { sash = item; break; }
  }
  if (!sash) return 0;

  const targetSerial = target.serial >>> 0;
  if ((sash.spellCastTargetSerial >>> 0) !== targetSerial) {
    sash.spellCastTargetSerial = targetSerial;
    sash.spellCastCount = 0;
    caster.client?.sendSystemMessage?.('Spell focusing damage has reset.');
  }

  sash.spellCastCount = Math.min(21, (sash.spellCastCount | 0) + 1);
  const count = sash.spellCastCount | 0;
  const offset = count <= 5 ? -(count * 6) : ((count - 6) * 2);
  caster._spellFocusingOffset = offset;
  caster._spellFocusingTargetSerial = targetSerial;

  if (offset === 0) caster.client?.sendSystemMessage?.('Spell focusing damage has now been tuned to your opponent.');
  if (count >= 21) {
    sash.spellCastTargetSerial = 0;
    sash.spellCastCount = 0;
    caster.client?.sendSystemMessage?.('Spell focusing damage has peaked.');
  }
  return Math.max(-30, Math.min(30, offset));
}

/** Map spell school → primary cast skill id. Spells default to magery
 *  if no `school` is set, preserving backward compatibility with all
 *  64 existing Magery files. */
export function skillIdForSchool(school) {
  switch (school) {
    case 'necromancy':    return SKILL_NECROMANCY;
    case 'chivalry':      return SKILL_CHIVALRY;
    case 'bushido':       return SKILL_BUSHIDO;
    case 'ninjitsu':      return SKILL_NINJITSU;
    case 'spellweaving':  return SKILL_SPELLWEAVING;
    case 'mysticism':     return SKILL_MYSTICISM;
    default:              return SKILL_MAGERY;
  }
}

/** Find the first matching reagent stack in caster's backpack by template name. */
export function findReagent(api, caster, templateName) {
  const tpl = api.templates?.get?.(templateName);
  if (!tpl) return null;
  // BUGFIX #91 (FAZA DW): the previous implementation only scanned
  // items DIRECTLY parented to the caster — i.e. items at layer level
  // in the paperdoll. Real UO players keep reagents in a "reagent bag"
  // tucked inside their backpack, which means the reagent's `parent`
  // is the bag's serial (not the mob). Casts silently failed with
  // "you lack reagent" while the player stared at a full bag. Walk
  // the parent chain so any reagent reachable from the mobile counts.
  for (const it of descendantsOf(api, caster.serial)) {
    if (it.itemId !== tpl.itemId) continue;
    if ((it.amount | 0) <= 0) continue;
    return it;
  }
  return null;
}

/**
 * Try to consume one of every reagent. Atomic: nothing is removed if any
 * reagent is missing. Returns `{ ok, missing? }`.
 */
export function consumeReagents(api, caster, reagents) {
  if (!reagents || reagents.length === 0) return { ok: true };
  const found = [];
  for (const r of reagents) {
    const stack = findReagent(api, caster, r);
    if (!stack) return { ok: false, missing: r };
    found.push(stack);
  }
  for (const stack of found) {
    stack.amount = (stack.amount | 0) - 1;
    if (stack.amount <= 0) {
      destroyConsumedItem(api, stack);
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
  return { ok: true };
}

export function healthUpdateFor(api, mob) {
  return api.protocol.healthUpdate({
    serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
  });
}

/**
 * BUGFIX #69 (FAZA DA): broadcast a health update to BOTH the mob's
 * own client AND every nearby observer. Mass-heal spells like Arch
 * Cure / Noble Sacrifice / Greater Heal previously only sent 0xA1 to
 * the recipient — overhead bars + dragged-out status bars on every
 * other player's screen stayed stale until the next combat tick.
 * Same class as #55 / #64 in combat.damage / damage riders.
 */
export function broadcastHealthUpdate(api, world, mob) {
  if (!mob || !api.protocol?.healthUpdate) return;
  const pkt = api.protocol.healthUpdate({
    serial: mob.serial, current: mob.hp ?? 0, max: mob.hpMax ?? 50,
  });
  if (mob.client) mob.client.send(pkt);
  for (const m of clientsNear(api, world, mob, 18, mob)) {
    m.client.send(pkt);
  }
}

export function broadcastSound(api, world, center, soundId) {
  const pkt = api.protocol.playSound({ soundId, x: center.x, y: center.y, z: center.z });
  sendToClientsNear(api, world, center, pkt, 18);
}

export function expireSummonedMobile(api, mob, durationMs) {
  setTimeout(() => {
    try {
      if (api.protocol?.removeEntity) {
        const rm = api.protocol.removeEntity(mob.serial);
        sendToClientsNear(api, api.world, mob, rm, 18);
      }
      destroyMobileBySerial(api, mob.serial);
    } catch { /* already gone */ }
  }, durationMs).unref?.();
}

export function broadcastEffect(api, world, center, bytes) {
  sendToClientsNear(api, world, center, bytes, 18);
}

/** Broadcast spell power-words above the caster's head — UO classic
 *  shows mantras like "In Vas Mani" floating above mages mid-cast.
 *  Uses unicodeMessage type=Spell (10) which the client routes to the
 *  overhead labels stack with a magenta tint. Sender + nearby viewers
 *  both get the packet (caster wants to read their own words too). */
export function broadcastSpellWords(api, world, caster, words) {
  if (!words || !api.protocol?.unicodeMessage) return;
  const pkt = api.protocol.unicodeMessage({
    serial: caster.serial >>> 0,
    graphic: caster.body & 0xFFFF,
    type: 10,                       // MessageType.Spell
    hue: 0x0035,                    // ServUO Spell.SpeechHue (purple-pink)
    font: 3,
    language: 'ENU',
    name: caster.name ?? '',
    text: words,
  });
  if (caster.client) caster.client.send(pkt);
  for (const m of clientsNear(api, world, caster, 18, caster)) {
    m.client.send(pkt);
  }
}

/** Mantra → spell name table. ServUO `SpellRegistry.GetMantra` per
 *  Magery / Necromancy / Chivalry circles. Lookup is by the spell's
 *  kebab-case name (matches the SPELLS map keys in spells/index.js). */
export const SPELL_MANTRAS = Object.freeze({
  // Magery circle 1
  'clumsy':         'Uus Jux',
  'create-food':    'In Mani Ylem',
  'feeblemind':     'Rel Wis',
  'heal':           'In Mani',
  'magic-arrow':    'In Por Ylem',
  'night-sight':    'In Lor',
  'reactive-armor': 'Flam Sanct',
  'weaken':         'Des Mani',
  // Circle 2
  'agility':        'Ex Uus',
  'cunning':        'Uus Wis',
  'cure':           'An Nox',
  'harm':           'An Mani',
  'magic-trap':     'In Jux',
  'magic-untrap':   'An Jux',
  'protection':     'Uus Sanct',
  'strength':       'Uus Mani',
  // Circle 3
  'bless':          'Rel Sanct',
  'fireball':       'Vas Flam',
  'magic-lock':     'An Por',
  'poison':         'In Nox',
  'telekinesis':    'Ort Por Ylem',
  'teleport':       'Rel Por',
  'unlock':         'Ex Por',
  'wall-of-stone':  'In Sanct Ylem',
  // Circle 4
  'arch-cure':      'Vas An Nox',
  'arch-protection':'Vas Uus Sanct',
  'curse':          'Des Sanct',
  'fire-field':     'In Flam Grav',
  'greater-heal':   'In Vas Mani',
  'lightning':      'Por Ort Grav',
  'mana-drain':     'Ort Rel',
  'recall':         'Kal Ort Por',
  // Circle 5
  'blade-spirits':  'In Jux Hur Ylem',
  'dispel-field':   'An Grav',
  'incognito':      'Kal In Ex',
  'magic-reflection':'In Jux Sanct',
  'mind-blast':     'Por Corp Wis',
  'paralyze':       'An Ex Por',
  'poison-field':   'In Nox Grav',
  'summon-creature':'Kal Xen',
  // Circle 6
  'dispel':         'An Ort',
  'energy-bolt':    'Corp Por',
  'explosion':      'Vas Ort Flam',
  'invisibility':   'An Lor Xen',
  'mark':           'Kal Por Ylem',
  'mass-curse':     'Vas Des Sanct',
  'paralyze-field': 'In Ex Grav',
  'reveal':         'Wis Quas',
  // Circle 7
  'chain-lightning':'Vas Ort Grav',
  'energy-field':   'In Sanct Grav',
  'flame-strike':   'Kal Vas Flam',
  'gate-travel':    'Vas Rel Por',
  'mana-vampire':   'Ort Sanct',
  'mass-dispel':    'Vas An Ort',
  'meteor-swarm':   'Flam Kal Des Ylem',
  'polymorph':      'Vas Ylem Rel',
  // Circle 8
  'earthquake':     'In Vas Por',
  'energy-vortex':  'Vas Corp Por',
  'resurrection':   'An Corp',
  'summon-air-elemental':   'Kal Vas Xen Hur',
  'summon-daemon':          'Kal Vas Xen Corp',
  'summon-earth-elemental': 'Kal Vas Xen Ylem',
  'summon-fire-elemental':  'Kal Vas Xen Flam',
  'summon-water-elemental': 'Kal Vas Xen An Flam',
  // Necromancy (English ASCII; ServUO uses an unrelated chant table)
  'pain-spike':     'In Sar',
  'corpse-skin':    'In Agle Corp Ylem',
  'curse-weapon':   'An Sanct Gra Char',
  'strangle':       'In Bal Nox',
  'wither':         'Kal Vas An Flam',
  'evil-omen':      'Pas Tym An Sanct',
  'poison-strike':  'In Vas Nox',
  'blood-oath':     'In Jux Mani Xen',
  'mind-rot':       'Wis An Ben',
  'horrific-beast': 'Rel Xen Vas Bal',
  'lich-form':      'Rel Xen Corp',
  'wraith-form':    'Rel Xen Um',
  'vampiric-embrace':'Rel Xen An Sanct',
  'exorcism':       'Ort Corp Grav',
  'animate-dead':   'Uus Corp',
  'summon-familiar':'Kal Xen Bal Beh',
  'vengeful-spirit':'Kal Xen Bal Beh',
});

/**
 * BUGFIX #35 (FAZA BS) — broadcast a body / hue / flag change to BOTH the
 * subject and every nearby observer. Form-change spells (wraith-form,
 * lich-form, horrific-beast, stone-form) used to send `mobileUpdate` only
 * to `caster.client`, so other players kept seeing the human body until
 * the next position change forced a `mobileMoving` re-broadcast. The
 * cleanest fix is to use `mobileMoving` for observers (CUO listens to
 * 0x77 for body/hue refreshes) and `mobileUpdate` for the subject (which
 * triggers the local paperdoll redraw too).
 *
 * @param {*} api
 * @param {*} world
 * @param {*} mob   subject whose body/hue/flags changed
 */
export function broadcastBodyChange(api, world, mob) {
  if (!mob || !world) return;
  if (mob.client && api.protocol?.mobileUpdate) {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
      flags: mob.flags ?? 0,
      x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
    }));
  }
  if (!api.protocol?.mobileMoving) return;
  const moving = api.protocol.mobileMoving({
    serial: mob.serial, body: mob.body,
    x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction ?? 0,
    hue: mob.hue ?? 0,
    flags: mob.flags ?? 0,
    notoriety: mob.notoriety ?? 1,
  });
  for (const m of clientsNear(api, world, mob, 18, mob)) {
    // Subject already got the richer mobileUpdate.
    m.client.send(moving);
  }
}

export function magerySkill(mob) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[SKILL_MAGERY] ?? mob.skills[String(SKILL_MAGERY)] ?? 0);
}

/** Read the cast-relevant skill value for a spell's school. Mirrors
 *  magerySkill but routed through the school's skill id. */
export function castSkillFor(mob, spell) {
  if (!mob?.skills) return 0;
  const id = skillIdForSchool(spell?.school);
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

export function skillValue(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

function _skillRaw(mob, id) {
  return skillValue(mob, id);
}

/**
 * Apply EvaluatingIntelligence bonus and Resisting Spells reduction to a
 * spell's base damage, then deal it via combat.damage. Awards skill gain
 * on both EvalInt (caster) and Resist (target) using the spell circle as
 * difficulty.
 *
 * Formulas (calibrated for the 0..120 scale we use; loosely modelled on
 * ServUO's `Spell.GetDamageScalar`):
 *   bonusMul = 1 + evalInt / 500     // +20% at 100 EvalInt, +24% at 120
 *   reduction = floor(resist / 10)   // at 100 Resist, -10 dmg flat
 *   final = max(floor(base/2), base * bonusMul - reduction)
 *
 * The half-damage floor mirrors ServUO's "magic resistance never drops a
 * spell below half" rule — keeps high-resist players relevant without
 * making them invincible.
 *
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 * @param {object} target
 * @param {number} baseDmg
 * @param {object} caster
 * @param {{circle?:number}} spell
 */
export function applySpellDamage(api, target, baseDmg, caster, spell) {
  const evalInt = _skillRaw(caster, SKILL_EVAL_INT);
  const resist  = _skillRaw(target, SKILL_RESIST);

  // ServUO CheckResisted — independent saving throw. The flat `reduction`
  // below scales linearly with Resist, but the canonical ServUO model
  // also gives Magic Resist a chance to halve the entire damage roll.
  // Formula (Spell.cs:CheckResisted, simplified to our 0..120 scale):
  //   chance = (resist - max(0, castSkill / 5 - 20) - (circle + 1) * 5) / 100
  //   chance is clamped to [0, 0.5] — a 100-resist target against a 0-skill
  //   caster on a circle-1 spell saves ~50% of the time. Doesn't stack with
  //   the linear reduction — both apply, so high-resist players get both
  //   advantages (canonical ServUO behaviour).
  const castSkill = _skillRaw(caster, SKILL_MAGERY);
  const circle = spell?.circle ?? 1;
  const saveChance = Math.max(0, Math.min(0.5,
    (resist - Math.max(0, castSkill / 5 - 20) - (circle + 1) * 5) / 100));
  const resisted = saveChance > 0 && Math.random() < saveChance;
  if (resisted) {
    baseDmg = Math.max(1, Math.floor(baseDmg / 2));
    // Visible cue — clients see a "resisted!" banner when the target
    // halves a spell. Falls through silently if the world hasn't wired
    // the broadcaster (test stubs).
    try {
      const msg = api.cliloc?.lookup?.(501783) ?? 'You feel yourself resisting magical energy.';
      if (target?.client?.sendSystemMessage) target.client.sendSystemMessage(msg);
    } catch { /* advisory */ }
  }

  // Audit #40 P2 #10 — ServUO `Spell.GetNewAosDamage:231-235` scales by
  // `(30 + 9*EvalInt/100) / 100` so 100 EI = ×1.39, 120 EI = ×1.408.
  // Was: `1 + evalInt/500` → ×1.20 / ×1.24 — every spell dealt ~14%
  // less damage than canon at GM.
  let bonusMul = (30 + 9 * evalInt / 100) / 100;
  // Arcane Focus (Spellweaving) — caster's `_arcaneFocusLevel` (1..5)
  // multiplies spell damage. Expires when `_arcaneFocusUntil` passes.
  // Audit #37 P1 #1: prefer the canonical `_arcaneFocusLevel` field
  // (persistence whitelist + spellweaving.js setter); fall back to
  // legacy `_arcaneFocus` for backward compat with old saves.
  const _focus = (caster?._arcaneFocusLevel | 0) || (caster?._arcaneFocus | 0);
  if ((caster?._arcaneFocusUntil ?? 0) > Date.now() && _focus > 1) {
    bonusMul *= 1 + (_focus * 0.05);
  } else if (caster?._arcaneFocusUntil) {
    caster._arcaneFocusLevel = 0; caster._arcaneFocus = 0;
    caster._arcaneFocusUntil = 0;
  }
  // AOS Spell Damage Increase. ServUO splits the cap: 100 % stacks
  // freely in PvE but PvP is hard-capped at 15 % so mages don't burst
  // through plate in two casts. We detect PvP by checking whether the
  // target carries a NetState (`target.client`), matching ServUO's
  // SpellHelper.SphereCheck logic.
  const sdiRaw = (api.attributes?.effective?.(caster)?.spellDamageIncrease | 0);
  const isPvP = !!target?.client && !!caster?.client && target !== caster;
  const sdi = Math.min(isPvP ? 15 : 100, sdiRaw);
  if (sdi > 0) bonusMul *= 1 + sdi / 100;
  const focusingOffset = spellFocusingOffset(api, caster, target);
  if (focusingOffset) bonusMul *= Math.max(0, 1 + focusingOffset / 100);
  // Audit #30 P2 #6 — AOS Inscribe (skill 24) bonus + Int flat add.
  // ServUO `Spell.cs::GetDamageScalar`: scribe contributes
  // `min(10, inscribe/10)` flat damage; Int adds `int/10` flat. An
  // Int-mage with 100 Inscription was missing ~20 % of expected
  // damage. Add post-bonus, pre-reduction.
  const inscribe = _skillRaw(caster, 24);
  const flatBonus = Math.floor(Math.min(10, inscribe / 10) + (caster?.int ?? 0) / 10);
  const reduction = Math.floor(resist / 10);
  const half = Math.max(1, Math.floor(baseDmg / 2));
  // Audit #38 P1 #2 — Evil Omen amplifies the NEXT harmful event by
  // +25 % damage, then consumes the flag. ServUO `EvilOmen.cs:107` +
  // `AOS.cs:230`. Was: 11-mana spell with no consumer.
  const evilOmen = (target?.evilOmenUntil ?? 0) > Date.now();
  if (evilOmen) bonusMul *= 1.25;
  // Hard 120 spell-damage cap — Stygian Dragon era ServUO clamp;
  // protects against runaway buffed crits one-shotting players.
  const SPELL_DAMAGE_CAP = 120;
  const final = Math.min(SPELL_DAMAGE_CAP,
    Math.max(half, Math.floor(baseDmg * bonusMul) + flatBonus - reduction));
  if (evilOmen) target.evilOmenUntil = 0;     // single-use consume

  // Offensive action breaks hide on both ends — the caster gives away their
  // position, and the victim pops out of any pre-existing concealment.
  reveal(api, caster);
  reveal(api, target);

  // Audit #40 P2 #12 — ServUO routes each Magery damage spell with an
  // explicit elemental breakdown (Fireball 100 fire, Lightning 100
  // energy, Energy Bolt 50/50, Mind Blast 100 cold, Harm 100 cold,
  // FlameStrike 100 fire, Magic Arrow 100 fire, Meteor Swarm 100 fire).
  // Was: untyped physical, so victims with naked phys resist took the
  // full hit while their fire/cold/energy resist did nothing. Spell
  // module supplies `damageType` (e.g. `{ fire: 100 }`); default is
  // 100% physical for backward compat with custom shard spells.
  const dmgType = spell?.damageType ?? null;
  api.combat.damage(api.world, target, final, caster, dmgType);

  // Skill gains: caster trains EvalInt, target trains Resist. Difficulty
  // tracks the spell circle so a magic-arrow doesn't push a maxed mage
  // through resist while a flame-strike still teaches a beginner.
  const difficulty = SPELL_DIFFICULTY_BY_CIRCLE[spell?.circle ?? 1] ?? 50;
  const award = api.combat?.awardSkill;
  if (caster?.skills && award) award(caster, SKILL_EVAL_INT, difficulty);
  if (target?.skills && target !== caster && award) award(target, SKILL_RESIST, difficulty);

  return final;
}

/**
 * Probability the cast fizzles. 0 = always succeeds, 1 = always fails.
 * Linear ramp between [minSkill, maxSkill].
 */
export function fizzleChance(caster, spell) {
  // Honour spell.school — Magery spells fizzle off Magery, Necromancy off
  // Necromancy skill, Chivalry off Chivalry. Default to Magery so the
  // 64 pre-existing magery spells keep working without a `school` field.
  const sk = castSkillFor(caster, spell);
  if (sk >= spell.maxSkill) return 0;
  if (sk < spell.minSkill) return 1;
  return 1 - (sk - spell.minSkill) / Math.max(1, spell.maxSkill - spell.minSkill);
}

/**
 * Apply a flat ±delta on str/dex/int via the status-effects framework so the
 * onRemove cleanly subtracts the same delta on expiry. Used by bless/curse
 * and mass-curse. Re-casting replaces (status-effects.apply triggers prior
 * onRemove first), avoiding stacking.
 */
export function applyStatBuff(api, target, name, delta, durationMs) {
  target.str = (target.str ?? 0) + delta;
  target.dex = (target.dex ?? 0) + delta;
  target.int = (target.int ?? 0) + delta;
  // Audit #40 P2 #8 — ServUO `Curse.cs:122-141` applies -10 to ALL
  // FIVE resists on top of the stat curse. The buff icon string
  // cliloc 1075835 lists exactly the 4 elemental + 1 physical
  // resist deltas. Was: only stat curse landed → players took 0%
  // resist hit, doubling Curse's PvE survivability gap.
  // Only the "curse" / "mass-curse" names get the resist drop;
  // bless variants leave the overlay alone.
  const isCurse = name === 'curse' || name === 'mass-curse';
  if (isCurse) {
    target._resistOverlay ??= { physical: 0, fire: 0, cold: 0, poison: 0, energy: 0 };
    target._resistOverlay.physical -= 10;
    target._resistOverlay.fire     -= 10;
    target._resistOverlay.cold     -= 10;
    target._resistOverlay.poison   -= 10;
    target._resistOverlay.energy   -= 10;
    target._resBagDirty = true;
  }
  api.statusEffects.apply(target, {
    name,
    durationMs,
    data: { delta, curseResists: isCurse },
    onRemove(mob) {
      mob.str = (mob.str ?? 0) - delta;
      mob.dex = (mob.dex ?? 0) - delta;
      mob.int = (mob.int ?? 0) - delta;
      if (isCurse && mob._resistOverlay) {
        mob._resistOverlay.physical += 10;
        mob._resistOverlay.fire     += 10;
        mob._resistOverlay.cold     += 10;
        mob._resistOverlay.poison   += 10;
        mob._resistOverlay.energy   += 10;
        const all0 = !mob._resistOverlay.physical && !mob._resistOverlay.fire
                  && !mob._resistOverlay.cold && !mob._resistOverlay.poison
                  && !mob._resistOverlay.energy;
        if (all0) mob._resistOverlay = null;
        else mob._resBagDirty = true;
      }
    },
  });
}

/**
 * Single-stat variant. Used by strength/weaken (str), agility/clumsy (dex),
 * cunning/feeblemind (int).
 */
export function applySingleStatBuff(api, target, name, stat, delta, durationMs) {
  target[stat] = (target[stat] ?? 0) + delta;
  api.statusEffects.apply(target, {
    name,
    durationMs,
    data: { stat, delta },
    onRemove(mob) { mob[stat] = (mob[stat] ?? 0) - delta; },
  });
}

/**
 * Tiny convenience: huedEffect with sensible defaults for common
 * "self-aura" / "target-aura" visuals. Pass overrides via opts.
 */
export function aura(api, source, opts = {}) {
  const {
    kind = api.protocol.EffectKind.FromSource,
    itemId = 0x376A, hue = 0, renderMode = 0,
    speed = 10, duration = 15,
    fixedDirection = 0, explodes = 0,
  } = opts;
  return api.protocol.huedEffect({
    kind,
    from: source.serial, to: source.serial,
    itemId,
    fromX: source.x, fromY: source.y, fromZ: source.z,
    toX: source.x, toY: source.y, toZ: source.z,
    speed, duration,
    fixedDirection, explodes,
    hue, renderMode,
  });
}

/**
 * Project gfx from caster to a target (mobile or {x,y,z} location).
 */
export function projectile(api, from, to, opts = {}) {
  const {
    kind = api.protocol.EffectKind.Moving,
    itemId, hue = 0, renderMode = 0,
    speed = 7, duration = 0,
    fixedDirection = 1, explodes = 0,
  } = opts;
  return api.protocol.huedEffect({
    kind,
    from: from.serial ?? 0, to: to.serial ?? 0,
    itemId,
    fromX: from.x, fromY: from.y, fromZ: from.z,
    toX: to.x, toY: to.y, toZ: to.z,
    speed, duration,
    fixedDirection, explodes,
    hue, renderMode,
  });
}
