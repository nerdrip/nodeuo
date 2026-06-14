// PaladinAI — Chivalry caster (ServUO PaladinAI.cs). Plays melee with
// periodic Holy Light AoEs and Divine Fury self-buffs.

import { registerCasterBehavior } from './_caster-helper.js';
import { sendToClientsNear } from '../../_spatial.js';

const PALADIN_FALLBACK = [
  { name: 'Holy Light',        mana: 10, damage: [12, 24], soundId: 0x212, graphicId: 0x376A, hue: 0x47E, fxSpeed: 6 },
  { name: 'Consecrate Weapon', mana: 10, damage: [0, 0],   soundId: 0x20C, graphicId: 0x37CC, hue: 0,     fxSpeed: 7 },
  { name: 'Enemy of One',      mana: 20, damage: [0, 0],   soundId: 0x0F5, graphicId: 0,      hue: 0,     fxSpeed: 0 },
  { name: 'Dispel Evil',       mana: 35, damage: [10, 18], soundId: 0x10F, graphicId: 0x375A, hue: 0,     fxSpeed: 8 },
];

// Paladin special: tries to self-heal with Close Wounds when low HP.
function preCastClose(mob, target, ctx) {
  if (!mob || (mob.hp == null) || (mob.hpMax == null)) return false;
  if (mob.hp / mob.hpMax > 0.4) return false;
  if ((mob.mana | 0) < 12) return false;
  mob.hp = Math.min(mob.hpMax, mob.hp + 18 + Math.floor(Math.random() * 12));
  mob.mana -= 12;
  // Visual: green sparkle on self.
  const fx = ctx?.api?.protocol?.huedEffect?.({
    kind: ctx.api.protocol.EffectKind?.FixedFrom ?? 0,
    from: mob.serial, to: 0,
    itemId: 0x376A, fromX: mob.x, fromY: mob.y, fromZ: mob.z,
    toX: mob.x, toY: mob.y, toZ: mob.z,
    speed: 5, duration: 10, fixedDirection: 1, explodes: 0,
    hue: 0x47D, renderMode: 0,
  });
  if (fx) {
    sendToClientsNear(ctx.api, mob, fx);
  }
  return true;
}

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/paladin-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'paladin',
    spellsField: 'chivalry.spells',
    fallbackSpells: PALADIN_FALLBACK,
    castIntervalMs: 3500,
    idealRange: 2,                        // melee paladin
    preCast: (mob, target, ctx) => preCastClose(mob, target, { ...ctx, api }),
  });
}
