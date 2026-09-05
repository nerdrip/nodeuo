// XmlSpawner extractor — walk every `.xml` under templates/ServUO/Spawns +
// templates/ServUO/RevampedSpawns and emit a flat JSON list of spawn
// rectangles the runtime can register via `[xmlload`.
//
// ServUO XmlSpawner stores `<Points><Points>` blocks; each block contains:
//   <Map>Felucca|Trammel|Ilshenar|Malas|Tokuno|TerMur</Map>
//   <X> <Y> <Width> <Height>            ← spawn rectangle
//   <CentreX/Y/Z>                        ← anchor
//   <MaxCount>                           ← total mobs at any time
//   <MinDelay> <MaxDelay> <DelayInSec>   ← respawn cadence
//   <ProximityRange>                     ← -1 = always; 0+ = require player
//   <Team>                               ← shared aggression team
//   <IsRunning>                          ← True/False flag
//   <Objects2>Rat:MX=1:SB=0:...:OBJ=Ratman:MX=1:...</Objects2>
//      Colon-delimited tuples; each :OBJ= starts a new spawn type.
//      MX = MaxCount per type (others mostly -1/0 defaults — ignored here).
//
// We emit:
//   {
//     name, map, x1, y1, x2, y2,
//     maxCount, minDelayMs, maxDelayMs, proximityRange, team, isRunning,
//     kinds: [{ name: "Rat", max: 1 }, { name: "Ratman", max: 1 }]
//   }
// `kinds[].name` keeps the raw ServUO PascalCase token; the [xmlload
// command normalises it to our kebab-case kind ids at register time.
//
// Output: apps/scripts/src/data/world/xmlspawners.json
//
//   node packages/extractor/xmlspawner.js [--src templates/ServUO]
//                                     [--out apps/scripts/src/data/world/xmlspawners.json]

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const MAP_NAME_TO_ID = {
  felucca: 0, trammel: 1, ilshenar: 2, malas: 3, tokuno: 4,
  termur: 5, 'ter mur': 5, stygianabyss: 5, 'stygian abyss': 5,
};

function tagText(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? m[1].trim() : null;
}
function tagInt(block, name, fallback = 0) {
  const t = tagText(block, name);
  if (t == null) return fallback;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : fallback;
}
function tagBool(block, name) {
  const t = tagText(block, name);
  return /^true$/i.test(t ?? '');
}

function parseObjects2(s) {
  if (!s) return [];
  // Format: TYPE:KEY=val:KEY=val:OBJ=TYPE:KEY=val:...
  // Split into segments at `:OBJ=` (the leading segment has no marker).
  const parts = s.split(/:OBJ=/);
  const out = [];
  for (const part of parts) {
    if (!part) continue;
    const fields = part.split(':');
    const type = fields[0]?.trim();
    if (!type) continue;
    const o = { name: type, max: 1 };
    for (let i = 1; i < fields.length; i++) {
      const eq = fields[i].indexOf('=');
      if (eq < 0) continue;
      const k = fields[i].slice(0, eq);
      const v = fields[i].slice(eq + 1);
      if (k === 'MX') o.max = parseInt(v, 10) || 1;
      // Other keys (SB, RT, KL, CA, DN, DX, SP, PR) carry per-spawn
      // schedule overrides we don't model; ignore.
    }
    out.push(o);
  }
  return out;
}

function parsePointsBlock(block, fileTag) {
  const map = MAP_NAME_TO_ID[(tagText(block, 'Map') || '').toLowerCase()];
  if (map == null) return null;
  const x = tagInt(block, 'X', NaN);
  const y = tagInt(block, 'Y', NaN);
  const w = tagInt(block, 'Width', 0);
  const h = tagInt(block, 'Height', 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const maxCount = tagInt(block, 'MaxCount', 1);
  const minDelay = tagInt(block, 'MinDelay', 5);
  const maxDelay = tagInt(block, 'MaxDelay', 10);
  const delayInSec = tagBool(block, 'DelayInSec');
  // ServUO default unit is MINUTES; multiply by 60_000 unless DelayInSec=true.
  const minDelayMs = (delayInSec ? minDelay : minDelay * 60) * 1000;
  const maxDelayMs = (delayInSec ? maxDelay : maxDelay * 60) * 1000;
  const proximityRange = tagInt(block, 'ProximityRange', -1);
  const team = tagInt(block, 'Team', 0);
  const isRunning = tagBool(block, 'IsRunning');
  const kinds = parseObjects2(tagText(block, 'Objects2') || tagText(block, 'Objects') || '');
  if (!kinds.length) return null;
  const name = (tagText(block, 'Name') || `${fileTag}#${x},${y}`).trim();
  return {
    name, map,
    x1: x, y1: y, x2: x + Math.max(0, w), y2: y + Math.max(0, h),
    maxCount, minDelayMs, maxDelayMs,
    proximityRange, team, isRunning,
    kinds,
  };
}

function* iterPointsBlocks(text) {
  const re = /<Points>([\s\S]*?)<\/Points>/g;
  let m;
  while ((m = re.exec(text))) yield m[1];
}

function walkXmlFiles(root) {
  const out = [];
  const walk = (dir, tag) => {
    let st;
    try { st = statSync(dir); } catch { return; }
    if (!st.isDirectory()) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p, name);
      else if (p.toLowerCase().endsWith('.xml')) {
        out.push({ path: p, tag: tag ?? basename(dir) });
      }
    }
  };
  walk(root, null);
  return out;
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    o[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const srcRoot = args.src ?? 'templates/ServUO';
const out = args.out ?? 'apps/scripts/src/data/world/xmlspawners.json';

const dirs = [join(srcRoot, 'Spawns'), join(srcRoot, 'RevampedSpawns')];
let files = [];
for (const d of dirs) if (existsSync(d)) files = files.concat(walkXmlFiles(d));
console.log(`[xmlspawn] scanning ${files.length} XML files`);

const all = [];
const fileCounts = new Map();
let dropped = 0;
for (const f of files) {
  let text;
  try { text = readFileSync(f.path, 'utf8'); }
  catch (e) { console.warn(`[xmlspawn] read failed ${f.path}: ${e.message}`); continue; }
  const tag = basename(f.path, '.xml');
  let n = 0;
  for (const block of iterPointsBlocks(text)) {
    const sp = parsePointsBlock(block, tag);
    if (sp) { all.push(sp); n++; }
    else dropped++;
  }
  fileCounts.set(tag, n);
}
console.log(`[xmlspawn] ${all.length} spawn points (${dropped} skipped)`);
for (const [t, c] of [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${t.padEnd(28)} ${c}`);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(all));
console.log(`[xmlspawn] → ${out} (${(JSON.stringify(all).length / 1024).toFixed(1)} KB)`);
