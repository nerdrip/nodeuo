// ServUO weapon / armor / clothing item extractor — bulk-pulls
// equipment definitions from `templates/ServUO/Scripts/Items/Equipment`
// and merges them into `apps/scripts/src/data/items.json`.
//
// Each ServUO weapon ctor calls `base(0xNNNN)` with the canonical UO
// item id; we capture that plus min/max damage, speed, strength req, and
// FlipableAttribute alt id. The exporter only adds entries for kinds we
// don't already have — preserves hand-tuned data.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RX = {
  classDecl: /class\s+(\w+)\s*:\s*Base(\w+)/,
  baseCtor:  /:\s*base\(\s*0x([0-9A-Fa-f]+)\s*\)/,
  flipable:  /FlipableAttribute\s*\(\s*0x([0-9A-Fa-f]+)\s*,\s*0x([0-9A-Fa-f]+)/,
  weight:    /Weight\s*=\s*([\d.]+)f?\s*;/,
  hue:       /Hue\s*=\s*0x([0-9A-Fa-f]+)/,
  oldMinDmg: /OldMinDamage[\s\S]{0,80}?return\s+(\d+)/,
  oldMaxDmg: /OldMaxDamage[\s\S]{0,80}?return\s+(\d+)/,
  oldSpeed:  /OldSpeed[\s\S]{0,80}?return\s+(\d+)/,
  oldStr:    /OldStrengthReq[\s\S]{0,80}?return\s+(\d+)/,
  primary:   /PrimaryAbility[\s\S]{0,120}?return\s+WeaponAbility\.(\w+)/,
  secondary: /SecondaryAbility[\s\S]{0,120}?return\s+WeaponAbility\.(\w+)/,
};

function kebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

const SLOT_BY_BASE = {
  // Weapons all go in the OneHanded / TwoHanded slots (CUO Layer 1/2).
  Axe: 'weapon', Knife: 'weapon', MeleeWeapon: 'weapon',
  Spear: 'weapon', Sword: 'weapon', Bashing: 'weapon',
  PoleArm: 'weapon', Ranged: 'weapon', Staff: 'weapon',
  // Armor / shield / clothing.
  Armor: 'armor', Shield: 'shield', Clothing: 'clothing',
  Helm: 'helm',   Sandals: 'shoes', Footwear: 'shoes',
};

function parseItem(path, dirRole) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const decl = text.match(RX.classDecl);
  if (!decl) return null;
  const className = decl[1];
  const baseClass = decl[2];
  // Skip abstract base classes (`BaseAxe`, `BaseSword`, etc.).
  if (className.startsWith('Base')) return null;
  const ctor = text.match(RX.baseCtor);
  if (!ctor) return null;
  const itemId = parseInt(ctor[1], 16);
  if (!itemId) return null;
  const flip = text.match(RX.flipable);
  const weight = text.match(RX.weight);
  const hue   = text.match(RX.hue);
  const dmgMin = text.match(RX.oldMinDmg);
  const dmgMax = text.match(RX.oldMaxDmg);
  const speed  = text.match(RX.oldSpeed);
  const strReq = text.match(RX.oldStr);
  const primary = text.match(RX.primary);
  const secondary = text.match(RX.secondary);
  const kind = kebab(className);
  const slot = SLOT_BY_BASE[baseClass] ?? dirRole ?? 'misc';
  const out = {
    name: kind,
    itemId,
    label: `a ${className.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()}`,
    clothing: true,
    equipLayer: slot === 'weapon' ? 1 : (slot === 'shield' ? 1 : 13),
    slot,
  };
  if (flip)   out.flipId = parseInt(flip[2], 16);
  if (weight) out.weight = parseFloat(weight[1]);
  if (hue)    out.hue    = parseInt(hue[1], 16);
  if (dmgMin) out.dmgMin = parseInt(dmgMin[1], 10);
  if (dmgMax) out.dmgMax = parseInt(dmgMax[1], 10);
  if (speed)  out.speed  = parseInt(speed[1], 10);
  if (strReq) out.strReq = parseInt(strReq[1], 10);
  if (primary)   out.primaryAbility   = primary[1];
  if (secondary) out.secondaryAbility = secondary[1];
  return out;
}

function walk(dir, role, results) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, role, results);
    else if (entry.endsWith('.cs')) {
      const item = parseItem(full, role);
      if (item) results.push(item);
    }
  }
}

export async function extractServUOItems(servuoPath, out) {
  const root = join(servuoPath, 'Scripts', 'Items', 'Equipment');
  /** @type {any[]} */
  const items = [];
  // Hint a "role" per top-level directory so generic-base items get a
  // meaningful slot when the BaseClass match misses.
  for (const role of [
    ['Weapons',   'weapon'],
    ['Armor',     'armor'],
    ['Clothing',  'clothing'],
    ['Jewelry',   'jewelry'],
    ['Spellbooks','spellbook'],
    ['Light',     'light'],
    ['Quivers',   'quiver'],
  ]) {
    const dir = join(root, role[0]);
    let exists = false;
    try { exists = statSync(dir).isDirectory(); } catch { exists = false; }
    if (!exists) continue;
    walk(dir, role[1], items);
  }
  // Merge into existing items.json (existing entries win).
  const outFile = join(out, 'data', 'items.json');
  /** @type {any[]} */
  const existing = JSON.parse(readFileSync(outFile, 'utf8'));
  const knownByName = new Set(existing.map((e) => e.name));
  const knownById   = new Set(existing.map((e) => e.itemId));
  let added = 0;
  for (const it of items) {
    if (knownByName.has(it.name) || knownById.has(it.itemId)) continue;
    existing.push(it);
    added++;
  }
  writeFileSync(outFile, JSON.stringify(existing, null, 2));
  return { scanned: items.length, added, total: existing.length };
}
