// Wraith Form — pass through walls + drain mana on hit. Body changes
// to wraith (0x0192) for 90s; the buff sets `_wraithUntil` which
// movement.js / combat.js read:
//   movement.js → walkability tile-checks SKIP solid statics when
//                 `mob._wraithUntil > now`
//   combat.js  → BaseWeapon.OnHit reads the marker and drains 5..15 %
//                of damage as mana from the target to the attacker.
import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../_helpers.js';

const WRAITH_DURATION_MS = 90_000;

export default {
  name: 'wraith-form', school: 'necromancy', circle: 5, mana: 17,
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody) return ctx.state.sendSystemMessage('You are already transformed.');
    caster._origBody = caster.body;
    // Audit #42 P1 #6 — ServUO `WraithForm.cs:45` returns body 747/748
    // (0x2EB male / 0x2EC female). Was 0x192 — the human female DEATH
    // ghost body, so wraith form silently turned everyone into a ghost.
    caster.body = (caster.body === 0x191) ? 0x2EC : 0x2EB;
    // Audit #39 P1 #2 — combat-formulas.damageRiders reads
    // `attacker.wraithFormUntil` (canonical no-underscore). The
    // `_wraithUntil` legacy field was dead — Wraith Form gave the body
    // change but ZERO mana leech. Write both names: walkability.js
    // reads `_wraithUntil` for the wall-pass behavior.
    caster._wraithUntil = Date.now() + WRAITH_DURATION_MS;
    caster.wraithFormUntil = caster._wraithUntil;
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x375A, hue: 0x10 }));
    broadcastSound(api, api.world, caster, 0x0167);
    // BUGFIX #35: nearby observers must see the body change too.
    broadcastBodyChange(api, api.world, caster);
    api.statusEffects?.apply?.(caster, {
      name: 'wraith-form', durationMs: WRAITH_DURATION_MS,
      onRemove(mob) {
        if (mob._origBody == null) return;
        mob.body = mob._origBody;
        delete mob._origBody;
        mob._wraithUntil = 0;
        mob.wraithFormUntil = 0;
        broadcastBodyChange(api, api.world, mob);
      },
    });
  },
};
