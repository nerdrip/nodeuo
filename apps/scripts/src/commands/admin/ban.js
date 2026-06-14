// [ban / [unban — flip the `banned` flag on an account. Mirrors ServUO
// `BanCommand` in `Scripts/Commands/General/Ban.cs`. Banned accounts can
// no longer authenticate; their currently-online sessions are kicked.
//
// Usage:
//   [ban <username>           ban by name
//   [ban                      cursor-target a logged-in mobile and ban
//                             the account that owns them
//   [unban <username>         unban
//
// Targeting a mobile (no arg) finds the player via `mob.accountName`
// (stamped in handlers.js bringIntoWorld). NPCs without an account
// silently no-op.

import { resolveMobileArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';

function findAccount(api, identifier) {
  const accounts = api.ctx?.accounts;
  if (!accounts) return null;
  return accounts.accounts.get(String(identifier).toLowerCase()) ?? null;
}

function disconnectAccountSessions(world, accountName) {
  const lower = String(accountName).toLowerCase();
  let kicked = 0;
  for (const m of allMobiles({ world })) {
    if (!m.client) continue;
    const acct = m.client?.accountName ?? m.accountName;
    if (acct && acct.toLowerCase() === lower) {
      try { m.client.ws?.close?.(); } catch { /* ignore */ }
      kicked++;
    }
  }
  return kicked;
}

export default function (api) {
  const { commands, world } = api;
  const accounts = api.ctx?.accounts;
  if (!accounts) return;

  commands.register({
    name: 'ban',
    help: 'Ban an account by username, or target a mobile.',
    access: 'Admin',
    run: (ctx) => {
      const apply = (acc) => {
        if (!acc) return;
        if (acc.accessLevel === 'Admin') {
          ctx.state.sendSystemMessage(`Refusing to ban admin account ${acc.username}.`);
          return;
        }
        acc.banned = true;
        try { accounts.saveSync(); } catch (e) { console.error('[ban] saveSync', e); }
        const kicked = disconnectAccountSessions(world, acc.username);
        ctx.state.sendSystemMessage(`Banned ${acc.username}${kicked > 0 ? ` (kicked ${kicked} session)` : ''}.`);
      };
      const arg = ctx.args?.[0];
      if (arg) {
        const acc = findAccount(api, arg);
        if (!acc) { ctx.state.sendSystemMessage(`No account: ${arg}`); return; }
        apply(acc);
        return;
      }
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        const acc = m.accountName ? findAccount(api, m.accountName) : null;
        if (!acc) { ctx.state.sendSystemMessage('Targeted mobile has no associated account.'); return; }
        apply(acc);
      });
    },
  });

  commands.register({
    name: 'unban',
    help: 'Unban an account by username.',
    access: 'Admin',
    run: (ctx) => {
      const arg = ctx.args?.[0];
      if (!arg) { ctx.state.sendSystemMessage('Usage: [unban <username>'); return; }
      const acc = findAccount(api, arg);
      if (!acc) { ctx.state.sendSystemMessage(`No account: ${arg}`); return; }
      acc.banned = false;
      try { accounts.saveSync(); } catch (e) { console.error('[unban] saveSync', e); }
      ctx.state.sendSystemMessage(`Unbanned ${acc.username}.`);
    },
  });

  return () => {
    commands.unregister('ban');
    commands.unregister('unban');
  };
}
