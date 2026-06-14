// Commands registry. Scripts (and the server itself) register text commands
// here; player speech starting with '[' or '.' is routed through this table.
//
// Each command handler receives (context, args) where context includes the
// sender's mobile, net state, and the world.

/**
 * @typedef {Object} CommandContext
 * @property {import('../world/world.js').Mobile} sender
 * @property {import('./net-state.js').NetState} state
 * @property {import('../world/world.js').World} world
 */

/**
 * @typedef {'Player'|'Counselor'|'GM'|'Admin'} AccessLevel
 *
 * @typedef {Object} CommandDef
 * @property {string} name
 * @property {(ctx: CommandContext, args: string[]) => void} run
 * @property {string} [help]
 * @property {AccessLevel} [access]  minimum access level required; defaults to 'Admin'.
 *                                    Commands exposed to normal players must
 *                                    explicitly set `access: 'Player'`.
 */

// Aliases mirror ServUO `AccessLevel` enum + ClassicUO command-file
// idioms: `GameMaster` (full word) and `GM` (short) are interchangeable;
// `Counsellor` is the British spelling. Without these aliases, a
// command declaring `access: 'GameMaster'` (the spelling used in
// freeze/account/del/copy/broadcast/…) hit the `?? 0` Player default
// and silently became open to every account. Add the alias instead of
// rewriting every command for the short form.
const ACCESS_ORDER = {
  Player: 0,
  Counselor: 1, Counsellor: 1,
  Seer: 2,                              // ServUO Seer — between Counselor and GM
  GM: 3, GameMaster: 3,
  Admin: 4, Administrator: 4,
};

/** @returns {boolean} */
export function hasAccess(actual, required) {
  return (ACCESS_ORDER[actual] ?? -1) >= (ACCESS_ORDER[required] ?? 0);
}

export class CommandRegistry {
  constructor() {
    /** @type {Map<string, CommandDef>} */
    this.commands = new Map();
  }

  /** @param {CommandDef} cmd */
  register(cmd) {
    this.commands.set(cmd.name.toLowerCase(), cmd);
  }

  unregister(name) {
    this.commands.delete(name.toLowerCase());
  }

  /**
   * Parse a command line ("add torch 3") and dispatch to the handler.
   * Returns true if the command existed. Enforces per-command access level.
   *
   * @param {string} line
   * @param {CommandContext} ctx
   */
  dispatch(line, ctx) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 0) return false;
    const name = parts[0].toLowerCase();
    const cmd = this.commands.get(name);
    if (!cmd) return false;
    const required = cmd.access ?? 'Admin';
    // Defensive re-promote — same guard as `pushCommandCatalogue`. If
    // `state.account.accessLevel` got demoted mid-session (account-DB
    // reload, save/restore cycle, etc.) and the username is in
    // UO_ADMINS, re-promote BEFORE checking access. Without this an
    // admin who ran `[createworld` could be told "you lack access"
    // for their own subsequent commands.
    try {
      const refreshed = ctx.state?.ctx?.accounts?.recheckPromotion?.(ctx.state?.accountName);
      if (refreshed) ctx.state.account = refreshed;
    } catch { /* advisory */ }
    const actual = ctx.state?.account?.accessLevel ?? 'Player';
    if (!hasAccess(actual, required)) {
      ctx.state?.sendSystemMessage?.(`You lack the access level (${required}) to use [${name}.`);
      console.warn(`[cmd] deny ${ctx.state?.accountName ?? '?'}(${actual}) -> ${name} (needs ${required})`);
      return true; // command existed; we simply denied it
    }
    const argv = parts.slice(1);
    // Many scripts read the parsed tokens via `ctx.args` instead of the second
    // run() parameter. Expose both so either style works.
    ctx.args = argv;
    try {
      cmd.run(ctx, argv);
    } catch (e) {
      console.error(`[cmd] ${name} threw:`, e);
    }
    return true;
  }
}
