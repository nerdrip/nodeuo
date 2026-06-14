// Tiny cliloc helper.
//
// The real `cliloc.enu` file ships thousands of localized strings keyed by
// 32-bit number; extracting it is a later task (Phase 1, step 6 — deferred).
// For now we keep an in-memory map that scripts can seed with commonly used
// numbers plus a substitution helper that mirrors ServUO's `args` semantics
// (tab-separated values filling `~1_NAME~`/`~2_VAL~`/... placeholders).
//
// Scripts send the 0xC1 packet via `protocol.messageLocalized(...)`. This
// helper exists so server-side code that only knows the number can fall back
// to an English string if the client's cliloc is missing (and for tests).

/** @type {Map<number, string>} */
const table = new Map();

/**
 * @param {number} num
 * @param {string} text   English template, may contain ~1_NAME~ style markers.
 */
export function register(num, text) {
  table.set(num >>> 0, text);
}

/**
 * Bulk-register from an object literal (`{ 1042971: 'Target cannot be...' }`).
 * @param {Record<string, string>} entries
 */
export function registerAll(entries) {
  for (const [k, v] of Object.entries(entries)) {
    const n = Number(k);
    if (Number.isFinite(n)) table.set(n >>> 0, v);
  }
}

export function get(num) {
  return table.get(num >>> 0);
}

/**
 * Format a cliloc template with tab-separated args.
 * Replaces `~1_X~`, `~2_Y~`, ... positionally. Missing args become ''.
 *
 * @param {number} num
 * @param {string} [args]  tab-joined substitution list
 */
export function format(num, args = '') {
  const tmpl = table.get(num >>> 0);
  if (!tmpl) return `[cliloc ${num}]${args ? ' ' + args.split('\t').join(' ') : ''}`;
  const parts = args ? args.split('\t') : [];
  return tmpl.replace(/~(\d+)_[A-Z0-9_]+~/g, (_m, idx) => parts[Number(idx) - 1] ?? '');
}

/** Clear all entries (tests only). */
export function _resetForTest() {
  table.clear();
}

/** Size of the registry. */
export function size() {
  return table.size;
}

// Seed a few commonly-needed entries so the server can send sensible
// messages without shipping the full cliloc table.
register(500000, '~1_NAME~ says: ~2_TEXT~');          // generic NPC speech
register(502034, 'The key will not fit.');
register(1042971, '~1_NOTHING~');                      // single-arg passthrough
register(1043124, 'You hear: ~1_TEXT~');
register(3000112, 'You see: ~1_NAME~');
