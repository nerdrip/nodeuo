// Revamped Dungeons — ENGINE ONLY.
//
// Dungeon definitions live in apps/scripts/src/data/world/revamped-dungeons.json
// and are registered at startup by apps/scripts/src/systems/bosses/revamped-dungeons.js.
//
// Engine responsibilities:
//   - hold the registered dungeon catalogue
//   - track per-player progression (startDungeon, recordKill, recordBossKill)
//   - expose lookup APIs (getDungeon, listDungeons, statusFor)

const DUNGEONS = new Map();

export function registerDungeon(def) {
  if (!def?.id) throw new Error('dungeon needs id');
  DUNGEONS.set(def.id, Object.freeze(def));
}

export function unregisterDungeon(id) { DUNGEONS.delete(id); }
export function getDungeon(id) { return DUNGEONS.get(id) ?? null; }
export function listDungeons() { return [...DUNGEONS.values()]; }
export function clearAll() { DUNGEONS.clear(); }

// ---- Per-player progress tracking ----------------------------------------

export function startDungeon(mob, id) {
  const def = DUNGEONS.get(id);
  if (!def) return { ok: false, reason: 'no-such-dungeon' };
  mob._revDungeons ??= {};
  if (mob._revDungeons[id]?.completed) {
    return { ok: false, reason: 'already-completed' };
  }
  mob._revDungeons[id] = {
    room: 0,
    cleared: {},
    completed: false,
    minibossDefeated: false,
    bossDefeated: false,
    startedAt: Date.now(),
  };
  return { ok: true, def };
}

export function recordKill(mob, kind) {
  if (!mob?._revDungeons) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._revDungeons)) {
    const def = DUNGEONS.get(id);
    if (!def || prog.completed) continue;
    const room = def.rooms[prog.room];
    if (!room) continue;
    if (!room.spawns.includes(kind)) continue;
    prog.cleared[room.id] = (prog.cleared[room.id] ?? 0) + 1;
    if (prog.cleared[room.id] >= room.count) {
      prog.room++;
      advanced.push({ id, room: room.id, next: def.rooms[prog.room]?.id ?? 'miniboss' });
    }
  }
  return advanced;
}

export function recordMinibossKill(mob, kind) {
  if (!mob?._revDungeons) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._revDungeons)) {
    const def = DUNGEONS.get(id);
    if (!def || prog.completed || !def.minibosses.includes(kind)) continue;
    prog.minibossDefeated = true;
    advanced.push({ id, kind });
  }
  return advanced;
}

export function recordBossKill(mob, kind, _world = null) {
  if (!mob?._revDungeons) return [];
  const rewards = [];
  for (const [id, prog] of Object.entries(mob._revDungeons)) {
    const def = DUNGEONS.get(id);
    if (!def || prog.completed || def.finalBoss !== kind) continue;
    prog.bossDefeated = true;
    prog.completed = true;
    prog.completedAt = Date.now();
    const pool = def.artifactPool ?? [];
    const artifact = pool[Math.floor(Math.random() * pool.length)] ?? null;
    rewards.push({ dungeonId: id, artifact, magicCount: 3 + Math.floor(Math.random() * 5) });
  }
  return rewards;
}

export function statusFor(mob, id = null) {
  if (!mob?._revDungeons) return null;
  if (id) return mob._revDungeons[id] ?? null;
  return { ...mob._revDungeons };
}
