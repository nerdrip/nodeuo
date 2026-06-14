// Region system. Mirrors ServUO's `Server/Region.cs` hierarchy:
//
//   Region (base) → GuardedRegion → TownRegion → DungeonRegion → NoMurderZone
//
// Each tier carries:
//   • a list of axis-aligned rectangles (axis = world tiles, integer)
//   • a `priority` integer — higher wins when tiles overlap
//   • optional flags: noKill, guarded, noMurder, allowGate, blockedSpells,
//     music, ambientSound, type, pvp
//   • optional callbacks: onEnter(mob), onLeave(mob), onSpell(mob, spellId)
//
// API stays backward-compatible with the v1 flat-array implementation:
//   const reg = new RegionRegistry();
//   reg.register({ name:'Britain', map:1, rects:[...], guarded:true, music:'britain1' });
//   reg.at(map, x, y)            → Region[]   (overlapping, ordered)
//   reg.primary(map, x, y)       → Region | null
//   reg.isGuarded(map, x, y)     → boolean

/** @typedef {Object} Rect
 *  @property {number} x1
 *  @property {number} y1
 *  @property {number} x2
 *  @property {number} y2
 */

/** @typedef {Object} Region
 *  @property {string} name
 *  @property {number} map
 *  @property {Rect[]} rects
 *  @property {number} [priority]              higher wins on tile overlap
 *  @property {('base'|'guarded'|'town'|'dungeon'|'nomurder')} [type]
 *  @property {boolean} [noKill]
 *  @property {boolean} [guarded]
 *  @property {boolean} [noMurder]
 *  @property {boolean} [allowGate]
 *  @property {string[]} [blockedSpells]
 *  @property {string} [music]
 *  @property {string} [ambientSound]
 *  @property {number} [season]                  0..4 (Spring/Summer/Fall/Winter/Desolation); pinned on entry
 *  @property {boolean} [pvp]
 *  @property {(mob:object)=>void} [onEnter]
 *  @property {(mob:object)=>void} [onLeave]
 *  @property {(mob:object, spellId:number|string)=>boolean} [onSpell]
 */

const TYPE_DEFAULTS = Object.freeze({
  base:     {},
  guarded:  { guarded: true },
  town:     { guarded: true, noMurder: true, allowGate: true },
  // Dungeons pin Desolation (4) so the client paints the dead-vegetation
  // skin even when shard-wide season is Summer. Per ServUO Region.GetSeason.
  dungeon:  { allowGate: false, pvp: true, season: 4 },
  nomurder: { noMurder: true },
});

export class RegionRegistry {
  constructor() {
    /** @type {Region[]} */
    this.regions = [];
  }

  /**
   * Register a region. Type defaults are applied first, then the caller's
   * own properties override (so `register({ type:'town', noMurder:false })`
   * registers a non-noMurder town if you really mean it).
   */
  register(r) {
    const defaults = r.type ? (TYPE_DEFAULTS[r.type] ?? {}) : {};
    const out = { priority: 0, ...defaults, ...r };
    this.regions.push(out);
    return out;
  }

  /**
   * Find all regions containing the given point. Returned in registration
   * order so the v1 "last match wins" contract still holds.
   */
  at(map, x, y) {
    const out = [];
    for (const r of this.regions) {
      if (r.map !== map) continue;
      for (const rc of r.rects) {
        if (x >= rc.x1 && x <= rc.x2 && y >= rc.y1 && y <= rc.y2) {
          out.push(r);
          break;
        }
      }
    }
    return out;
  }

  /**
   * Highest-priority region at the point. Within equal priority, the
   * last-registered wins (stable v1 behavior).
   */
  primary(map, x, y) {
    const all = this.at(map, x, y);
    if (all.length === 0) return null;
    let best = all[0];
    for (const r of all) {
      const pBest = best.priority | 0;
      const pR    = r.priority | 0;
      if (pR > pBest) best = r;
      else if (pR === pBest) best = r; // later in list wins on tie
    }
    return best;
  }

  /** True when the point is inside any guarded region. */
  isGuarded(map, x, y) {
    return this.at(map, x, y).some((r) => r.guarded);
  }

  /** True when the point is inside any noKill region (combat blocked). */
  isNoKill(map, x, y) {
    return this.at(map, x, y).some((r) => r.noKill);
  }

  /** True when kills here don't count toward the murder counter. */
  isNoMurder(map, x, y) {
    return this.at(map, x, y).some((r) => r.noMurder);
  }

  /** True when recall / gate are permitted *out of* this point. */
  allowGate(map, x, y) {
    const here = this.at(map, x, y);
    if (here.length === 0) return true;
    return here.every((r) => r.allowGate !== false);
  }

  /**
   * Spell-cast permission. Returns true iff every overlapping region
   * permits the spell. `spellRef` may be id (number) or name (string);
   * `region.blockedSpells` is matched against either.
   */
  allowSpellcast(map, x, y, spellRef, mob = null) {
    const here = this.at(map, x, y);
    for (const r of here) {
      if (Array.isArray(r.blockedSpells)) {
        for (const s of r.blockedSpells) {
          if (s === spellRef || (typeof s === 'string' && s === String(spellRef))) return false;
        }
      }
      if (typeof r.onSpell === 'function') {
        try { if (r.onSpell(mob, spellRef) === false) return false; }
        catch { /* ignore */ }
      }
    }
    return true;
  }

  findByName(name, map) {
    for (const r of this.regions) {
      if (r.name !== name) continue;
      if (map != null && r.map !== map) continue;
      return r;
    }
    return null;
  }

  regionType(r) { return r?.type ?? 'base'; }

  runEnterHook(mob, region) {
    if (region?.onEnter) {
      try { region.onEnter(mob); } catch { /* ignore */ }
    }
  }
  runLeaveHook(mob, region) {
    if (region?.onLeave) {
      try { region.onLeave(mob); } catch { /* ignore */ }
    }
  }
}
