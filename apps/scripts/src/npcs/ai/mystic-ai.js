// MysticAI — Mysticism caster. Mirrors ServUO MysticAI.cs.
// Spell graphic IDs match the ServUO `Effects.SendPacket` constants
// for the matching mystic spells (NetherBolt 0x36F4 hue 0x4F0,
// Bombard 0x36BD hue 0x83, HailStorm 0x36D4 hue 0x80).

import { registerCasterBehavior } from './_caster-helper.js';

const MYSTIC_FALLBACK = [
  { name: 'Nether Bolt',  mana: 6,  damage: [6, 14],  soundId: 0x211, graphicId: 0x36F4, hue: 0x4F0, fxSpeed: 7 },
  { name: 'Eagle Strike', mana: 9,  damage: [10, 20], soundId: 0x2EE, graphicId: 0x4FAF, hue: 0,     fxSpeed: 5 },
  { name: 'Bombard',      mana: 14, damage: [18, 30], soundId: 0x64B, graphicId: 0x36BD, hue: 0x83,  fxSpeed: 8, explodes: 1 },
  { name: 'Hail Storm',   mana: 30, damage: [25, 40], soundId: 0x64F, graphicId: 0x36D4, hue: 0x80,  fxSpeed: 6 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/mystic-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'mystic',
    spellsField: 'mysticism.spells',
    fallbackSpells: MYSTIC_FALLBACK,
    castIntervalMs: 2800,
    idealRange: 5,
  });
}
