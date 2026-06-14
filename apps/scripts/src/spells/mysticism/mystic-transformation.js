// MysticTransformationSpell — ServUO `Spells/Mysticism/Mystic.cs` base
// transformation. The base ServUO class is abstract; concrete subclasses
// are Stone Form (already shipped) and (in some shards) an alternate
// transformation. We surface the "alternate" form here as Hammer Form:
// a 60-s mystic battle transformation that boosts physical damage and
// mana regen at the cost of move speed.
//
// Mirrors the resist-overlay + body swap pattern used by Stone Form,
// Reaper Form, and Lich Form so the rest of the engine reads the same
// fields uniformly.

import { aura, broadcastEffect, broadcastSound, broadcastBodyChange, skillValue } from '../_helpers.js';

const SKILL_MYSTICISM = 56;
const SKILL_FOCUS     = 51;
const SKILL_IMBUING   = 57;
const DURATION_MS     = 60 * 1000;
const HAMMER_BODY     = 0x192;            // Mystic transform body (alternate)

export default {
  name: 'mystic-transformation', school: 'mysticism', circle: 5, mana: 23,
  cast(api, ctx) {
    const m = ctx.sender;
    if (m._origBody) {
      ctx.state.sendSystemMessage?.('You are already transformed.');
      return false;
    }
    const mys = skillValue(m, SKILL_MYSTICISM);
    const sec = Math.max(skillValue(m, SKILL_FOCUS), skillValue(m, SKILL_IMBUING));
    const dmgBonus = Math.floor((mys + sec) / 12);          // +10..16 % SDI
    const manaRegen = Math.floor((mys + sec) / 200);        // +0..4 mana/s
    const resBonus = Math.max(2, Math.min(6, Math.floor((mys + sec) / 32)));

    m._origBody = m.body;
    m.body = HAMMER_BODY;
    const prior = m._resistOverlay ?? {};
    m._resistOverlay = {
      physical: (prior.physical | 0) + resBonus,
      fire:     prior.fire     | 0,
      cold:     prior.cold     | 0,
      poison:   prior.poison   | 0,
      energy:   prior.energy   | 0,
    };
    m._resBagDirty = true;
    m._mysticTransformation = true;
    m._mysticTransformDmgBonus = dmgBonus;
    m._mysticTransformManaRegen = manaRegen;
    m._mysticTransformUntil = Date.now() + DURATION_MS;
    // Roll back when the effect lapses. We schedule a coarse 60-s
    // timer; cooperating combat-formulas / regen tick also bail on
    // expired _mysticTransformUntil so a missed timer is graceful.
    const origBody = m._origBody;
    const origOverlay = prior;
    setTimeout(() => {
      if (!m || m._mysticTransformUntil > Date.now()) return;
      m.body = origBody;
      m._resistOverlay = origOverlay;
      m._resBagDirty = true;
      delete m._mysticTransformation;
      delete m._mysticTransformDmgBonus;
      delete m._mysticTransformManaRegen;
      delete m._mysticTransformUntil;
      delete m._origBody;
      try { broadcastBodyChange(api, api.world, m); } catch { /* */ }
      m.client?.sendSystemMessage?.('The mystic energies fade from your form.');
    }, DURATION_MS).unref?.();

    try {
      broadcastBodyChange(api, api.world, m);
      broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x375A, hue: 0x47 }));
      broadcastSound(api, api.world, m, 0x208);
    } catch { /* */ }
    ctx.state.sendSystemMessage?.('Mystic energies forge your body into a vessel of war.');
    return true;
  },
};
