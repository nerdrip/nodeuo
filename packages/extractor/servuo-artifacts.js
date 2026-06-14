// ServUO artifact extractor — walks
// `templates/ServUO/Scripts/Items/Artifacts/` recursively and emits
// the unique magical-property profile for each item that declares
// `IsArtifact { get { return true; } }`. Output:
// `apps/scripts/src/data/artifacts.json`.
//
// Per artifact we capture:
//   { name, base, attributes:{}, skillBonuses:[], resists:{},
//     hits:[min,max], slayer? }
//
// `name` = class name (camelCase). `base` = parent class (the `:` after
// the class name). `LabelNumber` cliloc id is captured as `cliloc`.
// Attribute lines are pulled from `Attributes.XXX = N;` and
// `WeaponAttributes.XXX = N;` and `SkillBonuses.SetValues(slot, SkillName.X, val)`.
// We only enumerate the most common bonuses to keep the JSON compact.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ART_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts', 'Items', 'Artifacts');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'artifacts.json');

const RX_CLASS = /public\s+class\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/;
const RX_ARTIFACT = /IsArtifact\s*\{\s*get\s*\{\s*return\s+true/;
const RX_LABEL = /LabelNumber\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_HITS = /InitMinHits\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_HITS_MAX = /InitMaxHits\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_ATTR = /Attributes\.([A-Za-z]+)\s*=\s*(-?\d+)/g;
const RX_W_ATTR = /WeaponAttributes\.([A-Za-z]+)\s*=\s*(-?\d+)/g;
const RX_A_ATTR = /ArmorAttributes\.([A-Za-z]+)\s*=\s*(-?\d+)/g;
const RX_SKILL_BONUS = /SkillBonuses\.SetValues\(\s*\d+\s*,\s*SkillName\.([A-Za-z]+)\s*,\s*([\d.]+)/g;
const RX_BASE_COLD = /BaseColdResistance\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_BASE_FIRE = /BaseFireResistance\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_BASE_ENERGY = /BaseEnergyResistance\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_BASE_POIS = /BasePoisonResistance\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_BASE_PHYS = /BasePhysicalResistance\s*\{\s*get\s*\{\s*return\s+(\d+)/;
const RX_SLAYER = /Slayer\s*=\s*SlayerName\.([A-Za-z]+)/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith('.cs')) yield full;
  }
}

/**
 * Wave 10: derive an artifact rarity tier from the source file path.
 *
 *   Items/Artifacts/Equipment/...     → 'equipment' (standard rarity)
 *   Items/Artifacts/Decorative/...    → 'decorative' (housing rares)
 *   Items/Artifacts/Talismans/...     → 'talisman'
 *   Items/Artifacts/Tools/...         → 'tool'
 *   Items/Artifacts/Consumables/...   → 'consumable'
 *   TOTGreaterArtifacts.cs            → 'greater'  (top-tier ToT drops)
 *   TOTLesserArtifacts.cs             → 'lesser'   (mid-tier ToT)
 *   DespiseArtifacts.cs               → 'despise'  (Despise dungeon)
 *
 * Anything else falls back to 'equipment'.
 */
function tierForPath(file) {
  const norm = file.replace(/\\/g, '/');
  if (/TOTGreaterArtifacts/.test(norm)) return 'greater';
  if (/TOTLesserArtifacts/.test(norm)) return 'lesser';
  if (/DespiseArtifacts/.test(norm)) return 'despise';
  if (/\/Equipment\//.test(norm)) return 'equipment';
  if (/\/Decorative\//.test(norm)) return 'decorative';
  if (/\/Talismans\//.test(norm)) return 'talisman';
  if (/\/Tools\//.test(norm)) return 'tool';
  if (/\/Consumables\//.test(norm)) return 'consumable';
  return 'equipment';
}

function extractClasses(src) {
  // ServUO often packs multiple artifact classes per file. Split on
  // `public class` boundaries and run the per-class regexes on each
  // segment.
  const out = [];
  const splits = src.split(/(?=public\s+class\s)/);
  for (const seg of splits) {
    if (!RX_ARTIFACT.test(seg)) continue;
    const c = seg.match(RX_CLASS);
    if (!c) continue;
    const name = c[1];
    const base = c[2];
    const labelM = seg.match(RX_LABEL);
    const cliloc = labelM ? +labelM[1] : null;
    const slayerM = seg.match(RX_SLAYER);
    const slayer = slayerM ? slayerM[1] : null;

    const attributes = {};
    for (const m of seg.matchAll(RX_ATTR)) attributes[m[1]] = +m[2];
    const weaponAttributes = {};
    for (const m of seg.matchAll(RX_W_ATTR)) weaponAttributes[m[1]] = +m[2];
    const armorAttributes = {};
    for (const m of seg.matchAll(RX_A_ATTR)) armorAttributes[m[1]] = +m[2];
    const skillBonuses = [];
    for (const m of seg.matchAll(RX_SKILL_BONUS)) {
      skillBonuses.push({ skill: m[1], value: +m[2] });
    }
    const resists = {};
    const tryRes = (rx, key) => { const m = seg.match(rx); if (m) resists[key] = +m[1]; };
    tryRes(RX_BASE_COLD, 'cold');
    tryRes(RX_BASE_FIRE, 'fire');
    tryRes(RX_BASE_ENERGY, 'energy');
    tryRes(RX_BASE_POIS, 'poison');
    tryRes(RX_BASE_PHYS, 'physical');
    const hits = [];
    const hMin = seg.match(RX_HITS);
    const hMax = seg.match(RX_HITS_MAX);
    if (hMin) hits.push(+hMin[1]);
    if (hMax) hits.push(+hMax[1]);

    out.push({ name, base, cliloc, slayer,
      attributes, weaponAttributes, armorAttributes, skillBonuses,
      resists, hits });
  }
  return out;
}

function run() {
  if (!existsSync(ART_DIR)) {
    console.error(`[servuo-artifacts] missing ${ART_DIR}`);
    process.exit(1);
  }
  const out = [];
  let fileCount = 0;
  for (const f of walk(ART_DIR)) {
    fileCount++;
    let src;
    try { src = readFileSync(f, 'utf8'); }
    catch { continue; }
    const tier = tierForPath(f);
    for (const a of extractClasses(src)) {
      a.tier = tier;
      out.push(a);
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-artifacts] scanned ${fileCount} files → ${out.length} artifacts`);
  console.log(`[servuo-artifacts] wrote ${OUT}`);
}

run();
