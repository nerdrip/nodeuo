// [mute / [unmute — flag the targeted player so the speech handler
// silently drops their public chat. Mirrors ServUO `MuteCommand` —
// per-account flag (so creating an alt won't dodge a mute).
//
// The actual speech-drop check should consult `acc.muted` in the
// public-chat handler. The flag is set here; downstream consumers
// gate on it.

import { resolveMobileArg } from '../_targeting-helpers.js';

export default function (api) {
  const { commands } = api;
  const accounts = api.ctx?.accounts;
  if (!accounts) return;

  function mutateMute(api, ctx, mute) {
    resolveMobileArg(api, ctx, 0, (m) => {
      if (!m) return;
      if (!m.accountName) { ctx.state.sendSystemMessage('Target has no account.'); return; }
      const acc = accounts.accounts.get(m.accountName.toLowerCase());
      if (!acc) { ctx.state.sendSystemMessage('Target account not found.'); return; }
      acc.muted = mute;
      try { accounts.saveSync(); } catch (e) { console.error('[mute] saveSync', e); }
      ctx.state.sendSystemMessage(`${acc.username}: ${mute ? 'MUTED' : 'unmuted'}.`);
      m.client?.sendSystemMessage?.(mute
        ? 'You have been muted by an administrator.'
        : 'Your mute has been lifted.');
    });
  }

  commands.register({
    name: 'mute',
    help: 'Silently drop public chat from the targeted player.',
    access: 'GameMaster',
    run: (ctx) => mutateMute(api, ctx, true),
  });
  commands.register({
    name: 'unmute',
    help: 'Lift a mute on the targeted player.',
    access: 'GameMaster',
    run: (ctx) => mutateMute(api, ctx, false),
  });

  return () => {
    commands.unregister('mute');
    commands.unregister('unmute');
  };
}
