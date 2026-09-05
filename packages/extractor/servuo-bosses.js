// ServUO boss extractor — same regex parser as servuo-monsters.js but
// targets `Mobiles/Bosses` + `Mobiles/Named` and folds in special-ability
// metadata.
//
// Special abilities ServUO ships (CUO/ServUO `SpecialAbility` enum):
//   DragonBreath, Vomit, GraspingClaw, ColossalBlow, ConductiveBlast,
//   FlurryForce, RuneCorruption, RagingGrasp, RepellingCharge, SearingWounds,
//   StealLife, StickySkin, SuckerPunch, SwarmingSpiders, WallOfFire,
//   VenomousBite, Polymorph, Heal, NauseatingMist
// Plus name-only aliases (we surface the bare label so server scripts
// can dispatch a custom AI behavior per boss).

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RX = {
  classDecl: /class\s+(\w+)\s*:\s*Base/,
  name:      /Name\s*=\s*"([^"]+)"/,
  body:      /Body\s*=\s*(?:Utility\.RandomList\(\s*(\d+)|0x([0-9A-Fa-f]+)|(\d+))/,
  hits:      /SetHits\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  str:       /SetStr\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  dex:       /SetDex\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  intg:      /SetInt\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  dmg:       /SetDamage\(\s*(\d+)\s*,\s*(\d+)\s*\)/,
  sound:     /BaseSoundID\s*=\s*(\d+)/,
  fame:      /Fame\s*=\s*(\d+)/,
  karma:     /Karma\s*=\s*(-?\d+)/,
  vArmor:    /VirtualArmor\s*=\s*(\d+)/,
  resPhys:   /SetResistance\(\s*ResistanceType\.Physical\s*,\s*(\d+)\s*,\s*(\d+)/,
  resFire:   /SetResistance\(\s*ResistanceType\.Fire\s*,\s*(\d+)\s*,\s*(\d+)/,
  resCold:   /SetResistance\(\s*ResistanceType\.Cold\s*,\s*(\d+)\s*,\s*(\d+)/,
  resPois:   /SetResistance\(\s*ResistanceType\.Poison\s*,\s*(\d+)\s*,\s*(\d+)/,
  resEngy:   /SetResistance\(\s*ResistanceType\.Energy\s*,\s*(\d+)\s*,\s*(\d+)/,
  aiMage:    /AIType\.AI_Mage/,
  aiNecro:   /AIType\.AI_Necro/,
  // Capture every SpecialAbility / SetSpecialAbility / SetWeaponAbility line.
  specialAbils: /(?:SpecialAbility|SetSpecialAbility)\s*\(\s*(?:.*?,\s*)?Special(?:Ability)?\.(\w+)/g,
  // Catch boss-flavour AI name pulled from filename (e.g. CrimsonDragon).
};

function kebab(s) {
  return String(s).trim().replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function parseFile(path, kindHint) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const decl = text.match(RX.classDecl);
  if (!decl) return null;
  const className = decl[1];
  const name = text.match(RX.name)?.[1];
  if (!name) return null;
  const bM = text.match(RX.body);
  const body = bM ? (parseInt(bM[1] ?? bM[3], 10) || parseInt(bM[2] ?? '0', 16)) : 0;
  if (!body) return null;
  const hits  = text.match(RX.hits);
  const str   = text.match(RX.str);
  const dex   = text.match(RX.dex);
  const intg  = text.match(RX.intg);
  const dmg   = text.match(RX.dmg);
  const fame  = text.match(RX.fame);
  const karma = text.match(RX.karma);
  const sound = text.match(RX.sound);
  const vArm  = text.match(RX.vArmor);
  const out = {
    kind: kebab(className),
    name,
    body,
    hp:    hits ? parseInt(hits[2], 10) : 4000,    // bosses default HUGE
    str:   str  ? parseInt(str[2],  10) : 600,
    dex:   dex  ? parseInt(dex[2],  10) : 200,
    int:   intg ? parseInt(intg[2], 10) : 400,
    dmgMin: dmg ? parseInt(dmg[1], 10)  : 20,
    dmgMax: dmg ? parseInt(dmg[2], 10)  : 30,
    notoriety: 6,                                  // murderer red — bosses always
    aggroRange: 18,                                // longer for bosses
    attackInterval: 2000,
    boss: true,
    role: kindHint,                                // 'boss' | 'named' | 'champion'
  };
  if (fame)  out.fame  = parseInt(fame[1],  10);
  if (karma) out.karma = parseInt(karma[1], 10);
  if (sound) out.sound = parseInt(sound[1], 10);
  if (vArm)  out.virtualArmor = parseInt(vArm[1], 10);
  // Resistances.
  const r = {};
  for (const [k, rx] of [['phys', RX.resPhys], ['fire', RX.resFire],
                         ['cold', RX.resCold], ['pois', RX.resPois],
                         ['engy', RX.resEngy]]) {
    const e = text.match(rx);
    if (e) r[k] = parseInt(e[2], 10);
  }
  if (Object.keys(r).length) out.resists = r;
  if (text.match(RX.aiMage))  out.mageAI  = true;
  if (text.match(RX.aiNecro)) out.necroAI = true;
  // Special abilities — collect every match, dedupe.
  const abilities = new Set();
  for (const m of text.matchAll(RX.specialAbils)) abilities.add(m[1]);
  if (abilities.size) out.specialAbilities = [...abilities];
  // Hard-coded boss-tier loot tables we already define in loot-tables.json.
  // Bosses always drop a hoard + named items.
  out.gold = [Math.max(500, Math.floor(out.hp / 4)), Math.max(2000, out.hp)];
  out.loot = 'boss-hoard';
  return out;
}

function walk(dir, role, results) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, role, results);
    else if (entry.endsWith('.cs') && !entry.startsWith('Base')) {
      const data = parseFile(full, role);
      if (data) results.push(data);
    }
  }
}

export async function extractServUOBosses(servuoPath, out) {
  const root = join(servuoPath, 'Scripts', 'Mobiles');
  /** @type {any[]} */
  const all = [];
  walk(join(root, 'Bosses'), 'boss',  all);
  walk(join(root, 'Named'),  'named', all);
  // Stable sort by kind + role.
  all.sort((a, b) => a.kind.localeCompare(b.kind));
  // Merge into existing monsters.json.
  const outFile = join(out, 'data', 'config', 'monsters.json');
  /** @type {Record<string, any>} */
  const existing = JSON.parse(readFileSync(outFile, 'utf8'));
  const knownKinds = new Set(Object.values(existing).map((e) => e.kind));
  let nextKey = Math.max(...Object.keys(existing).map((k) => +k)) + 1;
  let added = 0;
  for (const mon of all) {
    if (knownKinds.has(mon.kind)) continue;
    existing[String(nextKey++)] = mon;
    added++;
  }
  writeFileSync(outFile, JSON.stringify(existing, null, 2));
  return { scanned: all.length, added, total: Object.keys(existing).length };
}
