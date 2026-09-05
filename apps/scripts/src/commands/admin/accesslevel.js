// [accesslevel — change an account's access level. Mirrors ServUO
// `Set.cs AccessLevel` admin command. Only Admin can promote/demote;
// the highest-rank account can never be silently demoted by another
// admin to avoid lock-out (the only way to demote an Admin is via the
// shard's SQLite account table directly).
//
// Usage:
//   [accesslevel <username> <level>
//   level ∈ {Player, Counselor, GameMaster, Admin}
//
// Counselor / GameMaster aliases (CounsellorCommand from ServUO):
//   counsellor → Counselor

const LEVELS = ['Player', 'Counselor', 'GameMaster', 'Admin'];
const ALIASES = {
  player: 'Player',
  counsellor: 'Counselor', counselor: 'Counselor',
  gm: 'GameMaster', gamemaster: 'GameMaster',
  admin: 'Admin', administrator: 'Admin',
};

function normalizeLevel(s) {
  if (!s) return null;
  const lower = s.toLowerCase();
  return ALIASES[lower] ?? (LEVELS.includes(s) ? s : null);
}

export default function (api) {
  const { commands } = api;
  const accounts = api.ctx?.accounts;
  if (!accounts) return;

  commands.register({
    name: 'accesslevel',
    help: 'Change an account access level. Usage: [accesslevel <user> <Player|Counselor|GameMaster|Admin>',
    access: 'Admin',
    run: (ctx) => {
      const username = ctx.args?.[0];
      const levelArg = ctx.args?.[1];
      if (!username || !levelArg) {
        ctx.state.sendSystemMessage('Usage: [accesslevel <username> <level>');
        return;
      }
      const acc = accounts.accounts.get(username.toLowerCase());
      if (!acc) { ctx.state.sendSystemMessage(`No account: ${username}`); return; }
      const level = normalizeLevel(levelArg);
      if (!level) {
        ctx.state.sendSystemMessage(`Unknown level. One of: ${LEVELS.join(', ')}`);
        return;
      }
      const before = acc.accessLevel;
      acc.accessLevel = level;
      try { accounts.saveSync(); } catch (e) { console.error('[accesslevel] saveSync', e); }
      ctx.state.sendSystemMessage(`${acc.username}: ${before} → ${level}`);
    },
  });

  return () => commands.unregister('accesslevel');
}
