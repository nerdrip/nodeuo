import { broadcastSound, applySpellDamage, mobilesNear } from '../../_helpers.js';
import { NOTO, viewerNotoriety } from '../../../_notoriety.js';

// Audit #41 P2 #25 — ServUO `Earthquake.cs:42-93` uses `CanBeHarmful`
// to filter own pets, innocents and party; damage = `Hits/2 − rand(2)`
// clamped [15..40]. Was: every mob in radius (incl. blue + own pets),
// flat 20..40.
function earthquakeDamage(m) {
  return Math.max(15, Math.min(40, Math.floor((m.hp ?? 50) / 2) - Math.floor(Math.random() * 3)));
}
function canHarmHere(api, caster, m) {
  if (m.controlMaster === caster.serial) return false;     // own pet
  const noto = viewerNotoriety(api, m, caster, null);
  if (noto === NOTO.Innocent || noto === NOTO.Ally) return false;
  return true;
}

// Damage every mob in radius 6 of the caster (the caster is the epicenter
// and is not hit themselves).
export default {
  name: 'earthquake',
  cast(api, ctx) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x220);
    let hit = 0;
    for (const m of mobilesNear(api, caster, 6, caster)) {
      if (!canHarmHere(api, caster, m)) continue;
      applySpellDamage(api, m, earthquakeDamage(m), caster, this);
      hit++;
    }
    ctx.state.sendSystemMessage(`The earth shakes — ${hit} being(s) stagger.`);
  },
};
