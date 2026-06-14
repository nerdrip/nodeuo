// Ad-hoc extractor for hardcoded `const X = [...]` arrays in spawns/*.js.
// We parse them as JSON literals (after a few JS-isms are normalised).
//
// Output: data/world/spawns/<filename>.json. The source script is then
// refactored to read from the JSON.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const OUT  = path.join(ROOT, 'apps/scripts/src/data/world/spawns');
fs.mkdirSync(OUT, { recursive: true });

// Slice `const NAME = ...;` body from source, normalise to JSON.
function extractConst(src, name) {
  const re = new RegExp(`^const ${name}\\s*=\\s*`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  // Find the matching brace/bracket using a simple stack scanner that
  // tracks string + comment boundaries.
  const start = m.index + m[0].length;
  const open  = src[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0, i = start;
  let inSL = false, inML = false, inStr = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inSL) {
      if (c === '\n') inSL = false;
    } else if (inML) {
      if (c === '*' && n === '/') { inML = false; i++; }
    } else if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '/' && n === '/') { inSL = true; i++; }
    else if (c === '/' && n === '*') { inML = true; i++; }
    else if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const body = src.slice(start, i + 1);
        return body;
      }
    }
    i++;
  }
  return null;
}

// Convert JS literal source → JSON. Cheap: single quotes → double,
// strip line + block comments, allow trailing commas. Not bullet-proof
// but enough for our hand-authored const blocks.
function jsToJson(jsBody) {
  // strip comments
  jsBody = jsBody.replace(/\/\/[^\n]*\n/g, '\n');
  jsBody = jsBody.replace(/\/\*[\s\S]*?\*\//g, '');
  // single-quoted strings → double-quoted (no escaped-quote handling
  // because our const blocks don't contain embedded quotes)
  jsBody = jsBody.replace(/'([^'\\]*)'/g, (_, body) => JSON.stringify(body));
  // trailing commas before ] or }
  jsBody = jsBody.replace(/,(\s*[\]}])/g, '$1');
  // unquoted keys → quoted
  jsBody = jsBody.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
  return jsBody;
}

const TARGETS = [
  { file: 'champions.js',            name: 'ALTARS',      out: 'champions.json' },
  { file: 'moongates.js',            name: 'TRAMMEL_GATES', out: 'moongates.json' },
  { file: 'dungeon-revamp-bosses.js',name: 'ENCOUNTERS',  out: 'dungeon-revamp-bosses.json' },
  { file: 'random-encounters.js',    name: 'ENCOUNTERS',  out: 'random-encounters.json' },
  { file: 'storyteller.js',          name: 'STORIES',     out: 'storyteller-tales.json' },
  { file: 'tokuno-sky-garden.js',    name: 'BONSAI_SPECIES', out: 'tokuno-bonsai.json' },
];

for (const t of TARGETS) {
  const file = path.join(ROOT, 'apps/scripts/src/spawns', t.file);
  const src  = fs.readFileSync(file, 'utf8');
  const body = extractConst(src, t.name);
  if (!body) { console.log(`  SKIP ${t.file}:${t.name} — not found`); continue; }
  try {
    const parsed = JSON.parse(jsToJson(body));
    fs.writeFileSync(path.join(OUT, t.out),
      JSON.stringify(parsed, null, 2));
    const n = Array.isArray(parsed) ? parsed.length : Object.keys(parsed).length;
    console.log(`  OK ${t.file}:${t.name} → ${t.out} (${n} entries)`);
  } catch (e) {
    console.log(`  ERR ${t.file}:${t.name} — ${e.message}`);
    fs.writeFileSync(path.join(OUT, t.out + '.raw.js'), body);
    console.log(`    raw body written to ${t.out}.raw.js for manual cleanup`);
  }
}
