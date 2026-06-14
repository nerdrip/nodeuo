// `[xmas claim` / `[xmas force-snow` / `[xmas on|off`. Admin + player
// surface for the systems/christmas engine. The first-login delivery
// is wired separately in main.js's character-bring-into-world path.

import { allMobiles } from '../../_spatial.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};
  const christmas = api.systems?.christmas;
  if (!christmas) {
    api.log?.('xmas: christmas system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'xmas',
    help: '[xmas claim — claim this year\'s holiday gift (during December). [xmas on/off (GM) toggles the event window.',
    access: 'Player',
    run(ctx) {
      const args = String(ctx.args ?? '').trim().split(/\s+/).filter(Boolean);
      const verb = (args[0] ?? 'claim').toLowerCase();
      const access = ctx.state?.account?.accessLevel ?? 'Player';
      const isStaff = access === 'GM' || access === 'Admin' || access === 'Seer';
      if (verb === 'on' || verb === 'off' || verb === 'clear') {
        if (!isStaff) {
          ctx.state.sendSystemMessage('Only staff can toggle the event.');
          return;
        }
        christmas.setOverride(verb === 'clear' ? null : verb);
        ctx.state.sendSystemMessage(`Christmas override → ${verb}`);
        return;
      }
      if (verb === 'force-snow') {
        if (!isStaff) {
          ctx.state.sendSystemMessage('Only staff can force snow.');
          return;
        }
        const pkt = api.protocol.seasonChange?.(3, 1);   // 3 = Winter
        if (!pkt) return;
        let n = 0;
        for (const m of allMobiles(api)) {
          if (!m.client) continue;
          try { m.client.send(pkt); n++; } catch { /* socket race */ }
        }
        ctx.state.sendSystemMessage(`Snow falling over ${n} client(s).`);
        return;
      }
      // Default: claim this year's gift.
      const account = ctx.state?.account;
      if (!account) {
        ctx.state.sendSystemMessage('No account binding — login required.');
        return;
      }
      const gift = christmas.deliverGift(api, account, ctx.sender);
      if (!gift) {
        if (!christmas.isActive()) {
          ctx.state.sendSystemMessage('It is not the holiday season.');
        } else {
          ctx.state.sendSystemMessage('You have already claimed this year\'s gift.');
        }
      }
    },
  });

  return () => api.commands.unregister('xmas');
}
