import { mobileBySerial } from '../_entities.js';
// `[accept` / `[decline` — respond to a pending third-party resurrection
// offer. The spell handler (spells/circle8/resurrection.js) stamps
// `mob._pendingResurrect = { casterSerial, expiresAt }` on the ghost.
// Mirrors ServUO `Mobile.Resurrect` accept gump (we use a text command
// instead of a gump until the YesNo dialog packet is wired client-side).

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  function takePending(mob) {
    const p = mob?._pendingResurrect;
    if (!p) return null;
    if (p.expiresAt < Date.now()) {
      mob._pendingResurrect = null;
      return { expired: true };
    }
    mob._pendingResurrect = null;
    return p;
  }

  api.commands.register({
    name: 'accept',
    help: 'accept — accept a pending resurrection offer.',
    access: 'Player',
    run(ctx) {
      const p = takePending(ctx.sender);
      if (!p) {
        ctx.state.sendSystemMessage('You have no pending offer to accept.');
        return;
      }
      if (p.expired) {
        ctx.state.sendSystemMessage('The offer has expired.');
        return;
      }
      if (!ctx.sender.ghost) {
        ctx.state.sendSystemMessage('You are already alive.');
        return;
      }
      if (api.corpse?.resurrectMobile) {
        const caster = mobileBySerial(api, p.casterSerial >>> 0);
        api.corpse.resurrectMobile(api.world, ctx.sender, caster ?? null);
        ctx.state.sendSystemMessage('You have accepted the resurrection.');
      }
    },
  });

  api.commands.register({
    name: 'decline',
    help: 'decline — decline a pending resurrection offer.',
    access: 'Player',
    run(ctx) {
      const p = takePending(ctx.sender);
      if (!p) {
        ctx.state.sendSystemMessage('You have no pending offer to decline.');
        return;
      }
      const caster = mobileBySerial(api, p.casterSerial >>> 0);
      caster?.client?.sendSystemMessage?.(`${ctx.sender.name ?? 'The fallen'} declined the resurrection.`);
      ctx.state.sendSystemMessage('You decline the offer.');
    },
  });

  return () => {
    api.commands.unregister('accept');
    api.commands.unregister('decline');
  };
}
