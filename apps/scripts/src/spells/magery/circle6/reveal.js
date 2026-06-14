import { broadcastSound, magerySkill, mobilesNear } from '../../_helpers.js';
import { reveal as revealMobile } from '../../../_visibility.js';

export default {
  name: 'reveal',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) return;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FD);
    // Audit #40 P1 #5 — ServUO `Reveal.cs:38-50` walks `GetMobilesInRange`
    // and calls `RevealingAction()` on every hidden mob (which both
    // clears Hiding skill state AND strips Invisibility spell). Was:
    // only the Magery Invisibility status-effect got stripped — pure
    // Hiding/Stealth users walked through the AOE untouched.
    // Radius scales with magery (`magerySkill/15`, capped 1..5).
    const radius = Math.max(1, Math.min(5, Math.floor(magerySkill(caster) / 15)));
    let revealed = 0;
    const center = { ...picked, map: picked.map ?? caster.map ?? 1 };
    for (const m of mobilesNear(api, center, radius)) {
      const wasHidden = !!m.hidden;
      if (api.statusEffects?.remove?.(m, 'invisibility', api.world)) revealed++;
      else if (wasHidden) { revealMobile(api, m); revealed++; }
    }
    ctx.state.sendSystemMessage(`You reveal ${revealed} hidden being(s).`);
  },
};
