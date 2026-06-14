// Doom Gauntlet — sequential boss arena. Mirrors ServUO `Engines/Doom/`:
//
//   1. The player enters the gauntlet via a teleporter at the Doom dungeon
//      entrance. They land in Boss Room 1.
//   2. Each room contains one boss + a sealed exit. Killing the boss
//      unseals the exit; stepping into it teleports them to the next room.
//   3. Final room (DarkFather) drops Doom artifacts on the loot table —
//      e.g. 'orny', 'aegis', 'ring-of-the-vile', 'helm-of-insight'.
//   4. After killing DarkFather, a 30-min cooldown prevents re-entry on
//      that account.
//
// API:
//   gauntlet.startInstance(world, party, opts)   — spawn rooms + bosses
//   gauntlet.onBossKilled(instance, bossSerial)  — unseal exit
//   gauntlet.cleanup(instance)                   — despawn after timeout
//
// Boss order:
//   1. Cerberus              — 3-headed dog, fire breath
//   2. Stone Harpy           — flying, paralysis attack
//   3. Impaler               — heavy melee + impale special
//   4. Flesh Renderer        — necro, summons skeletons
//   5. Shadow Knight         — fast melee + curse
//   6. Abyssal Infernal      — fire elemental king
//   7. DarkFather            — final boss, magery + summon imps

const BOSS_ORDER = [
  'cerberus',
  'stone-harpy',
  'impaler',
  'flesh-renderer',
  'shadow-knight',
  'abyssal-infernal',
  'darkfather',
];

const DOOM_ARTIFACTS = [
  // Original 10 — pre-ML era
  'ring-of-the-vile', 'aegis', 'orny',
  'helm-of-insight', 'midnight-bracers', 'staff-of-the-magi',
  'ornate-crown-of-the-lost-king', 'crimson-cincture',
  'gauntlets-of-nobility', 'jackal-collar',
  // +13 from ServUO `DoomArtifactsHelper` (post-ML expansion).
  // Bug-hunt #4 B1.
  'animated-legs-of-insanity', 'berserkers-maul', 'bone-crusher',
  'conjurers-trinket', 'detective-boots', 'dragon-nunchaku',
  'hat-of-the-magi', 'hunters-headdress', 'inquisitors-resolution',
  'leggings-of-bane', 'quiver-of-infinity', 'spirit-of-the-totem',
  'tunic-of-fire',
];

class GauntletInstance {
  constructor(party, opts = {}) {
    this.party = party;
    this.startedAt = Date.now();
    this.currentRoom = 0;
    this.bosses = new Map();          // bossSerial → idx
    this.dead = new Set();
    this.completed = false;
    this.opts = opts;
  }
}

const _instances = new Map();         // partyKey → GauntletInstance
const COOLDOWN_MS = 30 * 60 * 1000;
const _cooldowns = new Map();         // accountId → expireAt

function partyKey(party) {
  if (!party) return null;
  return party.id ?? party.leaderSerial ?? 'solo';
}

/** Start a fresh gauntlet for a party. Caller spawns the bosses + rooms
 *  via `world.createMobileFromKind(BOSS_ORDER[i], …)` and feeds the
 *  serial back via `linkBoss(instance, serial, idx)`. */
export function startInstance(world, party, opts = {}) {
  const key = partyKey(party);
  if (!key) return null;
  if (_instances.has(key)) return _instances.get(key);
  // Cooldown gate.
  for (const m of (party?.members ?? [])) {
    const exp = _cooldowns.get(m.accountId);
    if (exp && exp > Date.now()) {
      return { error: 'cooldown', expiresAt: exp };
    }
  }
  const inst = new GauntletInstance(party, opts);
  _instances.set(key, inst);
  return inst;
}

/** Register a spawned boss as belonging to this instance. */
export function linkBoss(instance, bossSerial, roomIdx) {
  if (!instance) return;
  instance.bosses.set(bossSerial, roomIdx | 0);
}

/** Called by combat death hook. Unseals room exit + advances index. */
export function onBossKilled(instance, bossSerial, _killer = null) {
  if (!instance) return false;
  const idx = instance.bosses.get(bossSerial);
  if (idx == null) return false;
  if (instance.dead.has(bossSerial)) return false;
  instance.dead.add(bossSerial);
  instance.currentRoom = Math.max(instance.currentRoom, idx);
  if (idx === BOSS_ORDER.length - 1) {
    // Final boss — start cooldown for every member.
    instance.completed = true;
    for (const m of (instance.party?.members ?? [])) {
      _cooldowns.set(m.accountId, Date.now() + COOLDOWN_MS);
    }
  }
  return true;
}

/** Roll a Doom artifact on a DarkFather kill. Caller drops it onto the
 *  designated lucky looter (highest damage attacker). */
export function rollDoomArtifact(rng = Math.random) {
  return DOOM_ARTIFACTS[Math.floor(rng() * DOOM_ARTIFACTS.length)];
}

export function cleanup(instance) {
  const key = partyKey(instance?.party);
  if (!key) return;
  _instances.delete(key);
}

export function getInstance(party) {
  return _instances.get(partyKey(party)) ?? null;
}

export const DOOM_CONST = Object.freeze({
  BOSS_ORDER, DOOM_ARTIFACTS, COOLDOWN_MS,
});
