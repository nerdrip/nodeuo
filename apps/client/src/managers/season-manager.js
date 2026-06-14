// SeasonManager — per-tile foliage/static graphic remap by season.
// Mirrors CUO `Game/Managers/SeasonManager.cs`.
//
// Server pushes 0xBC Season (kind, cursor). We track the active season
// and expose `remapStatic(graphicId)` which the tile renderer can call
// when mounting statics so winter strips foliage to bare branches and
// fall recolours leaves to amber.
//
// We populate the remap dictionary lazily on first use from
// `assets.tiledata.statics` — every static with the Foliage flag (0x40
// or 0x20000) collapses to the canonical "stump" graphic 0x0CCB during
// winter / desolation. Hand-curated seed entries cover the
// classic-Britannia trunk groups too in case tiledata isn't available
// at lookup time.

import { bus } from '../core/event-bus.js';
import { assets } from '../assets/asset-manager.js';
import { world } from '../world/world.js';

export const Season = Object.freeze({
  Spring: 0, Summer: 1, Fall: 2, Winter: 3, Desolation: 4,
});

// Hand-curated seed (used until tiledata-driven remap is populated).
const SEED_TREE_TO_STUMP = new Map([
  [0x0CCA, 0x0CCB], [0x0CCB, 0x0CCB], [0x0CCC, 0x0CCB],
  [0x0CCD, 0x0CCB], [0x0CCE, 0x0CCB], [0x0CCF, 0x0CCB],
  [0x0CD0, 0x0CCB], [0x0CD1, 0x0CCB], [0x0CD2, 0x0CCB],
  [0x0CD3, 0x0CCB], [0x0CD4, 0x0CCB], [0x0CD5, 0x0CCB],
  [0x0CD6, 0x0CCB], [0x0CD7, 0x0CCB], [0x0CD8, 0x0CCB],
  [0x0CD9, 0x0CCB], [0x0CDA, 0x0CCB], [0x0CDB, 0x0CCB],
]);

// Filled from tiledata on first lookup. Built once.
let TREE_TO_STUMP = null;
function buildTable() {
  if (TREE_TO_STUMP) return TREE_TO_STUMP;
  const out = new Map(SEED_TREE_TO_STUMP);
  const statics = assets.tiledata?.statics;
  if (statics) {
    for (let id = 0; id < statics.length; id++) {
      const s = statics[id];
      if (!s) continue;
      const flags = s.flags | 0;
      const isFoliage = (flags & 0x40) !== 0 || (flags & 0x20000) !== 0;
      if (!isFoliage) continue;
      // Don't remap stumps onto themselves.
      if (id === 0x0CCB) continue;
      if (!out.has(id)) out.set(id, 0x0CCB);
    }
  }
  TREE_TO_STUMP = out;
  return TREE_TO_STUMP;
}

class SeasonManager {
  constructor() {
    this.season = Season.Summer;
    this._installed = false;
    this._savedSeason = null;       // remembered when the player dies
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    bus.on('atmosphere:season', (info) => {
      if (info && Number.isFinite(info.season) && info.season !== this.season) {
        this.season = info.season | 0;
        bus.emit('season:changed', { season: this.season });
      }
    });
    // Audit #30 P2 #6 — CUO `PacketHandlers.cs::Death` flips the world
    // to Desolation when the player dies and restores the prior season
    // on resurrect. Without this, ghosts walk through cheery summer.
    bus.on('mobile:death', ({ serial }) => {
      if (!world.player || (serial >>> 0) !== world.player.serial) return;
      if (this.season === Season.Desolation) return;
      this._savedSeason = this.season;
      this.season = Season.Desolation;
      bus.emit('season:changed', { season: this.season });
    });
    bus.on('player:death-status', ({ action }) => {
      // 0x02 = manifest alive (resurrect). Restore whatever season was
      // active before the death flip.
      if (action !== 0x02 || this._savedSeason == null) return;
      this.season = this._savedSeason;
      this._savedSeason = null;
      bus.emit('season:changed', { season: this.season });
    });
  }

  /** Return the graphic to actually paint for `id` given current season.
   *  Falls back to `id` itself when no remap applies. */
  remapStatic(id) {
    if (this.season === Season.Winter || this.season === Season.Desolation) {
      const stump = buildTable().get(id | 0);
      if (stump != null) return stump;
    }
    return id | 0;
  }

  /** Optional hue tint for foliage during fall. Tile-renderer can apply
   *  this on top of the base graphic to recolour without remapping.
   *
   *  Audit rev.4 P3 — extended to cover every season. CUO's foliage
   *  table also recolours summer (deeper green), spring (light green),
   *  and desolation (grey-brown). Winter still uses the stump remap
   *  path (heavier-handed: actual graphic swap, not just tint).
   */
  hueTint(id) {
    if (!buildTable().has(id | 0)) return 0;
    switch (this.season) {
      case Season.Spring:     return 0x024C;   // light green
      case Season.Summer:     return 0x0233;   // deep green
      case Season.Fall:       return 0x0386;   // amber
      case Season.Desolation: return 0x03A8;   // grey-brown ash
      default:                return 0;        // winter swaps to stump
    }
  }
}

export const seasonManager = new SeasonManager();
