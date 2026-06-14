// Mounted combat tracker — per-mount bonus / penalty book.
//
// ServUO `BaseCombat.cs` applies a small DCI penalty to mounted
// attackers and a slight damage bonus on lance / lance-style weapons.
// We expose two reader functions that combat-formulas can call to
// adjust the swing without needing to know about mount kinds.
//
//   mountedHitChanceMod(attacker)         returns +/- DCI scalar
//   mountedDamageMod(attacker, weapon)    returns +/- damage scalar
//
// All bonuses pulled from `MOUNT_STATS[mount.kind]` keyed by the mount
// item's `mountKind` field stamped at spawn time. Default penalty for
// unknown mounts: -5% DCI, +0% damage.

const MOUNT_STATS = {
  // ServUO `BaseMount` defaults — minor DCI penalty, no damage change.
  'horse':           { dci: -0.05, dam: 0     },
  'ostard':          { dci: -0.05, dam: 0     },
  'llama':           { dci: -0.05, dam: 0     },
  'ridgeback':       { dci: -0.05, dam: 0     },
  // Heavy / war mounts — slightly bigger DCI penalty but a damage
  // multiplier on charged hits.
  'fire-steed':      { dci: -0.10, dam: +0.05 },
  'nightmare':       { dci: -0.10, dam: +0.10 },
  'unicorn':         { dci: -0.05, dam: +0.05 },
  'kirin':           { dci: -0.05, dam: +0.05 },
  // Flying / ethereal — no damage bonus but smaller DCI penalty.
  'ethereal-horse':  { dci: -0.02, dam: 0     },
  'beetle-blue':     { dci: -0.03, dam: +0.05 },     // Swampy Dragon analog
  // Sherpa / Cu Sidhe — light combat mounts with bonded damage scaling.
  'cu-sidhe':        { dci: -0.05, dam: +0.05 },
  'reptalon':        { dci: -0.08, dam: +0.10 },
};

const DEFAULT_STATS = { dci: -0.05, dam: 0 };

function mountOf(attacker, world) {
  if (!attacker) return null;
  // ServUO equips the mount at layer 25.
  for (const it of world?.items?.values?.() ?? []) {
    if (it.parent === attacker.serial && it.layer === 25) return it;
  }
  return null;
}

/** Return the multiplicative DCI modifier (e.g. -0.05 = -5%). 0 if
 *  the attacker isn't mounted or just got dismounted (under cooldown). */
export function mountedHitChanceMod(attacker, world) {
  if (!attacker) return 0;
  if ((attacker._dismountedUntil ?? 0) > Date.now()) return 0;
  const mount = mountOf(attacker, world);
  if (!mount) return 0;
  const stats = MOUNT_STATS[mount.mountKind ?? mount.kind] ?? DEFAULT_STATS;
  return stats.dci ?? 0;
}

/** Return the multiplicative damage modifier. Lance weapons get a
 *  +25% on charge — we approximate by reading `weapon.kind === 'lance'`. */
export function mountedDamageMod(attacker, weapon, world) {
  if (!attacker) return 0;
  if ((attacker._dismountedUntil ?? 0) > Date.now()) return 0;
  const mount = mountOf(attacker, world);
  if (!mount) return 0;
  const stats = MOUNT_STATS[mount.mountKind ?? mount.kind] ?? DEFAULT_STATS;
  let mod = stats.dam ?? 0;
  if (weapon && (weapon.kind === 'lance' || weapon.subKind === 'lance')) {
    // Lance bonus stacks additively with the mount's natural damage
    // modifier; ServUO uses +25% for lances on a real cavalry charge.
    mod += 0.25;
  }
  return mod;
}

/** Read full per-mount config — used by status commands. */
export function statsOfMount(kind) {
  return MOUNT_STATS[kind] ?? { ...DEFAULT_STATS };
}

export const MOUNTED_COMBAT_CONST = Object.freeze({ MOUNT_STATS });
