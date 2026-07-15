// Vendor commands — spawn shopkeepers that wander, greet, and sell goods.
//
// Originally a single `[vendor` command for a sample provisioner. Generalized
// to a factory: each vendor "kind" is just a name+hue+stock list, and the
// AI/buy/sell wiring is shared. Commands registered: [vendor (provisioner),
// [blacksmith, [mage, [armorer, [innkeeper.

import { normalizeSkillValue } from '../../_rules.js';
import { equipped, packItems } from '../../_inventory.js';

const GREET_RANGE   = 4;
const GREET_COOLDOWN_MS = 45_000;
const WANDER_RADIUS = 4;
const STEP_MIN_MS   = 2500;
const STEP_JITTER_MS = 2500;

const GREETINGS = [
  'Greetings, traveler.',
  'Hail, friend!',
  'Welcome to my stall.',
  'Good day to you.',
  'Come see my wares!',
];

// Wave 13: vendor session memory. Each customer accrues a history
// across visits — buys, sells, haggle outcomes — and the vendor's
// greeting tone shifts accordingly. ServUO has rudimentary "favored
// customer" hooks; we model a 4-tier ladder.
const REGULAR_GREETINGS = [
  'Welcome back, friend.',
  'Always a pleasure to see you.',
  'My best customer returns!',
  'Step right up, you know the wares.',
];
const ANNOYED_GREETINGS = [
  'Oh. It\'s you.',
  'What now?',
  'Don\'t waste my time.',
  'I have nothing more for hagglers.',
];
const COIN_FRIEND_GREETINGS = [
  'Ah, the deep-pocketed one!',
  'Come, look at the finest stock.',
  'Always good gold from your hand.',
];

/**
 * Pick a greeting tier for a customer record. Goes to "annoyed"
 * after 3+ failed haggles, "coin friend" after 5+ buys with no
 * failed haggles, "regular" after 2+ visits, generic otherwise.
 */
function greetingForHistory(h) {
  if (!h) return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  if ((h.haggleFails ?? 0) >= 3) return ANNOYED_GREETINGS[Math.floor(Math.random() * ANNOYED_GREETINGS.length)];
  if ((h.buys ?? 0) >= 5 && (h.haggleFails ?? 0) === 0) return COIN_FRIEND_GREETINGS[Math.floor(Math.random() * COIN_FRIEND_GREETINGS.length)];
  if ((h.visits ?? 0) >= 2) return REGULAR_GREETINGS[Math.floor(Math.random() * REGULAR_GREETINGS.length)];
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

// Customer-history GC tunables. Bug-hunt #2 A9: maps grew without
// bound — every player who ever bought / haggled left a perma-entry
// across save round-trips. Now bumpCustomerHistory opportunistically
// trims entries older than the retention window on each touch (cheap
// O(1) check against the Map's first iterator entry).
const CUSTOMER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const _GC_PROBE_RATE = 0.05;

/** Drop stale customer-history entries from `vendor._customerHistory`.
 *  Walks once across the Map but stops as soon as we hit a fresh entry
 *  (Maps preserve insertion order; bumpCustomerHistory does re-set on
 *  every touch so live entries float to the end). */
function gcCustomerHistory(vendor, now = Date.now()) {
  const m = vendor._customerHistory;
  if (!(m instanceof Map) || m.size === 0) return;
  for (const [key, h] of m) {
    if ((h?.lastSeen | 0) > 0 && (now - h.lastSeen) > CUSTOMER_RETENTION_MS) {
      m.delete(key);
    } else {
      // Live — Map iter order means everything after is fresher.
      break;
    }
  }
}
function gcHaggleCoupons(vendor, now = Date.now()) {
  const m = vendor._haggledBy;
  if (!(m instanceof Map) || m.size === 0) return;
  for (const [key, c] of m) {
    if ((c?.expiresAt | 0) > 0 && now > c.expiresAt) m.delete(key);
  }
}

/** Increment a customer history field on a vendor mob. */
function bumpCustomerHistory(vendor, playerSerial, field, delta = 1, deps = null) {
  vendor._customerHistory ??= new Map();
  // Opportunistic GC on 5 % of writes — keeps the map bounded over
  // long-running shards without paying the walk on every bump.
  if (Math.random() < _GC_PROBE_RATE) gcCustomerHistory(vendor);
  const h = vendor._customerHistory.get(playerSerial) ?? {};
  h[field] = (h[field] ?? 0) + delta;
  h.lastSeen = Date.now();
  // Map.set on existing key keeps insertion order; delete+set bumps to end
  // so the gcCustomerHistory early-break heuristic stays correct.
  vendor._customerHistory.delete(playerSerial);
  vendor._customerHistory.set(playerSerial, h);
  // Wave 14: honorific titles. We bump a global lifetime sales counter
  // and recompute the prestige tier; the runtime renders `name + title`
  // when present (paperdoll header + tooltip).
  if (field === 'buys') {
    vendor._lifetimeBuys = (vendor._lifetimeBuys ?? 0) + delta;
    refreshVendorTitle(vendor, deps);
  }
  return h;
}

/**
 * Wave 14: 4-tier prestige ladder driven by lifetime buy count across
 * ALL customers. Higher tiers get a noun prefix (cliched but UO-feel)
 * + a small per-tier hue shift on the body so the player sees who
 * does serious volume.
 *
 *   buys <50    → no title
 *   buys 50..   → 'Apprentice'
 *   buys 150..  → 'Skilled'
 *   buys 500..  → 'Master'
 *   buys 1500.. → 'Grandmaster'
 *
 * The kind name is used as the trade noun (provisioner → Provisioner).
 * Setter is idempotent so repeat calls don't churn the tooltip cache.
 */
/**
 * Wave 14: append a transaction record to the vendor's ring buffer.
 * Cap 50 entries (oldest evicted FIFO). Persisted across restarts via
 * MOBILE_EXT_KEYS so a GM can audit history after a server bounce.
 *
 * Wave 18: cumulative counter `_transactionCount` ticks every append.
 * Once it crosses 1000, archive the current full ring buffer to a
 * `saves/shoplog-archive-<vendorHex>-<ts>.json` file and reset the
 * counter (keep the live ring intact — only the counter rolls). This
 * gives shard managers a long-term audit trail without bloating the
 * world.json runtime save with a multi-thousand-entry log per vendor.
 */
function appendTransaction(vendor, entry, deps = null) {
  vendor._transactionLog ??= [];
  vendor._transactionLog.push(entry);
  if (vendor._transactionLog.length > 50) vendor._transactionLog.shift();
  vendor._transactionCount = (vendor._transactionCount ?? 0) + 1;
  if (vendor._transactionCount >= 1000) {
    archiveTransactionLog(vendor, deps).catch((e) => {
      console.warn('[vendor] auto-archive failed:', e.message);
    });
    vendor._transactionCount = 0;
  }
}

/**
 * Async write the vendor's ring buffer to disk. Runs off the event
 * loop so a hot vendor doesn't stall on the file system. Uses fs/promises.
 */
async function archiveTransactionLog(vendor, deps = null) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const saveDir = deps?.persistence?.saveDir
               ?? deps?.saveDir
               ?? path.resolve(process.cwd(), 'saves');
  const fname = `shoplog-archive-${(vendor.serial >>> 0).toString(16)}-${Date.now()}.json`;
  const target = path.join(saveDir, fname);
  const payload = {
    vendor: {
      serial: vendor.serial >>> 0, name: vendor.name, kind: vendor.vendorKind,
      title: vendor.title, lifetimeBuys: vendor._lifetimeBuys ?? 0,
    },
    archivedAt: new Date().toISOString(),
    transactionCount: vendor._transactionLog?.length ?? 0,
    transactions: [...(vendor._transactionLog ?? [])],
  };
  await fs.promises.mkdir(saveDir, { recursive: true });
  await fs.promises.writeFile(target, JSON.stringify(payload, null, 2));
  console.log(`[vendor] auto-archived ${vendor.name}'s shoplog to ${target}`);
}

// Wave 15: per-tier hue accent. Top-tier vendors carry a faint colour
// shift on top of their baseline body hue so a busy market stall is
// visually parseable at a glance — "the gold-tinged one is a master".
// We snapshot the original hue once into `_originalHue` so titles can
// be revoked back to baseline cleanly.
const TIER_HUE_DELTA = {
  Apprentice:  0x21E,    // soft cream
  Skilled:     0x044E,   // turquoise
  Master:      0x481,    // pale yellow / gold
  Grandmaster: 0x47E,    // bronze-gold
};

function refreshVendorTitle(vendor, deps = null) {
  // Wave 26: GM-set custom title takes precedence over auto-tier.
  // We still bump tier-hue + obituary triggers so prestige mechanics
  // run, but the displayed title stays the GM string. Setting
  // `_customTitle` to `null` reverts to auto.
  if (vendor._customTitle) {
    if (vendor.title !== vendor._customTitle) vendor.title = vendor._customTitle;
    return;
  }
  const lt = vendor._lifetimeBuys ?? 0;
  let tier = null;
  if (lt >= 1500)      tier = 'Grandmaster';
  else if (lt >= 500)  tier = 'Master';
  else if (lt >= 150)  tier = 'Skilled';
  else if (lt >= 50)   tier = 'Apprentice';
  const trade = (vendor.vendorKind ?? 'Trader').replace(/^./, (c) => c.toUpperCase());
  const wantTitle = tier ? `the ${tier} ${trade}` : null;
  if (vendor.title === wantTitle) return;
  // Wave 17: vendor obituary. When a Master+ tier vendor decays back
  // below Apprentice (50 lifetime buys) — i.e. drops out of the
  // honorific ladder entirely — broadcast a world line so the player
  // base notices their veterans retiring. Promotion deltas use the
  // existing greeting machinery, no fanfare needed.
  const prevTier = vendor.title?.match(/the (\w+) /)?.[1] ?? null;
  if (prevTier && (prevTier === 'Master' || prevTier === 'Grandmaster') && tier === null) {
    const protocol = deps?.protocol;
    const world = deps?.world;
    if (protocol?.unicodeMessage) {
      const obit = `${vendor.name} has retired from active trade after a long career.`;
      for (const m of allMobiles({ world })) {
        if (m.client) m.client.sendSystemMessage?.(obit);
      }
    }
  }
  vendor.title = wantTitle;

  // Apply the tier hue. Snapshot the baseline once on first promotion.
  if (vendor._originalHue == null) vendor._originalHue = vendor.hue ?? 0;
  // Wave 28: `_customTitleHue` (set via [vendortitle <kind> ... #hue)
  // overrides auto-tier color. Lets GMs paint event vendors a unique
  // hue regardless of their lifetimeBuys tier.
  const wantHue = vendor._customTitleHue != null
    ? vendor._customTitleHue
    : (tier ? (TIER_HUE_DELTA[tier] ?? vendor._originalHue) : vendor._originalHue);
  if (vendor.hue !== wantHue) {
    vendor.hue = wantHue;
    // Tell every client about the visual change. mobileIncoming
    // refreshes hue + name on the entity (same pattern as spawn).
    const protocol = deps?.protocol;
    const world = deps?.world;
    if (protocol?.mobileIncoming) {
      const pkt = protocol.mobileIncoming({
        serial: vendor.serial, body: vendor.body,
        x: vendor.x, y: vendor.y, z: vendor.z,
        direction: vendor.direction, hue: vendor.hue,
        flags: vendor.flags, notoriety: 1,
      });
      for (const m of allMobiles({ world })) {
        if (!m.client || m.map !== vendor.map) continue;
        if (Math.abs(m.x - vendor.x) > 18 || Math.abs(m.y - vendor.y) > 18) continue;
        m.client.send(pkt);
      }
    }
  }
}

function distanceTo(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function findNearbyPlayer(world, npc) {
  let best = null;
  let bestD = Infinity;
  for (const other of allMobiles({ world })) {
    if (!other.client) continue;
    if (other.map !== npc.map) continue;
    if (other.ghost) continue;
    const d = distanceTo(npc, other);
    if (d > GREET_RANGE) continue;
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

// Wave-7 follow-up: pull extracted SBInfo data and merge it as fallback
// vendor kinds. Each SBInfo gives us an itemized buy list with real
// itemIds (4th arg of GenericBuyInfo). We can't recover the canonical
// name+body+hue per kind from the .cs source, so the extracted vendors
// get a sensible default appearance keyed by the kind name (e.g.
// `blacksmith` re-uses the existing hardcoded body, others fall through
// to a generic male provisioner). The data is read at module-load time
// from `apps/scripts/src/data/config/vendor-inventory.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allMobiles, allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';
import { resolveStandingZ } from '../../_movement.js';
import { createMobile } from '../../_mobiles.js';
const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
function loadExtractedVendorInventory() {
  const file = path.join(__HERE, '..', 'data', 'vendor-inventory.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

const EXTRACTED_VENDOR_DEFAULTS = {
  // key → { name template, body, hue }. Anything we don't list here
  // falls through to the generic provisioner shape.
  alchemist:      { name: 'Apothecary Lyra', body: 0x0191, hue: 0x0455 },
  animaltrainer:  { name: 'Trainer Boran',   body: 0x0190, hue: 0x044E },
  architect:      { name: 'Architect Pell',  body: 0x0190, hue: 0x03E2 },
  axeweapon:      { name: 'Axemaker Hod',    body: 0x0190, hue: 0x03E2 },
  baker:          { name: 'Baker Berta',     body: 0x0191, hue: 0x021E },
  banker:         { name: 'Banker Dolan',    body: 0x0190, hue: 0x044E },
  bard:           { name: 'Bard Tavin',      body: 0x0190, hue: 0x021E },
  barkeeper:      { name: 'Innkeeper Otto',  body: 0x0190, hue: 0x021E },
  beekeeper:      { name: 'Beekeeper Ina',   body: 0x0191, hue: 0x021E },
  blacksmith:     { name: 'Smith Gareth',    body: 0x0190, hue: 0x03E2 },
  bowyer:         { name: 'Fletcher Roan',   body: 0x0190, hue: 0x021E },
  butcher:        { name: 'Butcher Karl',    body: 0x0190, hue: 0x021E },
  carpenter:      { name: 'Carpenter Doran', body: 0x0190, hue: 0x021E },
  chainmailarmor: { name: 'Mailmaker Hild',  body: 0x0191, hue: 0x03E2 },
  cobbler:        { name: 'Cobbler Tess',    body: 0x0191, hue: 0x021E },
  cook:           { name: 'Cook Mira',       body: 0x0191, hue: 0x021E },
  farmer:         { name: 'Farmer Ben',      body: 0x0190, hue: 0x021E },
  fisherman:      { name: 'Fisher Otho',     body: 0x0190, hue: 0x021E },
  fortuneteller:  { name: 'Madame Vela',     body: 0x0191, hue: 0x0481 },
  furtrader:      { name: 'Furrier Dax',     body: 0x0190, hue: 0x044E },
  gardener:       { name: 'Gardener Lia',    body: 0x0191, hue: 0x021E },
  glassblower:    { name: 'Glassman Hess',   body: 0x0190, hue: 0x044E },
  hairstylist:    { name: 'Stylist Pen',     body: 0x0191, hue: 0x044E },
  healer:         { name: 'Healer Rian',     body: 0x0191, hue: 0x0481 },
  innkeeper:      { name: 'Innkeeper Otto',  body: 0x0190, hue: 0x021E },
  // … all others fall through to the generic provisioner shape.
};

// Vendor catalog. Each kind defines the NPC name + body + hue and a stock
// table. itemIds use real UO art so the buy window shows recognisable goods.
export const VENDOR_KINDS = {
  // Generic ambient villager — no shop, just stands around. Used as the
  // fallback target by spawnAt's ALIAS map when regional-npcs.json
  // points at a flavor archetype (paladin, monk, miner, ranger, bard)
  // without a real storefront. Body is randomized male/female by the
  // pos.body override in spawnAt callers; default is male.
  wanderer: {
    name: 'a wanderer', body: 0x0190, hue: 0x83EA, stock: [],
  },
  provisioner: {
    name: 'Jacob the Provisioner',
    body: 0x0190, hue: 0x83EA,
    stock: [
      { itemId: 0x1F4D, name: 'scroll of magic',   price: 45 },
      { itemId: 0x1766, name: 'bolt of cloth',     price: 18 },
      { itemId: 0x1766, hue: 0x21, name: 'red cloth', price: 22 },
      { itemId: 0x097D, name: 'loaf of bread',     price: 3 },
      { itemId: 0x099F, name: 'jug of ale',        price: 8 },
      { itemId: 0x1822, name: 'bandage',           price: 2 },
    ],
  },
  blacksmith: {
    name: 'Gareth the Blacksmith',
    body: 0x0190, hue: 0x03E2,
    stock: [
      { itemId: 0x13B6, name: 'longsword',     price: 80 },
      { itemId: 0x13FF, name: 'katana',        price: 75 },
      { itemId: 0x143E, name: 'halberd',       price: 90 },
      { itemId: 0x1B72, name: 'wooden shield', price: 12 },
      { itemId: 0x1B76, name: 'heater shield', price: 60 },
      { itemId: 0x1408, name: 'plate chest',   price: 220 },
      { itemId: 0x1410, name: 'plate arms',    price: 110 },
      { itemId: 0x140E, name: 'plate helm',    price: 90 },
      { itemId: 0x1413, name: 'plate gloves',  price: 80 },
    ],
  },
  mage: {
    name: 'Mira the Mage',
    body: 0x0191, hue: 0x0455,
    stock: [
      { itemId: 0x0F7A, name: 'black pearl',    price: 5 },
      { itemId: 0x0F7B, name: 'blood moss',     price: 5 },
      { itemId: 0x0F84, name: 'garlic',         price: 3 },
      { itemId: 0x0F85, name: 'ginseng',        price: 3 },
      { itemId: 0x0F86, name: 'mandrake root',  price: 6 },
      { itemId: 0x0F88, name: 'nightshade',     price: 5 },
      { itemId: 0x0F8C, name: 'spider silk',    price: 4 },
      { itemId: 0x0F8D, name: 'sulfurous ash',  price: 4 },
      { itemId: 0x0EFA, name: 'spellbook',      price: 175 },
      { itemId: 0x1F4D, name: 'scroll',         price: 45 },
    ],
  },
  armorer: {
    name: 'Thordan the Armorer',
    body: 0x0190, hue: 0x025F,
    stock: [
      { itemId: 0x13EE, name: 'studded chest',   price: 150 },
      { itemId: 0x13DC, name: 'studded sleeves', price: 70 },
      { itemId: 0x13D5, name: 'studded gloves',  price: 50 },
      { itemId: 0x13F0, name: 'leather chest',   price: 60 },
      { itemId: 0x13CD, name: 'leather sleeves', price: 35 },
      { itemId: 0x13C6, name: 'leather gloves',  price: 25 },
      { itemId: 0x1B7B, name: 'kite shield',     price: 80 },
    ],
  },
  innkeeper: {
    name: 'Margaret the Innkeeper',
    body: 0x0191, hue: 0x0353,
    stock: [
      { itemId: 0x097D, name: 'loaf of bread',  price: 3 },
      { itemId: 0x099F, name: 'jug of ale',     price: 8 },
      { itemId: 0x09EA, name: 'bottle of wine', price: 12 },
      { itemId: 0x09B7, name: 'cooked bird',    price: 7 },
      { itemId: 0x09B5, name: 'wedge of cheese', price: 5 },
      { itemId: 0x09EB, name: 'pitcher of milk', price: 4 },
      { itemId: 0x097E, name: 'loaf of bread',  price: 3 },
    ],
  },
  // Vendor classes ported from ServUO Mobiles/Vendors/NPC/. Each adds an
  // [keyword spawn shortcut and a focused stock list. Hues match the
  // canonical ServUO outfits where I could find them in `EquipNotedItem`
  // overrides; otherwise plain mortal hues are used.
  bowyer: {
    name: 'Robin the Bowyer',
    body: 0x0190, hue: 0x0436,
    stock: [
      { itemId: 0x13B2, name: 'bow',                 price: 95 },
      { itemId: 0x13FD, name: 'heavy crossbow',      price: 110 },
      { itemId: 0x0F50, name: 'crossbow',            price: 80 },
      { itemId: 0x1BFB, name: 'crossbow bolt',       price: 4, amount: 50 },
      { itemId: 0x0F3F, name: 'arrow',               price: 2, amount: 50 },
      { itemId: 0x1BD7, name: 'board',               price: 4 },
      { itemId: 0x1BD4, name: 'wooden shaft',        price: 3 },
    ],
  },
  baker: {
    name: 'Hank the Baker',
    body: 0x0190, hue: 0x0578,
    stock: [
      { itemId: 0x097D, name: 'loaf of bread',       price: 3 },
      { itemId: 0x103B, name: 'baked goods',         price: 5 },
      { itemId: 0x103D, name: 'pie',                 price: 8 },
      { itemId: 0x1041, name: 'cake',                price: 12 },
      { itemId: 0x09F1, name: 'sliced bread',        price: 3 },
      { itemId: 0x099D, name: 'cookies',             price: 4 },
    ],
  },
  butcher: {
    name: 'Brian the Butcher',
    body: 0x0190, hue: 0x83F8,
    stock: [
      { itemId: 0x09F1, name: 'cut of ribs',         price: 7 },
      { itemId: 0x09F2, name: 'lamb leg',            price: 9 },
      { itemId: 0x1605, name: 'leg of mutton',       price: 8 },
      { itemId: 0x1607, name: 'pig\'s head',         price: 12 },
      { itemId: 0x09B7, name: 'cooked bird',         price: 7 },
      { itemId: 0x097B, name: 'fish steak',          price: 5 },
    ],
  },
  animal_trainer: {
    name: 'Sela the Animal Trainer',
    body: 0x0191, hue: 0x03DA,
    stock: [
      { itemId: 0x0E20, name: 'shepherd\'s crook',   price: 35 },
      { itemId: 0x0F66, name: 'bandage',             price: 5, amount: 25 },
      { itemId: 0x0E81, name: 'leash',               price: 12 },
      { itemId: 0x09EA, name: 'bottle of training oil', price: 30 },
      { itemId: 0x14F0, name: 'pet stable deed',     price: 1500 },
      { itemId: 0x1F1C, name: 'fish steak',          price: 4, amount: 20 },
    ],
  },
  healer: {
    name: 'Avery the Healer',
    body: 0x0190, hue: 0x0432,
    stock: [
      { itemId: 0x0E21, name: 'bandage',             price: 4, amount: 20 },
      { itemId: 0x0F0B, name: 'lesser cure potion',  price: 18 },
      { itemId: 0x0F0C, name: 'cure potion',         price: 35 },
      { itemId: 0x0F0F, name: 'lesser heal potion',  price: 25 },
      { itemId: 0x0F0E, name: 'heal potion',         price: 50 },
      { itemId: 0x0F12, name: 'greater heal potion', price: 80 },
      { itemId: 0x0F08, name: 'refresh potion',      price: 12 },
      // ServUO `SBHealer` carries the eight Magery reagents so the
      // healer can self-cast Cure / Greater Heal and Pally / Necro
      // adventurers can resupply before pushing back into a dungeon.
      { itemId: 0x0F7A, name: 'black pearl',         price: 3, amount: 50 },
      { itemId: 0x0F7B, name: 'blood moss',          price: 3, amount: 50 },
      { itemId: 0x0F84, name: 'garlic',              price: 3, amount: 50 },
      { itemId: 0x0F85, name: 'ginseng',             price: 3, amount: 50 },
      { itemId: 0x0F86, name: 'mandrake root',       price: 3, amount: 50 },
      { itemId: 0x0F88, name: 'nightshade',          price: 3, amount: 50 },
      { itemId: 0x0F8D, name: 'spider silk',         price: 3, amount: 50 },
      { itemId: 0x0F8C, name: 'sulfurous ash',       price: 3, amount: 50 },
    ],
  },
  scribe: {
    name: 'Thomas the Scribe',
    body: 0x0190, hue: 0x041C,
    stock: [
      { itemId: 0x0FBB, name: 'scribe pen',          price: 6 },
      { itemId: 0x0FBC, name: 'blank scroll',        price: 5, amount: 50 },
      { itemId: 0x0FF1, name: 'book',                price: 18 },
      { itemId: 0x0EFB, name: 'recall scroll',       price: 65 },
      { itemId: 0x0EFC, name: 'gate travel scroll',  price: 95 },
      { itemId: 0x0EFA, name: 'spellbook',           price: 175 },
    ],
  },
  alchemist: {
    name: 'Veronica the Alchemist',
    body: 0x0191, hue: 0x0490,
    stock: [
      { itemId: 0x0E9B, name: 'mortar and pestle',   price: 28 },
      { itemId: 0x0F0C, name: 'heal potion',         price: 50 },
      { itemId: 0x0F08, name: 'agility potion',      price: 38 },
      { itemId: 0x0F0B, name: 'refresh potion',      price: 12 },
      { itemId: 0x0F09, name: 'strength potion',     price: 38 },
      { itemId: 0x0F07, name: 'cure potion',         price: 35 },
      { itemId: 0x0F0A, name: 'poison potion',       price: 62 },
      { itemId: 0x0F0C, name: 'lesser heal potion',  price: 25 },
      { itemId: 0x0F86, name: 'mandrake root',       price: 6 },
      { itemId: 0x0F88, name: 'nightshade',          price: 5 },
    ],
  },
  tinker: {
    name: 'Ron the Tinker',
    body: 0x0190, hue: 0x07AA,
    stock: [
      { itemId: 0x1EB8, name: 'tinker tools',        price: 35 },
      { itemId: 0x1054, name: 'iron ingot',          price: 4, amount: 50 },
      { itemId: 0x1BDD, name: 'iron wire',           price: 3 },
      { itemId: 0x1086, name: 'gold ring',           price: 65 },
      { itemId: 0x108A, name: 'silver ring',         price: 52 },
      { itemId: 0x1F14, name: 'lockpick',            price: 20, amount: 5 },
      { itemId: 0x1051, name: 'sextant',             price: 18 },
    ],
  },
  jeweler: {
    name: 'Cassia the Jeweler',
    body: 0x0191, hue: 0x05F2,
    stock: [
      { itemId: 0x1EA3, name: 'gold ring',           price: 95 },
      { itemId: 0x1F09, name: 'sapphire',            price: 220 },
      { itemId: 0x1F0F, name: 'ruby',                price: 240 },
      { itemId: 0x1F13, name: 'emerald',             price: 220 },
      { itemId: 0x1F1A, name: 'diamond',             price: 380 },
      { itemId: 0x1086, name: 'gold ring',           price: 75 },
      { itemId: 0x1F06, name: 'tourmaline',          price: 85 },
    ],
  },

  // ServUO Mobiles/Vendors/NPC/ — additional canonical vendors (each is
  // its own .cs file in ServUO with hand-picked stock). Adding here so
  // [vendor <kind> spawns them with branded merchandise without waiting
  // for the extracted SBInfo fallback.
  weaver: {
    name: 'Mira the Weaver',
    body: 0x0191, hue: 0x0530,
    stock: [
      { itemId: 0x1779, name: 'spool of thread', price: 4 },
      { itemId: 0x1766, name: 'bolt of cloth',   price: 18 },
      { itemId: 0x1518, name: 'shirt',           price: 30 },
      { itemId: 0x1535, name: 'long pants',      price: 25 },
    ],
  },
  cobbler: {
    name: 'Stephen the Cobbler',
    body: 0x0190, hue: 0x0440,
    stock: [
      { itemId: 0x170B, name: 'shoes',           price: 14 },
      { itemId: 0x170D, name: 'boots',           price: 22 },
      { itemId: 0x170F, name: 'sandals',         price: 8 },
      { itemId: 0x170B, hue: 0x21, name: 'leather sandals', price: 16 },
    ],
  },
  tailor: {
    name: 'Eleanor the Tailor',
    body: 0x0191, hue: 0x0395,
    stock: [
      { itemId: 0x152E, name: 'long pants',      price: 24 },
      { itemId: 0x1517, name: 'shirt',           price: 30 },
      { itemId: 0x1F03, name: 'robe',            price: 70 },
      { itemId: 0x1B73, name: 'doublet',         price: 32 },
      { itemId: 0x1539, name: 'half apron',      price: 18 },
    ],
  },
  fisherman: {
    name: 'Goran the Fisherman',
    body: 0x0190, hue: 0x067D,
    stock: [
      { itemId: 0x0DBF, name: 'fishing pole',    price: 30 },
      { itemId: 0x097D, name: 'bait',            price: 1 },
      { itemId: 0x09CC, name: 'fish steaks',     price: 6 },
      { itemId: 0x9CC,  name: 'raw fish',        price: 4 },
    ],
  },
  carpenter: {
    name: 'Branwen the Carpenter',
    body: 0x0191, hue: 0x0410,
    stock: [
      { itemId: 0x1BD7, name: 'board',           price: 4 },
      { itemId: 0x1034, name: 'log',             price: 3 },
      { itemId: 0x1030, name: 'small crate',     price: 12 },
      { itemId: 0x1102, name: 'hammer',          price: 8 },
    ],
  },
  mason: {
    name: 'Cael the Mason',
    body: 0x0190, hue: 0x047D,
    stock: [
      { itemId: 0x12B3, name: 'mason hammer',    price: 10 },
      { itemId: 0x09EC, name: 'cobblestone',     price: 4 },
      { itemId: 0x4076, name: 'sculpting stone', price: 60 },
    ],
  },
  glassblower: {
    name: 'Theo the Glassblower',
    body: 0x0190, hue: 0x047E,
    stock: [
      { itemId: 0x10E5, name: 'sand',            price: 3 },
      { itemId: 0x1843, name: 'small bottle',    price: 4 },
      { itemId: 0x4079, name: 'blowpipe',        price: 30 },
      { itemId: 0x4083, name: 'glass cup',       price: 6 },
    ],
  },
  scholar: {
    name: 'Aric the Scholar',
    body: 0x0190, hue: 0x0481,
    stock: [
      { itemId: 0x0FF1, name: 'book',            price: 5 },
      { itemId: 0x0FBE, name: 'quill',           price: 2 },
      { itemId: 0x0FF0, name: 'scribe pen',      price: 10 },
      { itemId: 0x1F4D, name: 'blank scroll',    price: 8 },
    ],
  },
  cartographer: {
    name: 'Dorin the Cartographer',
    body: 0x0190, hue: 0x0481,
    stock: [
      { itemId: 0x14EB, name: 'blank map',       price: 14 },
      { itemId: 0x14EC, name: 'sextant',         price: 80 },
      { itemId: 0x14EC, hue: 0x150, name: 'navigation chart', price: 220 },
    ],
  },
  banker: {
    name: 'Quinn the Banker',
    body: 0x0190, hue: 0x025F,
    stock: [],   // Bankers don't sell — their dialog opens the vault.
  },
  herbalist: {
    name: 'Selina the Herbalist',
    body: 0x0191, hue: 0x008B,
    stock: [
      { itemId: 0x1727, name: 'mushroom',        price: 4 },
      { itemId: 0x171A, name: 'wood chips',      price: 3 },
      { itemId: 0x1A99, name: 'flax',            price: 5 },
      { itemId: 0x10E5, name: 'salt',            price: 6 },
    ],
  },
  pet_trainer: {
    name: 'Aldric the Animal Trainer',
    body: 0x0190, hue: 0x044F,
    stock: [],
  },
  shipwright: {
    name: 'Ezra the Shipwright',
    body: 0x0190, hue: 0x067D,
    stock: [
      { itemId: 0x14F4, name: 'small ship plans',  price: 4500 },
      { itemId: 0x14F5, name: 'medium ship plans', price: 6500 },
      { itemId: 0x14F6, name: 'large ship plans',  price: 8500 },
    ],
  },
  stable_master: {
    name: 'Bronson the Stable Master',
    body: 0x0190, hue: 0x044F,
    stock: [
      { itemId: 0x1059, name: 'pet feed',          price: 3 },
      { itemId: 0x1F4D, name: 'pet leash',         price: 12 },
    ],
    // ServUO `AnimalTrainer.OnSpeech` opens the stable gump on the
    // keyword "stable". Surfaced as a sentinel system message which
    // the client's game-scene re-emits as `ui:stable:open`.
    speech: { stable: '[stable gump' },
  },
  furtrader: {
    name: 'Nadya the Fur Trader',
    body: 0x0191, hue: 0x048C,
    stock: [
      { itemId: 0x1078, name: 'cured hide',         price: 12 },
      { itemId: 0x1079, name: 'spined leather',     price: 35 },
      { itemId: 0x107A, name: 'horned leather',     price: 60 },
      { itemId: 0x107B, name: 'barbed leather',     price: 95 },
    ],
  },
  arms_dealer: {
    name: 'Vincent the Arms Dealer',
    body: 0x0190, hue: 0x025F,
    stock: [
      { itemId: 0x0F50, name: 'crossbow',           price: 80 },
      { itemId: 0x0F62, name: 'spear',              price: 60 },
      { itemId: 0x143E, name: 'halberd',            price: 90 },
      { itemId: 0x1B7A, name: 'wooden shield',      price: 12 },
    ],
  },
  potion_seller: {
    name: 'Marcus the Potion Seller',
    body: 0x0190, hue: 0x047D,
    stock: [
      { itemId: 0x0F09, name: 'lesser heal potion',  price: 18 },
      { itemId: 0x0F0C, name: 'greater heal potion', price: 60 },
      { itemId: 0x0F0B, name: 'cure potion',         price: 22 },
      { itemId: 0x0F0E, name: 'refresh potion',      price: 18 },
      { itemId: 0x0F0D, name: 'explosion potion',    price: 38 },
    ],
  },
  gargish_armorer: {
    name: 'Korbar the Gargish Armorer',
    body: 0x29A,            // gargoyle female body
    hue: 0x88E,
    stock: [
      { itemId: 0x4D6E, name: 'gargish stone arms',   price: 220 },
      { itemId: 0x4D6F, name: 'gargish plate chest',  price: 320 },
      { itemId: 0x48B0, name: 'gargish cyclone',      price: 140 },
    ],
  },
  taxidermist: {
    name: 'Ulric the Taxidermist',
    body: 0x0190, hue: 0x048C,
    stock: [
      { itemId: 0x1E0F, name: 'leather',              price: 5 },
      { itemId: 0x1F03, name: 'mounted head',         price: 320 },
    ],
  },
  thief_guild: {
    name: 'Kross the Fence',
    body: 0x0190, hue: 0x047E,
    stock: [
      { itemId: 0x1690, name: 'lockpicks',            price: 12 },
      { itemId: 0x14F0, name: 'forged signet ring',   price: 80 },
    ],
  },
  // Faza H.1.12 — Faction-specific Reagent Merchants.
  // Each stronghold (Britain Castle / Magincia / Yew / Trinsic for the
  // four factions) hosts a dedicated reagent vendor with a curated
  // Magery + Necromancy reagent bundle. Faction members get a 20%
  // discount applied at purchase time (vendor.faction === buyer.faction).
  faction_reagent_britannia: {
    name: 'Quinlin of the True Britannians', faction: 'true-britannians',
    body: 0x0190, hue: 0x0481,
    stock: [
      { itemId: 0x0F7A, name: 'black pearl',     price: 4, amount: 100 },
      { itemId: 0x0F7B, name: 'blood moss',      price: 4, amount: 100 },
      { itemId: 0x0F84, name: 'garlic',          price: 2, amount: 100 },
      { itemId: 0x0F85, name: 'ginseng',         price: 2, amount: 100 },
      { itemId: 0x0F86, name: 'mandrake root',   price: 5, amount: 100 },
      { itemId: 0x0F88, name: 'nightshade',      price: 4, amount: 100 },
      { itemId: 0x0F8C, name: 'spider silk',     price: 3, amount: 100 },
      { itemId: 0x0F8D, name: 'sulfurous ash',   price: 3, amount: 100 },
    ],
  },
  faction_reagent_minax: {
    name: 'Saerys of Minax', faction: 'minax',
    body: 0x0191, hue: 0x0021,
    stock: [
      { itemId: 0x0F7A, name: 'black pearl',     price: 4, amount: 100 },
      { itemId: 0x0F7B, name: 'blood moss',      price: 4, amount: 100 },
      { itemId: 0x0F84, name: 'garlic',          price: 2, amount: 100 },
      { itemId: 0x0F85, name: 'ginseng',         price: 2, amount: 100 },
      { itemId: 0x0F86, name: 'mandrake root',   price: 5, amount: 100 },
      { itemId: 0x0F88, name: 'nightshade',      price: 4, amount: 100 },
      { itemId: 0x0F8C, name: 'spider silk',     price: 3, amount: 100 },
      { itemId: 0x0F8D, name: 'sulfurous ash',   price: 3, amount: 100 },
    ],
  },
  faction_reagent_shadowlords: {
    name: 'Vexar of the Shadowlords', faction: 'shadowlords',
    body: 0x0190, hue: 0x0966,
    stock: [
      { itemId: 0x0F7A, name: 'black pearl',     price: 4, amount: 100 },
      { itemId: 0x0F7B, name: 'blood moss',      price: 4, amount: 100 },
      { itemId: 0x0F84, name: 'garlic',          price: 2, amount: 100 },
      { itemId: 0x0F85, name: 'ginseng',         price: 2, amount: 100 },
      { itemId: 0x0F86, name: 'mandrake root',   price: 5, amount: 100 },
      { itemId: 0x0F88, name: 'nightshade',      price: 4, amount: 100 },
      { itemId: 0x0F8C, name: 'spider silk',     price: 3, amount: 100 },
      { itemId: 0x0F8D, name: 'sulfurous ash',   price: 3, amount: 100 },
    ],
  },
  faction_reagent_council: {
    name: 'Ardael of the Council of Mages', faction: 'council-of-mages',
    body: 0x0190, hue: 0x0455,
    stock: [
      { itemId: 0x0F7A, name: 'black pearl',     price: 4, amount: 100 },
      { itemId: 0x0F7B, name: 'blood moss',      price: 4, amount: 100 },
      { itemId: 0x0F84, name: 'garlic',          price: 2, amount: 100 },
      { itemId: 0x0F85, name: 'ginseng',         price: 2, amount: 100 },
      { itemId: 0x0F86, name: 'mandrake root',   price: 5, amount: 100 },
      { itemId: 0x0F88, name: 'nightshade',      price: 4, amount: 100 },
      { itemId: 0x0F8C, name: 'spider silk',     price: 3, amount: 100 },
      { itemId: 0x0F8D, name: 'sulfurous ash',   price: 3, amount: 100 },
    ],
  },
  // Necromancy reagent merchants (same 4 factions). ServUO splits
  // these into separate NPCs (a SBNecroReagent vs SBMageReagent),
  // matching the spell-school split.
  faction_necro_britannia: {
    name: 'Mordris of Britannia', faction: 'true-britannians',
    body: 0x0190, hue: 0x0497,
    stock: [
      { itemId: 0x0F8F, name: 'bat wing',        price: 4, amount: 100 },
      { itemId: 0x0F8E, name: 'grave dust',      price: 4, amount: 100 },
      { itemId: 0x0F7D, name: 'daemon blood',    price: 5, amount: 100 },
      { itemId: 0x0F8A, name: 'nox crystal',     price: 5, amount: 100 },
      { itemId: 0x0F8B, name: 'pig iron',        price: 4, amount: 100 },
      { itemId: 0x0F7E, name: 'daemon bone',     price: 5, amount: 100 },
    ],
  },
  faction_necro_minax: {
    name: 'Vendrick of Minax', faction: 'minax',
    body: 0x0190, hue: 0x0021,
    stock: [
      { itemId: 0x0F8F, name: 'bat wing',        price: 4, amount: 100 },
      { itemId: 0x0F8E, name: 'grave dust',      price: 4, amount: 100 },
      { itemId: 0x0F7D, name: 'daemon blood',    price: 5, amount: 100 },
      { itemId: 0x0F8A, name: 'nox crystal',     price: 5, amount: 100 },
      { itemId: 0x0F8B, name: 'pig iron',        price: 4, amount: 100 },
      { itemId: 0x0F7E, name: 'daemon bone',     price: 5, amount: 100 },
    ],
  },
  faction_necro_shadowlords: {
    name: 'Thalga of the Shadowlords', faction: 'shadowlords',
    body: 0x0191, hue: 0x0455,
    stock: [
      { itemId: 0x0F8F, name: 'bat wing',        price: 4, amount: 100 },
      { itemId: 0x0F8E, name: 'grave dust',      price: 4, amount: 100 },
      { itemId: 0x0F7D, name: 'daemon blood',    price: 5, amount: 100 },
      { itemId: 0x0F8A, name: 'nox crystal',     price: 5, amount: 100 },
      { itemId: 0x0F8B, name: 'pig iron',        price: 4, amount: 100 },
      { itemId: 0x0F7E, name: 'daemon bone',     price: 5, amount: 100 },
    ],
  },
  faction_necro_council: {
    name: 'Ilyana of the Council of Mages', faction: 'council-of-mages',
    body: 0x0191, hue: 0x0488,
    stock: [
      { itemId: 0x0F8F, name: 'bat wing',        price: 4, amount: 100 },
      { itemId: 0x0F8E, name: 'grave dust',      price: 4, amount: 100 },
      { itemId: 0x0F7D, name: 'daemon blood',    price: 5, amount: 100 },
      { itemId: 0x0F8A, name: 'nox crystal',     price: 5, amount: 100 },
      { itemId: 0x0F8B, name: 'pig iron',        price: 4, amount: 100 },
      { itemId: 0x0F7E, name: 'daemon bone',     price: 5, amount: 100 },
    ],
  },
};

/**
 * BUGFIX #134 (FAZA IF) + civic-NPC fix 2026-05-10: vendors spawned
 * naked unless the operator typed `[<kind>` from a player mobile.
 * Civic-npcs.js calls api.vendors.spawnAt(...) which originally
 * skipped the outfit step entirely — every banker, healer, and
 * trainer in town was a bald nude human. Lifted out of spawnVendor
 * so both spawn paths share one outfit table.
 *
 * Per-kind dress matches the ServUO `*Vendor.cs` `InitOutfit` palette
 * (hue + slot). Unknown kinds fall through to the "provisioner"
 * shopkeeper baseline so a freshly-extracted vendor type at least
 * shows up clothed.
 */
const VENDOR_OUTFITS = {
  provisioner: [
    { itemId: 0x1517, layer: 5, hue: 904 },     // shirt
    { itemId: 0x152E, layer: 4, hue: 954 },     // long pants
    { itemId: 0x170B, layer: 3 },               // shoes
  ],
  banker: [
    { itemId: 0x1F03, layer: 22, hue: 53 },     // robe (gold-trim)
    { itemId: 0x170B, layer: 3, hue: 53 },      // shoes
    { itemId: 0x1716, layer: 6, hue: 53 },      // skullcap
  ],
  healer: [
    { itemId: 0x1F03, layer: 22, hue: 56 },     // robe (white)
    { itemId: 0x170B, layer: 3, hue: 56 },
  ],
  animal_trainer: [
    { itemId: 0x1517, layer: 5, hue: 1109 },    // shirt (brown)
    { itemId: 0x152E, layer: 4, hue: 1109 },
    { itemId: 0x170D, layer: 3 },               // boots
    { itemId: 0x152C, layer: 20, hue: 1109 },   // cloak
  ],
  blacksmith: [
    { itemId: 0x1517, layer: 5, hue: 904 },
    { itemId: 0x152E, layer: 4, hue: 1110 },
    { itemId: 0x170D, layer: 3 },
    { itemId: 0x153B, layer: 22, hue: 1107 },   // apron
  ],
  mage: [
    { itemId: 0x1F03, layer: 22, hue: 38 },     // robe (purple)
    { itemId: 0x170B, layer: 3, hue: 38 },
    { itemId: 0x1718, layer: 6, hue: 38 },      // wizard hat
  ],
  armorer: [
    { itemId: 0x152C, layer: 20, hue: 33 },     // cloak
    { itemId: 0x152E, layer: 4, hue: 1110 },
    { itemId: 0x170D, layer: 3 },
  ],
  innkeeper: [
    { itemId: 0x1517, layer: 5, hue: 1153 },
    { itemId: 0x152E, layer: 4, hue: 1107 },
    { itemId: 0x170B, layer: 3, hue: 1107 },
    { itemId: 0x1539, layer: 12, hue: 1153 },   // half apron
  ],
  barkeeper: [
    { itemId: 0x1517, layer: 5, hue: 1153 },
    { itemId: 0x152E, layer: 4, hue: 1107 },
    { itemId: 0x170B, layer: 3, hue: 1107 },
    { itemId: 0x1539, layer: 12, hue: 1153 },
  ],
  baker: [
    { itemId: 0x1517, layer: 5, hue: 0 },
    { itemId: 0x152E, layer: 4, hue: 1107 },
    { itemId: 0x170B, layer: 3 },
    { itemId: 0x153B, layer: 22, hue: 0 },      // apron
  ],
  fisherman: [
    { itemId: 0x1517, layer: 5, hue: 952 },     // blue shirt
    { itemId: 0x152E, layer: 4, hue: 1110 },
    { itemId: 0x170B, layer: 3 },
  ],
  tailor: [
    { itemId: 0x1517, layer: 5, hue: 1153 },
    { itemId: 0x1F00, layer: 4, hue: 1107 },    // skirt
    { itemId: 0x170B, layer: 3, hue: 1107 },
  ],
  scribe: [
    { itemId: 0x1F03, layer: 22, hue: 41 },
    { itemId: 0x170B, layer: 3, hue: 41 },
  ],
  jeweler: [
    { itemId: 0x1517, layer: 5, hue: 1153 },
    { itemId: 0x152E, layer: 4, hue: 1107 },
    { itemId: 0x170B, layer: 3 },
  ],
  bowyer: [
    { itemId: 0x1517, layer: 5, hue: 1109 },
    { itemId: 0x152E, layer: 4, hue: 1109 },
    { itemId: 0x170D, layer: 3 },
  ],
  tinker: [
    { itemId: 0x1517, layer: 5, hue: 1107 },
    { itemId: 0x152E, layer: 4, hue: 1107 },
    { itemId: 0x170B, layer: 3 },
  ],
};

function applyVendorOutfit(api, world, mob, kindKey) {
  const outfit = VENDOR_OUTFITS[kindKey] ?? VENDOR_OUTFITS.provisioner;
  for (const piece of outfit) {
    try {
      createItem(api, world, {
        itemId: piece.itemId, hue: piece.hue ?? 0,
        x: 0, y: 0, z: 0, map: mob.map,
        parent: mob.serial, layer: piece.layer,
        movable: false,
      });
    } catch (e) { api.log?.(`vendor outfit: ${e?.message ?? e}`); }
  }
}

function spendVendorGold(api, protocol, buyerState, buyer, packSerial, totalCost) {
  if (totalCost <= 0) return true;
  const access = buyerState?.account?.accessLevel ?? 'Player';
  if (access === 'GM' || access === 'Admin') return true;

  let owned = 0;
  for (const item of packItems(api, buyer)) {
    if (item.itemId === 0x0EED) owned += item.amount | 0;
  }
  if (owned < totalCost) {
    buyerState.sendSystemMessage?.(`You need ${totalCost} gold; you have ${owned}.`);
    return false;
  }

  let remaining = totalCost;
  for (const item of [...packItems(api, buyer)]) {
    if (remaining <= 0) break;
    if (item.itemId !== 0x0EED) continue;
    const take = Math.min(remaining, item.amount | 0);
    item.amount -= take;
    remaining -= take;
    if (item.amount <= 0) {
      destroyItemBySerial(api, item.serial);
      const packet = protocol.removeEntity?.(item.serial);
      if (packet) buyerState.send?.(packet);
    } else {
      const packet = protocol.containerContentUpdate?.({
        serial: item.serial, itemId: item.itemId, amount: item.amount,
        hue: item.hue ?? 0, gridX: item.gridX ?? 0, gridY: item.gridY ?? 0,
        gridLocation: item.gridLocation ?? 0,
      }, packSerial);
      if (packet) buyerState.send?.(packet);
    }
  }
  return true;
}

export default function (api) {
  const { commands, world, vendors, protocol } = api;
  if (!vendors) return;

  // Wave 7 follow-up: merge extracted SBInfo into VENDOR_KINDS as a
  // fallback for any key not authored above. Authored entries win —
  // the extracted ones only add NEW vendor kinds (alchemist, baker,
  // butcher, cobbler, …). Each gets a sensible default appearance via
  // EXTRACTED_VENDOR_DEFAULTS, falling through to a generic provisioner
  // shape when the key isn't explicitly mapped. This adds ~70 new
  // vendor types we can spawn via `[vendor <kind>` instantly.
  const extracted = loadExtractedVendorInventory();
  if (extracted && typeof extracted === 'object') {
    let added = 0;
    for (const [key, info] of Object.entries(extracted)) {
      if (VENDOR_KINDS[key]) continue;          // never override authored
      if (!info?.buy?.length) continue;          // can't shop without stock
      const defaults = EXTRACTED_VENDOR_DEFAULTS[key] ?? {
        name: `${key.charAt(0).toUpperCase() + key.slice(1)}`,
        body: 0x0190, hue: 0x044E,
      };
      // Wave 9 follow-up: resolve sell entries (only have {type, price})
      // through `api.itemTypes.resolve()` so the vendor accepts those
      // exact items at canonical SBInfo prices instead of the
      // half-of-buy fallback. Entries without a resolvable type drop
      // through to the buy-side reverse index.
      const sellOverrides = [];
      if (Array.isArray(info.sell) && api.itemTypes?.resolve) {
        for (const s of info.sell) {
          const r = api.itemTypes.resolve(s.type);
          if (r?.itemId) sellOverrides.push({ itemId: r.itemId, price: s.price | 0, type: s.type });
        }
      }
      VENDOR_KINDS[key] = {
        name: defaults.name,
        body: defaults.body,
        hue: defaults.hue,
        // Map extracted buy entries (typed { type, price, stock, itemId, hue })
        // to our stock shape. Strip hue 0 (graphic-default) — most
        // SBInfo entries pass 0 for hue and we want the item baseline.
        stock: info.buy.map((e) => ({
          itemId: e.itemId | 0,
          hue: e.hue | 0,
          name: e.type,
          price: e.price | 0,
        })),
        sellOverrides,
      };
      added++;
    }
    api.log?.(`vendor: +${added} extracted vendor kinds (total ${Object.keys(VENDOR_KINDS).length})`);
  }

  // Register the AI behavior exactly once per script load (shared by all kinds).
  if (api.ai) {
    api.ai.registerBehavior({
      name: 'vendor',
      initState() {
        return {
          nextStepAt: 0,
          home: null,
          greetedAt: new Map(),
          lastGreetAt: -Infinity,
          lastSpeechReplyAt: 0,
        };
      },
      tick(ctx, mob, state) {
        if (state.home === null) state.home = { x: mob.x, y: mob.y };

        // BUGFIX #45 (FAZA CC): vendors didn't listen to player speech
        // commands, so the canonical UO interaction "vendor buy" /
        // "vendor sell" / "<name> buy" had no effect — players had to
        // right-click via context menu. Drain `_heardSpeech` here and
        // open the buy / sell window for the speaker.
        const queue = mob._heardSpeech;
        if (Array.isArray(queue) && queue.length > 0) {
          while (queue.length > 0) {
            const entry = queue.shift();
            if (!entry?.text || !entry.speaker?.client) continue;
            if (ctx.now - state.lastSpeechReplyAt < 1500) continue;
            const lcText = String(entry.text).toLowerCase();
            const want = (
              lcText.includes('vendor buy') || lcText.includes('shop buy') ||
              lcText === 'buy' || lcText.endsWith(' buy') ||
              (mob.name && lcText.includes(`${mob.name.toLowerCase()} buy`))
            ) ? 'buy'
              : (lcText.includes('vendor sell') || lcText.includes('shop sell') ||
                 lcText === 'sell' || lcText.endsWith(' sell') ||
                 (mob.name && lcText.includes(`${mob.name.toLowerCase()} sell`)))
              ? 'sell' : null;
            if (!want) {
              // Custom kind-level speech mapping (e.g. stable_master ->
              // "stable"). Each key is a substring; the matching value
              // is dispatched as a chat command on the speaker's side.
              const speechMap = VENDOR_KINDS[mob.vendorKind]?.speech;
              if (speechMap) {
                let triggered = null;
                for (const [keyword, cmd] of Object.entries(speechMap)) {
                  const k = String(keyword).toLowerCase();
                  if (lcText === k || lcText.includes(` ${k}`) || lcText.startsWith(`${k} `)) {
                    triggered = cmd; break;
                  }
                }
                if (triggered) {
                  state.lastSpeechReplyAt = ctx.now;
                  try { api.commands?.dispatch?.(triggered.replace(/^\[/, '').split(' ')[0], {
                    sender: entry.speaker, state: entry.speaker.client, world: ctx.world,
                    args: triggered.replace(/^\[/, '').split(' ').slice(1),
                  }); }
                  catch (e) { api.log?.(`vendor: speech custom (${triggered}) threw: ${e.message}`); }
                  break;
                }
              }
              continue;
            }
            state.lastSpeechReplyAt = ctx.now;
            try {
              if (want === 'buy') api.vendors.openBuy(entry.speaker.client, mob.serial);
              else                 api.vendors.openSell(entry.speaker.client, mob.serial);
              ctx.broadcastSpeech(mob, want === 'buy'
                ? 'Pleasure doing business — what shall I sell you?'
                : 'Show me what you have for sale.', 0x03B2);
            } catch (e) {
              api.log?.(`vendor: speech ${want} threw: ${e.message}`);
            }
            break;          // only one speech reply per tick
          }
        }

        if (ctx.now - state.lastGreetAt > 4000) {
          const player = findNearbyPlayer(ctx.world, mob);
          if (player) {
            const serial = player.serial >>> 0;
            const last = state.greetedAt.get(serial) ?? -Infinity;
            if (ctx.now - last > GREET_COOLDOWN_MS) {
              state.greetedAt.set(serial, ctx.now);
              state.lastGreetAt = ctx.now;
              // Wave 13: bump visits; pick greeting from customer history.
              const hist = bumpCustomerHistory(mob, serial, 'visits', 1);
              const line = greetingForHistory(hist);
              ctx.broadcastSpeech(mob, line, 0x03B2);
              const dx = Math.sign(player.x - mob.x);
              const dy = Math.sign(player.y - mob.y);
              if (dx || dy) {
                const idx = [[0,-1,0],[1,-1,1],[1,0,2],[1,1,3],[0,1,4],[-1,1,5],[-1,0,6],[-1,-1,7]]
                  .find((e) => e[0] === dx && e[1] === dy);
                if (idx) mob.direction = idx[2];
              }
              return;
            }
          }
        }

        if (ctx.now < state.nextStepAt) return;
        state.nextStepAt = ctx.now + STEP_MIN_MS + Math.random() * STEP_JITTER_MS;
        if (!api.ai.stepMobile) return;

        const dx = mob.x - state.home.x;
        const dy = mob.y - state.home.y;
        let dir;
        if (Math.abs(dx) > WANDER_RADIUS || Math.abs(dy) > WANDER_RADIUS) {
          const angle = Math.atan2(state.home.y - mob.y, state.home.x - mob.x);
          dir = (Math.round(angle / (Math.PI / 4)) + 2 + 8) & 7;
        } else {
          dir = Math.floor(Math.random() * 8);
        }
        if (api.ai.stepMobile(mob, dir)) ctx.broadcastMove(mob);
      },
    });
  }

  function spawnVendor(kindKey, ctx) {
    const resolvedKey = resolveVendorKind(kindKey) ?? kindKey;
    const kind = VENDOR_KINDS[resolvedKey];
    if (!kind) {
      ctx.state.sendSystemMessage(`Unknown vendor kind: ${kindKey}`);
      return;
    }
    const state = ctx.state;
    if (!state?.mobile) return;
    const mob = createMobile(api, world, {
      name: kind.name,
      body: kind.body,
      x: state.mobile.x, y: state.mobile.y, z: state.mobile.z,
      map: state.mobile.map, hue: kind.hue,
    });
    // FAZA BG: persistence — mark the kind so a server restart can
    // re-register the vendor binding. The reattach pass at script
    // load reads `mob.vendorKind` and re-runs the registry hook.
    mob.vendorKind = resolvedKey;
    // Faza H.1.12 — copy faction tag for the discount handler.
    if (kind.faction) mob.faction = kind.faction;

    // Outfit per kind — table + helper lifted to module scope so the
    // civic-NPC spawn path (api.vendors.spawnAt) can share the same
    // dress code instead of producing naked bankers/healers/trainers.
    applyVendorOutfit(api, world, mob, resolvedKey);

    // FAZA CC: opt into the speech queue so the AI tick can react to
    // "vendor buy" / "vendor sell" / `<name> buy`. Keywords are
    // case-folded substring matches; we keep the list short so the
    // server-side gate filters cheaply.
    mob._listensToSpeech = true;
    mob._speechKeywords = ['buy', 'sell', 'shop'];

    // BUGFIX #23 (FAZA BG): synthetic vendor-stock serials used to
    // overlap with real item allocations. The original encoding
    // `0x40000000 | mob.serial | ((i+1)<<20)` produced serials like
    // 0x40100001 — well inside the regular item-allocation space
    // (0x40000000..0x7FFFFFFF, allocated incrementally by allocItem).
    // After ~1M real items the allocator caught up and collided with
    // an existing vendor stock entry, breaking item lookups in
    // unpredictable ways. Move synthetic serials to the upper-quarter
    // 0x70000000..0x7FFFFFFF reserved-by-convention slice; the
    // allocator never reaches it on any practical shard.
    // Wave 10: each stock entry tracks current vs max stock so vendors
    // actually run out of inventory and restock on a timer. Extracted
    // SBInfo entries supply `stock` (e.g. 10 cure potions); hand-authored
    // kinds default to Infinity (back-compat — they never deplete).
    // currentStock is the live amount; maxStock is the cap restocked to.
    const stockItems = kind.stock.map((s, i) => {
      const maxStock = Number.isFinite(s.stock) && s.stock > 0 ? s.stock : Infinity;
      return {
        serial: (0x70000000 + ((mob.serial & 0xFFFFFF) << 8) + ((i + 1) & 0xFF)) >>> 0,
        itemId: s.itemId,
        hue: s.hue ?? 0,
        amount: maxStock,
        price: s.price,
        description: s.name,
        tagId: s.tagId,
        maxStock,
        currentStock: maxStock,
      };
    });

    vendors.register({
      vendorSerial: mob.serial,
      listStock: () => stockItems,
      listSellable: () => {
        const byId = new Map();
        for (const s of stockItems) {
          const price = Math.max(1, Math.floor((s.price ?? 0) / 2));
          if (price > (byId.get(s.itemId)?.price ?? 0)) byId.set(s.itemId, { itemId: s.itemId, price });
        }
        for (const s of kind.sellOverrides ?? []) {
          byId.set(s.itemId, { itemId: s.itemId, price: Math.max(1, s.price | 0) });
        }
        return [...byId.values()];
      },
      onBuy: (buyerState, picks) => {
        const buyer = buyerState.mobile;
        // BUGFIX #136 (FAZA JC): the previous code used `buyer.serial`
        // as the parent for spawned items. That's the MOB serial, not
        // the backpack — same dropped-wire as #119 in `[give`. Items
        // ended up on layer 0 of the paperdoll instead of inside the
        // bag, so players never saw their purchase. Resolve the
        // layer-21 backpack and parent there.
        const pack = api.game?.inventory?.findBackpack?.(buyer);
        if (!pack) {
          buyerState.sendSystemMessage?.('You have no backpack.');
          return;
        }
        const packSerial = pack.serial;
        // BUGFIX #133 (FAZA IC): the previous onBuy spawned items for
        // free regardless of player gold — vendors were a free buffet.
        // ServUO `BaseVendor.OnBuyItems` deducts the full bill from
        // the player's pack-gold before granting items. We do the
        // same here, with a GM/Admin bypass so staff can still demo.
        const accessLevel = buyerState?.account?.accessLevel ?? 'Player';
        const isStaff = accessLevel === 'GM' || accessLevel === 'Admin';
        let totalCost = 0;
        // Wave 10: clamp requested amount to currentStock per stock line.
        // Out-of-stock items become 0-amount picks (skipped below).
        const adjustedPicks = picks.map((p) => {
          const def = stockItems.find((s) => s.serial === p.serial);
          if (!def) return { ...p, amount: 0 };
          const requested = Math.max(1, p.amount);
          const allowed = Math.min(requested, def.currentStock);
          return { ...p, amount: allowed };
        });
        for (const p of adjustedPicks) {
          const def = stockItems.find((s) => s.serial === p.serial);
          if (!def) continue;
          totalCost += (def.price ?? 0) * Math.max(1, p.amount);
        }
        // Faza H.1.12 — Faction Reagent Merchant 20% discount for same-
        // faction buyers. `mob.faction` is set from VENDOR_KINDS;
        // `buyer._faction` is stamped by the faction join command.
        if (mob.faction && buyer._faction && mob.faction === buyer._faction && totalCost > 0) {
          const before = totalCost;
          totalCost = Math.max(1, Math.floor(totalCost * 0.8));
          buyerState.sendSystemMessage?.(
            `Faction discount saves you ${before - totalCost} gp (20% off).`);
        }
        // ServUO Begging skill — small per-purchase discount when the
        // buyer has at least 50.0 in Begging. ServUO formula: discount %
        // is (skill - 50) / 50 * 0.10, capped at 10% off at 100 skill.
        // The discount stacks with haggle (different mechanic) and is
        // permanent (no one-shot consume).
        const SKILL_BEGGING = 7;
        const rawBeggingSkill = buyer.skills?.[SKILL_BEGGING]
                             ?? buyer.skills?.[String(SKILL_BEGGING)] ?? 0;
        const beggingSkill = normalizeSkillValue(rawBeggingSkill);
        if (beggingSkill >= 50) {
          const pct = Math.min(0.10, (beggingSkill - 50) / 50 * 0.10);
          if (pct > 0) {
            const before = totalCost;
            totalCost = Math.max(1, Math.floor(totalCost * (1 - pct)));
            buyerState.sendSystemMessage?.(
              `Your skill at Begging saves you ${before - totalCost} gp (${Math.round(pct * 100)}% off).`);
          }
        }
        // Wave 11: apply a haggle discount if the buyer secured one.
        // Stored on the vendor as `_haggledBy.get(buyerSerial)` with
        // `{pct, expiresAt}`. Consumed (one-shot) on use.
        gcHaggleCoupons(mob);
        const haggleMap = mob._haggledBy;
        const haggle = haggleMap?.get(buyer.serial);
        if (haggle && Date.now() < haggle.expiresAt) {
          const discounted = Math.max(1, Math.floor(totalCost * (1 - haggle.pct)));
          buyerState.sendSystemMessage?.(
            `Haggle saves you ${totalCost - discounted} gp (${Math.round(haggle.pct * 100)}% off).`,
          );
          totalCost = discounted;
          haggleMap.delete(buyer.serial);
        }
        if (!isStaff) {
          let goldOwned = 0;
          for (const it of packItems(api, buyer)) if (it.itemId === 0x0EED) goldOwned += it.amount | 0;
          if (goldOwned < totalCost) {
            buyerState.sendSystemMessage?.(`You need ${totalCost} gold; you have ${goldOwned}.`);
            return;
          }
        }
        // Build every output first. The operation remains invisible until
        // all rows exist and payment succeeds; any failed constructor is
        // rolled back so a buyer can neither lose gold nor receive a
        // partially fulfilled order.
        const created = [];
        for (const p of adjustedPicks) {
          if (p.amount <= 0) continue;
          const def = stockItems.find((s) => s.serial === p.serial);
          if (!def) continue;
          const item = api.game?.mobile?.giveItem?.(buyer, {
            itemId: def.itemId, hue: def.hue, amount: p.amount,
            name: def.description, tagId: def.tagId,
          }, { notify: false, randomGrid: true });
          if (!item) {
            for (const made of created) destroyItemBySerial(api, made.item.serial);
            buyerState.sendSystemMessage?.('Your backpack cannot receive that order.');
            return;
          }
          created.push({ item, def, amount: p.amount });
        }
        if (!isStaff && !spendVendorGold(api, protocol, buyerState, buyer, packSerial, totalCost)) {
          for (const made of created) destroyItemBySerial(api, made.item.serial);
          return;
        }
        let stockShorted = false;
        for (const p of adjustedPicks) if (p.amount <= 0) stockShorted = true;
        for (const made of created) {
          const { item, def, amount } = made;
          // Wave 10: decrement live stock so the next listStock() reflects
          // depletion. currentStock is Infinity for hand-authored kinds —
          // arithmetic on Infinity stays Infinity, so they never deplete.
          def.currentStock = Math.max(0, def.currentStock - amount);
          def.amount = def.currentStock;
          // Wave 13: track sales for weighted refill — popular items
          // restock faster than dust-collectors.
          def._salesCount = (def._salesCount ?? 0) + amount;
          // FAZA CT: try to merge with an existing stack already in the
          // pack. ServUO does this automatically; without the merge,
          // buying 5×1 gold piles created 5 separate slots instead of
          // a single +5 increase.
          const existing = api.items.findMergeableStack?.(world, packSerial, item);
          if (existing) {
            api.items.mergeStacks(world, existing, item);
            buyerState.send(protocol.containerContentUpdate(existing, packSerial));
            if (itemBySerial(api, item.serial)) buyerState.send(protocol.containerContentUpdate(item, packSerial));
          } else {
            buyerState.send(protocol.containerContentUpdate(item, packSerial));
          }
        }
        buyerState.sendSystemMessage?.(
          isStaff ? 'GM bypass: goods granted free.' : `The goods are yours (paid ${totalCost} gp).`,
        );
        if (stockShorted) {
          buyerState.sendSystemMessage?.('Some items were out of stock — fewer delivered than requested.');
        }
        // Wave 13: track customer history so greetings + haggle responses
        // adapt over time.
        bumpCustomerHistory(mob, buyer.serial, 'buys', 1, { protocol, world });
        // Wave 14: append to the vendor's transaction ring buffer
        // (capped at 50 entries, oldest evicted) — used by `[shop log`.
        appendTransaction(mob, {
          type: 'buy', customerSerial: buyer.serial, customerName: buyer.name,
          itemCount: adjustedPicks.reduce((s, p) => s + Math.max(0, p.amount), 0),
          gold: totalCost, ts: Date.now(),
        }, api);
      },
      onSell: (sellerState, picks) => {
        let gold = 0;
        const backpack = api.game?.inventory?.findBackpack?.(sellerState.mobile);
        if (!backpack) return;
        // Wave 9: prefer canonical SBInfo sell prices when present.
        // sellOverrides comes from extracted vendor-inventory.sell with
        // explicit {itemId, price}. Fall back to half-of-buy lookup for
        // hand-authored kinds.
        const priceByItemId = new Map();
        for (const s of stockItems) {
          const prior = priceByItemId.get(s.itemId) ?? 0;
          if (s.price > prior) priceByItemId.set(s.itemId, Math.max(1, Math.floor(s.price / 2)));
        }
        const overrides = kind.sellOverrides ?? [];
        for (const o of overrides) {
          // Override always wins — the SBInfo price is canonical.
          priceByItemId.set(o.itemId, Math.max(1, o.price));
        }
        const planned = [];
        for (const p of picks) {
          const item = itemBySerial({ world }, p.serial);
          if (!item || ![...packItems(api, sellerState.mobile)].some((candidate) => candidate.serial === item.serial)) continue;
          const amount = Math.min(Math.max(1, p.amount), item.amount ?? 1);
          const price = priceByItemId.get(item.itemId);
          if (!price || item.insured || item.blessed || item.movable === false) continue;
          gold += price * amount;
          planned.push({ item, amount });
        }
        if (gold > 0) {
          for (const { item, amount } of planned) {
            if (amount >= (item.amount ?? 1)) {
              destroyItemBySerial(api, item.serial);
              sellerState.send(protocol.removeEntity(item.serial));
            } else {
              item.amount -= amount;
              sellerState.send(protocol.containerContentUpdate(item, item.parent));
            }
          }
          const payout = api.game?.mobile?.giveItem?.(sellerState.mobile, {
            itemId: 0x0EED, amount: gold, name: 'gold coins', stackable: true,
          }, { notify: false, randomGrid: true });
          if (!payout) {
            // Extremely defensive fallback: preserve value even if pack
            // allocation fails. The scalar is persisted and bankers expose it.
            sellerState.mobile.gold = (sellerState.mobile.gold ?? 0) + gold;
          } else {
            const existing = api.items.findMergeableStack?.(world, backpack.serial, payout);
            if (existing) {
              api.items.mergeStacks(world, existing, payout);
              sellerState.send(protocol.containerContentUpdate(existing, backpack.serial));
              if (itemBySerial(api, payout.serial)) sellerState.send(protocol.containerContentUpdate(payout, backpack.serial));
            } else sellerState.send(protocol.containerContentUpdate(payout, backpack.serial));
          }
          sellerState.sendSystemMessage?.(`You receive ${gold} gold.`);
          // Wave 13: track sell-side history too.
          bumpCustomerHistory(mob, sellerState.mobile.serial, 'sells', 1);
          // Wave 14: log sell-side transaction.
          appendTransaction(mob, {
            type: 'sell', customerSerial: sellerState.mobile.serial,
            customerName: sellerState.mobile.name,
            itemCount: picks.length, gold, ts: Date.now(),
          }, api);
        }
      },
    });

    if (api.ai) {
      try { api.ai.attach(mob, 'vendor'); }
      catch (e) { console.error('[vendor] attach threw:', e); }
    }

    for (const c of Array.from(allMobiles({ world })).filter((m) => m.client)) {
      c.client.send(protocol.mobileIncoming({
        serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: 1,
      }));
    }

    state.sendSystemMessage?.(`${mob.name} has arrived.`);
  }

  // `[vendor [kind]` is the one catalogue entry. Keep only five long-standing
  // shortcuts for old staff macros. The previous generated command for every
  // extracted vendor kind created dozens of clutter rows and collided with
  // unrelated commands such as [bard, [trainer and [healer.
  const cmdSpecs = [
    ['vendor',      'provisioner', '[vendor [kind|list] — spawn or browse vendor kinds.'],
    ['provisioner', 'provisioner', 'Spawn a provisioner (alias of [vendor).'],
    ['blacksmith',  'blacksmith',  'Spawn a blacksmith vendor at your feet.'],
    ['mage',        'mage',        'Spawn a mage shop vendor at your feet.'],
    ['armorer',     'armorer',     'Spawn an armorer vendor at your feet.'],
    ['innkeeper',   'innkeeper',   'Spawn an innkeeper vendor at your feet.'],
  ];
  // FAZA BG: re-attach vendors that survived a save/load. We walk
  // existing world.mobiles, find any with `vendorKind`, and re-run
  // the in-memory binding (registry + AI). Only attaches once per
  // mob — a duplicate vendors.register would shadow the prior entry.
  function reattachExisting(onlyMob = null, knownDressed = false) {
    // ServUO `BaseVendor.PendingConvert` maps to our reattach pass:
    // a persisted vendor is converted back into a live shop binding.
    // Cheap one-shot check: does this mob already have ANY worn item?
    // (parent === serial && layer > 0). Without rebuilding the equip
    // index here, walk world.items once and bucket by parent so we
    // don't have to repeat the walk for every vendor.
    const hasWornByMob = new Set();
    if (!onlyMob && !knownDressed) {
      for (const it of allItems({ world })) {
        if (it.parent && (it.layer | 0) > 0) hasWornByMob.add(it.parent);
      }
    }
    const candidates = onlyMob ? [onlyMob] : allMobiles({ world });
    for (const mob of candidates) {
      const kindKey = mob.vendorKind;
      if (!kindKey) continue;
      if (vendors.get?.(mob.serial)) continue; // already bound
      const kind = VENDOR_KINDS[kindKey];
      if (!kind) continue;
      // FAZA CC: re-flag persisted vendors so they listen to speech
      // again after restart.
      mob._listensToSpeech = true;
      mob._speechKeywords = ['buy', 'sell', 'shop'];
      // Re-apply outfit to vendors saved BEFORE the outfit-on-spawn fix
      // (legacy saves) OR to any vendor that somehow lost its worn
      // items. Without this every reloaded shard saw naked vendors —
      // Marcin: "Jacob the Provisioner nadal naked". The outfit items
      // are created with movable:false + layer, so the persistence
      // round-trip will keep them next save.
      if (!knownDressed && !hasWornByMob.has(mob.serial)) {
        try { applyVendorOutfit(api, world, mob, kindKey); }
        catch (e) { api.log?.(`vendor reattach outfit: ${e?.message ?? e}`); }
      }
      const stockItems = kind.stock.map((s, i) => ({
        serial: (0x70000000 + ((mob.serial & 0xFFFFFF) << 8) + ((i + 1) & 0xFF)) >>> 0,
        itemId: s.itemId, hue: s.hue ?? 0,
        amount: Number.isFinite(s.stock) && s.stock > 0 ? s.stock : Infinity,
        price: s.price, description: s.name, tagId: s.tagId,
        maxStock: Number.isFinite(s.stock) && s.stock > 0 ? s.stock : Infinity,
        currentStock: Number.isFinite(s.stock) && s.stock > 0 ? s.stock : Infinity,
      }));
      vendors.register({
        vendorSerial: mob.serial,
        listStock: () => stockItems,
        listSellable: () => {
          const rows = new Map();
          for (const s of stockItems) rows.set(s.itemId, { itemId: s.itemId, price: Math.max(1, Math.floor(s.price / 2)) });
          for (const s of kind.sellOverrides ?? []) rows.set(s.itemId, { itemId: s.itemId, price: Math.max(1, s.price | 0) });
          return [...rows.values()];
        },
        onBuy: (buyerState, picks) => {
          const buyer = buyerState.mobile;
          const pack = api.game?.inventory?.findBackpack?.(buyer);
          if (!pack) {
            buyerState.sendSystemMessage?.('You have no backpack.');
            return;
          }
          const accepted = [];
          let totalCost = 0;
          for (const p of picks) {
            const def = stockItems.find((sd) => sd.serial === p.serial);
            if (!def) continue;
            const amount = Math.min(Math.max(1, p.amount | 0), def.currentStock);
            if (amount <= 0) continue;
            accepted.push({ def, amount });
            totalCost += Math.max(0, def.price | 0) * amount;
          }
          const made = [];
          for (const { def, amount } of accepted) {
            const item = api.game?.mobile?.giveItem?.(buyer, {
              itemId: def.itemId, hue: def.hue, amount,
              name: def.description, tagId: def.tagId,
            }, { notify: false, randomGrid: true });
            if (!item) {
              for (const row of made) destroyItemBySerial(api, row.item.serial);
              buyerState.sendSystemMessage?.('The vendor could not deliver those goods.');
              return;
            }
            made.push({ def, amount, item });
          }
          if (!spendVendorGold(api, protocol, buyerState, buyer, pack.serial, totalCost)) {
            for (const row of made) destroyItemBySerial(api, row.item.serial);
            return;
          }
          let delivered = 0;
          for (const { def, amount, item } of made) {
            def.currentStock = Math.max(0, def.currentStock - amount);
            def.amount = def.currentStock;
            delivered += amount;
            const packet = protocol.containerContentUpdate?.(item, pack.serial);
            if (packet) buyerState.send?.(packet);
          }
          buyerState.sendSystemMessage?.(
            delivered > 0 ? `The goods are yours (paid ${totalCost} gp).` : 'The vendor could not deliver those goods.',
          );
        },
        onSell: (sellerState, picks) => {
          let gold = 0;
          const pack = api.game?.inventory?.findBackpack?.(sellerState.mobile);
          if (!pack) return;
          const allowed = new Map((kind.sellOverrides ?? []).map((s) => [s.itemId, Math.max(1, s.price | 0)]));
          for (const stock of stockItems) if (!allowed.has(stock.itemId)) allowed.set(stock.itemId, Math.max(1, Math.floor(stock.price / 2)));
          const planned = [];
          for (const pick of picks) {
            const item = itemBySerial({ world }, pick.serial);
            if (!item || ![...packItems(api, sellerState.mobile)].some((row) => row.serial === item.serial)) continue;
            const amount = Math.min(Math.max(1, pick.amount | 0), item.amount ?? 1);
            const price = allowed.get(item.itemId);
            if (!price || item.insured || item.blessed || item.movable === false) continue;
            gold += price * amount;
            planned.push({ item, amount });
          }
          if (gold > 0) {
            for (const { item, amount } of planned) {
              if (amount >= (item.amount ?? 1)) {
                destroyItemBySerial(api, item.serial);
                const packet = protocol.removeEntity?.(item.serial);
                if (packet) sellerState.send?.(packet);
              } else {
                item.amount -= amount;
                sellerState.send?.(protocol.containerContentUpdate?.(item, item.parent));
              }
            }
            const payout = api.game?.mobile?.giveItem?.(sellerState.mobile, {
              itemId: 0x0EED, amount: gold, name: 'gold coins', stackable: true,
            }, { notify: false, randomGrid: true });
            if (payout) sellerState.send?.(protocol.containerContentUpdate?.(payout, pack.serial));
            else sellerState.mobile.gold = (sellerState.mobile.gold ?? 0) + gold;
            sellerState.sendSystemMessage?.(`You receive ${gold} gold.`);
          }
        },
      });
      if (api.ai) {
        try { api.ai.attach(mob, 'vendor'); }
        catch (e) { console.error('[vendor] reattach AI threw:', e); }
      }
    }
  }
  // Run after the AI registerBehavior above so attach() finds it.
  reattachExisting();

  // Public spawn helper for fixed-location placers (regional-npcs.js,
  // quest scripts). Mirrors `spawnVendor` but takes explicit
  // (x,y,z,map) instead of inheriting from a player's mobile, and
  // re-runs `reattachExisting` immediately so the new mob is wired up
  // without waiting for the next script reload. Returns the mob.
  // Alias map: external callers (regional-npcs JSON, ServUO-port data,
  // xmlload, quest scripts) use looser kind names. Map them onto our
  // canonical VENDOR_KINDS slot before lookup so missing kinds become
  // a real config error, not a typo trap. Module-scoped so the
  // `hasKind` exporter below can apply the same resolution rules.
  const VENDOR_ALIAS = {
    smith: 'blacksmith', fletcher: 'bowyer',
    // ServUO uses `stablemaster` / `animaltrainer` (no underscore) in
    // its XML; our canonical kind is `animal_trainer` (with underscore).
    // Map both forms back to the canonical slot.
    stablemaster: 'stable_master', stable_master: 'stable_master',
    animaltrainer: 'animal_trainer', trainer: 'animal_trainer',
    mapmaker: 'cartographer', vet: 'animal_trainer',
    // ServUO XmlSpawner aliases — Scripts/Mobiles/Vendors namespace.
    // These appear in `Spawns/trammel.xml` etc. as PascalCase or short
    // forms that don't match our canonical VENDOR_KINDS keys.
    minter: 'banker',                   // banker/minter spawn pairs
    towncrier: 'wanderer', tinkerguildmaster: 'tinker',
    tailorguildmaster: 'tailor', mageguildmaster: 'mage',
    blacksmithguildmaster: 'blacksmith', healerguildmaster: 'healer',
    fishermanguildmaster: 'fisherman', rangerguildmaster: 'wanderer',
    cartographerguildmaster: 'cartographer',
    // Tavern / cookery — ServUO routes Cook to the food vendor pool
    // and Barkeeper/Bartender/Tavernkeeper to innkeeper. Waiter is a
    // server NPC with no shop, falls back to wanderer.
    cook: 'baker', barkeeper: 'innkeeper', bartender: 'innkeeper',
    tavernkeeper: 'innkeeper', waiter: 'wanderer',
    // Hire-NPCs (mercenaries, bards-for-hire, sailors) — no shop, just
    // ambient flavor. Wanderer covers the AI bind.
    hirebard: 'bard', hiresailor: 'wanderer', hirefighter: 'wanderer',
    merchant: 'provisioner', naturalist: 'wanderer',
    realestatebroker: 'provisioner', shipwrightguildmaster: 'shipwright',
    // Skinner / tanner specialise in leather → maps to furtrader (sells
    // hides and pelts in ServUO).
    tanner: 'furtrader', skinner: 'furtrader',
    // Combat / faction-ish vendors — these have proper shop tables in
    // VENDOR_KINDS but XmlSpawner writes the underscore-less form.
    armsdealer: 'arms_dealer', weaponsmith: 'arms_dealer',
    potionseller: 'potion_seller', gargisharmorer: 'gargish_armorer',
    thiefguildmaster: 'thief_guild', thief: 'thief_guild',
    pettrainer: 'pet_trainer', furtraderguildmaster: 'furtrader',
    // Scribes / mage variants — XmlSpawner writes both `scribe` and
    // `mage`; both already exist in VENDOR_KINDS so the direct-hit
    // path returns them without consulting this alias. Listed here
    // for documentation only.
    // scribe (in VENDOR_KINDS), alchemist (in VENDOR_KINDS).
    // Flavor archetypes without a real shop — fall back to wanderer
    // (a generic non-vendor villager). Used by regional-npcs.json
    // entries like `paladin`, `monk`, `miner`, `ranger`, `bard`.
    paladin: 'wanderer', monk: 'wanderer', miner: 'wanderer',
    ranger: 'wanderer', sister: 'wanderer', brother: 'wanderer',
    // Stable-related variants ServUO uses interchangeably.
    rancher: 'animal_trainer', shepherd: 'animal_trainer',
    veterinarian: 'animal_trainer',
    // Healer subtypes.
    evilhealer: 'healer', wanderinghealer: 'healer',
    // Misc one-off vendors.
    realtor: 'provisioner', taxidermistguildmaster: 'taxidermist',
    architect: 'carpenter', glassman: 'glassblower',
  };
  /** Resolve any external kind key (with alias) to a canonical
   *  VENDOR_KINDS slot, or null if neither the literal nor the alias
   *  matches. Lowercase-safe — ServUO PascalCase names are normalised
   *  by xmlload before reaching us. */
  function resolveVendorKind(kindKey) {
    if (!kindKey) return null;
    const k = String(kindKey).toLowerCase();
    if (VENDOR_KINDS[k]) return k;
    const aliased = VENDOR_ALIAS[k];
    if (aliased && VENDOR_KINDS[aliased]) return aliased;
    return null;
  }
  const vendorCatalog = Object.freeze(Object.entries(VENDOR_KINDS).map(([key, value]) => Object.freeze({
    key,
    name: value.name ?? key,
    itemCount: value.stock?.length ?? 0,
    search: `${key} ${value.name ?? ''} ${(value.stock ?? []).map((row) => row.name ?? '').join(' ')}`.toLowerCase(),
  })).sort((a, b) => a.key.localeCompare(b.key)));
  function searchVendorCatalog(query = '') {
    const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    return terms.length ? vendorCatalog.filter((entry) => terms.every((term) => entry.search.includes(term))) : vendorCatalog;
  }
  api.vendors = {
    ...(api.vendors ?? {}),
    /** True iff the kind (or its alias) resolves to a real vendor slot.
     *  xmlload uses this to decide whether a spawn entry is a vendor
     *  (route to api.vendors.spawnAt) or a monster (existing path). */
    hasKind: (kindKey) => resolveVendorKind(kindKey) != null,
    /** Read-only list of canonical vendor kind keys. */
    kinds: () => Object.keys(VENDOR_KINDS),
    search: (query) => searchVendorCatalog(query).map(({ search: _search, ...entry }) => entry),
    spawnAt(kindKey, pos) {
      const resolvedKey = resolveVendorKind(kindKey) ?? kindKey;
      const kind = VENDOR_KINDS[resolvedKey] ?? VENDOR_KINDS.wanderer;
      if (!kind) {
        api.log?.(`vendor.spawnAt: unknown kind '${kindKey}'`);
        return null;
      }
      // Defense-in-depth: callers (regional-npcs, quest scripts, admin
      // gump) sometimes pass `z: 0` for slots inside elevated buildings
      // (Britain Bank floor sits at z=20). Snap to standing surface so
      // the vendor never spawns under the floor.
      const map = pos.map ?? 1;
      let z = pos.z | 0;
      if (z === 0) {
        try {
          const standZ = resolveStandingZ(api, map, pos.x, pos.y, 0);
          if (Number.isFinite(standZ)) z = standZ;
        } catch { /* fall back to caller's z */ }
      }
      // Personal name picked from the human male/female pool when the
      // caller didn't supply a fixed name (named regional NPCs pass
      // `pos.name` to keep canon characters like "Hawkins"). The vendor
      // archetype lives in `mob.vendorKind` + `mob.title`; the displayed
      // name is the individual ("Hawkins", "Aldwin", etc.) so towns
      // stop being staffed by twenty identical "a banker"s.
      let displayName = pos.name ?? null;
      if (!displayName) {
        const tmp = { body: kind.body };
        displayName = api.names?.pickForMob?.(tmp) ?? kind.name;
      }
      const mob = createMobile(api, world, {
        name: displayName, body: kind.body, hue: kind.hue ?? 0,
        x: pos.x, y: pos.y, z, map,
        notoriety: 1,
      });
      mob.vendorKind = resolvedKey;
      if (kind.faction) mob.faction = kind.faction;
      // Title is the role suffix ("the banker"); spawnAt callers can
      // override via pos.title (regional NPCs use "the banker of Britain").
      mob.title = pos.title ?? kind.title ?? kindKey;
      // Dress before reattach so the broadcast frame below carries the
      // worn equipment in the mobileIncoming payload (otherwise client
      // sees a naked vendor until the next equip update). Civic NPCs
      // were universally bald-naked because reattachExisting only
      // wires registry + AI — not outfit.
      applyVendorOutfit(api, world, mob, kindKey);
      // Bind only the newly created vendor. The old all-world reattach here
      // rebuilt a worn-item index and scanned every mobile 141 times during
      // regional NPC bootstrap (quadratic cold-start cost).
      reattachExisting(mob, true);
      // Override AI behavior when the npcs.json template declares one.
      // reattachExisting attaches the generic 'vendor' behavior; if the
      // NPC catalog template names a more specific one (e.g. 'healer',
      // 'townCrier', 'bard') and that behavior is registered, swap it
      // in. attach() is a Map.set — last write wins. Unknown behavior
      // names fall through silently so editing npcs.json can't crash
      // the spawn path.
      const tmpl = api.npcs?.get?.(kindKey);
      const wantBehavior = tmpl?.behavior;
      if (wantBehavior && wantBehavior !== 'vendor' && api.ai?.attach) {
        try { api.ai.attach(mob, wantBehavior); }
        catch { /* unknown behavior — keep the default 'vendor' */ }
      }
      // Broadcast presence to anyone already in range — INCLUDING the
      // worn-equipment payload so observers don't see a naked frame
      // until the next 0x77 movement broadcast. Build the equipment
      // list from items parented to this mob with a non-zero layer.
      const equipment = [];
      for (const it of equipped(api, mob)) {
        if (!it.layer) continue;
        equipment.push({
          serial: it.serial, itemId: it.itemId, layer: it.layer, hue: it.hue ?? 0,
        });
      }
      for (const c of allMobiles({ world })) {
        if (!c.client) continue;
        if (c.map !== mob.map) continue;
        if (Math.abs(c.x - mob.x) > 18 || Math.abs(c.y - mob.y) > 18) continue;
        c.client.send(protocol.mobileIncoming({
          serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction, hue: mob.hue, flags: mob.flags, notoriety: 1,
          equipment,
        }));
      }
      return mob;
    },
  };

  // FAZA BG: stock-rotation timer. Every 10 minutes we re-jitter
  // prices ±10% from baseline so the economy "breathes".
  // Wave 10: also restock depleted entries — half of the gap closes
  // each cycle, full refill after two cycles from zero. SBInfo-driven
  // vendors with finite maxStock benefit; Infinity (hand-authored)
  // vendors no-op since `Infinity - currentStock = NaN` we guard for.
  // Wave 11: broadcast a single short speech line to nearby clients
  // when the vendor refills materially (>=25% of any line, or any
  // previously-empty line comes back). Cooldown 60s per vendor so
  // big restock waves don't spam. The notification reuses the AI's
  // broadcast-speech helper if available; otherwise direct send.
  const NOTIFY_COOLDOWN_MS = 60_000;
  const lastNotifiedAt = new Map();
  const tickVendorRestock = () => {
    for (const mob of allMobiles({ world })) {
      if (!mob.vendorKind) continue;
      const binding = vendors.get?.(mob.serial);
      if (!binding) continue;
      const list = binding.listStock?.();
      if (!Array.isArray(list)) continue;
      let restocked = false;
      let revived = false;     // a previously-zero line came back
      // Wave 12: each stock line carries its own next-restock-at gate.
      // Different items refill on different cycles — a fully-stocked
      // bottle rolls jitter, but a 70%-empty potion line keeps
      // refilling tick after tick until it reaches max. Cooldowns
      // staggered ±20% so the speech lines spread out instead of all
      // firing at once.
      const nowMs = Date.now();
      const PER_LINE_COOLDOWN_MS = 8 * 60_000;     // 8 min minimum between restocks per line
      for (const it of list) {
        const baseline = it._basePrice ?? (it._basePrice = it.price);
        const jitter = 0.9 + Math.random() * 0.2;
        it.price = Math.max(1, Math.floor(baseline * jitter));
        // Restock depleted finite stocks. Infinity caps stay Infinity.
        if (!Number.isFinite(it.maxStock)) continue;
        const gap = it.maxStock - it.currentStock;
        if (gap <= 0) continue;
        // Per-line cooldown — only refill if at least one cycle has passed.
        // Cooldown jitter ±20% (so 8min becomes 6.4..9.6min) to spread events.
        const lineCd = it._nextRestockAt ?? 0;
        if (nowMs < lineCd) continue;
        // Wave 13: weighted refill. Popular items (high _salesCount)
        // refill more aggressively. Multiplier maps salesCount/10 to a
        // 1..3× boost, capped — so a hot-selling potion line restocks
        // 3× faster than a dust-gathering decoration.
        const popularity = Math.min(3, 1 + (it._salesCount ?? 0) / 10);
        const wasZero = it.currentStock === 0;
        const refillSize = Math.ceil((gap / 2) * popularity);
        it.currentStock = Math.min(it.maxStock, it.currentStock + refillSize);
        it.amount = it.currentStock;
        // Decay the sales counter so a once-popular item that fell out
        // of fashion eventually returns to baseline cadence.
        it._salesCount = Math.max(0, (it._salesCount ?? 0) - Math.ceil((it._salesCount ?? 0) / 4));
        const refilled = it.currentStock - (it.maxStock - gap);
        if (refilled >= Math.ceil(it.maxStock * 0.25)) restocked = true;
        if (wasZero && it.currentStock > 0) revived = true;
        const jitter2 = 0.8 + Math.random() * 0.4;
        // Popular items also have shorter cooldown so the next cycle
        // can apply yet again. /popularity scales the gate inversely.
        it._nextRestockAt = nowMs + Math.floor(PER_LINE_COOLDOWN_MS * jitter2 / popularity);
      }
      if (!restocked && !revived) continue;
      const lastAt = lastNotifiedAt.get(mob.serial) ?? 0;
      const now = Date.now();
      if (now - lastAt < NOTIFY_COOLDOWN_MS) continue;
      lastNotifiedAt.set(mob.serial, now);
      const line = revived
        ? 'Fresh stock has just arrived!'
        : 'I have restocked some wares.';
      // Push to nearby clients. The AI tick already has a broadcast
      // helper; we duplicate it here so the timer doesn't have to
      // wait for the next AI tick to speak.
      if (api.protocol?.unicodeMessage) {
        const pkt = api.protocol.unicodeMessage({
          serial: mob.serial, graphic: mob.body, type: 0,
          hue: 0x03B2, font: 3, language: 'ENU', name: mob.name, text: line,
        });
        for (const m of allMobiles({ world })) {
          if (!m.client || m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 12 || Math.abs(m.y - mob.y) > 12) continue;
          m.client.send(pkt);
        }
      }
    }
  };
  const restockTimer = api.lifecycle?.setInterval?.(tickVendorRestock, 10 * 60_000)
    ?? setInterval(tickVendorRestock, 10 * 60_000);
  if (typeof restockTimer.unref === 'function') restockTimer.unref();

  // Wave 16: title decay. Vendors that go a full real-time day without
  // a buy lose 5% of their lifetime buys (rounded up) and re-evaluate
  // tier. Stops a Grandmaster from being grandfathered in forever
  // after the player base moves on. Runs hourly — fine-grained enough
  // to evict on a 24h boundary, coarse enough to be cheap.
  const TITLE_DECAY_INTERVAL_MS = 60 * 60_000;
  const TITLE_DECAY_IDLE_MS = 24 * 60 * 60_000;
  const tickVendorTitleDecay = () => {
    const now = Date.now();
    for (const mob of allMobiles({ world })) {
      if (!mob.vendorKind) continue;
      if (!mob._lifetimeBuys || mob._lifetimeBuys < 50) continue;
      const log = mob._transactionLog;
      const lastTs = log?.length ? log[log.length - 1].ts : 0;
      if (now - lastTs < TITLE_DECAY_IDLE_MS) continue;
      const before = mob._lifetimeBuys;
      mob._lifetimeBuys = Math.max(0, mob._lifetimeBuys - Math.ceil(mob._lifetimeBuys * 0.05));
      if (mob._lifetimeBuys !== before) refreshVendorTitle(mob, { protocol, world });
    }
  };
  const titleDecayTimer = api.lifecycle?.setInterval?.(tickVendorTitleDecay, TITLE_DECAY_INTERVAL_MS)
    ?? setInterval(tickVendorTitleDecay, TITLE_DECAY_INTERVAL_MS);
  if (typeof titleDecayTimer.unref === 'function') titleDecayTimer.unref();

  for (const [name, kind, help] of cmdSpecs) {
    commands.register({
      name,
      help,
      hidden: name !== 'vendor',
      run: (ctx, args) => {
        if (name !== 'vendor') {
          spawnVendor(kind, ctx);
          return;
        }
        const requested = String(args?.[0] ?? '').trim().toLowerCase();
        if (requested === 'list' || requested === 'search') {
          const query = requested === 'search' ? args.slice(1).join(' ') : '';
          const names = searchVendorCatalog(query).map((entry) => entry.key);
          ctx.state.sendSystemMessage?.(`Vendor kinds (${names.length}):`);
          for (let i = 0; i < names.length; i += 18) {
            ctx.state.sendSystemMessage?.(`  ${names.slice(i, i + 18).join(', ')}`);
          }
          return;
        }
        spawnVendor(requested || kind, ctx);
      },
    });
  }

  return () => {
    for (const [name] of cmdSpecs) commands.unregister(name);
    api.ai?.unregisterBehavior?.('vendor');
    // BUGFIX #27 (FAZA BK): the restock timer was left running across
    // script hot-reloads, accumulating one extra setInterval per reload.
    // After 10 saves the price-jitter loop fired 11× per cycle and
    // closed-over a stale `vendors` reference, mistinting prices and
    // leaking memory. Clear it in the disposer so hot-reload is idempotent.
    clearInterval(restockTimer);
    clearInterval(titleDecayTimer);
  };
}
