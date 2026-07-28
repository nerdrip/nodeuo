// ServUO item-definition extractor.
//
// Walks `templates/ServUO/Scripts/Items/` recursively. For every
// `public class X : Y` we grab:
//   - the first `: base(0xZZZZ` constructor (graphic literal)
//   - or `ItemID = 0xZZZZ` set in a constructor body
//   - or `Hue = N` in the same constructor (optional)
//
// Output: `apps/scripts/src/data/config/item-types.json`
//   { "BlackPearl": {
//       "definitionId":"BlackPearl", "artId":3990,
//       "name":"Black Pearl", "hue":0, "script":null,
//       "base":"BaseReagent", "source":".../BlackPearl.cs"
//   }, … }
//
// The runtime uses this to bridge the ServUO-side type strings that
// vendor/recipes/quests/artifacts expose (e.g. "BlackPearl") to
// concrete itemId graphics.
//
// Scope-of-fit: classes that genuinely don't carry an itemId in their
// own constructor (they rely on a parent's default) are skipped here;
// scripts can still resolve them through the registered template
// catalog by name.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ITEMS_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts', 'Items');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'config', 'item-types.json');

const RX_CLASS = /public\s+class\s+([A-Za-z0-9_]+)\s*(?::\s*([A-Za-z0-9_<>,\s]+?))?\s*[({,]/;
const RX_BASE_CALL = /:\s*base\s*\(\s*(0x[0-9A-Fa-f]+|\d+)/;          // : base(0xZZZZ, …)
const RX_ITEMID_SET = /(?:^|;)\s*ItemID\s*=\s*(0x[0-9A-Fa-f]+|\d+)/;
const RX_HUE_SET = /(?:^|;)\s*Hue\s*=\s*(0x[0-9A-Fa-f]+|\d+)/;
const RX_NAME_SET = /(?:this\.)?Name\s*=\s*"([^"]+)"/;

function num(s) { return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10); }

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith('.cs')) yield full;
  }
}

/**
 * Slice a single class definition out of a source file. Iterates
 * `public class` boundaries (handles file with multiple classes).
 */
function* eachClass(src) {
  // Anchor on `public class Name` — split keeps the class keyword on
  // each segment.
  const segments = src.split(/(?=public\s+class\s)/);
  for (const seg of segments) {
    const m = seg.match(RX_CLASS);
    if (!m) continue;
    yield { className: m[1], baseName: (m[2] ?? '').split(',')[0].trim() || null, body: seg };
  }
}

function extractClass(seg) {
  // Look for the FIRST :base(...) or ItemID= in the class body. We slice
  // class body up to the first balanced `}` so we don't accidentally pick
  // up a sibling class's :base(...) elsewhere in the file.
  const open = seg.indexOf('{');
  if (open < 0) return null;
  let depth = 1;
  let end = seg.length;
  for (let i = open + 1; i < seg.length; i++) {
    if (seg[i] === '{') depth++;
    else if (seg[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = seg.slice(open + 1, end);

  let itemId = null, hue = null;
  const baseM = body.match(RX_BASE_CALL);
  if (baseM) itemId = num(baseM[1]);
  if (itemId === null) {
    const idM = body.match(RX_ITEMID_SET);
    if (idM) itemId = num(idM[1]);
  }
  const hueM = body.match(RX_HUE_SET);
  if (hueM) hue = num(hueM[1]);
  const nameM = body.match(RX_NAME_SET);

  if (itemId === null) return null;
  if (!Number.isFinite(itemId) || itemId < 0 || itemId > 0xFFFF) return null;
  return { artId: itemId, hue: hue ?? 0, name: nameM?.[1] ?? null };
}

function humanName(className) {
  return String(className)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

function run() {
  if (!existsSync(ITEMS_DIR)) {
    console.error(`[servuo-item-types] missing ${ITEMS_DIR}`);
    process.exit(1);
  }
  /** @type {Record<string, object>} */
  const out = {};
  let scanned = 0;
  let withId = 0;
  let collisions = 0;
  for (const f of walk(ITEMS_DIR)) {
    scanned++;
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const { className, baseName, body } of eachClass(src)) {
      const r = extractClass(body);
      if (!r) continue;
      withId++;
      if (out[className]) {
        // Multiple defs of the same class name across files (extension
        // partials). Keep the FIRST. Note collisions for diagnostic.
        collisions++;
        continue;
      }
      out[className] = {
        definitionId: className,
        artId: r.artId,
        name: r.name ?? humanName(className),
        hue: r.hue,
        script: null,
        base: baseName ?? undefined,
        source: relative(ROOT, f).replaceAll('\\', '/'),
      };
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-item-types] scanned ${scanned} files, ${withId} classes with itemId, ${collisions} collisions`);
  console.log(`[servuo-item-types] wrote ${Object.keys(out).length} item definitions to ${OUT}`);
}

run();
