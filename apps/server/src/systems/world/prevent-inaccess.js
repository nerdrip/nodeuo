// PreventInaccess — ServUO `Services/PreventInaccess.cs`. Blocks a
// player from entering a region until they meet a precondition
// (karma, fame, virtue rank, completed quest, age, etc.).
//
// Region scripts declare gates via `setGate(regionName, predicateFn)`;
// the region's `onEnter` calls `check(mob, region)` and if it returns
// false, denies entry + sends the deny reason.
//
// Gates are server-side only and live in-process — they don't need to
// be persisted. Predicates take `(mob, region)` and return either
// `true` (allow) or `{ ok: false, reason: string }` (deny w/ message).

const _gates = new Map(); // regionName → predicate fn

/**
 * Register a precondition gate for a region.
 * @param {string} regionName
 * @param {(mob:any, region:any) => true | {ok:false,reason:string}} predicate
 */
export function setGate(regionName, predicate) {
  if (!regionName || typeof predicate !== 'function') return;
  _gates.set(String(regionName), predicate);
}

export function clearGate(regionName) {
  _gates.delete(String(regionName));
}

export function listGates() {
  return Array.from(_gates.keys());
}

/**
 * Check whether `mob` may enter `region`. Returns true (allowed) or
 * `{ ok: false, reason }` (denied — caller should send `reason` to
 * the player + push them back / refuse the teleport).
 */
export function check(mob, region) {
  if (!mob || !region) return true;
  const name = region.name ?? region.id ?? null;
  if (!name) return true;
  const pred = _gates.get(name);
  if (!pred) return true;
  try {
    const r = pred(mob, region);
    if (r === true || r === undefined) return true;
    if (r && r.ok === false) return r;
    return true;
  } catch (e) {
    console.error(`[prevent-inaccess] ${name} predicate threw:`, e?.message ?? e);
    return true;   // fail-open — don't deny on bug
  }
}

// Common gate factories — composable predicates.

export function requireKarma(min) {
  return (mob) => (mob.karma | 0) >= min
    || { ok: false, reason: `Thy karma is insufficient (need ${min}).` };
}

export function requireFame(min) {
  return (mob) => (mob.fame | 0) >= min
    || { ok: false, reason: `Thy fame is insufficient (need ${min}).` };
}

export function requireQuestComplete(questId) {
  return (mob) => (mob.completedQuests?.has?.(questId) || mob.completedQuests?.includes?.(questId))
    || { ok: false, reason: `Thou must complete the quest "${questId}" first.` };
}

export function requireVirtue(virtueId, minRank) {
  return (mob) => ((mob.virtues?.[virtueId] | 0) >= minRank)
    || { ok: false, reason: `Thy ${virtueId} virtue is insufficient.` };
}

export function requireAccountAge(daysMin) {
  return (mob) => {
    const created = mob.client?.account?.createdAt ?? 0;
    const days = (Date.now() - created) / 86_400_000;
    return days >= daysMin
      || { ok: false, reason: `Account must be at least ${daysMin} days old.` };
  };
}

/** AND-compose predicates: all must pass; first deny wins. */
export function all(...preds) {
  return (mob, region) => {
    for (const p of preds) {
      const r = p(mob, region);
      if (r !== true && r?.ok === false) return r;
    }
    return true;
  };
}
