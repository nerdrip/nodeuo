// Canonical shard-level world-event catalogue. Keeping authored registrations
// out of main.js makes the boot file orchestration-only and gives tests/admin
// tooling one reusable source of truth.

export const CORE_WORLD_BOSSES = Object.freeze([
  { id: 'harrower', cooldownMs: 24 * 60 * 60 * 1000 },
  { id: 'doppelganger', cooldownMs: 12 * 60 * 60 * 1000 },
  { id: 'spirit-of-the-land', cooldownMs: 8 * 60 * 60 * 1000 },
]);

export const CORE_SIGILS = Object.freeze([
  { id: 'britain', x: 1495, y: 1629, map: 1 },
  { id: 'magincia', x: 3713, y: 2113, map: 1 },
  { id: 'minoc', x: 2479, y: 439, map: 1 },
  { id: 'trinsic', x: 1846, y: 2745, map: 1 },
  { id: 'yew', x: 633, y: 858, map: 1 },
]);

export function registerCoreWorldEvents({ worldBosses, sigils }) {
  if (worldBosses) {
    for (const boss of CORE_WORLD_BOSSES) worldBosses.registerBoss(boss.id, { cooldownMs: boss.cooldownMs });
  }
  if (sigils) {
    for (const sigil of CORE_SIGILS) sigils.registerSigil(sigil.id, sigil.x, sigil.y, sigil.map);
  }
  return {
    bosses: worldBosses ? CORE_WORLD_BOSSES.length : 0,
    sigils: sigils ? CORE_SIGILS.length : 0,
  };
}
