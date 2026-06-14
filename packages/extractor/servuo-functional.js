// ServUO functional + decorative item extractor — adds anvils, forges,
// looms, spinning wheels, training dummies, banners, statues, etc.
//
// We pull only items that:
//   - inherit from `Item` (single-tile) — Items/Functional flat .cs files
//   - or inherit from `BaseAddon` and ship a single component (small
//     decoratives: banners, light sources, simple furniture)
//
// Multi-tile addons (full bookshelves, beds, complex banners) get an
// `addon: true` flag so the spawner knows to use the multi placement
// path instead of single-item creation.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RX = {
  classDecl:    /class\s+(\w+)\s*:\s*(?:Item|Container|BaseAddon|BaseLight|BaseFurniture)/,
  baseCtor:     /:\s*base\(\s*0x([0-9A-Fa-f]+)\s*\)/,
  flipable:     /FlipableAttribute\s*\(\s*0x([0-9A-Fa-f]+)\s*,\s*0x([0-9A-Fa-f]+)/,
  weight:       /Weight\s*=\s*([\d.]+)f?\s*;/,
  immovable:    /Movable\s*=\s*false/,
  craftMarker:  /Server\.Engines\.Craft\.(Anvil|Forge|TinkerTools|TailorTools|CarpentryTools|InscriptionTools|AlchemyTable)/,
  bodyId:       /Body\s*=\s*(\d+)/,
};

function kebab(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function categorise(text, className) {
  // Detect crafting role from class attributes / class name.
  const craft = text.match(RX.craftMarker)?.[1];
  if (craft === 'Anvil')          return 'anvil';
  if (craft === 'Forge')          return 'forge';
  if (craft === 'TinkerTools')    return 'tinker-tools';
  if (craft === 'TailorTools')    return 'tailor-tools';
  if (craft === 'CarpentryTools') return 'carpentry-tools';
  if (craft === 'InscriptionTools') return 'inscription-tools';
  if (craft === 'AlchemyTable')   return 'alchemy-table';
  // Heuristic name-match fallback.
  const n = className.toLowerCase();
  if (/anvil/.test(n))          return 'anvil';
  if (/forge/.test(n))          return 'forge';
  if (/loom/.test(n))           return 'loom';
  if (/spinningwheel/.test(n))  return 'spinning-wheel';
  if (/dummy|trainingdummy/.test(n)) return 'training-dummy';
  if (/oven|stove/.test(n))     return 'oven';
  if (/banner/.test(n))         return 'banner';
  if (/statue/.test(n))         return 'statue';
  if (/torch|lantern|brazier|candelabra|lamp/.test(n)) return 'light';
  if (/altar|shrine/.test(n))   return 'altar';
  if (/bookcase|bookshelf/.test(n)) return 'bookshelf';
  if (/chair|bench|stool|throne/.test(n)) return 'chair';
  if (/table|desk/.test(n))     return 'table';
  if (/bed/.test(n))            return 'bed';
  if (/door|gate/.test(n))      return 'door';
  if (/chest|barrel|crate/.test(n)) return 'container';
  if (/campfire/.test(n))       return 'campfire';
  if (/ankh/.test(n))           return 'ankh';
  return 'decorative';
}

function parseFile(path, isAddon) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  // We want concrete classes only; bases are abstract.
  const decl = text.match(RX.classDecl);
  if (!decl) return null;
  const className = decl[1];
  if (className.startsWith('Base') || className.startsWith('Abstract')) return null;
  const ctor = text.match(RX.baseCtor);
  if (!ctor) return null;
  const itemId = parseInt(ctor[1], 16);
  if (!itemId) return null;
  const flip   = text.match(RX.flipable);
  const weight = text.match(RX.weight);
  const role   = categorise(text, className);
  const out = {
    name: kebab(className),
    itemId,
    label: `a ${className.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()}`,
    slot: 'world',
    role,
  };
  if (flip)   out.flipId = parseInt(flip[2], 16);
  if (weight) out.weight = parseFloat(weight[1]);
  if (text.match(RX.immovable)) out.movable = false;
  if (isAddon) out.addon = true;
  return out;
}

function walk(dir, isAddon, results) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, isAddon, results);
    else if (entry.endsWith('.cs')) {
      const item = parseFile(full, isAddon);
      if (item) results.push(item);
    }
  }
}

export async function extractServUOFunctional(servuoPath, out) {
  const root = join(servuoPath, 'Scripts', 'Items');
  /** @type {any[]} */
  const items = [];
  walk(join(root, 'Functional'), false, items);
  walk(join(root, 'Addons'),     true,  items);
  // Deduplicate by name.
  const seenNames = new Set();
  const uniq = [];
  for (const it of items) {
    if (seenNames.has(it.name)) continue;
    seenNames.add(it.name);
    uniq.push(it);
  }
  uniq.sort((a, b) => a.name.localeCompare(b.name));
  // Merge into items.json.
  const outFile = join(out, 'data', 'items.json');
  /** @type {any[]} */
  const existing = JSON.parse(readFileSync(outFile, 'utf8'));
  const knownByName = new Set(existing.map((e) => e.name));
  let added = 0;
  // Tally roles for the log.
  const byRole = {};
  for (const it of uniq) {
    if (knownByName.has(it.name)) continue;
    existing.push(it);
    knownByName.add(it.name);
    byRole[it.role] = (byRole[it.role] ?? 0) + 1;
    added++;
  }
  writeFileSync(outFile, JSON.stringify(existing, null, 2));
  return { scanned: uniq.length, added, total: existing.length, byRole };
}
