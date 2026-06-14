// Notoriety / karma / murder tracking.
//
// UO's notoriety byte (sent via 0x77 / 0x78 / 0x22) controls the
// nameplate colour the client renders over a mobile. Values:
//
//   1  Innocent  (blue)        — peaceful citizens; killing one is murder
//   2  Ally      (green)       — guild member, party, faction friend
//   3  Animal    (grey)        — non-aggressive wildlife, neutral pets
//   4  Criminal  (grey)        — short-term flagged for theft / harm
//   5  Enemy     (orange)      — guild enemy or aggressive monster
//   6  Murderer  (red)         — 5+ player kills on innocents
//   7  Invulnerable (yellow)   — guards, NPC vendors
//
// We store karma + kills + criminalUntil on the mobile and recompute the
// stored `notoriety` field whenever those change. Per-viewer relative
// notoriety (e.g. an enemy faction member shows orange to your view but
// blue to their own faction) is a FAZA L follow-up — for now everyone
// sees the same colour.

export const NOTO = Object.freeze({
  Innocent:    1,
  Ally:        2,
  Animal:      3,
  Criminal:    4,
  Enemy:       5,
  Murderer:    6,
  Invulnerable: 7,
});

/** Threshold for the murderer flag — ServUO default is 5 short-term kills. */
const MURDER_THRESHOLD = 5;

/** Per-kill decay window. ServUO uses 8 h for short-term + 40 h for the
 *  long-term "perma-red" count. We collapse to a single counter — the
 *  short-term timer drives the murderer flag, so 8 h is enough for the
 *  player-visible behaviour. Each tick of decayMurders() will subtract
 *  one kill from any player whose oldest kill is older than this. */
const MURDER_KILL_DECAY_MS = 8 * 60 * 60 * 1000;

/** Karma / Fame title brackets — mirrors ServUO `Titles.cs`. The first
 *  bracket whose threshold matches in priority order wins. Players
 *  cross a threshold when their karma/fame moves above/below the
 *  bracket boundary, and `adjustKarma()` / `adjustFame()` fire a
 *  one-shot system message announcing the new style.  */
const KARMA_TITLES = [
  { min:  10000, title: 'the Glorious Lord' },
  { min:   5000, title: 'the Honorable' },
  { min:   1250, title: 'the Trustworthy' },
  { max:  -1250, title: 'the Disgraced' },
  { max:  -5000, title: 'the Wicked' },
  { max: -10000, title: 'the Dread Lord' },
];
const FAME_TITLES = [
  { min: 10000, title: 'Renowned' },
  { min:  5000, title: 'Famed' },
  { min:  2500, title: 'Notable' },
  { min:  1250, title: 'Known' },
];

function karmaTitleFor(value) {
  // High-karma brackets first (ascending), then low-karma.
  for (const b of KARMA_TITLES) {
    if (b.min != null && value >= b.min) return b.title;
    if (b.max != null && value <= b.max) return b.title;
  }
  return null;
}
function fameTitleFor(value) {
  for (const b of FAME_TITLES) if (b.min != null && value >= b.min) return b.title;
  return null;
}

/**
 * Adjust karma by `delta` and announce title changes when the player
 * crosses a bracket. Caps at ±10000 per ServUO. Returns the new
 * karma value. Caller does NOT need to call recomputeNotoriety —
 * we do it here when -10000 crosses the murderer threshold.
 */
export function adjustKarma(mob, delta) {
  if (!mob) return 0;
  const before = mob.karma | 0;
  const rawDelta = delta | 0;
  const appliedDelta = (rawDelta > 0 && (mob.karmaLocked || mob.KarmaLocked)) ? 0 : rawDelta;
  const after = Math.max(-10000, Math.min(10000, before + appliedDelta));
  mob.karma = after;
  const tBefore = karmaTitleFor(before);
  const tAfter  = karmaTitleFor(after);
  if (tBefore !== tAfter && mob.client?.sendSystemMessage) {
    mob.client.sendSystemMessage(
      tAfter ? `You are now known as ${mob.name} ${tAfter}.`
             : `You have lost the title "${tBefore}".`);
  }
  // Karma can flip the murderer flag (deeply evil karma → red even
  // without 5 kills).
  if ((before > -10000) !== (after > -10000)) recomputeNotoriety(mob);
  return after;
}

/**
 * Adjust fame by `delta`. Caps at 10000 (ServUO upper bound; fame
 * doesn't go negative). Same title-cross announcement as karma.
 */
export function adjustFame(mob, delta) {
  if (!mob) return 0;
  const before = mob.fame | 0;
  const after = Math.max(0, Math.min(10000, before + (delta | 0)));
  mob.fame = after;
  const tBefore = fameTitleFor(before);
  const tAfter  = fameTitleFor(after);
  if (tBefore !== tAfter && mob.client?.sendSystemMessage) {
    mob.client.sendSystemMessage(
      tAfter ? `Your fame grows — you are now ${tAfter}.`
             : `Your fame fades to obscurity.`);
  }
  return after;
}
export { karmaTitleFor, fameTitleFor };

/**
 * Recompute the mob's stored `notoriety` byte from karma/kills/criminalUntil.
 * Returns the new value. Caller is responsible for re-broadcasting the
 * mobile if the value changed (we don't have the world ref here on purpose
 * — keep this function pure).
 */
export function recomputeNotoriety(mob, now = Date.now()) {
  if (!mob) return NOTO.Animal;

  // Hard-set roles win over derived state.
  if (mob.invulnerable) {
    mob.notoriety = NOTO.Invulnerable;
    return mob.notoriety;
  }

  // Murderer status: 5+ kill counter takes priority over everything else
  // for player mobiles. NPCs ignore this — they keep their template noto.
  if (mob.client) {
    const kills = mob.kills | 0;
    if (kills >= MURDER_THRESHOLD) {
      mob.notoriety = NOTO.Murderer;
      return mob.notoriety;
    }
  }

  // Criminal flag: short-term grey. Set by attacking innocent / theft /
  // casting harm on a blue. Auto-clears after `criminalUntil` timestamp.
  if (mob.criminalUntil && mob.criminalUntil > now) {
    mob.notoriety = NOTO.Criminal;
    return mob.notoriety;
  }
  if (mob.criminalUntil && mob.criminalUntil <= now) {
    // Expired — clear so we don't keep entering this branch.
    mob.criminalUntil = 0;
  }

  // For NPCs/monsters: keep whatever the template assigned (5 = enemy
  // for orcs / liches, 1 = innocent for vendors / townsfolk). For
  // players: default Innocent unless karma is deeply negative.
  if (mob.client) {
    const karma = mob.karma | 0;
    if (karma <= -10000) {
      mob.notoriety = NOTO.Murderer;  // very-evil karma flips red even without kills
    } else {
      mob.notoriety = NOTO.Innocent;
    }
  } else {
    // NPC — preserve the templated notoriety; no mutation.
  }
  return mob.notoriety;
}

/**
 * Compute the notoriety byte the *viewer* should see when they look at
 * `target`. Replaces the old "send the same byte to everyone" pattern so
 * faction enemies, party-mates, guild allies and pet masters all read
 * the right colour.
 *
 * Resolution order (mirrors ServUO `Notoriety.MobileNotoriety`):
 *   1. Yourself                  → Innocent (no nameplate change)
 *   2. Same party                → Ally
 *   3. Same guild / alliance     → Ally
 *   4. Mutual faction enemies    → Enemy
 *   5. target.controlMaster      → Friend's pet inherits master's relation
 *   6. Otherwise                 → target's stored notoriety
 *
 * Pet inheritance: if the target is owned by a player, the pet shows the
 * SAME colour the master would. So a tamer's wolf reads green to the
 * tamer, blue to a stranger, red if the master is a murderer.
 */
export function viewerNotoriety(target, viewer, world = null) {
  if (!target) return NOTO.Animal;
  if (!viewer || target === viewer) return target.notoriety ?? NOTO.Innocent;

  // Pet inheritance — recurse through master so colour follows ownership.
  // BUGFIX #1 (FAZA AF): the previous code read `viewer.world ?? target.world`
  // but mobiles don't carry a `.world` field — it was always undefined,
  // so this whole branch silently no-op'd. Now the world is passed in by
  // callers that have it (AI scheduler, broadcast helpers); a missing
  // world just means we skip the master lookup, which is the same end
  // result as before but explicit.
  if (target.controlMaster && world?.mobiles) {
    const master = world.mobiles.get(target.controlMaster >>> 0);
    if (master && master !== target) {
      const masterNoto = viewerNotoriety(master, viewer, world);
      if (masterNoto === NOTO.Ally || masterNoto === NOTO.Murderer
          || masterNoto === NOTO.Criminal || masterNoto === NOTO.Enemy) {
        return masterNoto;
      }
    }
  }

  // BUGFIX #7 (FAZA AL): the party / guild modules stash their back-
  // pointer on `mob._party` / `mob._guild` (with the underscore — a
  // convention to mark "runtime-only, don't serialise"). The previous
  // notoriety code read `mob.party` / `mob.guild`, so the party-mate
  // and guild-mate checks NEVER matched — even a 5-man group saw each
  // other in orange instead of green. Now we read the same field the
  // owning modules write.
  if (target._party && viewer._party && target._party === viewer._party) {
    return NOTO.Ally;
  }
  if (target._guild && viewer._guild && target._guild === viewer._guild) {
    return NOTO.Ally;
  }

  // BUGFIX #41 (FAZA BY): faction relations were only one-sided — the
  // previous branch returned Enemy for opposing factions but did NOT
  // return Ally for same-faction members. Two players sharing the
  // Council of Mages flag with no guild in common saw each other as
  // Innocent blue instead of faction-green, which broke the entire
  // PvP cooperation flow. Now we honour both directions.
  if (target.faction && viewer.faction) {
    if (target.faction === viewer.faction) return NOTO.Ally;
    return NOTO.Enemy;
  }

  return target.notoriety ?? NOTO.Innocent;
}

/** Post-flag callbacks — content scripts register here to react to a
 *  player going criminal. Used by `apps/scripts/src/spawns/town-guards.js`
 *  to schedule a `GuardedRegion.CallGuards` summon when the flagged
 *  mob is standing inside a guarded city. Each callback runs in a
 *  try/catch so a misbehaving listener can't block flagCriminal. */
const _criminalFlagCallbacks = new Set();

/** Register a `(mob, now)` callback fired immediately after a successful
 *  `flagCriminal()`. Returns an unsubscribe function. */
export function onCriminalFlag(fn) {
  _criminalFlagCallbacks.add(fn);
  return () => _criminalFlagCallbacks.delete(fn);
}

/**
 * Mark a mob as criminal for `durationMs` ms. Used when a player attacks
 * an innocent (and isn't already a murderer), steals, or casts a harmful
 * spell on a blue. Returns true if the flag was actually set or extended.
 */
export function flagCriminal(mob, durationMs = 120_000, now = Date.now()) {
  if (!mob) return false;
  // Murderers don't pick up the criminal flag — they're already worse.
  if ((mob.kills | 0) >= MURDER_THRESHOLD) return false;
  const until = now + durationMs;
  // Bug-hunt #12 B6 — `Date.now()` is ~1.7e12, way past int32. `| 0`
  // truncated to a wraparound negative, so the "extend longer" check
  // always passed. Use `?? 0`.
  if (until <= (mob.criminalUntil ?? 0)) return false;
  mob.criminalUntil = until;
  recomputeNotoriety(mob, now);
  // Fan-out to content scripts (town-guards, etc.). Skip silently when
  // none are registered — keeps the cost zero on cold boot.
  if (_criminalFlagCallbacks.size > 0) {
    for (const cb of _criminalFlagCallbacks) {
      try { cb(mob, now); } catch (e) { console.error('[criminal-flag-cb]', e); }
    }
  }
  return true;
}

/** Audit #35 P2 #9 — ServUO `Mobile.DoBeneficial(target)` calls
 *  `OnBeneficialAct` which flags the actor criminal when the target is
 *  a murderer or already-criminal. Was completely missing — players
 *  freely healed/cured/blessed red farms with zero consequence. Call
 *  from every beneficial-act site (Heal, GHeal, Cure, ArchCure, Bless,
 *  Resurrect, bandage on another mob). */
export function flagBeneficialOnCriminal(caster, target, now = Date.now()) {
  if (!caster || !target || caster === target) return false;
  if (!caster.client) return false;                 // NPC healers are exempt
  // Already-criminal caster: nothing more to escalate.
  if ((caster.criminalUntil ?? 0) > now) return true;
  const targetCriminal = (target.criminalUntil ?? 0) > now
    || (target.kills | 0) >= MURDER_THRESHOLD;
  if (!targetCriminal) return false;
  return flagCriminal(caster, 120_000, now);
}

/**
 * Record a kill of `victim` by `killer`. Increments `killer.kills` if the
 * victim was innocent (the only kill that "counts" for the murderer flag).
 * Caller must re-broadcast the killer if the return value indicates a
 * notoriety change so other clients update their nameplate colour.
 */
export function recordKill(killer, victim, now = Date.now()) {
  if (!killer?.client) return false;          // NPCs don't accumulate murder counts
  if (!victim?.client) return false;          // killing a monster isn't murder
  if (victim === killer) return false;         // suicide doesn't count
  if ((victim.notoriety | 0) !== NOTO.Innocent) return false; // PK only innocents count

  killer.kills = (killer.kills | 0) + 1;
  // Stamp the moment of the most-recent kill. `decayMurders` uses this
  // to subtract a count once `MURDER_KILL_DECAY_MS` has elapsed. ServUO
  // tracks per-kill timestamps; we collapse to "time of latest kill"
  // since the player-visible behaviour (lose 1 count per 8 h while
  // crimes-free) is identical for the realistic threshold range (5..10
  // kills) and the bookkeeping is dramatically cheaper.
  killer._oldestKillAt = killer._oldestKillAt || now;
  killer._latestKillAt = now;
  // BH #12 B7 — ServUO `Mobile.OnKilledBy` debits fame/karma on the
  // killer for murdering an innocent. ~5 % of killer's own fame + 2000
  // karma loss. Without this PK loops never lose social standing.
  const fameLost = Math.floor((killer.fame | 0) * 0.05);
  if (fameLost > 0) adjustFame(killer, -fameLost);
  adjustKarma(killer, -2000);
  const before = killer.notoriety | 0;
  recomputeNotoriety(killer, now);
  return killer.notoriety !== before;
}

/**
 * Walk online players and decay one murder count from any whose oldest
 * unclaimed kill is older than the 8-hour decay window. Returns the
 * count of mobs that lost a kill this pass — main.js logs and reschedules.
 *
 * Intended cadence: every 10 minutes. ServUO runs this on a dedicated
 * timer but for a single-shard Node port we just piggyback on a slow
 * housekeeping loop.
 */
export function decayMurders(world, now = Date.now()) {
  if (!world?.mobiles?.values) return 0;
  let changed = 0;
  for (const mob of world.mobiles.values()) {
    if (!mob.client && !mob.isPlayer) continue;       // players only — NPCs are immune
    if ((mob.kills | 0) <= 0) continue;
    const oldest = mob._oldestKillAt ?? 0;
    if (oldest <= 0) {
      // Legacy data: never recorded a timestamp but still has kills.
      // Stamp 'now' so the next pass evaluates against an honest window.
      mob._oldestKillAt = now;
      continue;
    }
    if (now - oldest < MURDER_KILL_DECAY_MS) continue;
    mob.kills = Math.max(0, mob.kills - 1);
    // Shift the window forward by one decay-tick so we drop ≤1 kill per
    // pass — a long-offline player doesn't snap-clear their entire
    // bounty when they log back in.
    mob._oldestKillAt = oldest + MURDER_KILL_DECAY_MS;
    if (mob.kills === 0) {
      mob._oldestKillAt = 0;
      mob._latestKillAt = 0;
    }
    const before = mob.notoriety | 0;
    recomputeNotoriety(mob, now);
    changed++;
    if (mob.notoriety !== before && mob.client?.sendSystemMessage) {
      try {
        mob.client.sendSystemMessage(
          mob.kills === 0
            ? 'Your reputation has been redeemed.'
            : `Your murder count is now ${mob.kills}.`);
      } catch { /* advisory */ }
    }
  }
  return changed;
}
