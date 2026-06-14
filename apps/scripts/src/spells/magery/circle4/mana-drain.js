import { broadcastEffect, broadcastSound, skillValue } from '../../_helpers.js';

// Unlike OSI we don't give the drained mana back to the caster (balance);
// it's just depleted from the target.
export default {
  name: 'mana-drain',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target || !target.serial) { ctx.state.sendSystemMessage('Mana drain needs a target.'); return; }
    // Audit #36 P2 #9 — ServUO `ManaDrain.cs:53-72`: drain `40 + (EvalInt
    // − MagicResist)` clamped to target.mana, return same amount to
    // target 5 s later via `AosDelay_Callback`. Subsequent re-casts
    // within the 5-s window deal 0 (already-drained gate). Was: flat
    // random 10-19 with no return — purely griefable.
    if ((target._manaDrainUntil ?? 0) > Date.now()) {
      ctx.state.sendSystemMessage('Your spell has no effect — the target is already drained.');
      return;
    }
    // Audit #41 P1 #5 — EvalInt is skill id 17 (16 = Discordance).
    // Was: 40 + (Discord - MR) — drain was tiny for any non-bard mage.
    const evalInt = skillValue(caster, 17);       // 17 = Evaluating Intelligence
    const resist  = skillValue(target, 27);       // 27 = Magic Resist
    const drained = Math.max(0, Math.min(target.mana ?? 0, 40 + ((evalInt - resist) | 0)));
    target.mana = Math.max(0, (target.mana ?? 0) - drained);
    target._manaDrainUntil = Date.now() + 5000;
    // Audit #40 P2 #15 — also stamp the amount on the target so
    // `regen.js` can refund it even if the setTimeout dies in a save
    // round-trip. Was: server restart mid-drain meant the target
    // PERMANENTLY lost `drained` mana — the timer never re-armed.
    target._manaDrainAmount = drained;
    setTimeout(() => {
      if (!target) return;
      target.mana = Math.min(target.manaMax ?? 100, (target.mana ?? 0) + drained);
      if (target.client && api.protocol.manaUpdate) {
        target.client.send(api.protocol.manaUpdate({
          serial: target.serial, current: target.mana, max: target.manaMax ?? 50,
        }));
      }
      target._manaDrainUntil = 0;
      target._manaDrainAmount = 0;
    }, 5000).unref?.();
    api.combat.animate(api.world, caster, 0x10);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.Moving,
      from: caster.serial, to: target.serial,
      itemId: 0x374A,
      fromX: caster.x, fromY: caster.y, fromZ: caster.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 7, duration: 0,
      fixedDirection: 1, explodes: 0,
      hue: 0x1C2, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x1F8);
    if (target.client && api.protocol.manaUpdate) {
      target.client.send(api.protocol.manaUpdate({
        serial: target.serial, current: target.mana, max: target.manaMax ?? 50,
      }));
    }
  },
};
