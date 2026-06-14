// Journal custom-filter helpers. Kept UI-free so smokes can validate the
// expression compiler without constructing Pixi gumps.

const TYPE = Object.freeze({
  Normal: 0,
  System: 1,
  Object: 2,
  Guild: 3,
  Alliance: 4,
  Party: 5,
  ClientCommand: 6,
  Damage: 7,
  Label: 8,
});

const SPELL_RX = /(in mani|in vas|kal|por|ort|grav|vas flam|corp por|invocat)/i;
const COMBAT_RX = /(damage|hit|miss|heal|killed|dies|attacks)/i;

const TYPE_ALIASES = {
  all: null,
  normal: TYPE.Normal,
  chat: [TYPE.Normal, TYPE.Party, TYPE.Guild, TYPE.Alliance],
  system: TYPE.System,
  object: TYPE.Object,
  guild: TYPE.Guild,
  alliance: TYPE.Alliance,
  party: TYPE.Party,
  command: TYPE.ClientCommand,
  clientcommand: TYPE.ClientCommand,
  damage: TYPE.Damage,
  combat: 'combat',
  label: TYPE.Label,
  spell: 'spell',
  spells: 'spell',
};

export function normalizeJournalFilters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const expr = String(f.expr ?? '').trim();
    if (!expr) continue;
    const id = String(f.id || `custom:${out.length + 1}`).replace(/[^\w:-]/g, '').slice(0, 40);
    const label = String(f.label || 'Filter').trim().slice(0, 16) || 'Filter';
    out.push({ id: id.startsWith('custom:') ? id : `custom:${id}`, label, expr });
  }
  return out.slice(0, 8);
}

export function makeJournalFilterId(label, existing = []) {
  const base = String(label || 'filter')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'filter';
  const used = new Set(existing.map((f) => f.id));
  let id = `custom:${base}`;
  let n = 2;
  while (used.has(id)) id = `custom:${base}-${n++}`;
  return id;
}

export function compileJournalFilter(expr) {
  const raw = String(expr ?? '').trim();
  if (!raw) return () => true;

  const normalized = raw
    .replace(/\s+\bOR\b\s+/gi, ' || ')
    .replace(/\s+\bAND\b\s+/gi, ' && ');

  const orGroups = splitExpr(normalized, '||')
    .map((g) => splitExpr(g, '&&').map(compileAtom).filter(Boolean))
    .filter((g) => g.length);

  if (!orGroups.length) return () => true;
  return (line) => orGroups.some((group) => group.every((fn) => fn(line)));
}

function compileAtom(atomRaw) {
  let atom = String(atomRaw ?? '').trim();
  if (!atom) return null;
  let negate = false;
  while (atom.startsWith('!')) {
    negate = !negate;
    atom = atom.slice(1).trim();
  }

  let key = 'contains';
  let value = atom;
  const call = atom.match(/^([a-z][\w-]*)\((.*)\)$/i);
  const pair = atom.match(/^([a-z][\w-]*)\s*(?::|=|==)\s*(.*)$/i);
  if (call) {
    key = call[1].toLowerCase();
    value = call[2];
  } else if (pair) {
    key = pair[1].toLowerCase();
    value = pair[2];
  }

  value = unquote(value.trim());
  const pred = predicateFor(key, value);
  return negate ? (line) => !pred(line) : pred;
}

function predicateFor(key, value) {
  const needle = String(value ?? '').toLowerCase();
  if (!needle && key !== 'type' && key !== 'channel') return () => true;

  switch (key) {
    case 'contains':
    case 'message':
    case 'text':
      return (line) => lower(line?.text).includes(needle);
    case 'name':
    case 'from':
    case 'source':
      return (line) => lower(line?.name).includes(needle);
    case 'exact':
      return (line) => lower(line?.text) === needle;
    case 'startswith':
    case 'starts':
      return (line) => lower(line?.text).startsWith(needle);
    case 'endswith':
    case 'ends':
      return (line) => lower(line?.text).endsWith(needle);
    case 'type':
    case 'channel':
      return typePredicate(needle);
    case 'hue':
    case 'color': {
      const wanted = parseNumeric(value);
      return (line) => wanted == null ? false : (((line?.hue ?? 0) & 0xffff) === wanted);
    }
    case 'regex':
    case 're': {
      let rx = null;
      try { rx = new RegExp(value, 'i'); } catch { return () => false; }
      return (line) => rx.test(line?.text ?? '') || rx.test(`${line?.name ?? ''} ${line?.text ?? ''}`);
    }
    default:
      return (line) => `${lower(line?.name)} ${lower(line?.text)}`.includes(needle);
  }
}

function typePredicate(name) {
  const alias = TYPE_ALIASES[name.replace(/[^a-z0-9]/g, '')];
  if (alias == null) return () => name === 'all';
  if (alias === 'spell') return (line) => SPELL_RX.test(line?.text ?? '');
  if (alias === 'combat') return (line) => (line?.textType === TYPE.Damage) || COMBAT_RX.test(line?.text ?? '');
  if (Array.isArray(alias)) return (line) => alias.includes(line?.textType);
  return (line) => line?.textType === alias;
}

function lower(v) { return String(v ?? '').toLowerCase(); }

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseNumeric(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = s.startsWith('0x') || s.startsWith('0X') ? Number.parseInt(s, 16) : Number.parseInt(s, 10);
  return Number.isFinite(n) ? (n & 0xffff) : null;
}

function splitExpr(text, sep) {
  const out = [];
  let quote = '';
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && text.slice(i, i + sep.length) === sep) {
      out.push(text.slice(start, i).trim());
      i += sep.length - 1;
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}
