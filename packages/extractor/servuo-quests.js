// ServUO quest extractor — walks `templates/ServUO/Scripts/Quests/`
// recursively and pulls out each quest's metadata. Output:
// `apps/scripts/src/data/quests-extracted.json` (kept distinct from
// the hand-authored `quests.json` so the runtime can prefer authored
// over extracted when both define the same key).
//
// ServUO quest classes follow loose patterns. The most common shape is:
//   public class FooQuest : BaseQuest
//   {
//       public override int Title { get { return 1075000; } }
//       public override int Description { get { return 1075001; } }
//       public override int RefuseMessage { get { return 1075002; } }
//       …
//       public override object Uncomplete { get { return 1075003; } }
//       public override object Complete { get { return 1075004; } }
//
//       public FooQuest() {
//           AddObjective(new ObtainObjective(typeof(BlackPearl), "black pearl", 5));
//           AddReward(new BaseReward(typeof(SmallBOD), 1));
//       }
//   }
//
// Extracted fields:
//   { class, base, title, description, refuse, uncomplete, complete,
//     objectives:[{ kind, type, label?, qty? }], rewards:[{ type, qty? }] }

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const QUESTS_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts', 'Quests');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'quests-extracted.json');

const RX_CLASS = /public\s+class\s+([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)/;
const RX_OVERRIDE_INT = (name) => new RegExp(`override\\s+int\\s+${name}\\s*\\{\\s*get\\s*\\{\\s*return\\s+(\\d+)`);
const RX_OVERRIDE_OBJ = (name) => new RegExp(`override\\s+object\\s+${name}\\s*\\{\\s*get\\s*\\{\\s*return\\s+(\\d+)`);
const RX_OBJECTIVE = /AddObjective\(\s*new\s+([A-Za-z0-9_]+)\(\s*typeof\(([A-Za-z0-9_]+)\)(?:\s*,\s*"([^"]+)")?(?:\s*,\s*(\d+))?/g;
const RX_REWARD = /AddReward\(\s*new\s+[A-Za-z0-9_]+\(\s*typeof\(([A-Za-z0-9_]+)\)(?:\s*,\s*(\d+))?/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith('.cs')) yield full;
  }
}

function safeMatch(seg, name, kind = 'int') {
  const rx = kind === 'obj' ? RX_OVERRIDE_OBJ(name) : RX_OVERRIDE_INT(name);
  const m = seg.match(rx);
  return m ? +m[1] : null;
}

function extract(file) {
  let src;
  try { src = readFileSync(file, 'utf8'); }
  catch { return []; }
  const out = [];
  for (const seg of src.split(/(?=public\s+class\s)/)) {
    const c = seg.match(RX_CLASS);
    if (!c) continue;
    const className = c[1];
    const baseName  = c[2];
    if (!/Quest$/.test(className) && !/Quest/.test(baseName)) continue;

    const title       = safeMatch(seg, 'Title');
    const description = safeMatch(seg, 'Description');
    const refuse      = safeMatch(seg, 'RefuseMessage');
    const uncomplete  = safeMatch(seg, 'Uncomplete', 'obj');
    const complete    = safeMatch(seg, 'Complete', 'obj');

    const objectives = [];
    for (const m of seg.matchAll(RX_OBJECTIVE)) {
      objectives.push({
        kind: m[1], type: m[2],
        label: m[3] ?? null, qty: m[4] ? +m[4] : null,
      });
    }
    const rewards = [];
    for (const m of seg.matchAll(RX_REWARD)) {
      rewards.push({ type: m[1], qty: m[2] ? +m[2] : 1 });
    }
    if (title === null && objectives.length === 0 && rewards.length === 0) continue;

    out.push({
      class: className, base: baseName,
      title, description, refuse, uncomplete, complete,
      objectives, rewards,
    });
  }
  return out;
}

function run() {
  if (!existsSync(QUESTS_DIR)) {
    console.error(`[servuo-quests] missing ${QUESTS_DIR}`);
    process.exit(1);
  }
  const out = [];
  let fileCount = 0;
  for (const f of walk(QUESTS_DIR)) {
    fileCount++;
    out.push(...extract(f));
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-quests] scanned ${fileCount} files → ${out.length} quest classes`);
  console.log(`[servuo-quests] wrote ${OUT}`);
}

run();
