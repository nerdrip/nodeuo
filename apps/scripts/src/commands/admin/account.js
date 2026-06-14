// [account — dump account information. Mirrors ServUO `AdminAccount.cs`
// in spirit (text dump only — no full-blown admin gump yet).
//
// Usage:
//   [account                     info on the caller's own account
//   [account <username>          info on the named account
//   [account create <username> <password>   create a new account
//
// All but the read form require Admin. Read form requires GM (so a GM
// can audit which characters belong to whom).

export default function (api) {
  const { commands } = api;
  const accounts = api.ctx?.accounts;
  if (!accounts) return;

  function findAccount(name) {
    return accounts.accounts.get(String(name).toLowerCase()) ?? null;
  }

  function dump(ctx, acc) {
    if (!acc) { ctx.state.sendSystemMessage('No such account.'); return; }
    const lines = [
      `account: ${acc.username}  (${acc.accessLevel})`,
      `  created:    ${acc.created ?? '?'}`,
      `  lastLogin:  ${acc.lastLogin ?? 'never'}`,
      `  banned:     ${acc.banned ? 'yes' : 'no'}`,
      `  muted:      ${acc.muted ? 'yes' : 'no'}`,
      `  jailed:     ${acc.jailed ? 'yes' : 'no'}`,
    ];
    if (acc.mobileSerial) {
      lines.push(`  mobileSerial: 0x${(acc.mobileSerial >>> 0).toString(16).padStart(8, '0')}`);
    }
    for (const ln of lines) ctx.state.sendSystemMessage(ln);
  }

  commands.register({
    name: 'account',
    help: 'Account info: [account [username] | [account create <user> <pass>]',
    access: 'GameMaster',
    run: (ctx) => {
      const sub = ctx.args?.[0];
      if (!sub) {
        const me = ctx.state?.account;
        if (!me) { ctx.state.sendSystemMessage('You are not bound to an account.'); return; }
        dump(ctx, me);
        return;
      }
      if (/^create$/i.test(sub)) {
        // Admin-only path.
        if (ctx.state?.account?.accessLevel !== 'Admin') {
          ctx.state.sendSystemMessage('Admin only.');
          return;
        }
        const username = ctx.args?.[1];
        const password = ctx.args?.[2];
        if (!username || !password) {
          ctx.state.sendSystemMessage('Usage: [account create <username> <password>');
          return;
        }
        try {
          const acc = accounts.createAccount(username, password, 'Player');
          ctx.state.sendSystemMessage(`Created account: ${acc.username}`);
        } catch (e) {
          ctx.state.sendSystemMessage(`Failed: ${e.message}`);
        }
        return;
      }
      const acc = findAccount(sub);
      dump(ctx, acc);
    },
  });

  return () => commands.unregister('account');
}
