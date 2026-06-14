// `[shoplog [N]` — admin transaction audit for the nearest vendor.
// Reads the ring buffer maintained by vendor.js (cap 50). Default
// shows the last 10 entries; an explicit [shoplog 30] caps higher.
//
// Each line: time-ago · type · player → vendor · count items · gold.
// Useful when a player claims they bought something and the inventory
// disagrees, or when checking exploit volume on a bug-hunting round.

import fs from 'node:fs';
import path from 'node:path';
import { allMobiles } from '../../_spatial.js';

const RANGE = 6;

function findNearestVendor(world, mob) {
  let best = null, bestD = RANGE + 1;
  for (const m of allMobiles({ world })) {
    if (!m.vendorKind) continue;
    if (m.map !== mob.map) continue;
    const d = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
    if (d <= bestD) { best = m; bestD = d; }
  }
  return best;
}

/**
 * Wave 26: preset entry helpers. Old-format presets store the tokens
 * array directly under the name key; new-format wraps as
 * { tokens, tag? }. Read paths normalise to tokens; write paths
 * preserve any existing tag.
 */
function presetTokens(entry) {
  if (Array.isArray(entry)) return entry;
  if (entry && Array.isArray(entry.tokens)) return entry.tokens;
  return null;
}
function presetTag(entry) {
  if (Array.isArray(entry)) return null;
  return entry?.tag ?? null;
}
function presetWrite(map, name, tokens, tag) {
  map.set(name, { tokens, ...(tag ? { tag } : {}) });
}

/**
 * Wave 19: tiny `where`-clause compiler for [shoplog. Tokens like
 * `gold > 100 and type = buy` get parsed into a function (entry) → bool.
 * Field aliases:
 *   gold → entry.gold
 *   type → entry.type
 *   items → entry.itemCount
 *   ago → seconds since entry.ts
 *   cust → entry.customerName (string substring/equality)
 * Numeric ops use Number(); string ops use lowercase substring (for `=`)
 * or strict !=. Multi-clause joined by 'and' (OR not supported — keeps
 * parsing trivial; use multiple commands if you need it).
 */
function compileWhereExpression(tokens, context = null) {
  if (!tokens.length) return { ok: false, error: 'empty expression' };
  // Wave 20: recursive-descent parser. Grammar:
  //   expr   := orExpr
  //   orExpr := andExpr ( 'or'  andExpr )*
  //   andExpr:= unary  ( 'and' unary  )*
  //   unary  := '(' expr ')' | clause
  //   clause := field op value
  // Operator precedence: AND binds tighter than OR (standard).
  // Token stream is the user's whitespace-split args; '(' and ')'
  // can appear glued to other tokens (e.g. "(gold") so we pre-split.
  const flat = [];
  for (const raw of tokens) {
    const s = String(raw);
    // Wave 28: `preset+a+b+c` shorthand. Expands to
    // `( preset:a or preset:b or preset:c )` before parsing. Lets
    // players quickly union multiple stored queries without typing
    // the full `or` chain. Caveat: bare `preset+` (no names) drops
    // through and the parser will reject "unknown field".
    if (s.toLowerCase().startsWith('preset+')) {
      const names = s.slice('preset+'.length).split('+').filter(Boolean);
      if (names.length > 0) {
        flat.push('(');
        names.forEach((n, idx) => {
          if (idx > 0) flat.push('or');
          flat.push(`preset:${n.toLowerCase()}`);
        });
        flat.push(')');
        continue;
      }
    }
    // Wave 29: glob wildcard in preset references. `preset:fraud-*`
    // matches every saved preset whose name starts with `fraud-`,
    // expanded inline to an OR-chain. Supports `*` (zero-or-more)
    // and `?` (single char). Empty match → nothing emitted (parser
    // will fail on the trailing operator, which is the right signal).
    const lc = s.toLowerCase();
    if (lc.startsWith('preset:') && (lc.includes('*') || lc.includes('?'))) {
      const pat = lc.slice('preset:'.length);
      const presets = context?.presets;
      if (presets) {
        const rx = new RegExp(
          '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                   .replace(/\*/g, '.*')
                   .replace(/\?/g, '.') + '$',
        );
        const matches = [...presets.keys()].filter((k) => rx.test(k));
        if (matches.length > 0) {
          flat.push('(');
          matches.forEach((n, idx) => {
            if (idx > 0) flat.push('or');
            flat.push(`preset:${n}`);
          });
          flat.push(')');
          continue;
        }
        // No matches — emit a clause that always evaluates false so
        // the parser doesn't choke on a missing atom. `gold < 0` is
        // never true for non-negative price fields.
        flat.push('gold', '<', '0');
        continue;
      }
    }
    let buf = '';
    for (const ch of s) {
      if (ch === '(' || ch === ')') {
        if (buf) { flat.push(buf); buf = ''; }
        flat.push(ch);
      } else {
        buf += ch;
      }
    }
    if (buf) flat.push(buf);
  }
  let i = 0;
  const peek = () => flat[i];
  const advance = () => flat[i++];

  function parseExpr() { return parseOr(); }
  function parseOr() {
    let left = parseAnd();
    if (left.error) return left;
    while (peek()?.toLowerCase() === 'or') {
      advance();
      const right = parseAnd();
      if (right.error) return right;
      const lTest = left.test, rTest = right.test;
      left = { test: (e) => lTest(e) || rTest(e) };
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    if (left.error) return left;
    while (peek()?.toLowerCase() === 'and') {
      advance();
      const right = parseUnary();
      if (right.error) return right;
      const lTest = left.test, rTest = right.test;
      left = { test: (e) => lTest(e) && rTest(e) };
    }
    return left;
  }
  function parseUnary() {
    // Wave 21: NOT prefix. Recursive — `not not type = buy` is legal
    // (and a no-op). Higher precedence than AND/OR.
    if (peek()?.toLowerCase() === 'not') {
      advance();
      const inner = parseUnary();
      if (inner.error) return inner;
      const innerTest = inner.test;
      return { test: (e) => !innerTest(e) };
    }
    if (peek() === '(') {
      advance();
      const inner = parseExpr();
      if (inner.error) return inner;
      if (advance() !== ')') return { error: 'missing ")"' };
      return inner;
    }
    // Wave 27: preset reference — `preset:<name>` resolves to the
    // tokens of the named preset (compiled with the same context so
    // nested preset references work). Returns the inner test fn.
    // Cycle detection via a Set kept on `context._inflight`.
    const tok = peek();
    if (typeof tok === 'string' && tok.toLowerCase().startsWith('preset:')) {
      advance();
      const name = tok.slice('preset:'.length).toLowerCase();
      if (!context?.presets) {
        return { error: 'preset reference not allowed here' };
      }
      const inflight = context._inflight ??= new Set();
      if (inflight.has(name)) {
        return { error: 'preset cycle: ' + name };
      }
      const entry = context.presets.get?.(name);
      const refTokens = presetTokens(entry);
      if (!refTokens) return { error: 'unknown preset "' + name + '"' };
      inflight.add(name);
      const sub = compileWhereExpression(refTokens, context);
      inflight.delete(name);
      if (!sub.ok) return { error: 'in preset "' + name + '": ' + sub.error };
      return { test: sub.test };
    }
    const field = advance()?.toLowerCase();
    const op = advance();
    const value = advance();
    if (!field || !op || value === undefined) {
      return { error: 'incomplete clause' };
    }
    if (!FIELD_GETTERS[field]) return { error: 'unknown field "' + field + '"' };
    if (!OPS[op])              return { error: 'unknown op "' + op + '"' };
    return {
      test: (entry) => OPS[op](FIELD_GETTERS[field](entry), value),
    };
  }

  const tree = parseExpr();
  if (tree.error) return { ok: false, error: tree.error };
  if (i < flat.length) {
    return { ok: false, error: 'unexpected token "' + flat[i] + '" at position ' + i };
  }
  return { ok: true, test: tree.test };
}

const FIELD_GETTERS = {
  gold:  (t) => Number(t.gold ?? 0),
  type:  (t) => String(t.type ?? '').toLowerCase(),
  items: (t) => Number(t.itemCount ?? 0),
  ago:   (t) => Math.floor((Date.now() - (t.ts ?? 0)) / 1000),
  cust:  (t) => String(t.customerName ?? '').toLowerCase(),
};

// Wave 22: cache compiled regex per pattern so repeated queries don't
// re-parse. Bounded LRU (cap 50) — query DSL is small enough that
// regression on this cache is unlikely to be observable.
const _regexCache = new Map();
function toRegex(pattern) {
  const key = String(pattern);
  if (_regexCache.has(key)) return _regexCache.get(key);
  // Strip leading/trailing slashes if present (`/foo/i` style).
  let body = key;
  let flags = 'i';   // case-insensitive default for usability
  const m = key.match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) { body = m[1]; flags = m[2] || 'i'; }
  let rx;
  try { rx = new RegExp(body, flags); }
  catch { rx = null; }
  if (_regexCache.size > 50) _regexCache.delete(_regexCache.keys().next().value);
  _regexCache.set(key, rx);
  return rx;
}

const OPS = {
  '=':  (a, b) => isNumeric(a) ? a === Number(b) : String(a).toLowerCase().includes(String(b).toLowerCase()),
  '!=': (a, b) => isNumeric(a) ? a !== Number(b) : !String(a).toLowerCase().includes(String(b).toLowerCase()),
  '>':  (a, b) => Number(a) >  Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<':  (a, b) => Number(a) <  Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  // Wave 22: regex match. Pattern can be either bare ('marc.*') or
  // /pattern/flags style. Failing-to-compile patterns return false.
  '~':  (a, b) => {
    const rx = toRegex(b);
    return rx ? rx.test(String(a ?? '')) : false;
  },
};

function isNumeric(x) { return typeof x === 'number' && Number.isFinite(x); }

function ago(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'shoplog',
    help: '[shoplog [N] | player | where | save/load/last/presets/share/export/import/rename/stats | dump — admin.',
    access: 'GM',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const vendor = findNearestVendor(world, mob);
      if (!vendor) {
        ctx.state.sendSystemMessage('No vendor within 6 tiles.');
        return;
      }
      const log = vendor._transactionLog ?? [];
      if (!log.length) {
        ctx.state.sendSystemMessage(`${vendor.name}: no transactions logged.`);
        return;
      }
      // Wave 15: `[shoplog player <name>` filters the log to a single
      // customer's transactions (substring, case-insensitive on
      // customerName). Useful for chasing a specific player's history
      // when a refund / dispute happens.
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      // Wave 19: `[shoplog where <f> <op> <v> [and <f> <op> <v>]` —
      // tiny query DSL. Fields: gold, type, items (alias of itemCount),
      // ago (seconds since now). Ops: =, !=, >, >=, <, <=. Values:
      // bare ints OR identifier strings ('buy', 'sell', or part of
      // customerName for special field 'cust'). All clauses join AND.
      // Examples:
      //   [shoplog where gold > 100
      //   [shoplog where type = buy and gold >= 50
      //   [shoplog where cust = marcin and ago < 3600
      // Wave 23: query presets. Three subcommands operating on
      // `mob._shoplogPresets` (Map<name, tokens>) and
      // `mob._lastShoplogQuery` (most-recent where-tokens):
      //   [shoplog save <name> where <expr>   stash a named preset
      //   [shoplog load <name>                replay preset
      //   [shoplog last                       replay most-recent
      // Persistence: both fields live on the player mob via
      // MOBILE_EXT_KEYS so presets survive restarts.
      if (sub === 'save') {
        const name = ctx.args[1]?.toLowerCase();
        const whereKw = ctx.args[2]?.toLowerCase();
        const exprTokens = ctx.args.slice(3);
        if (!name || whereKw !== 'where' || exprTokens.length === 0) {
          ctx.state.sendSystemMessage('Usage: [shoplog save <name> where <expr>');
          return;
        }
        // Validate the expression once before saving (preset:foo
        // references resolve against the player's existing presets).
        const m = compileWhereExpression(exprTokens, { presets: mob._shoplogPresets });
        if (!m.ok) {
          ctx.state.sendSystemMessage(`Query parse error: ${m.error}`);
          return;
        }
        mob._shoplogPresets ??= new Map();
        // Wave 26: preserve existing tag when overwriting a name.
        const existingTag = presetTag(mob._shoplogPresets.get(name));
        presetWrite(mob._shoplogPresets, name, exprTokens, existingTag);
        ctx.state.sendSystemMessage(`Saved query "${name}" (${exprTokens.length} tokens).`);
        return;
      }
      // Wave 31: `[shoplog stats` — summary of player's preset
      // collection: total count, breakdown by tag, presence of a
      // recent query, longest preset (most tokens), shortest, average.
      // Pure read; doesn't touch any state.
      // Wave 34: `[shoplog stats compare <player>` — diff caller's
      // preset collection against another online player. Output:
      // mine-only / theirs-only / shared name lists.
      if (sub === 'stats' && String(ctx.args[1] ?? '').toLowerCase() === 'compare') {
        const targetName = ctx.args.slice(2).join(' ').toLowerCase();
        if (!targetName) {
          ctx.state.sendSystemMessage('Usage: [shoplog stats compare <player>');
          return;
        }
        let target = null;
        for (const m of allMobiles({ world })) {
          if (!m.client) continue;
          if (String(m.name ?? '').toLowerCase().includes(targetName)) { target = m; break; }
        }
        if (!target) {
          ctx.state.sendSystemMessage(`No online player matching "${targetName}".`);
          return;
        }
        const mineKeys = new Set([...(mob._shoplogPresets ?? new Map()).keys()]);
        const theirsKeys = new Set([...(target._shoplogPresets ?? new Map()).keys()]);
        const onlyMine = [...mineKeys].filter((k) => !theirsKeys.has(k)).sort();
        const onlyTheirs = [...theirsKeys].filter((k) => !mineKeys.has(k)).sort();
        const shared = [...mineKeys].filter((k) => theirsKeys.has(k)).sort();
        const lines = [
          `Preset diff: ${mob.name ?? 'you'} ↔ ${target.name}`,
          `  shared (${shared.length}): ${shared.length ? shared.join(', ') : '(none)'}`,
          `  only yours (${onlyMine.length}): ${onlyMine.length ? onlyMine.join(', ') : '(none)'}`,
          `  only theirs (${onlyTheirs.length}): ${onlyTheirs.length ? onlyTheirs.join(', ') : '(none)'}`,
        ];
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      // Wave 33: `[shoplog stats csv` writes the same data plus the
      // per-preset rows to a CSV file in the save dir. Useful for
      // long-term analytics across many GMs / players.
      if (sub === 'stats' && String(ctx.args[1] ?? '').toLowerCase() === 'csv') {
        const map = mob._shoplogPresets;
        if (!map || map.size === 0) {
          ctx.state.sendSystemMessage('No saved presets to export.');
          return;
        }
        (async () => {
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const saveDir = api.persistence?.saveDir
                         ?? path.resolve(process.cwd(), 'saves');
            const playerHex = (mob.serial >>> 0).toString(16);
            const fname = `shoplog-stats-${playerHex}-${Date.now()}.csv`;
            const target = path.join(saveDir, fname);
            const header = 'name,tag,token_count,tokens\n';
            const rows = [...map.entries()].map(([name, entry]) => {
              const toks = presetTokens(entry) ?? [];
              const tag = (presetTag(entry) ?? '').replace(/[",\n]/g, ' ');
              const safeTokens = toks.join(' ').replace(/[",\n]/g, ' ');
              return `${name.replace(/[",\n]/g, ' ')},${tag},${toks.length},"${safeTokens}"`;
            }).join('\n');
            await fs.promises.mkdir(saveDir, { recursive: true });
            await fs.promises.writeFile(target, header + rows + '\n');
            ctx.state.sendSystemMessage(`Exported ${map.size} presets to ${target}`);
          } catch (e) {
            ctx.state.sendSystemMessage(`CSV export failed: ${e.message}`);
          }
        })();
        return;
      }
      if (sub === 'stats') {
        const map = mob._shoplogPresets;
        if (!map || map.size === 0) {
          ctx.state.sendSystemMessage('No saved presets — run [shoplog save first.');
          return;
        }
        const tagCounts = new Map();
        let longest = null, shortest = null, totalTokens = 0;
        for (const [name, entry] of map) {
          const tokens = presetTokens(entry) ?? [];
          const tag = presetTag(entry) ?? '(none)';
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
          totalTokens += tokens.length;
          if (!longest || tokens.length > longest.len) longest = { name, len: tokens.length };
          if (!shortest || tokens.length < shortest.len) shortest = { name, len: tokens.length };
        }
        const lines = [
          `Shoplog presets — ${map.size} total, ${totalTokens} tokens (avg ${(totalTokens / map.size).toFixed(1)}).`,
        ];
        const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
        lines.push('  By tag:');
        for (const [tag, count] of sortedTags) {
          lines.push(`    ${tag.padEnd(16)} ${count}`);
        }
        if (longest) lines.push(`  Longest: "${longest.name}" (${longest.len} tokens)`);
        if (shortest && shortest.name !== longest?.name) {
          lines.push(`  Shortest: "${shortest.name}" (${shortest.len} tokens)`);
        }
        if (mob._lastShoplogQuery) {
          lines.push(`  Last run: ${mob._lastShoplogQuery.length} tokens — replay with [shoplog last`);
        }
        // Wave 32: token-count histogram. Buckets: 1-5 (trivial),
        // 6-10 (simple), 11-20 (compound), 21+ (complex). ASCII bar
        // scales to the largest bucket so even a small collection
        // shows visible gradient.
        const buckets = { '1-5': 0, '6-10': 0, '11-20': 0, '21+': 0 };
        for (const entry of map.values()) {
          const n = (presetTokens(entry) ?? []).length;
          if (n <= 5)       buckets['1-5']++;
          else if (n <= 10) buckets['6-10']++;
          else if (n <= 20) buckets['11-20']++;
          else              buckets['21+']++;
        }
        const maxBucket = Math.max(1, ...Object.values(buckets));
        lines.push('  Token-count distribution:');
        for (const [range, count] of Object.entries(buckets)) {
          const barLen = Math.round((count / maxBucket) * 20);
          const bar = '█'.repeat(barLen) + '░'.repeat(20 - barLen);
          lines.push(`    ${range.padEnd(6)} ${bar} ${count}`);
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      // Wave 30: `[shoplog rename <old> <new>` — relocate a preset
      // under a new name, preserving tokens AND tag. Refuses if old
      // doesn't exist, or if new already exists (avoids accidental
      // overwrite). Cheap audit-friendly operation.
      if (sub === 'rename') {
        const oldName = ctx.args[1]?.toLowerCase();
        const newName = ctx.args[2]?.toLowerCase();
        if (!oldName || !newName) {
          ctx.state.sendSystemMessage('Usage: [shoplog rename <old> <new>');
          return;
        }
        const map = mob._shoplogPresets;
        const entry = map?.get?.(oldName);
        if (!entry) {
          ctx.state.sendSystemMessage(`No preset "${oldName}" to rename.`);
          return;
        }
        if (map.has(newName)) {
          ctx.state.sendSystemMessage(`Preset "${newName}" already exists. Delete it first.`);
          return;
        }
        const tokens = presetTokens(entry);
        const tag = presetTag(entry);
        map.delete(oldName);
        presetWrite(map, newName, tokens, tag);
        ctx.state.sendSystemMessage(`Renamed preset "${oldName}" → "${newName}".`);
        return;
      }
      // Wave 26: `[shoplog tag <name> <tag>` stamps a category tag on a
      // saved preset; empty tag clears. `[shoplog presets [tag]`
      // filters listings by tag.
      if (sub === 'tag') {
        const name = ctx.args[1]?.toLowerCase();
        const tagVal = ctx.args.slice(2).join(' ').trim().toLowerCase();
        if (!name) { ctx.state.sendSystemMessage('Usage: [shoplog tag <name> [tag]'); return; }
        const map = mob._shoplogPresets;
        const entry = map?.get?.(name);
        const tokens = presetTokens(entry);
        if (!tokens) {
          ctx.state.sendSystemMessage(`No preset "${name}".`);
          return;
        }
        if (!tagVal) {
          map.set(name, { tokens });
          ctx.state.sendSystemMessage(`Cleared tag on "${name}".`);
        } else {
          map.set(name, { tokens, tag: tagVal });
          ctx.state.sendSystemMessage(`Tagged "${name}" → "${tagVal}".`);
        }
        return;
      }
      if (sub === 'load' || sub === 'last') {
        let exprTokens;
        if (sub === 'load') {
          const name = ctx.args[1]?.toLowerCase();
          if (!name) { ctx.state.sendSystemMessage('Usage: [shoplog load <name>'); return; }
          exprTokens = presetTokens(mob._shoplogPresets?.get?.(name));
          if (!exprTokens) {
            const known = mob._shoplogPresets ? [...mob._shoplogPresets.keys()].join(', ') : '(none)';
            ctx.state.sendSystemMessage(`No preset "${name}". Saved presets: ${known}`);
            return;
          }
        } else {
          exprTokens = mob._lastShoplogQuery;
          if (!exprTokens) {
            ctx.state.sendSystemMessage('No previous query to replay. Run [shoplog where … first.');
            return;
          }
        }
        const matcher = compileWhereExpression(exprTokens, { presets: mob._shoplogPresets });
        if (!matcher.ok) {
          ctx.state.sendSystemMessage(`Stored query parse error: ${matcher.error}`);
          return;
        }
        const filtered = log.filter((t) => matcher.test(t));
        const lines = [`${vendor.name} — ${filtered.length} of ${log.length} matching (replayed):`];
        for (let i = filtered.length - 1; i >= 0; i--) {
          const t = filtered[i];
          const cust = t.customerName ?? `0x${(t.customerSerial >>> 0).toString(16)}`;
          lines.push(`  ${ago(t.ts).padEnd(8)} ${t.type.toUpperCase().padEnd(4)} ${cust}  ${t.itemCount} item(s)  ${t.gold} gp`);
        }
        if (!filtered.length) lines.push('  (none)');
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      // Wave 25: `[shoplog export <name>` — encode a saved preset
      // as base64(JSON({name, tokens})). Output as a system message
      // the player can copy-paste.  `[shoplog import <b64>` — decode
      // and stash under the original preset name (overwriting).
      if (sub === 'export') {
        const presetName = ctx.args[1]?.toLowerCase();
        if (!presetName) { ctx.state.sendSystemMessage('Usage: [shoplog export <name>'); return; }
        const entry = mob._shoplogPresets?.get?.(presetName);
        const tokens = presetTokens(entry);
        if (!tokens) {
          ctx.state.sendSystemMessage(`No preset "${presetName}".`);
          return;
        }
        const tag = presetTag(entry);
        const payload = { v: 1, name: presetName, tokens, ...(tag ? { tag } : {}) };
        const json = JSON.stringify(payload);
        const b64 = Buffer.from(json, 'utf8').toString('base64');
        ctx.state.sendSystemMessage(`Exported "${presetName}":\n${b64}`);
        return;
      }
      if (sub === 'import') {
        const b64 = ctx.args.slice(1).join('');
        if (!b64) { ctx.state.sendSystemMessage('Usage: [shoplog import <base64>'); return; }
        let decoded;
        try {
          const json = Buffer.from(b64, 'base64').toString('utf8');
          decoded = JSON.parse(json);
        } catch (e) {
          ctx.state.sendSystemMessage(`Decode failed: ${e.message}`);
          return;
        }
        if (!decoded || decoded.v !== 1
            || typeof decoded.name !== 'string'
            || !Array.isArray(decoded.tokens)) {
          ctx.state.sendSystemMessage('Decoded payload missing required fields (v=1 / name / tokens).');
          return;
        }
        // Validate the expression itself before stashing — refuses to
        // import a preset that won't run. preset:<name> references
        // are validated against the player's current presets.
        const m = compileWhereExpression(decoded.tokens, { presets: mob._shoplogPresets });
        if (!m.ok) {
          ctx.state.sendSystemMessage(`Imported query parse error: ${m.error}`);
          return;
        }
        mob._shoplogPresets ??= new Map();
        // Carry imported tag through to local entry.
        if (decoded.tag) presetWrite(mob._shoplogPresets, decoded.name.toLowerCase(), decoded.tokens, decoded.tag);
        else             presetWrite(mob._shoplogPresets, decoded.name.toLowerCase(), decoded.tokens, null);
        ctx.state.sendSystemMessage(
          `Imported preset "${decoded.name}" (${decoded.tokens.length} tokens${decoded.tag ? `, tag="${decoded.tag}"` : ''}).`,
        );
        return;
      }
      // Wave 24: `[shoplog share <name> <player>` — copy a saved
      // preset to another logged-in player. Recipient must be online
      // (we look them up by display name, case-insensitive substring).
      // The donor's preset is unchanged. Use case: GM sharing a
      // canned forensic query with another auditor.
      if (sub === 'share') {
        const presetName = ctx.args[1]?.toLowerCase();
        const targetName = ctx.args.slice(2).join(' ').toLowerCase();
        if (!presetName || !targetName) {
          ctx.state.sendSystemMessage('Usage: [shoplog share <preset-name> <player-name>');
          return;
        }
        const srcEntry = mob._shoplogPresets?.get?.(presetName);
        const tokens = presetTokens(srcEntry);
        const tag = presetTag(srcEntry);
        if (!tokens) {
          ctx.state.sendSystemMessage(`No preset "${presetName}" to share.`);
          return;
        }
        let target = null;
        for (const m of allMobiles({ world })) {
          if (!m.client) continue;
          if (String(m.name ?? '').toLowerCase().includes(targetName)) { target = m; break; }
        }
        if (!target) {
          ctx.state.sendSystemMessage(`No online player matching "${targetName}".`);
          return;
        }
        target._shoplogPresets ??= new Map();
        presetWrite(target._shoplogPresets, presetName, [...tokens], tag);
        ctx.state.sendSystemMessage(
          `Shared "${presetName}" with ${target.name}.`,
        );
        target.client.sendSystemMessage?.(
          `${mob.name} shared shoplog query "${presetName}" with you. Run [shoplog load ${presetName}.`,
        );
        return;
      }
      if (sub === 'presets') {
        const map = mob._shoplogPresets;
        if (!map || map.size === 0) {
          ctx.state.sendSystemMessage('No saved presets.');
          return;
        }
        // Wave 26: optional `[shoplog presets <tag>` filter.
        const filter = ctx.args[1]?.toLowerCase();
        const out = [`Saved query presets${filter ? ` — tag "${filter}"` : ''}:`];
        let count = 0;
        for (const [name, entry] of map) {
          const toks = presetTokens(entry);
          const tag = presetTag(entry);
          if (filter && tag !== filter) continue;
          const tagBadge = tag ? `[${tag}] ` : '';
          out.push(`  ${name.padEnd(16)} ${tagBadge}${(toks ?? []).join(' ')}`);
          count++;
        }
        if (count === 0) {
          out.push(filter ? `  (no presets with tag "${filter}")` : '  (none)');
        }
        ctx.state.sendSystemMessage(out.join('\n'));
        return;
      }
      if (sub === 'where') {
        const tokens = ctx.args.slice(1);
        // Wave 27: pass presets into the compiler so `preset:<name>`
        // atoms resolve. Stored presets come from the player mob.
        const matcher = compileWhereExpression(tokens, { presets: mob._shoplogPresets });
        if (!matcher.ok) {
          ctx.state.sendSystemMessage(`Query parse error: ${matcher.error}`);
          return;
        }
        // Wave 23: stash the most-recent for `[shoplog last`.
        mob._lastShoplogQuery = tokens;
        const filtered = log.filter((t) => matcher.test(t));
        const lines = [`${vendor.name} — ${filtered.length} of ${log.length} matching:`];
        for (let i = filtered.length - 1; i >= 0; i--) {
          const t = filtered[i];
          const cust = t.customerName ?? `0x${(t.customerSerial >>> 0).toString(16)}`;
          lines.push(`  ${ago(t.ts).padEnd(8)} ${t.type.toUpperCase().padEnd(4)} ${cust}  ${t.itemCount} item(s)  ${t.gold} gp`);
        }
        if (!filtered.length) lines.push('  (none)');
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      // Wave 16: `[shoplog dump` writes the full transaction log to a
      // saves/shoplog-<vendorSerial>-<ts>.json file for offline
      // analysis (spreadsheet pivot, fraud detection, balance audit).
      if (sub === 'dump') {
        const saveDir = api.persistence?.saveDir
                     ?? path.resolve(process.cwd(), 'saves');
        const fname = `shoplog-${(vendor.serial >>> 0).toString(16)}-${Date.now()}.json`;
        const target = path.join(saveDir, fname);
        const payload = {
          vendor: {
            serial: vendor.serial >>> 0, name: vendor.name, kind: vendor.vendorKind,
            title: vendor.title, lifetimeBuys: vendor._lifetimeBuys ?? 0,
          },
          dumpedAt: new Date().toISOString(),
          transactionCount: log.length,
          transactions: log,
        };
        try {
          fs.mkdirSync(saveDir, { recursive: true });
          fs.writeFileSync(target, JSON.stringify(payload, null, 2));
          ctx.state.sendSystemMessage(`Dumped ${log.length} transactions to ${target}`);
        } catch (e) {
          ctx.state.sendSystemMessage(`Dump failed: ${e.message}`);
        }
        return;
      }
      let filtered = log;
      let header;
      if (sub === 'player') {
        // Wave 17: combined `[shoplog player <name> [N]` — trailing
        // integer caps the result count. Without it, full match list
        // is returned. We sniff the LAST arg: numeric → cap; non-
        // numeric → name component, no cap.
        const tail = ctx.args.slice(1);
        let cap = 0;
        const lastInt = parseInt(tail[tail.length - 1], 10);
        if (Number.isFinite(lastInt) && lastInt > 0 && tail.length > 1) {
          cap = Math.min(50, lastInt);
          tail.pop();
        }
        const name = tail.join(' ').toLowerCase();
        if (!name) {
          ctx.state.sendSystemMessage('Usage: [shoplog player <name> [N]');
          return;
        }
        filtered = log.filter((t) => (t.customerName ?? '').toLowerCase().includes(name));
        if (cap > 0) filtered = filtered.slice(-cap);
        header = `${vendor.name} — ${filtered.length} transaction(s) matching "${name}"${cap ? ` (last ${cap})` : ''}:`;
        if (!filtered.length) {
          ctx.state.sendSystemMessage(header + '\n  (none)');
          return;
        }
      } else {
        const requested = Math.max(1, Math.min(50, parseInt(ctx.args[0], 10) || 10));
        filtered = log.slice(-requested);
        header = `${vendor.name} — last ${filtered.length} of ${log.length} transactions:`;
      }
      const lines = [header];
      for (let i = filtered.length - 1; i >= 0; i--) {
        const t = filtered[i];
        const cust = t.customerName ?? `0x${(t.customerSerial >>> 0).toString(16)}`;
        lines.push(`  ${ago(t.ts).padEnd(8)} ${t.type.toUpperCase().padEnd(4)} ${cust}  ${t.itemCount} item(s)  ${t.gold} gp`);
      }
      // Aggregate: total gold + per-type counts when filter is active.
      if (sub === 'player') {
        const buys = filtered.filter((t) => t.type === 'buy');
        const sells = filtered.filter((t) => t.type === 'sell');
        const buyGold = buys.reduce((s, t) => s + (t.gold ?? 0), 0);
        const sellGold = sells.reduce((s, t) => s + (t.gold ?? 0), 0);
        lines.push(`  ── ${buys.length} buys (${buyGold} gp paid)  /  ${sells.length} sells (${sellGold} gp earned)`);
      }
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  return () => commands.unregister('shoplog');
}
