// Security and lifecycle policy for server-driven UO gumps.
//
// Classic 0xB0/0xB1 has no nonce. The compatible replay boundary is a
// connection-local, single-use (serial, gumpId) tuple plus the exact response
// controls declared by the layout.

export const GUMP_LIMITS = Object.freeze({
  layoutBytes: 256 * 1024,
  controls: 4096,
  texts: 2048,
  textChars: 16 * 1024,
  totalTextChars: 256 * 1024,
  responseSwitches: 1024,
  responseTexts: 512,
  responseTextChars: 4096,
  activePerConnection: 64,
  lifetimeMs: 5 * 60 * 1000,
  // Large, server-driven dialogs are substantially more expensive to parse,
  // pack and retain than ordinary paperdolls or context menus. Keep their
  // rate connection-local so a script bug cannot monopolise the game loop.
  heavyBytes: 32 * 1024,
  heavyOpensPerWindow: 8,
  heavyOpenWindowMs: 5 * 1000,
});

const CONTROL_COMMANDS = new Set([
  'button', 'buttontileart', 'checkbox', 'radio', 'textentry',
  'textentrylimited', 'htmlgump', 'xmfhtmlgump', 'xmfhtmlgumpcolor',
  'xmfhtmltok', 'text', 'croppedtext', 'resizepic', 'gumppic',
  'gumppictiled', 'tilepic', 'tilepichue', 'tilepicfit', 'checkertrans',
  'itemproperty', 'tooltip',
]);

function integerToken(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Validate a layout and collect the response IDs it declares. */
export function inspectGumpLayout(layout, limits = GUMP_LIMITS) {
  if (typeof layout !== 'string') throw new TypeError('gump layout must be a string');
  const bytes = new TextEncoder().encode(layout).length;
  if (bytes > limits.layoutBytes) throw new RangeError(`gump layout exceeds ${limits.layoutBytes} bytes`);
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(layout)) throw new TypeError('gump layout contains non-ASCII control data');

  const commands = [];
  const buttons = new Set([0]);
  const switches = new Set();
  const textEntries = new Set();
  let controls = 0;
  let cursor = 0;
  const re = /\{\s*([^{}]*?)\s*\}/g;
  let match;
  while ((match = re.exec(layout)) !== null) {
    if (layout.slice(cursor, match.index).trim() !== '') throw new TypeError('gump layout has data outside a command');
    cursor = re.lastIndex;
    const tokens = match[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) throw new TypeError('gump layout contains an empty command');
    const name = tokens[0].toLowerCase();
    commands.push(name);
    if (CONTROL_COMMANDS.has(name) && ++controls > limits.controls) {
      throw new RangeError(`gump layout exceeds ${limits.controls} controls`);
    }

    if (name === 'button' && tokens.length >= 8) {
      const id = integerToken(tokens[7]);
      if (id != null) buttons.add(id >>> 0);
    } else if (name === 'buttontileart' && tokens.length >= 8) {
      const id = integerToken(tokens[7]);
      if (id != null) buttons.add(id >>> 0);
    } else if ((name === 'checkbox' || name === 'radio') && tokens.length >= 7) {
      const id = integerToken(tokens[6]);
      if (id != null) switches.add(id >>> 0);
    } else if ((name === 'textentry' || name === 'textentrylimited') && tokens.length >= 7) {
      const id = integerToken(tokens[6]);
      if (id != null) textEntries.add(id & 0xffff);
    }
  }
  if (layout.slice(cursor).trim() !== '') throw new TypeError('gump layout has unbalanced braces');
  return { bytes, controls, commands, buttons, switches, textEntries };
}

export function validateGumpTexts(texts, limits = GUMP_LIMITS) {
  if (!Array.isArray(texts)) throw new TypeError('gump texts must be an array');
  if (texts.length > limits.texts) throw new RangeError(`gump has more than ${limits.texts} texts`);
  let chars = 0;
  return texts.map((value) => {
    const text = String(value ?? '');
    if (text.length > limits.textChars) throw new RangeError(`gump text exceeds ${limits.textChars} characters`);
    chars += text.length;
    if (chars > limits.totalTextChars) throw new RangeError(`gump texts exceed ${limits.totalTextChars} characters`);
    return text;
  });
}

export function validateGumpDefinition(gump, limits = GUMP_LIMITS) {
  if (!gump || typeof gump !== 'object') throw new TypeError('gump definition must be an object');
  const layout = String(gump.layout ?? '');
  const metadata = inspectGumpLayout(layout, limits);
  const texts = validateGumpTexts(gump.texts ?? [], limits);
  return { ...gump, layout, texts, metadata };
}

/**
 * Account for an expensive outgoing gump without changing the UO protocol.
 * Small dialogs bypass the counter. The fixed window lives on NetState and is
 * intentionally reset when a connection is replaced.
 */
export function allowHeavyGump(state, estimatedBytes, { now = Date.now(), limits = GUMP_LIMITS } = {}) {
  if ((Number(estimatedBytes) || 0) < limits.heavyBytes) return { ok: true, remaining: limits.heavyOpensPerWindow };
  const previous = state?._heavyGumpRate;
  const windowExpired = !previous || now - previous.startedAt >= limits.heavyOpenWindowMs;
  const rate = windowExpired ? { startedAt: now, count: 0 } : previous;
  rate.count++;
  if (state) state._heavyGumpRate = rate;
  const ok = rate.count <= limits.heavyOpensPerWindow;
  return {
    ok,
    remaining: Math.max(0, limits.heavyOpensPerWindow - rate.count),
    retryAfterMs: ok ? 0 : Math.max(1, rate.startedAt + limits.heavyOpenWindowMs - now),
  };
}

export function validateGumpResponse(entry, response, { now = Date.now(), limits = GUMP_LIMITS } = {}) {
  if (!entry || entry.consumed) return { ok: false, reason: 'replay' };
  if (now > entry.expiresAt) return { ok: false, reason: 'expired' };
  if ((response.serial >>> 0) !== (entry.serial >>> 0)) return { ok: false, reason: 'serial' };
  if ((response.gumpId >>> 0) !== (entry.gumpId >>> 0)) return { ok: false, reason: 'type' };
  if (!entry.buttons.has(response.buttonId >>> 0)) return { ok: false, reason: 'button' };
  if (!Array.isArray(response.switches) || response.switches.length > limits.responseSwitches) return { ok: false, reason: 'switch-count' };
  if (!Array.isArray(response.textEntries) || response.textEntries.length > limits.responseTexts) return { ok: false, reason: 'text-count' };

  const seenSwitches = new Set();
  for (const raw of response.switches) {
    const id = raw >>> 0;
    if (seenSwitches.has(id) || !entry.switches.has(id)) return { ok: false, reason: 'switch' };
    seenSwitches.add(id);
  }
  const seenTexts = new Set();
  for (const field of response.textEntries) {
    const id = field?.entryId & 0xffff;
    if (seenTexts.has(id) || !entry.textEntries.has(id)) return { ok: false, reason: 'text-id' };
    if (typeof field?.text !== 'string' || field.text.length > limits.responseTextChars) return { ok: false, reason: 'text-length' };
    seenTexts.add(id);
  }
  return { ok: true };
}

export function makeActiveGumpEntry({ serial, gumpId, callback, metadata, sessionToken = null, now = Date.now(), lifetimeMs = GUMP_LIMITS.lifetimeMs }) {
  return {
    serial: serial >>> 0,
    gumpId: gumpId >>> 0,
    callback,
    sessionToken,
    buttons: new Set(metadata.buttons),
    switches: new Set(metadata.switches),
    textEntries: new Set(metadata.textEntries),
    openedAt: now,
    expiresAt: now + Math.max(1000, Math.min(GUMP_LIMITS.lifetimeMs, lifetimeMs | 0)),
    consumed: false,
  };
}

export function pruneActiveGumps(state, now = Date.now()) {
  let removed = 0;
  for (const [id, entry] of state.activeGumps ?? []) {
    if (typeof entry === 'function') continue;
    if (!entry || entry.consumed || now > entry.expiresAt) {
      state.activeGumps.delete(id);
      removed++;
    }
  }
  return removed;
}
