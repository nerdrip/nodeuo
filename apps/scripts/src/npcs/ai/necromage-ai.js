// NecromageAI — Magery + Necromancy hybrid (ServUO NecromageAI.cs).
// Picks from a merged spell roster; HP-tier rule selects between
// instant magery damage and necro DoTs.

import { registerCasterBehavior } from './_caster-helper.js';

const NECROMAGE_FALLBACK = [
  { name: 'Magic Arrow',  mana: 6,  damage: [4, 8],   soundId: 0x1E5, graphicId: 0x36E4, hue: 0,     fxSpeed: 7 },
  { name: 'Pain Spike',   mana: 5,  damage: [8, 16],  soundId: 0x208, graphicId: 0x37B9, hue: 0,     fxSpeed: 7 },
  { name: 'Fireball',     mana: 9,  damage: [10, 18], soundId: 0x15E, graphicId: 0x36D4, hue: 0,     fxSpeed: 5 },
  { name: 'Lightning',    mana: 11, damage: [12, 22], soundId: 0x29,  graphicId: 0,      hue: 0,     fxSpeed: 0 },
  { name: 'Poison Strike',mana: 17, damage: [12, 24], soundId: 0x205, graphicId: 0x36B0, hue: 0x44,  fxSpeed: 8,
    effect: { name: 'poison', durationMs: 12000, data: { level: 2 } } },
  { name: 'Energy Bolt',  mana: 20, damage: [18, 32], soundId: 0x20A, graphicId: 0x379F, hue: 0x47E, fxSpeed: 6 },
  { name: 'Wither',       mana: 23, damage: [15, 30], soundId: 0x1FB, graphicId: 0x37CC, hue: 0x47D, fxSpeed: 6, explodes: 1 },
  { name: 'Flame Strike', mana: 40, damage: [28, 45], soundId: 0x208, graphicId: 0x3709, hue: 0,     fxSpeed: 0 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/necromage-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'necromage',
    spellsField: 'necromage.spells',
    fallbackSpells: NECROMAGE_FALLBACK,
    castIntervalMs: 2800,
    idealRange: 5,
  });
}
