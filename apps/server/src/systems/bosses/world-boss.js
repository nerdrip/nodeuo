// World-boss respawn cooldown tracker. ServUO has Doom champion + Doom
// guardians + Stygian dragons on multi-hour timers; we expose a generic
// registry so content scripts can declare:
//
//   worldBosses.register({
//     id: 'doom-grim-reaper',
//     respawnMs: 4 * 3600_000,
//     spawn(world) { return spawnTemplate(world, 'grim-reaper', ...); },
//   });
//
// The shard's main tick calls `worldBosses.tick(world)` periodically;
// each boss's `nextRespawnAt` is checked + `spawn()` invoked when due.

/** @type {Map<string, {respawnMs:number, spawn:Function, nextRespawnAt:number, lastInstance:any}>} */
const _bosses = new Map();

export const worldBosses = {
  register(cfg) {
    if (!cfg?.id || typeof cfg.spawn !== 'function') return;
    const existing = _bosses.get(cfg.id);
    _bosses.set(cfg.id, {
      respawnMs: cfg.respawnMs ?? (4 * 3600_000),
      spawn: cfg.spawn,
      nextRespawnAt: existing?.nextRespawnAt ?? Date.now(),
      lastInstance:  existing?.lastInstance ?? null,
    });
  },
  unregister(id) { _bosses.delete(id); },

  /** Notify the registry that the boss has been killed; schedules respawn. */
  recordKill(id) {
    const b = _bosses.get(id);
    if (!b) return;
    b.nextRespawnAt = Date.now() + b.respawnMs;
    b.lastInstance = null;
  },

  /** Walk all bosses and (re)spawn those due. */
  tick(world) {
    // A maintenance `[wipeworld` closes this gate until CreateWorld has
    // completed. Autonomous boss timers must not dirty the clean slate.
    if (world?._createWorldDone === false) return;
    const now = Date.now();
    for (const [id, b] of _bosses) {
      if (b.lastInstance && world.mobiles.has(b.lastInstance.serial)) continue;
      if (now < b.nextRespawnAt) continue;
      try {
        const inst = b.spawn(world);
        b.lastInstance = inst ?? null;
      } catch (e) {
        console.error(`[world-boss] ${id} spawn failed:`, e.message);
        b.nextRespawnAt = now + 60_000;
      }
    }
  },

  serialize() {
    const out = {};
    for (const [id, b] of _bosses) {
      out[id] = { nextRespawnAt: b.nextRespawnAt };
    }
    return out;
  },
  loadSnapshot(data) {
    for (const [id, snap] of Object.entries(data ?? {})) {
      const b = _bosses.get(id);
      if (b && Number.isFinite(snap.nextRespawnAt)) b.nextRespawnAt = snap.nextRespawnAt;
      else _bosses.set(id, { respawnMs: 0, spawn: () => null, nextRespawnAt: snap.nextRespawnAt, lastInstance: null });
    }
  },
};
