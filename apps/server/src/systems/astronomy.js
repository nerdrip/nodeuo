// Astronomy — port of ServUO `Scripts/Services/Astronomy/`. Tracks the
// in-world night sky: 8 constellations rotating across the year, two
// moons (Trammel + Felucca) with independent phase cycles. The visible
// constellation depends on month + facet; phases tick every 2h ServUO
// time.

const CONSTELLATIONS = [
  'The Mage',     'The Forge',    'The Tower',    'The Serpent',
  'The Lantern',  'The Ankh',     'The Wisp',     'The Lantern Lord',
];

// 8 phases, one per 2h-of-day stride (16 ServUO hours / 2 = 8 slots).
const PHASES = [
  'New', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
  'Full', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent',
];

// In-world day = 2h real (CUO accelerated cycle). Two-moon offset:
// Trammel leads Felucca by 4 phase slots so both are rarely full at
// the same time.
const DAY_MS = 2 * 60 * 60 * 1000;
const PHASE_MS = DAY_MS / PHASES.length;

export function moonPhases(now = Date.now()) {
  const slot = Math.floor(now / PHASE_MS);
  return {
    trammel: PHASES[(slot) & 7],
    felucca: PHASES[((slot + 4) & 7)],
  };
}

export function visibleConstellation(now = Date.now(), facet = 0) {
  // Drift constellation index by `dayOfYear` so it shifts ~weekly.
  const day = Math.floor(now / DAY_MS);
  return CONSTELLATIONS[((day + facet) % CONSTELLATIONS.length + CONSTELLATIONS.length) % CONSTELLATIONS.length];
}

/** Pretty-print for `[sky` command. */
export function describeSky(now = Date.now(), facet = 0) {
  const m = moonPhases(now);
  const c = visibleConstellation(now, facet);
  return `Trammel: ${m.trammel}.  Felucca: ${m.felucca}.  Constellation: ${c}.`;
}

// ----------------------------------------------------------------------
// Astronomy quest content — port of ServUO `Services/Astronomy/`.
//
// Players use a Telescope item to log observations of the 8 constellations.
// Once all 8 have been logged the player turns the ledger in to Willebrord
// for the Astronomer title deed + Anniversary 21st reward bag. Brass
// Orrery is a placed addon that lets you preview the current sky without
// leaving the house.
// ----------------------------------------------------------------------

/**
 * Per-mobile observation ledger. Stored on the mobile under
 * `_astronomyLedger = { observed: Set<string>, completedAt?: number }`.
 */
export function ensureLedger(mob) {
  if (!mob._astronomyLedger) {
    mob._astronomyLedger = { observed: new Set(), completedAt: 0 };
  }
  return mob._astronomyLedger;
}

/** Returns true when the mob just observed a *new* constellation. */
export function observe(mob, now = Date.now(), facet = 0) {
  const ledger = ensureLedger(mob);
  const c = visibleConstellation(now, facet);
  const before = ledger.observed.size;
  ledger.observed.add(c);
  if (ledger.observed.size === CONSTELLATIONS.length && !ledger.completedAt) {
    ledger.completedAt = now;
  }
  return { constellation: c, newEntry: ledger.observed.size > before, totalLogged: ledger.observed.size, totalAvailable: CONSTELLATIONS.length };
}

export function listAllConstellations() { return [...CONSTELLATIONS]; }

export function ledgerSummary(mob) {
  const ledger = ensureLedger(mob);
  return {
    observed: [...ledger.observed],
    remaining: CONSTELLATIONS.filter((c) => !ledger.observed.has(c)),
    complete: ledger.observed.size === CONSTELLATIONS.length,
    completedAt: Number(ledger.completedAt) || 0,
  };
}

/** Turn the ledger in — returns reward descriptor or null when incomplete. */
export function turnInLedger(mob) {
  const summary = ledgerSummary(mob);
  if (!summary.complete) return null;
  // Mark the ledger consumed so the player can't turn it in twice.
  if (mob._astronomyTitleClaimed) return null;
  mob._astronomyTitleClaimed = true;
  return {
    title: 'Astronomer',
    rewardItem: 'astronomer-title-deed',
    rewardBag: 'anniversary-21-bag',
  };
}
