// Pet hunger / loyalty tick.
//
// ServUO `BaseCreature.cs` ticks `hunger` and `loyalty` on a long timer
// (~hour). When loyalty hits 0 the pet goes wild. We boil this down to:
//   - hunger: 0..20, decays 1/min by default (faster for larger pets)
//   - loyalty: 0..100, decays 1/15min while hunger is 0; recovers
//     1/5min while well-fed (hunger >= 10).
//   - notify the master via system message at thresholds (hungry, very
//     hungry, unhappy, will-go-wild).
//   - on loyalty 0 → release: clear controlMaster + revert to wild
//     wander/aggressive behavior depending on the creature kind.
//
// Tick is driven from main.js's regen loop (already runs every second).
// We accumulate fractional decay per-second so the cadence above stays
// consistent without a dedicated timer.

const HUNGER_DECAY_PER_SEC = 1 / 60;     // 1 hunger per 60s
const LOYALTY_DECAY_PER_SEC = 1 / (15 * 60); // when starving
const LOYALTY_GAIN_PER_SEC  = 1 / (5 * 60);  // when well-fed
const HUNGRY_THRESHOLD     = 5;
const VERY_HUNGRY          = 2;
const STARVING             = 0;

// ServUO `BaseCreature.LoyaltyTimer` equivalent. The actual cadence is
// fractional per-second so it stays cheap in Node while preserving drift.
export const ServUOPetLoyaltyClasses = Object.freeze(['BaseCreature', 'LoyaltyTimer', 'FKEntry']);

/**
 * Tick every owned creature on `world`. Skip players (those with .client)
 * and untamed mobiles (no controlMaster).
 *
 * @param {import('../world/world.js').World} world
 * @param {number} dtSec  seconds since last tick (typically 1.0)
 */
/**
 * Register a pet in the world's reverse index. Call from tame/hire/summon
 * paths so tickPetHunger() walks a 50-entry Set instead of the 11.7k mob
 * map. Idempotent — safe to call on every controlMaster assignment.
 */
export function registerPet(world, mob) {
  if (!world) return;
  world._pets ||= new Set();
  world._pets.add(mob.serial);
}
/** Drop a pet from the reverse index. */
export function unregisterPet(world, mob) {
  if (!world?._pets) return;
  world._pets.delete(mob.serial);
}

export function tickPetHunger(world, dtSec = 1) {
  // Fast path — walk the explicit pet index. Falls back to a full
  // scan when the index doesn't exist (tests build worlds without
  // going through tame/hire paths). The fallback ALSO lazily populates
  // the index so subsequent ticks take the fast path.
  if (world._pets && world._pets.size > 0) {
    for (const serial of [...world._pets]) {
      const m = world.mobiles.get(serial);
      if (!m || !m.controlMaster || m.client) { world._pets.delete(serial); continue; }
      _stepPet(world, m, dtSec);
    }
    return;
  }
  for (const m of world.mobiles.values()) {
    if (m.client) continue;
    if (!m.controlMaster) continue;
    // Lazy-build the index so the next tick uses the fast path.
    if (world._pets) world._pets.add(m.serial);
    _stepPet(world, m, dtSec);
  }
}

function _stepPet(world, m, dtSec) {
  // Initialise on first tick.
  if (m.hunger == null)  m.hunger = 18;
  if (m.loyalty == null) m.loyalty = 100;
  // Hunger decay.
  const prevHunger = m.hunger;
  m.hunger = Math.max(0, m.hunger - HUNGER_DECAY_PER_SEC * dtSec);
  // Loyalty drift.
  if (m.hunger <= STARVING) {
    m.loyalty = Math.max(0, m.loyalty - LOYALTY_DECAY_PER_SEC * dtSec);
  } else if (m.hunger >= 10) {
    m.loyalty = Math.min(100, m.loyalty + LOYALTY_GAIN_PER_SEC * dtSec);
  }
  // Threshold notifications.
  if (prevHunger > HUNGRY_THRESHOLD && m.hunger <= HUNGRY_THRESHOLD) {
    notifyMaster(world, m, `${m.name ?? 'Your pet'} is hungry.`);
  } else if (prevHunger > VERY_HUNGRY && m.hunger <= VERY_HUNGRY) {
    notifyMaster(world, m, `${m.name ?? 'Your pet'} is very hungry!`);
  } else if (prevHunger > STARVING && m.hunger <= STARVING) {
    notifyMaster(world, m, `${m.name ?? 'Your pet'} is starving!`);
  }
  // Loyalty zero → go wild. Drop the pet from the world's index so the
  // next tick skips it without a re-check.
  if (m.loyalty <= 0 && m.controlMaster) {
    notifyMaster(world, m, `${m.name ?? 'Your pet'} no longer trusts you and has wandered off.`);
    m.controlMaster = null;
    m.party = null;
    m.controlOrder = null;
    unregisterPet(world, m);
  }
}

/** Reset hunger to full when the pet eats food. Caller is expected to be
 *  the food item's onUse hook. */
export function feedPet(pet, satiation = 12) {
  if (pet.hunger == null) pet.hunger = 0;
  pet.hunger = Math.min(20, pet.hunger + satiation);
  // Audit #34 P2 #3 — ServUO `BaseCreature.cs:3210` SE-era branch sets
  // `Loyalty = MaxLoyalty` on every feed. Was missing; a pet with
  // bleeding loyalty (from repeated damage) could never recover. The
  // visual feedback (system message) matches ServUO's "Your pet looks
  // happier" cliloc 1043238.
  if ((pet.loyalty | 0) < 100) {
    pet.loyalty = 100;
    pet.controlMasterClient?.sendSystemMessage?.('Your pet looks happier.');
  }
}

// ServUO BaseCreature.BondingDelay = 7 days. Auto-promotes a pet to
// bonded once tameSince has been set for the full duration.
const BONDING_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Sweep the pet index and promote any creature past the 7-day bonding
 * delay to `bonded = true`. Idempotent — already-bonded pets are
 * skipped. Cheap O(|_pets|). Run from main.js's slow timer (1h
 * cadence — sub-day precision is fine for a 7-day window).
 */
export function sweepBondingPromotions(world, now = Date.now()) {
  if (!world?._pets) return 0;
  let promoted = 0;
  for (const serial of world._pets) {
    const m = world.mobiles.get(serial);
    if (!m || !m.controlMaster) continue;
    if (m.bonded) continue;
    // ServUO BaseCreature.cs BondingDelay = 7 days. We were doing
    // `tameSince | 0` which truncates a ~1.78e12 Date.now() ms timestamp
    // to a small int32, so `(now - since)` always exceeded 7 days →
    // every pet bonded on the first hourly sweep. Use `?? 0` to keep
    // the full precision and the legacy-stamp branch.
    const since = m.tameSince ?? 0;
    if (since <= 0) {
      m.tameSince = now;
      continue;
    }
    if (now - since < BONDING_DELAY_MS) continue;
    m.bonded = true;
    promoted++;
    const master = world.mobiles.get(m.controlMaster >>> 0);
    if (master?.client?.sendSystemMessage) {
      master.client.sendSystemMessage(`${m.name ?? 'Your pet'} has bonded with you.`);
    }
  }
  return promoted;
}

function notifyMaster(world, pet, msg) {
  const master = world.mobiles.get(pet.controlMaster);
  if (master?.client?.sendSystemMessage) master.client.sendSystemMessage(msg);
}
