// SpellweavingAI — Spellweaving elf caster (ServUO SpellweavingAI.cs).
// AoE-heavy: Wildfire / Thunderstorm / Hail Storm at range; switches
// to Nature Fury / Reaper Form on low HP.

import { registerCasterBehavior } from './_caster-helper.js';

const SW_FALLBACK = [
  { name: 'Nature Fury',    mana: 24, damage: [14, 24], soundId: 0x53D, graphicId: 0x910,  hue: 0x53D, fxSpeed: 7 },
  { name: 'Thunderstorm',   mana: 32, damage: [20, 32], soundId: 0x10D, graphicId: 0,      hue: 0x47C, fxSpeed: 0 },
  { name: 'Word of Death',  mana: 50, damage: [40, 70], soundId: 0x66B, graphicId: 0x375A, hue: 0,     fxSpeed: 8, explodes: 1 },
  { name: 'Wildfire',       mana: 50, damage: [25, 40], soundId: 0x208, graphicId: 0x3709, hue: 0,     fxSpeed: 0 },
  { name: 'Essence of Wind',mana: 40, damage: [18, 30], soundId: 0x66C, graphicId: 0x375A, hue: 0x4F4, fxSpeed: 6 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/spellweaving-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'spellweaving',
    spellsField: 'spellweaving.spells',
    fallbackSpells: SW_FALLBACK,
    castIntervalMs: 3500,
    idealRange: 8,
  });
}
