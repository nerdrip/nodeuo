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
// Item subclasses also live beside quests, mobiles, multis and seasonal
// services.  Scan the complete Scripts tree so those definitions inherit the
// same stable identity and art resolution as files under Scripts/Items.
const ITEMS_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'config', 'item-types.json');

const RX_CLASS = /\b((?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*)class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([A-Za-z_][A-Za-z0-9_.<>]*))?/g;
const RX_BASE_CALL = /:\s*base\s*\(\s*(0x[0-9A-Fa-f]+|\d+)/;          // : base(0xZZZZ, …)
const RX_ITEMID_SET = /(?:^|;)\s*ItemID\s*=\s*(0x[0-9A-Fa-f]+|\d+)/;
const RX_HUE_SET = /(?:^|;)\s*Hue\s*=\s*(0x[0-9A-Fa-f]+|\d+)/;
const RX_NAME_SET = /(?:this\.)?Name\s*=\s*"([^"]+)"/;
const RX_WEIGHT_SET = /(?:this\.)?Weight\s*=\s*([\d.]+)f?\s*;/;

const ITEM_ROOTS = new Set([
  'Item', 'Container', 'BaseContainer', 'Corpse', 'BaseAddon', 'AddonComponent',
  'BaseAddonDeed', 'BaseWeapon', 'BaseArmor', 'BaseClothing', 'BaseJewel',
  'BaseTool', 'BasePotion', 'Food', 'BaseFood', 'BaseBeverage', 'BaseLight',
  'BaseDoor', 'BaseHouseDoor', 'Teleporter', 'DyeTub', 'BaseBook', 'MapItem',
  'BaseMulti', 'BaseBoat', 'BaseBoatDeed', 'BaseDockedBoat', 'SpecialScroll',
  'BaseWand', 'Spellbook', 'BaseHarvestTool', 'BaseRunicTool', 'HouseDeed',
  'BaseHouse', 'BaseCostume', 'BaseSuit', 'EtherealMount', 'MonsterStatuette',
  'SoulStone', 'PromotionalToken', 'BaseRewardBag', 'FarmableCrop',
  'QuestHintItem', 'BaseDecayingItem',
]);

const ROOT_ART = new Map([
  ['Item', 0x0001], ['Container', 0x0E40], ['BaseContainer', 0x0E40],
  ['BaseAddonDeed', 0x14F0], ['HouseDeed', 0x14F0], ['BaseBoatDeed', 0x14F0],
  ['BaseTool', 0x1EB8], ['BaseHarvestTool', 0x0F39], ['BaseRunicTool', 0x1EB8],
  ['BasePotion', 0x0F0E], ['Food', 0x09D0], ['BaseFood', 0x09D0],
  ['BaseBeverage', 0x099F], ['DyeTub', 0x0FAB], ['BaseBook', 0x0FF1],
  ['Spellbook', 0x0EFA], ['SpecialScroll', 0x1F4D], ['BaseWand', 0x0DF2],
  ['BaseAddon', 0x0EED], ['AddonComponent', 0x0EED], ['Teleporter', 0x1822],
]);

function num(s) { return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10); }

function* walk(dir) {
  for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
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
  RX_CLASS.lastIndex = 0;
  let match;
  while ((match = RX_CLASS.exec(src))) {
    const open = src.indexOf('{', RX_CLASS.lastIndex);
    if (open < 0) continue;
    let depth = 1;
    let end = src.length;
    for (let i = open + 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    yield {
      className: match[2],
      baseName: (match[3] ?? '').split('.').at(-1)?.replace(/<.*$/, '') || null,
      abstract: /\babstract\b/.test(match[1] ?? ''),
      body: src.slice(match.index, end),
    };
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
    // Constructors such as staff suits pass access, hue and graphic to a
    // shared base.  The final literal is the item graphic in those families.
    for (const call of body.matchAll(/:\s*base\s*\(([^\r\n{}]*)\)/g)) {
      const literals = [...call[1].matchAll(/\b(0x[0-9A-Fa-f]+|\d+)\b/g)].map((m) => num(m[1]));
      if (literals.length) { itemId = literals.at(-1); break; }
    }
  }
  if (itemId === null) {
    const idM = body.match(RX_ITEMID_SET);
    if (idM) itemId = num(idM[1]);
  }
  if (itemId === null) {
    const randomM = body.match(/(?:this\.)?ItemID\s*=\s*Utility\.Random\s*\(\s*(0x[0-9A-Fa-f]+|\d+)/);
    if (randomM) itemId = num(randomM[1]);
  }
  if (itemId === null) {
    const methodM = body.match(/:\s*base\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\)/);
    if (methodM) {
      const method = methodM[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const returned = body.match(new RegExp(`\\b${method}\\s*\\([^)]*\\)[\\s\\S]*?\\breturn\\s+(0x[0-9A-Fa-f]+|\\d+)\\s*;`));
      if (returned) itemId = num(returned[1]);
    }
  }
  const hueM = body.match(RX_HUE_SET);
  if (hueM) hue = num(hueM[1]);
  const nameM = body.match(RX_NAME_SET);
  const weightM = body.match(RX_WEIGHT_SET);
  if (itemId !== null && (!Number.isFinite(itemId) || itemId < 0 || itemId > 0xFFFF)) itemId = null;
  return {
    artId: itemId,
    hue: hue ?? 0,
    name: nameM?.[1] ?? null,
    weight: weightM ? Number(weightM[1]) : null,
    movable: !/(?:this\.)?Movable\s*=\s*false\s*;/.test(body),
    stackable: /(?:this\.)?Stackable\s*=\s*true\s*;/.test(body),
  };
}

function humanName(className) {
  return String(className)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

function scriptFor(className) {
  if (className === 'GreenThorns') return 'green-thorns';
  if (className === 'GreenThornsSHTeleporter') return 'green-thorns-solen-hole';
  if (className === 'GenderChangeToken') return 'gender-change-token';
  if (className === 'RaceChangeToken') return 'race-change-token';
  if (className === 'GlassblowingBook' || className === 'MasonryBook') return 'imbue-recipe-scroll';
  return null;
}

function runtimeFieldsFor(className) {
  if (className === 'GlassblowingBook') return { recipeUnlock: 'glassblowing' };
  if (className === 'MasonryBook') return { recipeUnlock: 'masonry' };
  return {};
}

function run() {
  if (!existsSync(ITEMS_DIR)) {
    console.error(`[servuo-item-types] missing ${ITEMS_DIR}`);
    process.exit(1);
  }
  /** @type {Record<string, object>} */
  const out = {};
  const descriptors = new Map();
  let scanned = 0;
  let withId = 0;
  let collisions = 0;
  for (const f of walk(ITEMS_DIR)) {
    scanned++;
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const descriptor of eachClass(src)) {
      if (descriptors.has(descriptor.className)) { collisions++; continue; }
      descriptors.set(descriptor.className, {
        ...descriptor,
        ...extractClass(descriptor.body),
        source: relative(ROOT, f).replaceAll('\\', '/'),
      });
    }
  }

  const itemMemo = new Map();
  function isItemClass(name, trail = new Set()) {
    if (ITEM_ROOTS.has(name)) return true;
    if (itemMemo.has(name)) return itemMemo.get(name);
    if (trail.has(name)) return false;
    const descriptor = descriptors.get(name);
    if (!descriptor?.baseName) return false;
    trail.add(name);
    const result = ITEM_ROOTS.has(descriptor.baseName) || isItemClass(descriptor.baseName, trail);
    itemMemo.set(name, result);
    trail.delete(name);
    return result;
  }

  const artMemo = new Map();
  function resolveArt(name, trail = new Set()) {
    if (artMemo.has(name)) return artMemo.get(name);
    if (trail.has(name)) return null;
    const descriptor = descriptors.get(name);
    if (descriptor?.artId != null) { artMemo.set(name, descriptor.artId); return descriptor.artId; }
    const base = descriptor?.baseName;
    if (!base) return null;
    trail.add(name);
    const result = resolveArt(base, trail) ?? ROOT_ART.get(base) ?? null;
    trail.delete(name);
    if (result != null) artMemo.set(name, result);
    return result;
  }

  for (const [className, descriptor] of descriptors) {
    if (descriptor.abstract || !isItemClass(className)) continue;
    const artId = resolveArt(className);
    if (artId == null || artId < 0 || artId > 0xFFFF) continue;
    withId++;
    out[className] = {
      definitionId: className,
      artId,
      name: descriptor.name ?? humanName(className),
      hue: descriptor.hue,
      script: scriptFor(className),
      base: descriptor.baseName ?? undefined,
      source: descriptor.source,
      servuoClass: className,
      ...(descriptor.weight != null ? { weight: descriptor.weight } : {}),
      ...(descriptor.movable === false ? { movable: false } : {}),
      ...(descriptor.stackable ? { stackable: true } : {}),
      ...(descriptor.artId == null ? { inheritedArt: true } : {}),
      ...runtimeFieldsFor(className),
    };
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-item-types] scanned ${scanned} files, ${descriptors.size} classes, ${withId} concrete item definitions, ${collisions} collisions`);
  console.log(`[servuo-item-types] wrote ${Object.keys(out).length} item definitions to ${OUT}`);
}

run();
