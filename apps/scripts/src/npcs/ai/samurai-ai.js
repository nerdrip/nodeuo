// SamuraiAI — Bushido melee+spell hybrid (ServUO SamuraiAI.cs).
// Stays in melee range, occasionally fires Lightning Strike / Momentum
// Strike instead of plain swing.

import { registerCasterBehavior } from './_caster-helper.js';

const SAMURAI_FALLBACK = [
  { name: 'Lightning Strike',   mana: 5,  damage: [10, 18], soundId: 0x1FB, graphicId: 0,      hue: 0,     fxSpeed: 0 },
  { name: 'Momentum Strike',    mana: 10, damage: [12, 22], soundId: 0x33D, graphicId: 0,      hue: 0,     fxSpeed: 0 },
  { name: 'Honorable Execution',mana: 0,  damage: [16, 28], soundId: 0x33C, graphicId: 0,      hue: 0,     fxSpeed: 0 },
  { name: 'Confidence',         mana: 10, damage: [0, 0],   soundId: 0x51A, graphicId: 0x37C4, hue: 0x47E, fxSpeed: 8 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/samurai-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'samurai',
    spellsField: 'bushido.spells',
    fallbackSpells: SAMURAI_FALLBACK,
    castIntervalMs: 3000,
    idealRange: 1,
  });
}
