// UO facet (map) catalogue. Mirrors ClassicUO `Game/Data/Maps.cs` +
// ServUO `Server/Map.cs`. Tile dimensions come from the canonical maps
// that ship with the extractor; if a custom shard re-extracts with a
// different patch, the JSON manifest in apps/client/public/assets/<facet>/
// `map-meta.json` is the authoritative source — these constants are the
// fallback that the iso editor + admin worldmap UI default to when no
// per-extract metadata is loaded yet.
//
// SHARED MODULE: pure data + a single resolver helper.

export const FACET_FELUCCA   = 0;
export const FACET_TRAMMEL   = 1;
export const FACET_ILSHENAR  = 2;
export const FACET_MALAS     = 3;
export const FACET_TOKUNO    = 4;
export const FACET_TER_MUR   = 5;

/** Tile-coordinate dimensions per facet. `wrap` reflects the few
 *  facets that wrap the player around at the east edge (Felucca,
 *  Trammel) vs the bounded ones (Ilshenar onwards). */
export const FACETS = Object.freeze([
  { id: FACET_FELUCCA,  key: 'felucca',  name: 'Felucca',  width: 7168,  height: 4096, wrap: true  },
  { id: FACET_TRAMMEL,  key: 'trammel',  name: 'Trammel',  width: 7168,  height: 4096, wrap: true  },
  { id: FACET_ILSHENAR, key: 'ilshenar', name: 'Ilshenar', width: 2304,  height: 1600, wrap: false },
  { id: FACET_MALAS,    key: 'malas',    name: 'Malas',    width: 2560,  height: 2048, wrap: false },
  { id: FACET_TOKUNO,   key: 'tokuno',   name: 'Tokuno',   width: 1448,  height: 1448, wrap: false },
  { id: FACET_TER_MUR,  key: 'termur',   name: 'Ter Mur',  width: 1280,  height: 4096, wrap: false },
]);

/** Look up a facet record by numeric id. Returns `null` for unknown
 *  ids so callers can fall back to the runtime mapMeta if available. */
export function facetById(id) {
  return FACETS[id | 0] ?? null;
}

/** Look up a facet by its lower-case key (felucca/trammel/...). */
export function facetByKey(key) {
  const k = String(key ?? '').toLowerCase();
  return FACETS.find((f) => f.key === k) ?? null;
}
