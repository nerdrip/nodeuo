// ServUO monster catalogue extractor — reads every .cs file under
// `templates/ServUO/Scripts/Mobiles/Normal` and pulls out the fields our
// data-driven spawner cares about:
//
//   - kind (filename without extension, lowercased + hyphenated)
//   - name (string literal in `Name = "..."`)
//   - body (literal int OR first arg of Utility.RandomList(...))
//   - hp   (max of `SetHits(a, b)` — we treat hpMax = b)
//   - str  (max of `SetStr(a, b)`)
//   - dex  (max of `SetDex(a, b)`)
//   - int  (max of `SetInt(a, b)`)
//   - dmg  ([min, max] of `SetDamage(a, b)`)
//   - resists ({phys, fire, cold, pois, engy} maxes from SetResistance)
//   - sound (`BaseSoundID = N`)
//   - tamable (`Tamable = true`)
//   - controlSlots (`ControlSlots = N`)
//   - tameSkill (`MinTameSkill = N`)
//   - karma (signed int from `Karma = N`)
//   - fame  (`Fame = N`)
//   - mageAI (true when `AIType.AI_Mage` in base ctor)
//
// Notoriety is derived: karma <= -10000 → 6 (Murderer red), karma < 0 → 5 (Enemy/monster orange),
// karma >= 0 → 5 too (most untamable monsters are neutral-aggressive).
// Aggro range / attack interval default to engine values; we fold tamable
// + ControlSlots so the existing pet system can use them.
//
// Output is merged into `apps/scripts/src/data/config/monsters.json`.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const RX = {
  name:    /Name\s*=\s*"([^"]+)"/,
  body:    /Body\s*=\s*(?:Utility\.RandomList\(\s*(\d+)|0x([0-9A-Fa-f]+)|(\d+))/,
  hits:    /SetHits\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  str:     /SetStr\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  dex:     /SetDex\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  intg:    /SetInt\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  dmg:     /SetDamage\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  sound:   /BaseSoundID\s*=\s*(\d+)/,
  tamable: /Tamable\s*=\s*true/,
  ctrl:    /ControlSlots\s*=\s*(\d+)/,
  tameSk:  /MinTameSkill\s*=\s*([\d.]+)/,
  karma:   /Karma\s*=\s*(-?\d+)/,
  fame:    /Fame\s*=\s*(\d+)/,
  resPhys: /SetResistance\(\s*ResistanceType\.Physical\s*,\s*(\d+)\s*,\s*(\d+)/,
  resFire: /SetResistance\(\s*ResistanceType\.Fire\s*,\s*(\d+)\s*,\s*(\d+)/,
  resCold: /SetResistance\(\s*ResistanceType\.Cold\s*,\s*(\d+)\s*,\s*(\d+)/,
  resPois: /SetResistance\(\s*ResistanceType\.Poison\s*,\s*(\d+)\s*,\s*(\d+)/,
  resEngy: /SetResistance\(\s*ResistanceType\.Energy\s*,\s*(\d+)\s*,\s*(\d+)/,
  aiMage:  /AIType\.AI_Mage/,
};

function kebab(s) {
  return String(s).trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function parseFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  // Skip files that don't look like creature defs.
  if (!/class\s+\w+\s*:\s*BaseCreature/.test(text)) return null;
  const baseName = basename(path, '.cs');
  const kind = kebab(baseName);
  const m = (rx) => text.match(rx);
  const name = m(RX.name)?.[1];
  if (!name) return null;
  const bM = m(RX.body);
  const body = bM ? (parseInt(bM[1] ?? bM[3], 10) || parseInt(bM[2] ?? '0', 16)) : 0;
  if (!body) return null;
  const hits = m(RX.hits);
  const str  = m(RX.str);
  const dex  = m(RX.dex);
  const intg = m(RX.intg);
  const dmg  = m(RX.dmg);
  const karma = m(RX.karma)?.[1];
  const out = {
    kind,
    name,
    body,
    hp: hits ? parseInt(hits[2], 10) : 50,
    str: str ? parseInt(str[2], 10) : 50,
    dex: dex ? parseInt(dex[2], 10) : 50,
    int: intg ? parseInt(intg[2], 10) : 30,
    dmgMin: dmg ? parseInt(dmg[1], 10) : 5,
    dmgMax: dmg ? parseInt(dmg[2], 10) : 10,
    notoriety: 5,
    aggroRange: 8,
    attackInterval: 1800,
  };
  // Notoriety from karma — < 0 enemy/orange (5), <= -10000 still 5 because UO
  // doesn't paint normal monsters red (red = murderer 6 reserved for PKs).
  if (karma != null) {
    const k = parseInt(karma, 10);
    if (k < 0) out.notoriety = 5;
    else if (k > 0) out.notoriety = 1;       // tame-friendly creatures
  }
  const sound = m(RX.sound);
  if (sound) out.sound = parseInt(sound[1], 10);
  if (m(RX.tamable)) out.tamable = true;
  const ctrl = m(RX.ctrl);
  if (ctrl) out.controlSlots = parseInt(ctrl[1], 10);
  const tameSk = m(RX.tameSk);
  if (tameSk) out.tameSkill = parseFloat(tameSk[1]);
  const fame = m(RX.fame);
  if (fame) out.fame = parseInt(fame[1], 10);
  // Resistances — use the upper bound (server typically rolls min..max).
  const r = {};
  for (const [k, rx] of [['phys', RX.resPhys], ['fire', RX.resFire],
                         ['cold', RX.resCold], ['pois', RX.resPois],
                         ['engy', RX.resEngy]]) {
    const e = m(rx);
    if (e) r[k] = parseInt(e[2], 10);
  }
  if (Object.keys(r).length) out.resists = r;
  // Mage AI heuristic — flag so the spawner can pick a different behavior.
  if (m(RX.aiMage)) out.mageAI = true;
  // Loot table guess.
  out.gold = [Math.max(0, Math.floor(out.hp / 4)), Math.max(out.hp, Math.floor(out.hp * 1.5))];
  out.loot = `${kind}-common`;
  return out;
}

export async function extractServUOMonsters(servuoPath, out) {
  const dir = join(servuoPath, 'Scripts', 'Mobiles', 'Normal');
  /** @type {any[]} */
  const monsters = [];
  let scanned = 0, parsed = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.cs')) continue;
    scanned++;
    const data = parseFile(join(dir, file));
    if (data) { monsters.push(data); parsed++; }
  }
  // Stable sort by kind.
  monsters.sort((a, b) => a.kind.localeCompare(b.kind));
  // Merge into existing monsters.json so the hand-curated 0..43 entries
  // keep their flavour adjustments. Existing entries WIN — extractor just
  // back-fills the long tail.
  const outFile = join(out, 'data', 'config', 'monsters.json');
  /** @type {Record<string, any>} */
  const existing = JSON.parse(readFileSync(outFile, 'utf8'));
  const normalizedKinds = new Set();
  for (const [key, entry] of Object.entries(existing)) {
    if (!entry?.kind) continue;
    const previousKind = entry.kind;
    entry.kind = kebab(previousKind);
    if (entry.loot === `${previousKind}-common`) entry.loot = `${entry.kind}-common`;
    if (!normalizedKinds.has(entry.kind)) {
      normalizedKinds.add(entry.kind);
      continue;
    }
    if (Array.isArray(existing)) existing[Number(key)] = null;
    else delete existing[key];
  }
  if (Array.isArray(existing)) {
    const unique = existing.filter(Boolean);
    existing.splice(0, existing.length, ...unique);
  }
  const knownKinds = new Set(Object.values(existing).map((e) => e.kind));
  let nextKey = Math.max(...Object.keys(existing).map((k) => +k)) + 1;
  let added = 0;
  for (const mon of monsters) {
    if (knownKinds.has(mon.kind)) continue;
    existing[String(nextKey++)] = mon;
    added++;
  }
  writeFileSync(outFile, JSON.stringify(existing, null, 2));
  return { scanned, parsed, added, total: Object.keys(existing).length };
}
