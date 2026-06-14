import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SERVUO_ADDONS = path.join(ROOT, 'templates', 'ServUO', 'Scripts', 'Items', 'Addons');
const OUT = path.join(ROOT, 'apps', 'scripts', 'src', 'data', 'world', 'addons.generated.json');
const AUTHORED = path.join(ROOT, 'apps', 'scripts', 'src', 'data', 'world', 'addons.json');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.cs')) out.push(full);
  }
  return out;
}

function splitWords(input) {
  return String(input ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\\/]+/g, ' ')
    .trim();
}

function kebab(input) {
  return splitWords(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function addonKey(className) {
  return kebab(String(className)
    .replace(/Addon$/i, '')
    .replace(/Deed$/i, '')
    .replace(/Component$/i, ''));
}

function classBlocks(text) {
  const out = [];
  const re = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < text.length && depth > 0) {
      const ch = text[i++];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    out.push({ name: match[1], body: text.slice(re.lastIndex, i - 1) });
    re.lastIndex = i;
  }
  return out;
}

function parseNumber(raw) {
  const value = String(raw ?? '').trim();
  if (/^0x[0-9a-f]+$/i.test(value)) return parseInt(value, 16);
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function splitArgs(raw) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(raw ?? '')) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function initialVars(body) {
  const vars = new Map();
  const re = /\b(?:int|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9a-f]+|\d+)\s*;/gi;
  let match;
  while ((match = re.exec(body))) vars.set(match[1], parseNumber(match[2]));
  return vars;
}

function resolveId(expr, vars) {
  const raw = String(expr ?? '').trim();
  const num = parseNumber(raw);
  if (num != null) return num;
  let match = /^([A-Za-z_][A-Za-z0-9_]*)\+\+$/.exec(raw);
  if (match && vars.has(match[1])) {
    const value = vars.get(match[1]);
    vars.set(match[1], value + 1);
    return value;
  }
  match = /^\+\+([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  if (match && vars.has(match[1])) {
    const value = vars.get(match[1]) + 1;
    vars.set(match[1], value);
    return value;
  }
  match = /^([A-Za-z_][A-Za-z0-9_]*)\s*\+\s*(\d+)$/.exec(raw);
  if (match && vars.has(match[1])) return vars.get(match[1]) + (parseInt(match[2], 10) | 0);
  return null;
}

function componentFactories(classes) {
  const factories = new Map();
  for (const cls of classes) {
    let match = /:\s*base\s*\(\s*(0x[0-9a-f]+|\d+)\s*\)/i.exec(cls.body);
    if (match) {
      const id = parseNumber(match[1]);
      if (id != null) factories.set(cls.name, () => id);
      continue;
    }
    match = /:\s*base\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\?\s*(0x[0-9a-f]+|\d+)\s*:\s*(0x[0-9a-f]+|\d+)\s*\)/i.exec(cls.body);
    if (match) {
      const yes = parseNumber(match[2]);
      const no = parseNumber(match[3]);
      if (yes != null && no != null) {
        factories.set(cls.name, (args) => /^true$/i.test(String(args?.[0] ?? '').trim()) ? yes : no);
      }
    }
  }
  return factories;
}

function extractComponents(body, factories = new Map()) {
  const vars = initialVars(body);
  const out = [];
  const re = /Add(Craft)?Component\s*\(\s*new\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*,\s*([+-]?\d+)\s*\)/g;
  let match;
  while ((match = re.exec(body))) {
    const args = splitArgs(match[3]);
    const idArg = match[1] && /AddonToolComponent/i.test(match[2]) ? args[1] : args[0];
    const id = resolveId(idArg, vars) ?? factories.get(match[2])?.(args);
    if (!id) continue;
    const component = {
      dx: parseInt(match[4], 10) | 0,
      dy: parseInt(match[5], 10) | 0,
      id,
    };
    const dz = parseInt(match[6], 10) | 0;
    if (dz) component.dz = dz;
    out.push(component);
  }
  return out;
}

function extractDirectionalComponents(body, factories = new Map()) {
  const out = [];
  const caseRe = /\bcase\s+DirectionType\.([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)(?=\bcase\s+DirectionType\.|\bdefault\s*:|\bbreak\s*;\s*(?:\}|case)|$)/g;
  let match;
  while ((match = caseRe.exec(body))) {
    const dir = match[1].toLowerCase();
    const caseBody = match[2];
    const components = extractComponents(caseBody, factories);
    if (components.length > 0) out.push({ dir, components });
  }
  return out;
}

function main() {
  const authored = fs.existsSync(AUTHORED) ? JSON.parse(fs.readFileSync(AUTHORED, 'utf8')) : {};
  const generated = {};
  for (const file of walk(SERVUO_ADDONS).sort()) {
    const text = fs.readFileSync(file, 'utf8');
    const classes = classBlocks(text);
    const factories = componentFactories(classes);
    const classNames = classes.map((cls) => cls.name);
    for (const cls of classes) {
      if (/Deed$|Gump$|Entry$|Timer$|Target$|Prompt$|Component$/i.test(cls.name)) continue;
      const key = addonKey(cls.name);
      if (!key) continue;
      const directional = extractDirectionalComponents(cls.body, factories);
      if (directional.length > 0) {
        for (const variant of directional) {
          const variantKey = `${key}-${variant.dir}`;
          if (authored[variantKey]) continue;
          generated[variantKey] = {
            servuoClasses: classNames,
            components: variant.components,
          };
        }
        continue;
      }
      const components = extractComponents(cls.body, factories);
      if (components.length === 0 || authored[key]) continue;
      generated[key] = {
        servuoClasses: classNames,
        components,
      };
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`[servuo-addon-extract] wrote ${path.relative(ROOT, OUT)} (${Object.keys(generated).length} addons)`);
}

main();
