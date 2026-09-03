// Complete ServUO mobile catalogue extractor.
//
// Unlike the historical monster extractor this walks the whole Scripts tree,
// understands inheritance and records NPCs, summons, mounts and quest mobiles
// as stable NodeUO definitions.  Behaviour remains data-driven: the runtime
// registers the records in the native monster/NPC registries and the normal AI,
// quest, vendor and pet systems own their execution.

import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SCRIPTS = join(ROOT, 'templates', 'ServUO', 'Scripts');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'config', 'mobile-types.json');

const MOBILE_ROOTS = new Set([
  'Mobile', 'BaseCreature', 'BaseMount', 'BaseWarHorse', 'BaseVendor',
  'MondainQuester', 'BaseEscort', 'TownEscortable', 'NewHavenEscortable',
  'PersonalAttendant', 'BaseTalismanSummon',
]);

function* walk(dir) {
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) yield* walk(full);
    else if (stat.isFile() && full.endsWith('.cs')) yield full;
  }
}

function stripComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/.*$/gm, (value) => ' '.repeat(value.length));
}

function* classesIn(source, sourcePath) {
  const text = stripComments(source);
  const rx = /\b((?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z_][A-Za-z0-9_.<>]*))?/g;
  let match;
  while ((match = rx.exec(text))) {
    const open = text.indexOf('{', rx.lastIndex);
    if (open < 0) continue;
    let depth = 1;
    let end = text.length;
    for (let i = open + 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    yield {
      className: match[2],
      baseName: (match[3] ?? '').split('.').at(-1)?.replace(/<.*$/, '') || null,
      abstract: /\babstract\b/.test(match[1] ?? ''),
      body: text.slice(match.index, end),
      source: sourcePath,
    };
  }
}

function number(value) {
  return /^0x/i.test(value) ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
}

function firstNumber(text, regex) {
  const match = text.match(regex);
  return match ? number(match[1]) : null;
}

function range(text, method, fallback) {
  const match = text.match(new RegExp(`\\b${method}\\s*\\(\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?:,\\s*(-?\\d+(?:\\.\\d+)?))?`));
  if (!match) return fallback;
  const low = Number(match[1]);
  const high = Number(match[2] ?? match[1]);
  return [low, high];
}

function parseDirect(descriptor) {
  const text = descriptor.body;
  const name = text.match(/(?:this\.)?Name\s*=\s*"([^"]+)"/)?.[1] ?? null;
  const title = text.match(/(?:this\.)?Title\s*=\s*"([^"]+)"/)?.[1] ?? null;
  let body = firstNumber(text, /(?:this\.)?Body\s*=\s*(0x[0-9A-Fa-f]+|\d+)/);
  // The first variant is a valid deterministic catalogue graphic; the live
  // creature may still randomise among the remaining variants when an authored
  // definition overrides this generated fallback.
  body ??= firstNumber(text, /(?:this\.)?Body\s*=\s*Utility\.RandomList\s*\(\s*(0x[0-9A-Fa-f]+|\d+)/);
  body ??= firstNumber(text, /(?:this\.)?Body\s*=\s*Utility\.Random(?:MinMax)?\s*\(\s*(0x[0-9A-Fa-f]+|\d+)/);
  body ??= firstNumber(text, /\bBodyValue\s*(?:=>|\{[\s\S]*?return)\s*(0x[0-9A-Fa-f]+|\d+)/);
  if (body == null && /(?:this\.)?Body\s*=\s*(?:Female|IsFemale|female)\s*\?/.test(text)) {
    const variants = text.match(/(?:this\.)?Body\s*=\s*(?:Female|IsFemale|female)\s*\?\s*(0x[0-9A-Fa-f]+|\d+)\s*:\s*(0x[0-9A-Fa-f]+|\d+)/);
    if (variants) body = number(variants[2]);
  }
  if (body == null && /(?:BaseMount|BaseWarHorse)/.test(descriptor.baseName ?? '')) {
    const call = text.match(/:\s*base\s*\(([^\r\n{}]*)\)/)?.[1] ?? '';
    const literal = call.match(/(?:^|,)\s*(?:"[^"]*"\s*,\s*)?(0x[0-9A-Fa-f]+|\d+)/)?.[1];
    if (literal) body = number(literal);
  }
  return {
    name, title, body,
    hue: firstNumber(text, /(?:this\.)?Hue\s*=\s*(0x[0-9A-Fa-f]+|\d+)/),
    hp: range(text, 'SetHits', null),
    str: range(text, 'SetStr', null),
    dex: range(text, 'SetDex', null),
    int: range(text, 'SetInt', null),
    damage: range(text, 'SetDamage', null),
    fame: firstNumber(text, /(?:this\.)?Fame\s*=\s*(\d+)/),
    karma: (() => {
      const value = text.match(/(?:this\.)?Karma\s*=\s*(-?\d+)/)?.[1];
      return value == null ? null : Number.parseInt(value, 10);
    })(),
    sound: firstNumber(text, /(?:this\.)?BaseSoundID\s*=\s*(0x[0-9A-Fa-f]+|\d+)/),
    controlSlots: firstNumber(text, /(?:this\.)?ControlSlots\s*=\s*(\d+)/),
    tameSkill: (() => {
      const value = text.match(/(?:this\.)?MinTameSkill\s*=\s*([\d.]+)/)?.[1];
      return value == null ? null : Number(value);
    })(),
    tamable: /(?:this\.)?Tamable\s*=\s*true/.test(text),
    ai: text.match(/AIType\.AI_([A-Za-z]+)/)?.[1]?.toLowerCase() ?? null,
  };
}

function humanName(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function kebab(value) {
  return humanName(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function roleOf(descriptor) {
  const source = descriptor.source.replaceAll('\\', '/');
  if (descriptor.className === 'PlayerMobile') return 'player';
  if (/\/(?:NPCs|Vendors?)\//i.test(source)
      || /(?:Vendor|Quester|Escort|Attendant)/.test(descriptor.baseName ?? '')) return 'npc';
  return 'monster';
}

function run() {
  if (!existsSync(SCRIPTS)) throw new Error(`missing ${SCRIPTS}`);
  const descriptors = new Map();
  let files = 0;
  for (const file of walk(SCRIPTS)) {
    files++;
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    const sourcePath = relative(ROOT, file).replaceAll('\\', '/');
    for (const descriptor of classesIn(source, sourcePath)) {
      if (!descriptors.has(descriptor.className)) {
        descriptors.set(descriptor.className, { ...descriptor, ...parseDirect(descriptor) });
      }
    }
  }

  const mobileMemo = new Map();
  function isMobile(name, trail = new Set()) {
    if (MOBILE_ROOTS.has(name)) return true;
    if (mobileMemo.has(name)) return mobileMemo.get(name);
    if (trail.has(name)) return false;
    const descriptor = descriptors.get(name);
    if (!descriptor?.baseName) return false;
    trail.add(name);
    const result = MOBILE_ROOTS.has(descriptor.baseName) || isMobile(descriptor.baseName, trail);
    trail.delete(name);
    mobileMemo.set(name, result);
    return result;
  }

  function inherited(name, key, trail = new Set()) {
    if (trail.has(name)) return null;
    const descriptor = descriptors.get(name);
    if (!descriptor) return null;
    if (descriptor[key] != null) return descriptor[key];
    if (!descriptor.baseName) return null;
    trail.add(name);
    const result = inherited(descriptor.baseName, key, trail);
    trail.delete(name);
    return result;
  }

  const records = [];
  for (const descriptor of descriptors.values()) {
    if (descriptor.abstract || !isMobile(descriptor.className)) continue;
    const role = roleOf(descriptor);
    const hp = inherited(descriptor.className, 'hp') ?? [50, 50];
    const str = inherited(descriptor.className, 'str') ?? [50, 50];
    const dex = inherited(descriptor.className, 'dex') ?? [50, 50];
    const intelligence = inherited(descriptor.className, 'int') ?? [30, 30];
    const damage = inherited(descriptor.className, 'damage') ?? [5, 10];
    const karma = inherited(descriptor.className, 'karma') ?? 0;
    const body = inherited(descriptor.className, 'body') ?? (role === 'npc' || role === 'player' ? 0x190 : 0x0001);
    records.push({
      kind: kebab(descriptor.className),
      name: inherited(descriptor.className, 'name') ?? humanName(descriptor.className),
      ...(inherited(descriptor.className, 'title') ? { title: inherited(descriptor.className, 'title') } : {}),
      body,
      hue: inherited(descriptor.className, 'hue') ?? 0,
      hp: hp[1], hpMax: hp[1], str: str[1], dex: dex[1], int: intelligence[1],
      dmgMin: damage[0], dmgMax: damage[1],
      notoriety: karma < 0 ? 5 : 1,
      aggroRange: role === 'monster' ? 10 : 0,
      attackInterval: 1800,
      ai: inherited(descriptor.className, 'ai') ?? (role === 'monster' ? 'melee' : 'wander'),
      role,
      servuoClass: descriptor.className,
      servuoClasses: [descriptor.className, ...(descriptor.baseName ? [descriptor.baseName] : [])],
      servuoBaseClass: descriptor.baseName,
      servuoPath: descriptor.source,
      ...(inherited(descriptor.className, 'sound') != null ? { sound: inherited(descriptor.className, 'sound') } : {}),
      ...(inherited(descriptor.className, 'fame') != null ? { fame: inherited(descriptor.className, 'fame') } : {}),
      ...(inherited(descriptor.className, 'controlSlots') != null ? { controlSlots: inherited(descriptor.className, 'controlSlots') } : {}),
      ...(inherited(descriptor.className, 'tameSkill') != null ? { tameSkill: inherited(descriptor.className, 'tameSkill') } : {}),
      ...(inherited(descriptor.className, 'tamable') ? { tamable: true } : {}),
    });
  }
  records.sort((a, b) => a.servuoClass.localeCompare(b.servuoClass));
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`);
  console.log(`[servuo-mobile-types] scanned ${files} files, wrote ${records.length} definitions to ${OUT}`);
}

run();
