// TerMur expansion content — ENGINE ONLY.
//
// Encounter pack definitions (Tomb of Kings + Underworld + Exploring
// the Deep) live in apps/scripts/src/data/world/termur-content.json and are
// registered at startup by apps/scripts/src/systems/bosses/termur-content.js.
//
// Engine responsibilities:
//   - hold the pack catalogue
//   - track per-player pack progression
//   - expose lookup APIs

const PACKS = new Map();

export function registerPack(def) {
  if (!def?.id) throw new Error('termur pack needs id');
  PACKS.set(def.id, Object.freeze(def));
}

export function unregisterPack(id) { PACKS.delete(id); }
export function getPack(id) { return PACKS.get(id) ?? null; }
export function listPacks() { return [...PACKS.values()]; }
export function clearAll() { PACKS.clear(); }

// ---- Player progression --------------------------------------------------

export function startPack(mob, packId) {
  const def = PACKS.get(packId);
  if (!def) return { ok: false, reason: 'no-such-pack' };
  mob._termurPacks ??= {};
  if (mob._termurPacks[packId]?.completed) return { ok: false, reason: 'already-completed' };
  mob._termurPacks[packId] = {
    room: 0, cleared: {}, completed: false, startedAt: Date.now(),
  };
  return { ok: true, def };
}

export function recordKill(mob, kind) {
  if (!mob?._termurPacks) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._termurPacks)) {
    const def = PACKS.get(id);
    if (!def || prog.completed) continue;
    const room = def.rooms[prog.room];
    if (room && room.spawns.includes(kind)) {
      prog.cleared[room.id] = (prog.cleared[room.id] ?? 0) + 1;
      if (prog.cleared[room.id] >= room.count) {
        prog.room++;
        advanced.push({ id, room: room.id });
      }
    }
    if (def.finalBoss === kind && !prog.completed) {
      prog.completed = true;
      prog.completedAt = Date.now();
      advanced.push({ id, boss: true,
        artifact: def.artifactPool[Math.floor(Math.random() * def.artifactPool.length)] });
    }
  }
  return advanced;
}

export function statusFor(mob, packId = null) {
  if (!mob?._termurPacks) return null;
  return packId ? (mob._termurPacks[packId] ?? null) : { ...mob._termurPacks };
}
