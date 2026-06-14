import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
// Audit #37 P1 #5 — Attune Weapon damage absorb pool. ServUO
// `AttuneWeapon.cs:42-62`:
//   absorb = (skill/2) + 14 + (focusLevel * 10)
// The pool drains incoming MELEE damage; when empty the buff expires.
// Was: a no-op flag with 60-s duration. Central `damage()` reader
// now subtracts from `mob._attuneAbsorb` when stamp is live.
export default {
  name: 'attune-weapon', school: 'spellweaving', circle: 1, mana: 24,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x376A, hue: 0x4FE }));
    broadcastSound(api, api.world, m, 0x5BE);
    const sw = skillValue(m, 55);
    const focus = (m._arcaneFocusLevel | 0) || (m._arcaneFocus | 0);
    const absorb = Math.floor(sw / 2) + 14 + focus * 10;
    m._attuneAbsorb = absorb;
    m._attuneUntil = Date.now() + 60_000;
    api.statusEffects?.apply?.(m, {
      name: 'attune-weapon',
      durationMs: 60_000,
      onRemove(mob) {
        mob._attuneAbsorb = 0;
        mob._attuneUntil = 0;
      },
    });
    m.client?.sendSystemMessage?.(`Your weapon absorbs the next ${absorb} damage.`);
  },
};
