// PHASE EY — World boss respawn timer.
//
// ServUO `Engines/SpawnerSystem`: world bosses (Doppelganger, Harrower,
// Spirit of the Land) re-spawn at fixed intervals after death — usually
// 24-48 hours. We track per-name kill timestamps and gate spawn calls
// against a configurable cooldown.

const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** @type {Map<string, {lastKilledAt: number|null, cooldownMs: number}>} */
const bosses = new Map();

export function registerBoss(name, opts = {}) {
  bosses.set(name, {
    lastKilledAt: null,
    cooldownMs: opts.cooldownMs ?? DEFAULT_COOLDOWN_MS,
  });
}

export function recordBossKill(name, now = Date.now()) {
  const b = bosses.get(name);
  if (!b) return;
  b.lastKilledAt = now;
}

export function canSpawnBoss(name, now = Date.now()) {
  const b = bosses.get(name);
  if (!b) return false;
  if (b.lastKilledAt == null) return true;
  return (now - b.lastKilledAt) >= b.cooldownMs;
}

export function timeUntilBoss(name, now = Date.now()) {
  const b = bosses.get(name);
  if (!b || b.lastKilledAt == null) return 0;
  const left = b.cooldownMs - (now - b.lastKilledAt);
  return Math.max(0, left);
}

export function _resetBossesForTest() { bosses.clear(); }
export function listBosses() { return [...bosses.keys()]; }
