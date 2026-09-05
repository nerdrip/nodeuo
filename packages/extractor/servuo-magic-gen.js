// ServUO magic-item property extractor — pulls every Register(...) line
// from `ItemPropertyInfo.cs` to recover the full magic-item-affix table:
//
//   Register(<id>, new ItemPropertyInfo(<attribute>, <cliloc>, <weight>,
//      [pRes, gRes, spRes,] <scale>, <start>, <maxInt>, <desc>, …));
//
// Each entry feeds the random-magic-item generator (LootPack rolls a
// budget, picks `weight`-rolled affixes, draws an intensity in
// [start..maxInt]). Output: `apps/scripts/src/data/config/magic-properties.json`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SRC = join(ROOT, 'templates', 'ServUO', 'Scripts', 'Services', 'LootGeneration', 'ItemPropertyInfo.cs');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'config', 'magic-properties.json');

// Two register signatures — short (no resource args) and long (with res
// types). We try long first since it's more specific.
const RX_LONG = /Register\(\s*(\d+)\s*,\s*new\s+ItemPropertyInfo\(\s*([A-Za-z]+Attribute|[A-Za-z]+SkillName|[A-Za-z]+Slayer)\.([A-Za-z]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;
const RX_SHORT = /Register\(\s*(\d+)\s*,\s*new\s+ItemPropertyInfo\(\s*([A-Za-z]+Attribute|[A-Za-z]+SkillName|[A-Za-z]+Slayer)\.([A-Za-z]+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g;

function run() {
  if (!existsSync(SRC)) {
    console.error(`[servuo-magic-gen] missing ${SRC}`);
    process.exit(1);
  }
  const text = readFileSync(SRC, 'utf8');
  const out = [];
  for (const m of text.matchAll(RX_LONG)) {
    out.push({
      id: +m[1],
      group: m[2], attribute: m[3],
      cliloc: +m[4], weight: +m[5],
      primary: m[6], gem: m[7], special: m[8],
      scale: +m[9], start: +m[10], maxIntensity: +m[11],
    });
  }
  // Short path covers the no-resource entries.
  for (const m of text.matchAll(RX_SHORT)) {
    const id = +m[1];
    if (out.find((p) => p.id === id)) continue;
    out.push({
      id, group: m[2], attribute: m[3],
      cliloc: +m[4], weight: +m[5],
      scale: +m[6], start: +m[7], maxIntensity: +m[8],
    });
  }
  out.sort((a, b) => a.id - b.id);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-magic-gen] extracted ${out.length} magic properties`);
  console.log(`[servuo-magic-gen] wrote ${OUT}`);
}

run();
