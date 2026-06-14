// Vendor Search — port of ServUO `Scripts/Services/Vendor Searching`.
// CUO sends a `0xBF 0x32` request with a search query (item name +
// optional category + price range). The server walks every player vendor
// (NPC sub-class with a stock list) on every facet and returns matching
// entries. Wire here is collapsed to a query function the command layer
// invokes directly + sysmsg renderer; a 0xBF subop hook can be wired
// later when the client gump is on.

/** Walk all spawned mobiles, pick those tagged as `_vendor=true` (set by
 *  the vendor template). Each vendor exposes `_stock` — an array of
 *  `{ itemId, name, price, hue, kind?, props?[] }` entries. We filter by
 *  query terms + optional category/property/sort.
 *
 *  Extended query options:
 *    text       — name substring (space-separated tokens, ALL must match)
 *    minPrice   — minimum price (inclusive)
 *    maxPrice   — maximum price (inclusive)
 *    kind       — exact stock entry `kind` ('weapon', 'armor', 'scroll', …)
 *    property   — magic-property substring (e.g. 'di', 'reflect',
 *                 'cold-resist'). Matches against entry.props joined
 *                 with the entry.label.
 *    sort       — 'price-asc' | 'price-desc' | 'name' (default: insertion)
 *    limit      — cap on result count (1..200, default 50)
 *
 *  Caller decides how to render (sysmsg, gump, etc.). */
export function searchVendors(world, query) {
  const q = String(query?.text ?? '').toLowerCase().trim();
  const minP = Number.isFinite(query?.minPrice) ? query.minPrice | 0 : 0;
  const maxP = Number.isFinite(query?.maxPrice) ? query.maxPrice | 0 : Infinity;
  const limit = Math.max(1, Math.min(200, query?.limit ?? 50));
  const kindFilter = String(query?.kind ?? '').toLowerCase().trim();
  const propFilter = String(query?.property ?? '').toLowerCase().trim();
  const sort = String(query?.sort ?? '').toLowerCase().trim();
  const out = [];

  const tokens = q.split(/\s+/).filter(Boolean);

  for (const npc of world?.mobiles?.values?.() ?? []) {
    if (!npc?._vendor) continue;
    if (!Array.isArray(npc._stock) || npc._stock.length === 0) continue;
    for (const entry of npc._stock) {
      const price = entry.price | 0;
      if (price < minP || price > maxP) continue;
      if (tokens.length > 0) {
        const haystack = `${entry.name ?? ''} ${entry.label ?? ''}`.toLowerCase();
        if (!tokens.every((t) => haystack.includes(t))) continue;
      }
      if (kindFilter && String(entry.kind ?? '').toLowerCase() !== kindFilter) continue;
      if (propFilter) {
        const propHaystack = (Array.isArray(entry.props)
          ? entry.props.join(' ') : '')
          + ' ' + String(entry.label ?? '');
        if (!propHaystack.toLowerCase().includes(propFilter)) continue;
      }
      out.push({
        vendorSerial: npc.serial >>> 0,
        vendorName: npc.name ?? 'a vendor',
        x: npc.x | 0, y: npc.y | 0, z: npc.z | 0, map: npc.map | 0,
        itemId: entry.itemId | 0,
        itemName: entry.name ?? 'item',
        price,
        hue: entry.hue ?? 0,
        amount: entry.amount ?? 1,
        kind: entry.kind ?? null,
        props: Array.isArray(entry.props) ? [...entry.props] : null,
      });
      // No early return — collect first, sort, then trim.
    }
  }
  // Sort.
  if (sort === 'price-asc')       out.sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') out.sort((a, b) => b.price - a.price);
  else if (sort === 'name')       out.sort((a, b) => a.itemName.localeCompare(b.itemName));
  return out.slice(0, limit);
}

/** Render a flat result list to a player's sysmsg stream. Caller (a
 *  command handler) supplies `state` and the world. */
export function renderResultsToSysmsg(state, results) {
  if (!Array.isArray(results) || results.length === 0) {
    state?.sendSystemMessage?.('No matching vendor wares found.');
    return;
  }
  state?.sendSystemMessage?.(`Vendor wares (${results.length}):`);
  for (const r of results.slice(0, 20)) {
    state?.sendSystemMessage?.(
      `  ${r.itemName} — ${r.price}gp @ ${r.vendorName} (${r.x},${r.y})`,
    );
  }
  if (results.length > 20) {
    state?.sendSystemMessage?.(`  …${results.length - 20} more (refine query).`);
  }
}
