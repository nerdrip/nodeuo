// ServUO craft recipes extractor — reads every `Def<Skill>.cs` under
// `templates/ServUO/Scripts/Services/Craft/` and pulls out each
// AddCraft + AddRes call. Output:
// `apps/scripts/src/data/config/recipes.json`.
//
// AddCraft signature (the canonical one we care about):
//   AddCraft(typeof(RefreshPotion), 1116348, 1044538, -25, 25.0,
//            typeof(BlackPearl), 1044353, 1, 1044361)
//   args:                 result      group   name   minSkill maxSkill
//                         res-1-type      res-1-name  res-1-qty  fail-msg
//
// Following AddRes(index, typeof(X), name, qty, msg) lines add extra
// resources to the previous AddCraft.
//
// We capture per recipe:
//   { result, minSkill, maxSkill, resources:[{type, qty}], skill }
//
// Skill is inferred from `MainSkill` getter — `return SkillName.Alchemy;`
// → "alchemy". Files without that getter (fragments) are skipped.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CRAFT_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts', 'Services', 'Craft');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'config', 'recipes.json');

const RX_MAIN_SKILL = /SkillName\.([A-Za-z]+)/;
const RX_ADD_CRAFT = /AddCraft\(\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*\d+\s*,\s*\d+\s*,\s*([-]?[\d.]+)\s*,\s*([-]?[\d.]+)\s*,\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*\d+\s*,\s*(\d+)/g;
const RX_ADD_RES = /AddRes\(\s*index\s*,\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*\d+\s*,\s*(\d+)/g;

function extract(file) {
  const src = readFileSync(file, 'utf8');
  const skMatch = src.match(RX_MAIN_SKILL);
  if (!skMatch) return null;
  const skill = skMatch[1].toLowerCase();
  const recipes = [];
  // Walk the file in order, interleaving AddCraft and AddRes.
  // Strategy: split on lines, regex each.
  const lines = src.split('\n');
  let cur = null;
  for (const line of lines) {
    const c = RX_ADD_CRAFT.exec(line); RX_ADD_CRAFT.lastIndex = 0;
    if (c) {
      cur = {
        result: c[1],
        minSkill: parseFloat(c[2]),
        maxSkill: parseFloat(c[3]),
        resources: [{ type: c[4], qty: parseInt(c[5], 10) }],
      };
      recipes.push(cur);
      continue;
    }
    const r = RX_ADD_RES.exec(line); RX_ADD_RES.lastIndex = 0;
    if (r && cur) {
      cur.resources.push({ type: r[1], qty: parseInt(r[2], 10) });
    }
  }
  return { skill, recipes };
}

function run() {
  if (!existsSync(CRAFT_DIR)) {
    console.error(`[servuo-recipes] missing ${CRAFT_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(CRAFT_DIR).filter((f) => f.startsWith('Def') && f.endsWith('.cs'));
  const out = {};
  let totalRecipes = 0;
  for (const f of files) {
    const r = extract(join(CRAFT_DIR, f));
    if (!r || !r.recipes.length) continue;
    out[r.skill] = (out[r.skill] ?? []).concat(r.recipes);
    totalRecipes += r.recipes.length;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-recipes] ${files.length} Def files → ${Object.keys(out).length} skills, ${totalRecipes} recipes`);
  console.log(`[servuo-recipes] wrote ${OUT}`);
}

run();
