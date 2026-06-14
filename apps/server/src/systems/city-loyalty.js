// City Loyalty — port of ServUO `Scripts/Services/City Loyalty System/CityLoyaltySystem.cs`.
//
// Players earn loyalty points toward each city by completing quests, donating
// resources, killing local enemies, or defending it. Loyalty unlocks tiered
// rewards (titles, vendor discounts, banner banners, citizenship perks).
//
// Tier table (ServUO):
//   0..2999     Stranger      no benefits
//   3000..5999  Visitor       title only
//   6000..9999  Resident      5% vendor discount
//  10000..14999 Citizen       10% discount + cliloc title
//  15000..23999 Hero          15% + heraldry banner
//  24000..29999 Senator       20% + governance vote
//  30000..      Statesman     25% + Lord/Lady title
//
// Cities (ServUO canonical):
//   Britain, Jhelom, Magincia, Minoc, Moonglow, New Magincia, Nujelm,
//   Skara Brae, Trinsic, Vesper, Yew, Wind, Papua, Delucia.

const CITIES = Object.freeze([
  'Britain', 'Jhelom', 'Magincia', 'Minoc', 'Moonglow', 'NewMagincia',
  'Nujelm', 'SkaraBrae', 'Trinsic', 'Vesper', 'Yew', 'Wind', 'Papua', 'Delucia',
]);

const TIERS = Object.freeze([
  { name: 'Stranger',  min:     0, discount: 0   },
  { name: 'Visitor',   min:  3000, discount: 0   },
  { name: 'Resident',  min:  6000, discount: 0.05 },
  { name: 'Citizen',   min: 10000, discount: 0.10 },
  { name: 'Hero',      min: 15000, discount: 0.15 },
  { name: 'Senator',   min: 24000, discount: 0.20 },
  { name: 'Statesman', min: 30000, discount: 0.25 },
]);

const MAX_POINTS = 50_000;
const DECAY_PER_DAY = 25;        // ServUO uses 0.5%/week — we use a flat ramp

/** Per-account loyalty state. Persists via world saves under `_cityLoyalty`. */
export class CityLoyaltyRegistry {
  constructor() {
    /** @type {Map<string, { city: string, points: number, citizen: boolean, lastTouchedAt: number }[]>} */
    this._data = new Map();
  }

  _row(account, city) {
    if (!CITIES.includes(city)) return null;
    let rows = this._data.get(account);
    if (!rows) { rows = []; this._data.set(account, rows); }
    let row = rows.find((r) => r.city === city);
    if (!row) {
      row = { city, points: 0, citizen: false, lastTouchedAt: Date.now() };
      rows.push(row);
    }
    return row;
  }

  /** Award `points` to (account, city). Returns the new total. */
  award(account, city, points) {
    const row = this._row(account, city);
    if (!row) return 0;
    row.points = Math.min(MAX_POINTS, Math.max(0, row.points + (points | 0)));
    row.lastTouchedAt = Date.now();
    return row.points;
  }

  /** Read current points (0 for unknown account/city). */
  pointsOf(account, city) {
    const rows = this._data.get(account);
    if (!rows) return 0;
    const row = rows.find((r) => r.city === city);
    return row?.points ?? 0;
  }

  /** Tier for the given point value. */
  tierFor(points) {
    let best = TIERS[0];
    for (const t of TIERS) if (points >= t.min) best = t;
    return best;
  }

  /** Tier name + discount fraction for (account, city). */
  status(account, city) {
    const points = this.pointsOf(account, city);
    const tier = this.tierFor(points);
    const rows = this._data.get(account) ?? [];
    const row = rows.find((r) => r.city === city);
    return {
      city, points, tierName: tier.name, discount: tier.discount,
      citizen: !!row?.citizen,
    };
  }

  /** Citizenship — costs 2000 loyalty + locks the player to one city. */
  declareCitizen(account, city) {
    const row = this._row(account, city);
    if (!row) return false;
    if (row.points < 2000) return false;
    // Drop other cities' citizenship
    const rows = this._data.get(account) ?? [];
    for (const r of rows) r.citizen = (r.city === city);
    row.lastTouchedAt = Date.now();
    return true;
  }

  /** Renounce citizenship (free). */
  renounce(account, city) {
    const row = this._row(account, city);
    if (!row || !row.citizen) return false;
    row.citizen = false;
    return true;
  }

  /** Decay rule — call from a daily timer. Reduces points by DECAY_PER_DAY
   *  for accounts that haven't been touched in 7+ days. */
  decay(now = Date.now()) {
    const cutoff = now - 7 * 86400_000;
    for (const rows of this._data.values()) {
      for (const r of rows) {
        if (r.lastTouchedAt > cutoff) continue;
        const days = Math.max(0, Math.floor((now - r.lastTouchedAt) / 86400_000));
        r.points = Math.max(0, r.points - DECAY_PER_DAY * days);
        r.lastTouchedAt = now;
      }
    }
  }

  /** Snapshot for persistence. */
  serialize() {
    const out = {};
    for (const [acc, rows] of this._data) out[acc] = rows.map((r) => ({ ...r }));
    return out;
  }

  /** Restore from persistence. */
  load(snapshot) {
    this._data.clear();
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [acc, rows] of Object.entries(snapshot)) {
      if (!Array.isArray(rows)) continue;
      this._data.set(acc, rows.map((r) => ({ ...r })));
    }
  }
}

export function listCities() { return [...CITIES]; }
export function listTiers()  { return TIERS.map((t) => ({ ...t })); }
