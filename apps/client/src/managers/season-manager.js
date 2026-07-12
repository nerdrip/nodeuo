// SeasonManager — per-tile foliage/static graphic remap by season.
// Mirrors CUO `Game/Managers/SeasonManager.cs`.
//
// Server pushes 0xBC Season (kind, cursor). We track the active season
// and expose exact static/land remaps generated from CUO's seasons.txt
// defaults. This avoids destructive broad foliage-to-stump replacement.

import { bus } from '../core/event-bus.js';
import { world } from '../world/world.js';
import { SEASON_STATIC_REMAP, SEASON_LAND_REMAP } from '../data/season-data.js';

export const Season = Object.freeze({
  Spring: 0, Summer: 1, Fall: 2, Winter: 3, Desolation: 4,
});

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
        this.season = Math.max(0, Math.min(4, info.season | 0));
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
    const raw = id | 0;
    return SEASON_STATIC_REMAP[this.season]?.[raw] ?? raw;
  }

  remapLand(id) {
    const raw = id | 0;
    return SEASON_LAND_REMAP[this.season]?.[raw] ?? raw;
  }

  /** Canonical season changes are art remaps, not broad hue washes. */
  hueTint(_id) {
    return 0;
  }
}

export const seasonManager = new SeasonManager();
