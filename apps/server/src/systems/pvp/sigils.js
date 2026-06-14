// FAZA EI — faction sigils.
//
// ServUO `Engines/Factions/Core/Sigil.cs`: 5 town sigils (Britain,
// Magincia, Minoc, Trinsic, Yew). Holding a sigil for 10 minutes
// "corrupts" the town to your faction. Carrying a sigil drops your
// notoriety to 4 (criminal-like) so PvP becomes legal everywhere.
//
// We track sigils as world singletons with the carrier's serial +
// pickup timestamp. The corruption check fires from a tick (caller's
// responsibility — we expose `tickCorruption(now)`).

const TOWNS = ['britain', 'magincia', 'minoc', 'trinsic', 'yew'];
// Audit #43 P1-5 — ServUO `Services/Factions/Items/Sigil.cs:17`
// `CorruptionPeriod = TimeSpan.FromHours(10.0)`. Was 10 MINUTES → a
// faction raider could flip a town over a lunch break. Now 10 hours.
const CORRUPTION_MS = 10 * 60 * 60 * 1000;

/** @type {Map<string, {town: string, carrier: number|null, pickedUpAt: number, owner: string|null, corruptedAt: number|null, x?:number, y?:number, map?:number}>} */
const sigils = new Map();

export function registerSigil(town, x, y, map = 1) {
  if (!TOWNS.includes(town)) throw new Error(`unknown town: ${town}`);
  sigils.set(town, {
    town, carrier: null, pickedUpAt: 0,
    owner: null, corruptedAt: null,
    x, y, map,
  });
}

export function getSigil(town) { return sigils.get(town) ?? null; }
export function listSigils() { return [...sigils.values()]; }

/** Audit #34 P3 #7 — ServUO `StuckMenu.cs:319` and the Recall/Gate/
 *  SacredJourney `CheckCast` paths refuse long-distance teleport when
 *  the player carries any Town Sigil. Cheap O(|sigils|) lookup keyed
 *  by carrier serial. Previously the carrier could `[stuck` or Recall
 *  away with the sigil and escape the faction-stronghold defenders. */
export function isSigilCarrier(mobSerial) {
  for (const s of sigils.values()) {
    if (s.carrier && s.carrier === mobSerial) return true;
  }
  return false;
}

export function pickup(town, mobSerial, now = Date.now()) {
  const s = sigils.get(town);
  if (!s) return { ok: false, reason: 'no-such-sigil' };
  if (s.carrier && s.carrier !== mobSerial) return { ok: false, reason: 'already-held' };
  s.carrier = mobSerial;
  s.pickedUpAt = now;
  return { ok: true, sigil: s };
}

export function drop(town, mobSerial) {
  const s = sigils.get(town);
  if (!s) return { ok: false, reason: 'no-such-sigil' };
  if (s.carrier !== mobSerial) return { ok: false, reason: 'not-carrier' };
  s.carrier = null;
  s.pickedUpAt = 0;
  return { ok: true };
}

/**
 * If carrier has held the sigil long enough, mark corruption. `factionFor`
 * resolves a mobile serial to a faction id (or null).
 *
 * BUGFIX #127 (FAZA HM): every faction member should hear "{Town}
 * has been corrupted by {Faction}!" when the rite completes —
 * faction warfare without that announcement felt invisible. Caller
 * passes an optional `broadcast(message)` callback (main.js wires it
 * to a server-wide unicode message fan-out).
 */
export function tickCorruption(now, factionFor, broadcast = null) {
  const corrupted = [];
  for (const s of sigils.values()) {
    if (!s.carrier) continue;
    if (now - s.pickedUpAt < CORRUPTION_MS) continue;
    const faction = factionFor?.(s.carrier);
    if (!faction) continue;
    if (s.owner === faction) continue;
    s.owner = faction;
    s.corruptedAt = now;
    corrupted.push(s);
    if (broadcast) {
      try {
        const town = s.town.charAt(0).toUpperCase() + s.town.slice(1);
        broadcast(`${town} has been corrupted by ${faction}!`);
      } catch { /* best-effort */ }
    }
  }
  return corrupted;
}

export function _resetForTest() { sigils.clear(); }

export const _SIGIL_CONST = Object.freeze({ TOWNS, CORRUPTION_MS });
