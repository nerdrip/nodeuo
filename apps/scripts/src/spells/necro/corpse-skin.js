// Corpse Skin — Necromancy debuff: target's resistances drop, fire/cold
// damage they take is amplified. We approximate by tagging a debuff via
// status-effects with a short duration; combat damage code can read the
// `corpse-skin` flag to add 25% to incoming damage when we wire that.
// For now the visible effect is a green tint flash + system message.

import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';

export default {
  name: 'corpse-skin',
  school: 'necromancy',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target?.serial) {
      ctx.state.sendSystemMessage('Corpse Skin needs a target.');
      return;
    }
    const fx = aura(api, target, { itemId: 0x373A, hue: 0x06D });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x0240);
    const necro = skillValue(caster, 50);
    // Audit #41 P1 #3 — SpiritSpeak is skill 33 (32 = Archery).
    const ss    = skillValue(caster, 33);
    const durationMs = 30_000 + necro * 200;    // 30..54s
    // ServUO `CorpseSkin.cs`: malus = min(15, (Necro+SS) × 0.075). The
    // combat-formulas Corpse Skin reader scales fire+poison damage UP
    // by this value, and cold+physical DOWN by 10%.
    const malus = Math.min(15, Math.floor((necro + ss) * 0.075));
    target._corpseSkinMalus = malus;
    // Audit #38 P2 #10 — ServUO `CorpseSkin.cs:124-130` applies resist
    // mods directly on the mob: `-malus Fire/Poison, +10 Cold/Physical`.
    // Was: combat-formulas had a complex weighted-breakdown reader that
    // only worked when the weapon had `damageBreakdown` set — most
    // physical-only weapons silently took -10% instead of fire/poison
    // attackers seeing the +malus amplification. Apply via the standard
    // `_resistOverlay` overlay so the existing resist pipeline handles
    // every elemental swing uniformly.
    const prior = target._resistOverlay ?? {};
    target._resistOverlay = {
      physical: (prior.physical | 0) + 10,
      fire:     (prior.fire     | 0) - malus,
      cold:     (prior.cold     | 0) + 10,
      poison:   (prior.poison   | 0) - malus,
      energy:   (prior.energy   | 0),
    };
    target._resBagDirty = true;
    target._corpseSkinOverlayApplied = true;     // gates legacy reader off
    api.statusEffects?.apply?.(target, {
      name: 'corpse-skin',
      durationMs,
      onRemove(mob) {
        const cur = mob._resistOverlay ?? {};
        mob._resistOverlay = {
          physical: (cur.physical | 0) - 10,
          fire:     (cur.fire     | 0) + malus,
          cold:     (cur.cold     | 0) - 10,
          poison:   (cur.poison   | 0) + malus,
          energy:   (cur.energy   | 0),
        };
        const o = mob._resistOverlay;
        if (!o.physical && !o.fire && !o.cold && !o.poison && !o.energy) {
          mob._resistOverlay = null;
        }
        mob._resBagDirty = true;
        mob._corpseSkinMalus = 0;
        mob._corpseSkinOverlayApplied = false;
      },
    });
    if (target.client) {
      target.client.sendSystemMessage('Your skin is mottled with grave-rot.');
    }
  },
};
