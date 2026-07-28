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
 * @property {string[]} [aliases] compatibility spellings; hidden from the catalogue.
 * @property {boolean} [hidden] dispatchable but omitted from visual command lists.
 * @property {string} [aliasOf] populated internally for alias entries.
 */

// Aliases mirror ServUO `AccessLevel` enum + ClassicUO command-file
// idioms: `GameMaster` (full word) and `GM` (short) are interchangeable;
// `Counsellor` is the British spelling. Without these aliases, a
// command declaring `access: 'GameMaster'` (the spelling used in
// freeze/account/del/copy/broadcast/…) hit the `?? 0` Player default
// and silently became open to every account. Add the alias instead of
// rewriting every command for the short form.
import { recordAudit } from '../systems/operational-diagnostics.js';
import { commandRegistryAudit, fuzzySuggestions } from '../systems/runtime-governor.js';

// Shared, non-enumerable-by-convention metadata used by the script runtime to
// identify command owners in collision diagnostics without exposing an
// implementation field through command catalogues or JSON responses.
const COMMAND_OWNER = Symbol.for('nodeuo.commandOwner');

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
    /** Duplicate attempts retained for diagnostics instead of silently
     * replacing a command according to filesystem load order. */
    this.collisions = [];
    /** @type {Map<string, Set<string>>} */
    this._aliasesByCanonical = new Map();
    this.usage = new Map();
    this.unknownCount = 0;
    this._searchDirty = true;
    this._searchIndex = new Map();
    this._searchNames = new Set();
  }

  /** @param {CommandDef} cmd */
  register(cmd) {
    if (!cmd || typeof cmd.name !== 'string' || !cmd.name.trim() || typeof cmd.run !== 'function') {
      throw new TypeError('Command requires a non-empty name and run(ctx, args) function.');
    }
    const key = cmd.name.trim().toLowerCase();
    const canonical = { ...cmd, name: key };
    const existing = this.commands.get(key);
    if (existing) {
      const keptOwner = existing[COMMAND_OWNER] ?? 'unknown';
      const rejectedOwner = canonical[COMMAND_OWNER] ?? 'unknown';
      this.collisions.push({
        name: key, kept: existing, rejected: canonical, keptOwner, rejectedOwner,
      });
      console.warn(
        `[cmd] duplicate registration [${key}] rejected; keeping ${keptOwner}, rejecting ${rejectedOwner}`,
      );
      return false;
    }
    this.commands.set(key, canonical);
    this._searchDirty = true;

    const aliases = new Set();
    for (const rawAlias of cmd.aliases ?? []) {
      const alias = String(rawAlias).trim().toLowerCase();
      if (!alias || alias === key) continue;
      const occupied = this.commands.get(alias);
      if (occupied) {
        this.collisions.push({ name: alias, kept: occupied, rejected: canonical, aliasFor: key });
        console.warn(`[cmd] alias [${alias}] for [${key}] rejected; name is already registered`);
        continue;
      }
      this.commands.set(alias, {
        ...canonical, name: alias, aliases: undefined, aliasOf: key, hidden: true,
      });
      aliases.add(alias);
    }
    if (aliases.size) this._aliasesByCanonical.set(key, aliases);
    return true;
  }

  unregister(name) {
    const key = String(name).toLowerCase();
    const entry = this.commands.get(key);
    if (!entry) return false;
    if (entry.aliasOf) {
      this.commands.delete(key);
      this._searchDirty = true;
      this._aliasesByCanonical.get(entry.aliasOf)?.delete(key);
      return true;
    }
    for (const alias of this._aliasesByCanonical.get(key) ?? []) this.commands.delete(alias);
    this._aliasesByCanonical.delete(key);
    const removed = this.commands.delete(key);
    if (removed) this._searchDirty = true;
    return removed;
  }

  _ensureSearchIndex() {
    if (!this._searchDirty) return;
    this._searchIndex.clear(); this._searchNames.clear();
    for (const command of this.commands.values()) {
      if (command.aliasOf || command.hidden === true) continue;
      const name = command.name.toLowerCase(); this._searchNames.add(name);
      const padded = `  ${name} `;
      for (let i = 0; i <= padded.length - 3; i++) {
        const gram = padded.slice(i, i + 3); const set = this._searchIndex.get(gram) ?? new Set();
        set.add(name); this._searchIndex.set(gram, set);
      }
    }
    this._searchDirty = false;
  }

  /** Canonical, visible command definitions for UI catalogues/audits. */
  list({ includeHidden = false } = {}) {
    return [...this.commands.values()].filter((cmd) => (
      !cmd.aliasOf && (includeHidden || cmd.hidden !== true)
    ));
  }

  usageSnapshot() {
    return {
      unknownCount: this.unknownCount,
      commands: [...this.usage.entries()].map(([name, stat]) => ({
        name, ...stat,
        averageMs: stat.completed ? Number((stat.totalMs / stat.completed).toFixed(3)) : 0,
      })).sort((a, b) => b.calls - a.calls),
      collisions: this.collisions.map((entry) => ({
        name: entry.name,
        aliasFor: entry.aliasFor,
        keptOwner: entry.keptOwner,
        rejectedOwner: entry.rejectedOwner,
      })),
    };
  }

  diagnostics() {
    this._ensureSearchIndex();
    const audit = commandRegistryAudit(this.list({ includeHidden: true }));
    const unused = this.list({ includeHidden: true })
      .filter((command) => !this.usage.has(command.name))
      .map((command) => command.name).sort();
    const aliasGroups = [...this._aliasesByCanonical].map(([name, aliases]) => ({ name, aliases: [...aliases].sort() }));
    return { ...audit, unused, unreachable: this.collisions.map((entry) => entry.name),
      collisions: this.collisions.length, aliases: this.commands.size - this.list({ includeHidden: true }).length,
      aliasGroups, searchIndex: { names: this._searchNames.size, grams: this._searchIndex.size } };
  }

  suggest(input, access = 'Player', limit = 5) {
    this._ensureSearchIndex();
    const query = String(input).toLowerCase(); const padded = `  ${query} `; const scored = new Map();
    for (let i = 0; i <= padded.length - 3; i++) for (const name of this._searchIndex.get(padded.slice(i, i + 3)) ?? []) scored.set(name, (scored.get(name) ?? 0) + 1);
    let candidates = [...scored].sort((a, b) => b[1] - a[1]).slice(0, 64).map(([name]) => name);
    // Very short typos have no trigram overlap; use the bounded first-letter
    // bucket instead of scanning all command definitions.
    if (!candidates.length) candidates = [...(this._searchIndex.get(`  ${query[0] ?? ''}`) ?? [])].slice(0, 64);
    const names = candidates.filter((name) => hasAccess(access, this.commands.get(name)?.access ?? 'Admin'));
    return fuzzySuggestions(input, names, limit).filter((row) => row.score <= Math.max(2, String(input).length / 2));
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
    if (!cmd) {
      this.unknownCount++;
      const actual = ctx.state?.account?.accessLevel ?? 'Player';
      const suggestions = this.suggest(name, actual, 3);
      if (suggestions.length) ctx.state?.sendSystemMessage?.(`Unknown command [${name}. Did you mean [${suggestions[0].name}?`);
      return false;
    }
    const canonicalName = cmd.aliasOf ?? name;
    const stat = this.usage.get(canonicalName) ?? {
      calls: 0, completed: 0, denied: 0, errors: 0, totalMs: 0, maxMs: 0, lastUsedAt: 0,
    };
    stat.calls++; stat.lastUsedAt = Date.now(); this.usage.set(canonicalName, stat);
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
      stat.denied++;
      recordAudit('command.denied', { actor: ctx.state?.accountName, target: canonicalName, detail: `${actual} needs ${required}`, ok: false });
      return true; // command existed; we simply denied it
    }
    const argv = parts.slice(1);
    // Many scripts read the parsed tokens via `ctx.args` instead of the second
    // run() parameter. Expose both so either style works.
    ctx.args = argv;
    const startedAt = performance.now();
    const finish = (error = null) => {
      const elapsed = performance.now() - startedAt;
      stat.completed++; stat.totalMs += elapsed; stat.maxMs = Math.max(stat.maxMs, elapsed);
      if (error) stat.errors++;
      recordAudit(error ? 'command.error' : 'command.run', {
        actor: ctx.state?.accountName, target: canonicalName,
        detail: error ? String(error?.message ?? error) : `${argv.length} argument(s)`, ok: !error,
      });
    };
    try {
      const result = cmd.run(ctx, argv);
      if (result && typeof result.then === 'function') {
        result.then(() => finish()).catch((e) => {
          finish(e);
          console.error(`[cmd] ${name} rejected:`, e);
          ctx.state?.sendSystemMessage?.(`Command [${name} failed. Check the server log and try again.`);
        });
      } else finish();
    } catch (e) {
      finish(e);
      console.error(`[cmd] ${name} threw:`, e);
      ctx.state?.sendSystemMessage?.(`Command [${name} failed. Check the server log and try again.`);
    }
    return true;
  }
}
