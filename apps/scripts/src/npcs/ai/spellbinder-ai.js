// SpellbinderAI — Magery + Necromancy elite hybrid (ServUO
// SpellbinderAI.cs). Same deck as NecromageAI but cast cadence is
// faster, idealRange is wider, and Energy Vortex / Wraith summons
// can be queued via cfg.

import { registerCasterBehavior } from './_caster-helper.js';

const SPELLBINDER_FALLBACK = [
  { name: 'Energy Bolt',  mana: 20, damage: [22, 35], soundId: 0x20A, graphicId: 0x379F, hue: 0x47E, fxSpeed: 6 },
  { name: 'Mind Blast',   mana: 14, damage: [18, 28], soundId: 0x213, graphicId: 0x374A, hue: 0x47C, fxSpeed: 7 },
  { name: 'Pain Spike',   mana: 5,  damage: [10, 18], soundId: 0x208, graphicId: 0x37B9, hue: 0,     fxSpeed: 7 },
  { name: 'Strangle',     mana: 29, damage: [12, 22], soundId: 0x205, graphicId: 0x374A, hue: 0x47E, fxSpeed: 6,
    effect: { name: 'curse', durationMs: 12000 } },
  { name: 'Flame Strike', mana: 40, damage: [30, 50], soundId: 0x208, graphicId: 0x3709, hue: 0,     fxSpeed: 0 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/spellbinder-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'spellbinder',
    spellsField: 'spellbinder.spells',
    fallbackSpells: SPELLBINDER_FALLBACK,
    castIntervalMs: 2400,
    idealRange: 6,
  });
}
