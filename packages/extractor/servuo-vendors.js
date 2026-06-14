// ServUO vendor inventory extractor — reads every `SB*.cs` under
// `templates/ServUO/Scripts/VendorInfo/` and pulls out the buy/sell
// lists. Output: `apps/scripts/src/data/vendor-inventory.json`.
//
// Each SB-class follows a stable shape:
//   public class SBAlchemist : SBInfo
//   {
//       public class InternalBuyInfo : List<GenericBuyInfo>
//       {
//           public InternalBuyInfo(Mobile m)
//           {
//               Add(new GenericBuyInfo(typeof(RefreshPotion), 15, 10, 0xF0B, 0, true));
//               …
//           }
//       }
//       public class InternalSellInfo : GenericSellInfo
//       {
//           public InternalSellInfo()
//           {
//               Add(typeof(BlackPearl), 3);
//               …
//           }
//       }
//   }
//
// We capture the `typeof(<TypeName>)` + price + stock + itemId + hue
// from each Add() call, plus the simpler sell-side `Add(typeof(T), N)`.
// The result is keyed by the lowercased SB-name (sans "SB" prefix) so
// scripts can look up `vendorInventory.alchemist.buy[]` etc.
//
// Item-name → graphic mapping is recorded for buy lines (we already
// have the literal). For sell lines we leave graphic null and let the
// runtime resolve via item-catalog lookup.

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SBINFO_DIR = join(ROOT, 'templates', 'ServUO', 'Scripts', 'VendorInfo');
const OUT = join(ROOT, 'apps', 'scripts', 'src', 'data', 'vendor-inventory.json');

const RX_BUY = /Add\(\s*new\s+GenericBuyInfo\(\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*(0x[0-9A-Fa-f]+|\d+)/g;
const RX_SELL = /Add\(\s*typeof\(([A-Za-z0-9_]+)\)\s*,\s*(\d+)\s*\)/g;
const RX_CLASS_NAME = /public\s+class\s+(SB[A-Za-z0-9_]+)\s*:\s*SBInfo/;

function num(s) { return /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10); }

function extract(file) {
  const src = readFileSync(file, 'utf8');
  const cmatch = src.match(RX_CLASS_NAME);
  const className = cmatch?.[1] ?? basename(file, '.cs');
  const key = className.replace(/^SB/, '').toLowerCase();

  // Restrict the buy regex to within InternalBuyInfo class — we slice
  // the file by the next `public class` keyword and run the regex on
  // each section.
  const buyRegion = sliceClass(src, 'InternalBuyInfo');
  const sellRegion = sliceClass(src, 'InternalSellInfo');

  const buy = [];
  if (buyRegion) {
    for (const m of buyRegion.matchAll(RX_BUY)) {
      buy.push({
        type: m[1],
        price: num(m[2]),
        stock: num(m[3]),
        itemId: num(m[4]),
        hue: num(m[5]),
      });
    }
  }
  const sell = [];
  if (sellRegion) {
    for (const m of sellRegion.matchAll(RX_SELL)) {
      sell.push({ type: m[1], price: num(m[2]) });
    }
  }
  return { className, key, buy, sell };
}

function sliceClass(src, className) {
  const idx = src.indexOf(`class ${className}`);
  if (idx < 0) return null;
  // Find the matching closing brace of the class body. ServUO's coding
  // style is consistent: `class Name … { … }` with K&R-ish bracing. We
  // count braces from the first `{` after the class keyword until they
  // balance back to zero.
  const open = src.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 1;
  for (let i = open + 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

function run() {
  if (!existsSync(SBINFO_DIR)) {
    console.error(`[servuo-vendors] missing ${SBINFO_DIR}`);
    process.exit(1);
  }
  const files = readdirSync(SBINFO_DIR).filter((f) => f.startsWith('SB') && f.endsWith('.cs'));
  const out = {};
  let totalBuy = 0, totalSell = 0;
  for (const f of files) {
    const r = extract(join(SBINFO_DIR, f));
    if (!r.buy.length && !r.sell.length) continue;
    out[r.key] = { buy: r.buy, sell: r.sell };
    totalBuy += r.buy.length;
    totalSell += r.sell.length;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[servuo-vendors] ${files.length} SB files → ${Object.keys(out).length} vendors, ${totalBuy} buy / ${totalSell} sell entries`);
  console.log(`[servuo-vendors] wrote ${OUT}`);
}

run();
