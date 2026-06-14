// NecroAI — Necromancy caster. Mirrors ServUO NecroAI.cs (under
// Mobiles/AI/Magical AI/). Heavy on DoT (Strangle, Pain Spike, Wither).
// Each entry's `effect` field plugs into status-effects.add for the
// damage-over-time component; instant damage stays on `damage`.

import { registerCasterBehavior } from './_caster-helper.js';

const NECRO_FALLBACK = [
  { name: 'Pain Spike',      mana: 5,  damage: [8, 16],  soundId: 0x208, graphicId: 0x37B9, hue: 0,     fxSpeed: 7 },
  { name: 'Poison Strike',   mana: 17, damage: [12, 24], soundId: 0x205, graphicId: 0x36B0, hue: 0x44,  fxSpeed: 8,
    effect: { name: 'poison', durationMs: 12000, data: { level: 2 } } },
  { name: 'Strangle',        mana: 29, damage: [10, 20], soundId: 0x205, graphicId: 0x374A, hue: 0x47E, fxSpeed: 6,
    effect: { name: 'curse', durationMs: 10000 } },
  { name: 'Wither',          mana: 23, damage: [15, 30], soundId: 0x1FB, graphicId: 0x37CC, hue: 0x47D, fxSpeed: 6, explodes: 1 },
  { name: 'Vengeful Spirit', mana: 41, damage: [18, 35], soundId: 0x108, graphicId: 0x3753, hue: 0x47E, fxSpeed: 7 },
];

export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol || !api.monsters) {
    api.log('npc/necro-ai: missing api deps; skipping');
    return () => {};
  }
  return registerCasterBehavior(api, {
    name: 'necro',
    spellsField: 'necromancy.spells',
    fallbackSpells: NECRO_FALLBACK,
    castIntervalMs: 3200,
    idealRange: 5,
  });
}
