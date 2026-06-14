// Treasures of Tokuno — quarterly artifact rotation.
//
// ServUO `Engines/TreasuresOfTokuno/TreasuresOfTokunoEra.cs` runs a
// 90-day rotation where 10 artifacts from the 17-entry pool are active
// drops; the rest are dormant. Players who turn in 10 Tokuno-tagged
// minor artifacts to a Special Move trainer get a major artifact
// upgrade. We reproduce the rotation deterministically from a
// world-startup epoch so all clients see the same active pool for the
// same calendar window.

const ROTATION_MS = 90 * 24 * 60 * 60 * 1000;        // 90 days
const ACTIVE_COUNT = 10;
const EPOCH = Date.UTC(2025, 0, 1);                   // Jan 1 2025 UTC anchor

/** Artifact tag pool — pushed in by the script loader at startup.
 *  Defaults empty; falls back gracefully if scripts haven't loaded. */
let _artifactTags = [];

/** Loader API — apps/scripts/src/items/tokuno-artifacts.js calls this
 *  with the array of tag IDs it just registered. */
export function setArtifactTags(tags) {
  _artifactTags = Array.isArray(tags) ? tags.slice() : [];
}

export function getArtifactTags() { return _artifactTags.slice(); }

/** Deterministic shuffle using a uint32 seed. Mulberry32 PRNG. */
function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = seed | 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    const j = (r * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Which slot of the rotation is currently active. */
function currentSlot(now = Date.now()) {
  return Math.floor((now - EPOCH) / ROTATION_MS);
}

/** Active 10 artifact tags for the current rotation slot. */
export function activeArtifacts(now = Date.now()) {
  if (_artifactTags.length === 0) return [];
  const slot = currentSlot(now);
  const shuffled = seededShuffle(_artifactTags, slot);
  return shuffled.slice(0, Math.min(ACTIVE_COUNT, shuffled.length));
}

/** Pick a random ACTIVE tag — used by drop hooks. */
export function rollArtifact(now = Date.now()) {
  const pool = activeArtifacts(now);
  return pool[(Math.random() * pool.length) | 0] ?? null;
}

/** Reward chain — track per-account artifact turn-ins. 10 turn-ins
 *  earns a Major Artifact upgrade. */
const _turnins = new Map();                          // accountId → count
const MAJOR_THRESHOLD = 10;

export function recordTurnin(account) {
  if (!account?.id) return null;
  const cur = (_turnins.get(account.id) | 0) + 1;
  _turnins.set(account.id, cur);
  if (cur >= MAJOR_THRESHOLD) {
    _turnins.set(account.id, 0);
    return { major: true, count: cur };
  }
  return { major: false, count: cur };
}

export function turninCount(account) {
  return _turnins.get(account?.id) | 0;
}

/** Slot info for diagnostics / `[tokuno status`. */
export function rotationInfo(now = Date.now()) {
  const slot = currentSlot(now);
  const slotStart = EPOCH + slot * ROTATION_MS;
  const slotEnd = slotStart + ROTATION_MS;
  return {
    slot,
    slotStart,
    slotEnd,
    msUntilRotate: Math.max(0, slotEnd - now),
    active: activeArtifacts(now),
  };
}
