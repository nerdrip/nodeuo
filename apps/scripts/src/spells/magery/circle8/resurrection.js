import { broadcastEffect, broadcastSound } from '../../_helpers.js';

const ACCEPT_WINDOW_MS = 30 * 1000;

export default {
  name: 'resurrection',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target) { ctx.state.sendSystemMessage('Resurrection needs a target.'); return; }
    if (!target.ghost) { ctx.state.sendSystemMessage('They are not dead.'); return; }
    // Audit #39 P1 #3 — ServUO `Resurrection.cs:40-58` gates: cannot
    // self-res (use a shrine instead), target MUST be a player, must
    // be within 1 tile. Was: self-res shortcut, pets/summons could
    // also be raised, no range check (cross-map ghost-res exploit).
    if (caster.serial === target.serial) {
      ctx.state.sendSystemMessage('Thou can not resurrect thyself.');
      return;
    }
    if (!target.client) {
      ctx.state.sendSystemMessage('That is not a being.');
      return;
    }
    if (target.map !== caster.map
        || Math.max(Math.abs(target.x - caster.x), Math.abs(target.y - caster.y)) > 1) {
      ctx.state.sendSystemMessage('The target is not close enough.');
      return;
    }
    api.combat.animate(api.world, caster, 0x11);
    const fx = api.protocol.huedEffect({
      kind: api.protocol.EffectKind.FromSource,
      from: target.serial, to: target.serial,
      itemId: 0x376A,
      fromX: target.x, fromY: target.y, fromZ: target.z,
      toX: target.x, toY: target.y, toZ: target.z,
      speed: 10, duration: 15,
      fixedDirection: 0, explodes: 0,
      hue: 0, renderMode: 0,
    });
    broadcastEffect(api, api.world, target, fx);
    broadcastSound(api, api.world, target, 0x214);
    // ServUO `Spell.Resurrection.OnTarget` — a third-party res is
    // never silent. The ghost gets a 30 s window to type `[accept`
    // or `[decline`. Self-cast (caster === target) skips the prompt
    // and resurrects immediately. NPC res (no client on target) also
    // skips the prompt — pets and summons take the res straight away.
    const selfRes = caster.serial === target.serial;
    if (!selfRes && target.client?.sendSystemMessage) {
      target._pendingResurrect = {
        casterSerial: caster.serial,
        expiresAt: Date.now() + ACCEPT_WINDOW_MS,
      };
      // Sentinel opens the client ResurrectGump (3-option dialog).
      target.client.sendSystemMessage(
        `@@OPEN_RESURRECT_GUMP@@${caster.name ?? 'Someone'}`,
      );
      target.client.sendSystemMessage(
        `${caster.name ?? 'Someone'} offers to resurrect you. Type [accept within 30 seconds, or [decline.`,
      );
      // Notify the caster too so they don't think the spell silently failed.
      ctx.state.sendSystemMessage(
        `Resurrection offered to ${target.name ?? 'the fallen'} — awaiting their response.`,
      );
      return;
    }
    if (api.corpse?.resurrectMobile) {
      api.corpse.resurrectMobile(api.world, target, caster);
      ctx.state.sendSystemMessage(`${target.name ?? 'The fallen'} walks again.`);
    }
  },
};
