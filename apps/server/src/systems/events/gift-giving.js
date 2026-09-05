// Gift Giving — port of ServUO `Scripts/Services/GiftGiving/`. Holiday
// event scaffolding: enrol players for a gift on first-login during a
// window, deliver via in-game mail (or directly to pack on next login).
//
// Events (date windows are UTC):
//   Yule       Dec 18 → Jan 02   → year-rotating Yule Gift Box
//   Easter     Mar 25 → Apr 10   → "Easter Basket" with chocolate eggs
//   Halloween  Oct 28 → Nov 02   → "Halloween Treat Bag" with candy
//   Anniversary  Sep 24 → Oct 04 → year-rotating Anniversary item
//
// Caller (login handler) calls `tryDeliver(world, mob, now)` once on
// world entry; it returns the gift item descriptor (or null).
//
// Phase H.4 — historical Yule + Anniversary catalogs (2004-2025).
// Each year's gift is canonically different per ServUO `GiftGiving/`
// year stamps. Lookup by UTC year of `now`. Falls back to the generic
// item when year is out of range.

/** Per-year Yule gift item kinds (ServUO `GiftGiving/Yule*.cs`). */
const YULE_BY_YEAR = {
  2004: 'yule-snowman-ornament',
  2005: 'yule-candle-trio',
  2006: 'yule-frosted-acorn',
  2007: 'yule-crystal-snowflake',
  2008: 'yule-snow-globe',
  2009: 'yule-stocking',
  2010: 'yule-gingerbread-cookie',
  2011: 'yule-festive-wreath',
  2012: 'yule-holly-garland',
  2013: 'yule-silver-bell',
  2014: 'yule-mistletoe',
  2015: 'yule-spruce-sapling',
  2016: 'yule-icicle-ornament',
  2017: 'yule-reindeer-figurine',
  2018: 'yule-spinning-top',
  2019: 'yule-music-box-festive',
  2020: 'yule-snow-painting',
  2021: 'yule-glass-bauble',
  2022: 'yule-tinsel-strand',
  2023: 'yule-glowing-lantern',
  2024: 'yule-crystal-tree',
  2025: 'yule-aurora-pendant',
};

/** Per-year Anniversary token kinds (ServUO `GiftGiving/Anniversary*.cs`). */
const ANNIVERSARY_BY_YEAR = {
  2004: 'anniv-7-statuette',
  2005: 'anniv-8-tapestry',
  2006: 'anniv-9-painting',
  2007: 'anniv-10-bronze-token',
  2008: 'anniv-11-silver-token',
  2009: 'anniv-12-gold-token',
  2010: 'anniv-13-rare-cloak',
  2011: 'anniv-14-virtue-shield',
  2012: 'anniv-15-mountainous-cake',
  2013: 'anniv-16-platinum-token',
  2014: 'anniv-17-statue',
  2015: 'anniv-18-mastery-tome',
  2016: 'anniv-19-bone-throne',
  2017: 'anniv-20-crystal-cake',
  2018: 'anniv-21-celestial-orb',
  2019: 'anniv-22-spectral-cloak',
  2020: 'anniv-23-feather-quill',
  2021: 'anniv-24-empire-medal',
  2022: 'anniv-25-jade-coin',
  2023: 'anniv-26-runic-banner',
  2024: 'anniv-27-shrine-bell',
  2025: 'anniv-28-prismatic-talisman',
};

const EVENTS = [
  { id: 'yule',       startMD: [12, 18], endMD: [ 1,  2], gift: 'yule-gift-box',         catalog: YULE_BY_YEAR },
  { id: 'easter',     startMD: [ 3, 25], endMD: [ 4, 10], gift: 'easter-basket' },
  { id: 'halloween',  startMD: [10, 28], endMD: [11,  2], gift: 'halloween-treat-bag' },
  { id: 'anniversary',startMD: [ 9, 24], endMD: [10,  4], gift: 'anniversary-cake',      catalog: ANNIVERSARY_BY_YEAR },
];

function inWindow(d, ev) {
  const m = d.getUTCMonth() + 1, day = d.getUTCDate();
  const [sm, sd] = ev.startMD, [em, ed] = ev.endMD;
  // Cross-year window (Dec → Jan): special-case.
  if (sm > em || (sm === em && sd > ed)) {
    return (m > sm || (m === sm && day >= sd))
        || (m < em || (m === em && day <= ed));
  }
  return (m > sm || (m === sm && day >= sd))
      && (m < em || (m === em && day <= ed));
}

export function activeEvent(now = Date.now()) {
  const d = new Date(now);
  return EVENTS.find((e) => inWindow(d, e)) ?? null;
}

export function listEvents() { return EVENTS; }

/** Resolve the year-specific gift kind. Falls back to ev.gift when
 *  no catalog or year-not-found. ServUO `GiftGiving/Yule<Year>.cs`. */
export function giftForYear(ev, year) {
  if (!ev) return null;
  return ev.catalog?.[year] ?? ev.gift;
}

/** Deliver a gift if eligible. Idempotent per (mob, event, year) —
 *  yearly gifts are re-issuable across years (a player who got the
 *  2024 Yule still receives the 2025 one). */
export function tryDeliver(world, mob, now = Date.now()) {
  if (!mob || !world) return null;
  const ev = activeEvent(now);
  if (!ev) return null;
  const year = new Date(now).getUTCFullYear();
  if (!(mob._giftsClaimed instanceof Set)) {
    mob._giftsClaimed = new Set(Array.isArray(mob._giftsClaimed) ? mob._giftsClaimed : []);
  }
  // Year-stamped key — `yule:2025`, `anniversary:2025` etc. — so the
  // 2025 Yule gift doesn't block the 2026 one.
  const key = ev.catalog ? `${ev.id}:${year}` : ev.id;
  if (mob._giftsClaimed.has(key)) return null;
  mob._giftsClaimed.add(key);
  return { event: ev.id, gift: giftForYear(ev, year), year };
}

/** Browse the full historical catalog. Used by admin tooling. */
export function historicalCatalog() {
  return {
    yule:        { ...YULE_BY_YEAR },
    anniversary: { ...ANNIVERSARY_BY_YEAR },
  };
}
