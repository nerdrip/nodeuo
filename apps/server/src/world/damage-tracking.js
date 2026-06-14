// DamageEntry tracking — mirrors ServUO `Mobile.DamageEntries` (List<DamageEntry>).
//
// Every blow landed on a mobile records: who hit, for how much, and when. The
// list is used to:
//   - Award loot ownership / kill credit to the top damage dealer (corpse
//     loot lock phase, faction kill record, party XP split).
//   - Decide criminal/aggressor flags — anyone who damaged you within the
//     last 2 minutes is on your "aggressor" list and may be retaliated against
//     without going criminal yourself.
//   - Power the resurrect-by-killer mechanic (a player's killer can be
//     identified by reading the corpse's top damage entry).
//
// Entries older than `EXPIRY_MS` are pruned lazily on `recordDamage` and
// `getTopDamager`. No background timer needed.

const EXPIRY_MS = 5 * 60 * 1000;        // 5 minutes — ServUO default
const MAX_ENTRIES = 64;                  // hard cap so a 100-mob mob can't OOM

/** Append (or merge with the most recent) damage entry for `victim`. */
export function recordDamage(victim, attacker, amount, now = Date.now(), world = null) {
  if (!victim || !attacker || amount <= 0) return;
  if (!victim.damageEntries) victim.damageEntries = [];
  pruneExpired(victim.damageEntries, now);
  // Audit #43 P1-7 — ServUO `Mobile.RegisterDamage` walks the
  // ControlMaster chain and records BOTH the pet (Damager) and the
  // master (Responsible). `GetLootingRights` then awards credit to
  // the master. Was: pet-damage went solely under the pet's serial,
  // so a Tamer-Vet's dragon got 100% kill credit and looting rights
  // (the pet's serial can't open a corpse). Recurse the controlMaster
  // pointer, recording a second entry under the master if found.
  const masterSerial = attacker.controlMaster;
  if (masterSerial && world?.mobiles && masterSerial !== attacker.serial) {
    const master = world.mobiles.get(masterSerial >>> 0);
    if (master && master.client) {
      // Recurse with master as the attribution attacker. Avoids
      // infinite chains because `master.controlMaster` would be unset
      // on a player. Pass world=null to short-circuit further walks.
      recordDamage(victim, master, amount, now, null);
    }
  }
  // Merge with the latest entry from the same attacker — collapses a
  // burst of consecutive swings into one row instead of bloating the
  // list. ServUO `Mobile.RegisterDamage` does the same.
  const last = victim.damageEntries[victim.damageEntries.length - 1];
  if (last && last.attackerSerial === (attacker.serial >>> 0) &&
      now - last.lastDamageAt < 5_000) {
    last.totalDamage += amount;
    last.lastDamageAt = now;
    return;
  }
  victim.damageEntries.push({
    attackerSerial: attacker.serial >>> 0,
    attackerName:   attacker.name ?? '',
    isPlayer:       Boolean(attacker.client),
    totalDamage:    amount,
    firstDamageAt:  now,
    lastDamageAt:   now,
  });
  if (victim.damageEntries.length > MAX_ENTRIES) {
    victim.damageEntries.splice(0, victim.damageEntries.length - MAX_ENTRIES);
  }
}

/** Drop entries older than `EXPIRY_MS`. */
function pruneExpired(entries, now) {
  if (!entries.length) return;
  const cutoff = now - EXPIRY_MS;
  while (entries.length && entries[0].lastDamageAt < cutoff) entries.shift();
}

/**
 * Return the (attackerSerial, totalDamage) pair with the most damage
 * dealt to `victim`. Used by corpse loot ownership: the top damager
 * gets exclusive loot for the first N seconds before the corpse opens
 * to the public. Returns null when no entries exist.
 */
export function getTopDamager(victim, now = Date.now()) {
  if (!victim?.damageEntries?.length) return null;
  pruneExpired(victim.damageEntries, now);
  let best = null;
  for (const e of victim.damageEntries) {
    if (!best || e.totalDamage > best.totalDamage) best = e;
  }
  return best;
}

/**
 * Return aggregated damage by serial — caller can split kill credit
 * proportionally (e.g. party XP split, faction kill multi-attribution).
 * @returns {Map<number, {serial:number, name:string, isPlayer:boolean, totalDamage:number}>}
 */
export function aggregateDamageBySerial(victim, now = Date.now()) {
  /** @type {Map<number, {serial:number, name:string, isPlayer:boolean, totalDamage:number}>} */
  const out = new Map();
  if (!victim?.damageEntries?.length) return out;
  pruneExpired(victim.damageEntries, now);
  for (const e of victim.damageEntries) {
    const cur = out.get(e.attackerSerial);
    if (cur) cur.totalDamage += e.totalDamage;
    else out.set(e.attackerSerial, {
      serial: e.attackerSerial, name: e.attackerName,
      isPlayer: e.isPlayer, totalDamage: e.totalDamage,
    });
  }
  return out;
}

/** Drop the entire damage history. Called after `killMobile` so a
 *  resurrected mob doesn't carry kill-credit from its previous life. */
export function clearDamageEntries(mob) {
  if (mob?.damageEntries) mob.damageEntries.length = 0;
}
