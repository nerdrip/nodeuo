// Cannons system — fixed (fort) and ship cannons fire projectiles via
// the bombarding-skill formula. Mirrors ServUO `Items/Cannons/`.
//
// Cannon placement:
//   • Fixed cannons mounted on castle walls (fort defense).
//   • Ship cannons on Galleon-class boats — fire broadside.
// Loading a cannon:
//   • Ramming-rod swab (cleans residue).
//   • Powder charge.
//   • Cannonball (light/heavy/grape).
//   • Fuse — ignite to fire.
// Firing:
//   • Computes target tile from cannon's facing + powder charge.
//   • AOE damage 4 tiles around impact.
//   • Cooldown 4-6s based on caliber.
//
// API:
//   cannons.placeCannon(world, x, y, z, map, kind)
//   cannons.loadCannon(cannon, { component, item })
//   cannons.fireCannon(cannon, deps)
//   cannons.targetTile(cannon, charge)        — computed impact x,y
//   cannons.swabCannon(cannon)

const CANNON_KINDS = Object.freeze({
  light:  { caliber: 1, damage: 30,  range: 12, cooldownMs: 3500, itemId: 0x14B5 },
  medium: { caliber: 2, damage: 60,  range: 18, cooldownMs: 4500, itemId: 0x14B6 },
  heavy:  { caliber: 3, damage: 120, range: 24, cooldownMs: 6000, itemId: 0x14B7 },
});

const POWDER_CHARGE = { light: 1, normal: 2, heavy: 3 };

const LOADING_STAGES = Object.freeze(['empty', 'swabbed', 'powdered', 'shot-loaded', 'primed']);

export function placeCannon(world, opts = {}) {
  const kind = opts.kind ?? 'medium';
  const def = CANNON_KINDS[kind];
  if (!def) throw new Error(`unknown cannon kind: ${kind}`);
  return world.createItem({
    itemId: def.itemId,
    x: opts.x | 0, y: opts.y | 0, z: opts.z | 0, map: opts.map | 0,
    name: `${kind} cannon`,
    weight: 200,
    cannon: {
      kind,
      stage: 'empty',
      facing: opts.facing ?? 0,
      powderCharge: 0,
      shotKind: null,
      lastFiredAt: 0,
    },
  });
}

/**
 * Load one component step. `componentKind` is 'swab' | 'powder' |
 * 'cannonball-light' | 'cannonball-heavy' | 'cannonball-grape' | 'fuse'.
 * Returns { ok, stage } or { ok:false, reason }.
 */
export function loadCannon(cannon, componentKind, opts = {}) {
  const c = cannon?.cannon;
  if (!c) return { ok: false, reason: 'not-a-cannon' };

  if (componentKind === 'swab') {
    if (c.stage !== 'empty') return { ok: false, reason: 'wrong-stage' };
    c.stage = 'swabbed';
    return { ok: true, stage: c.stage };
  }
  if (componentKind === 'powder') {
    if (c.stage !== 'swabbed') return { ok: false, reason: 'must-swab-first' };
    const charge = POWDER_CHARGE[opts.charge ?? 'normal'] ?? 2;
    c.powderCharge = charge;
    c.stage = 'powdered';
    return { ok: true, stage: c.stage, charge };
  }
  if (componentKind.startsWith('cannonball-')) {
    if (c.stage !== 'powdered') return { ok: false, reason: 'no-powder' };
    c.shotKind = componentKind.replace('cannonball-', '');
    c.stage = 'shot-loaded';
    return { ok: true, stage: c.stage };
  }
  if (componentKind === 'fuse') {
    if (c.stage !== 'shot-loaded') return { ok: false, reason: 'no-shot' };
    c.stage = 'primed';
    return { ok: true, stage: c.stage };
  }
  return { ok: false, reason: 'unknown-component' };
}

/** Compute the impact tile from the cannon's facing + powder charge. */
// Bug-hunt #11 #1 — `c.facing` is a cardinal int (0/N, 1/E, 2/S, 3/W),
// NOT radians. Previous Math.cos / Math.sin treated 0..3 as ~0 radians,
// rounding to dx=1, dy=0 — every cannon fired east regardless of
// intended facing. Plus `range = min(def.range, def.range * charge/2)`
// clamped HIGH charges DOWN — flipped to max so heavy charge boosts range.
const CANNON_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export function targetTile(cannon) {
  const c = cannon?.cannon;
  if (!c) return null;
  const def = CANNON_KINDS[c.kind];
  if (!def) return null;
  const range = Math.max(1, Math.min(def.range * 2,
    Math.round(def.range * Math.max(0.5, (c.powderCharge ?? 1) / 2))));
  const [dx, dy] = CANNON_DIRS[(c.facing | 0) & 3];
  return { x: cannon.x + dx * range, y: cannon.y + dy * range, map: cannon.map };
}

/**
 * Fire the cannon. Pre-conditions: stage must be 'primed', cooldown must
 * have elapsed. Resolves impact via deps.applyAOEDamage(impactTile, damage,
 * radius=2). Returns { ok, impact } or { ok:false, reason }.
 */
export function fireCannon(cannon, deps = {}, now = Date.now()) {
  const c = cannon?.cannon;
  if (!c) return { ok: false, reason: 'not-a-cannon' };
  if (c.stage !== 'primed') return { ok: false, reason: 'not-primed' };
  const def = CANNON_KINDS[c.kind];
  if (now - (c.lastFiredAt | 0) < def.cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }
  const impact = targetTile(cannon);
  if (!impact) return { ok: false, reason: 'no-target' };

  // ServUO ammunition variants. Each shotKind has its own damage scalar,
  // radius and damage typing:
  //   light    — quick low-damage round, 1-tile splash
  //   heavy    — siege round, max damage, 2-tile splash, slower reload baked
  //   grape    — scatter pellets, 4-tile splash, half damage but reliable hit
  //   chain    — anti-sail: 0.4× damage but disables ship sail for 8s
  //   explosive— delayed 1.5s detonation, +25% damage, fire-typed
  //   smoke    — 0× damage but spawns a 5-tile smoke cloud blocking LOS 12s
  const SHOT = {
    light:     { mul: 0.7, radius: 2, type: 'physical', sailDisableMs: 0 },
    heavy:     { mul: 1.5, radius: 2, type: 'physical', sailDisableMs: 0 },
    grape:     { mul: 0.5, radius: 4, type: 'physical', sailDisableMs: 0 },
    chain:     { mul: 0.4, radius: 1, type: 'physical', sailDisableMs: 8000 },
    explosive: { mul: 1.25, radius: 3, type: 'fire',    sailDisableMs: 0, fuse: 1500 },
    smoke:     { mul: 0.0, radius: 5, type: 'none',     sailDisableMs: 0, smokeMs: 12000 },
  };
  const shot = SHOT[c.shotKind] ?? SHOT.light;
  const dmg = Math.floor(def.damage * shot.mul * (c.powderCharge / 2));
  const radius = shot.radius;

  if (shot.fuse) {
    // Delayed detonation — fire-on-timer.
    setTimeout(() => {
      try {
        deps.applyAOEDamage?.(impact, dmg, radius, cannon, { damageType: shot.type });
        deps.broadcastEffect?.({ x: impact.x, y: impact.y, map: impact.map, kind: 'explosion' });
      } catch { /* world torn down between fire & fuse */ }
    }, shot.fuse);
  } else if (shot.smokeMs) {
    deps.broadcastEffect?.({ x: impact.x, y: impact.y, map: impact.map, kind: 'smoke', durationMs: shot.smokeMs });
    deps.spawnSmokeCloud?.(impact, radius, shot.smokeMs);
  } else {
    deps.applyAOEDamage?.(impact, dmg, radius, cannon, { damageType: shot.type });
    deps.broadcastEffect?.({ x: impact.x, y: impact.y, map: impact.map, kind: 'explosion' });
  }
  // Chain shot: tries to disable target ship sail (deps.disableSail walks
  // boat list near impact, sets sail-state to stop for the duration).
  if (shot.sailDisableMs && deps.disableSail) {
    try { deps.disableSail(impact, shot.sailDisableMs); }
    catch { /* no boat at impact */ }
  }

  // Reset state.
  c.stage = 'empty';
  c.shotKind = null;
  c.powderCharge = 0;
  c.lastFiredAt = now;
  return { ok: true, impact, damage: dmg, radius };
}

export function swabCannon(cannon) {
  const c = cannon?.cannon;
  if (!c) return false;
  c.stage = 'empty';
  c.shotKind = null;
  c.powderCharge = 0;
  return true;
}

export const CANNON_CONST = Object.freeze({
  CANNON_KINDS, POWDER_CHARGE, LOADING_STAGES,
});
