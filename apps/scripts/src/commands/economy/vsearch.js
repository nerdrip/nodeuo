// `[vsearch <query>` — Vendor Searching command. Mirrors the
// "Vendor Search Stone" ServUO interaction collapsed to a chat
// command. Token form supports filters:
//
//   min:N         minimum price
//   max:N         maximum price
//   kind:weapon   stock entry kind (weapon, armor, scroll, …)
//   prop:di       magic-property substring (di, reflect, cold-resist)
//   sort:asc      price-asc | price-desc | name
//
// e.g.  [vsearch dagger min:50 max:1000 kind:weapon prop:di sort:asc

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const vendorSearch = api.systems?.vendorSearch;
  if (!vendorSearch) {
    api.log?.('vsearch: vendor search system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'vsearch',
    help: '[vsearch <query> [min:N] [max:N] [kind:X] [prop:Y] [sort:asc|desc|name] — search vendors.',
    access: 'Player',
    run(ctx, args) {
      const argv = args ?? [];
      if ((argv[0] ?? '').toLowerCase() === 'gump') {
        // Phase H.2 — emit sentinel; the client gump builds the query
        // form and re-issues `[vsearch <text> filters` on submit.
        ctx.state.sendSystemMessage?.('@@OPEN_VENDORSEARCH_GUMP@@');
        return;
      }
      const q = { text: '', minPrice: 0, maxPrice: Infinity, limit: 50 };
      const text = [];
      for (const a of argv) {
        const m = String(a).match(/^(min|max|kind|prop|sort):(.+)$/i);
        if (m) {
          const k = m[1].toLowerCase();
          const v = m[2];
          if (k === 'min')      q.minPrice = parseInt(v, 10) | 0;
          else if (k === 'max') q.maxPrice = parseInt(v, 10) | 0;
          else if (k === 'kind') q.kind = v.toLowerCase();
          else if (k === 'prop') q.property = v.toLowerCase();
          else if (k === 'sort') q.sort =
            (v.toLowerCase() === 'asc'  ? 'price-asc' :
             v.toLowerCase() === 'desc' ? 'price-desc' :
             v.toLowerCase());
        } else text.push(a);
      }
      q.text = text.join(' ');
      const results = vendorSearch.searchVendors(api.world, q);
      vendorSearch.renderResultsToSysmsg(ctx.state, results);
    },
  });
  return () => api.commands.unregister('vsearch');
}
