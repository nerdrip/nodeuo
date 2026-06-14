// Krampus — winter holiday boss event (ServUO `Engines/Holiday/Krampus.cs`).
//
// Each year between Dec 1 and Jan 7 (server clock), Krampus roams the
// world delivering coal to naughty children. Players can hunt him for
// the seasonal artifact pool. The event has 3 phases:
//
//   1. Naughty/Nice scoring — players who completed annual quests or
//      donated to community boards build a "nice" score; PKs/criminals
//      build a "naughty" score. The score determines which artifact
//      pool drops.
//   2. Encounter — Krampus spawns at a random city center every 4h.
//      Shard-wide announce; players have 30 min to converge.
//   3. Death drops — random naughty-pool item to all party members
//      (coal lumps for trolls), random nice-pool item to the killer.
//
// State is per-account in `_krampusScore: { nice, naughty }`.

const KRAMPUS_HP = 25000;
const KRAMPUS_BODY = 0x0017;        // a male troll
const KRAMPUS_HUE = 0x021;          // angry red
const SPAWN_INTERVAL_MS = 4 * 60 * 60 * 1000;   // 4 hours

const SPAWN_CENTERS = [
  { name: 'Britain',  x: 1496, y: 1624, z: 10, map: 1 },
  { name: 'Vesper',   x: 2898, y:  675, z:  0, map: 1 },
  { name: 'Trinsic',  x: 1880, y: 2772, z:  0, map: 1 },
  { name: 'Minoc',    x: 2477, y:  411, z: 15, map: 1 },
  { name: 'Yew',      x:  643, y:  854, z:  0, map: 1 },
];

const NICE_ARTIFACTS = [
  { name: 'Coal-Stuffed Stocking',   itemId: 0x172B, hue: 0x47E },
  { name: 'Ribbon of Joy',           itemId: 0x1F9F, hue: 0x481 },
  { name: 'Snowman Statuette',       itemId: 0x100E, hue: 0x47E },
  { name: 'Krampus Whip',            itemId: 0x166E, hue: 0x021 },
];
const NAUGHTY_ARTIFACTS = [
  { name: 'Lump of Coal',            itemId: 0x19B7, hue: 0x21 },
  { name: 'Burlap Sack',             itemId: 0x1B72, hue: 0x21 },
];

const KRAMPUS_SEASON_START = { month: 11, day: 1 };   // Dec 1 (month 0-indexed)
const KRAMPUS_SEASON_END   = { month:  0, day: 7 };   // Jan 7

let _state = null;          // { lastSpawnAt, currentBossSerial?, currentLocation?, completedAt? }

function isInSeason(now = new Date()) {
  const m = now.getMonth(), d = now.getDate();
  if (m === KRAMPUS_SEASON_START.month && d >= KRAMPUS_SEASON_START.day) return true;
  if (m === KRAMPUS_SEASON_END.month   && d <= KRAMPUS_SEASON_END.day)   return true;
  return false;
}

/** Reset / initialise state (idempotent). */
export function ensureState() {
  if (!_state) _state = { lastSpawnAt: 0, currentBossSerial: 0, currentLocation: null };
  return _state;
}

/** Add to an account's nice tally. */
export function scoreNice(account, amount = 1) {
  if (!account) return 0;
  account._krampusScore ??= { nice: 0, naughty: 0 };
  account._krampusScore.nice += amount | 0;
  return account._krampusScore.nice;
}

/** Add to an account's naughty tally — fires automatically on murder
 *  counts (we hook this via the notoriety criminal-flag callback). */
export function scoreNaughty(account, amount = 1) {
  if (!account) return 0;
  account._krampusScore ??= { nice: 0, naughty: 0 };
  account._krampusScore.naughty += amount | 0;
  return account._krampusScore.naughty;
}

export function scoreOf(account) {
  return account?._krampusScore ?? { nice: 0, naughty: 0 };
}

/** Returns true if a fresh Krampus spawn is due (4h after last). */
export function shouldSpawn(now = Date.now()) {
  if (!isInSeason()) return false;
  ensureState();
  return now - (_state.lastSpawnAt | 0) >= SPAWN_INTERVAL_MS;
}

/** Spawn Krampus at a random town. Returns the spawned mob (or null
 *  on failure). Caller is responsible for the shard-wide announce. */
export function spawnKrampus(world, opts = {}) {
  ensureState();
  const loc = SPAWN_CENTERS[(Math.random() * SPAWN_CENTERS.length) | 0];
  const factory = opts.spawnFactory;
  let boss = null;
  if (factory) {
    try {
      boss = factory(world, 'krampus', {
        x: loc.x, y: loc.y, z: loc.z, map: loc.map,
      });
    } catch { /* fall through */ }
  }
  if (!boss) {
    boss = world.createMobile?.({
      name: 'Krampus', body: KRAMPUS_BODY, hue: KRAMPUS_HUE,
      x: loc.x, y: loc.y, z: loc.z, map: loc.map,
      hp: KRAMPUS_HP, hpMax: KRAMPUS_HP,
      str: 600, dex: 200, int: 400,
      notoriety: 5, fame: 22500, karma: -22500,
      kind: 'krampus',
    });
  }
  if (!boss) return null;
  boss._krampusBoss = true;
  _state.lastSpawnAt = Date.now();
  _state.currentBossSerial = boss.serial;
  _state.currentLocation = loc;
  return boss;
}

/** Decide which artifact a killer / participant earns based on score. */
export function rollKrampusArtifact(account) {
  const s = scoreOf(account);
  const niceWeight = Math.max(0, s.nice);
  const naughtyWeight = Math.max(0, s.naughty);
  // Default 50/50 if no score; otherwise biased toward whichever is higher.
  const total = niceWeight + naughtyWeight;
  const niceChance = total > 0 ? niceWeight / total : 0.5;
  const pool = Math.random() < niceChance ? NICE_ARTIFACTS : NAUGHTY_ARTIFACTS;
  return pool[(Math.random() * pool.length) | 0];
}

export function snapshot() {
  return _state ? { ..._state } : null;
}

export const KRAMPUS_CENTERS = SPAWN_CENTERS;
