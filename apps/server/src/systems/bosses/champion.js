// Champion spawn altar — multi-tier wave spawn manager.
//
// Mirrors the ServUO `Engines/Spawners/ChampionSpawn.cs` topology:
//   Tier 1: lots of weak mobs (12 fresh creatures replenished as players kill).
//   Tier 2: graduates to tougher mid-tier mobs (8 alive at once).
//   Tier 3: pre-boss elites (4 alive).
//   Boss:   the named champion.
//
// Progression is by kill count: each tier needs N kills before the next
// tier unlocks. The altar keeps respawning the current tier's mob until
// `tierKillsRequired[i]` is met. When the boss dies, the altar resets
// and (in PvP shards) drops a power-scroll cluster — for now we just
// emit a system message and reset.
//
// One altar instance per location. The `champion` script registers a
// few canonical altars (Shame, Destard, Despise) and exposes `[champ`
// admin commands to start/stop/inspect.

/** @typedef {import('../world/world.js').World} World */
/** @typedef {import('../world/world.js').Mobile} Mobile */

/**
 * @typedef {Object} ChampionTier
 * @property {string[]} kinds          monster kinds (must exist in MonsterRegistry)
 * @property {number}   capAlive       max simultaneous mobs at this tier
 * @property {number}   killsToAdvance progress required to unlock next tier
 */

/**
 * @typedef {Object} ChampionConfig
 * @property {string}    name
 * @property {number}    map
 * @property {number}    cx
 * @property {number}    cy
 * @property {number}    cz
 * @property {number}    radius
 * @property {ChampionTier[]} tiers
 * @property {string}    bossKind
 * @property {string}    [rewardKind]
 */

export class ChampionAltar {
  /**
   * @param {World} world
   * @param {ChampionConfig} cfg
   * @param {{ spawnFactory: (world:World, kind:string, pos:{x:number,y:number,z:number,map:number}) => Mobile|null }} deps
   */
  constructor(world, cfg, deps) {
    this.world = world;
    this.cfg = cfg;
    this.deps = deps;
    this.active = false;
    this.tier = 0;
    this.killsAtTier = 0;
    /** Serials of mobs we've spawned that are still alive. */
    this.spawned = new Set();
    /** Boss serial, when the boss has spawned. */
    this.boss = 0;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.tier = 0;
    this.killsAtTier = 0;
    this.spawned.clear();
    this.boss = 0;
    this._notify();
  }

  stop() {
    this.active = false;
    // BUGFIX #36 (PHASE BT): the previous stop() deleted serials from
    // world.mobiles directly without broadcasting `removeEntity`, so
    // every nearby client kept the despawned mob's sprite on screen
    // until they walked 18+ tiles away. Now we ask the dependency
    // injector to broadcast a removal first, then use the canonical
    // mobile lifecycle so sector and destroy-hook state follows.
    for (const serial of this.spawned) {
      this.deps.despawn?.(this.world, serial);
      this.world.destroyMobile?.(serial);
    }
    if (this.boss) {
      this.deps.despawn?.(this.world, this.boss);
      this.world.destroyMobile?.(this.boss);
    }
    this.spawned.clear();
    this.boss = 0;
    this.tier = 0;
    this._notify();
  }

  /** Called from the global tick. Refills the wave and advances tiers. */
  tick() {
    if (!this.active) return;

    let dirty = false;
    // Drop dead/missing serials from our tracking set.
    for (const serial of [...this.spawned]) {
      const m = this.world.mobiles.get(serial);
      if (!m || (m.hp ?? 0) <= 0 || m.ghost) {
        this.spawned.delete(serial);
        this.killsAtTier++;
        dirty = true;
      }
    }
    if (this.boss) {
      const b = this.world.mobiles.get(this.boss);
      if (!b || (b.hp ?? 0) <= 0) {
        // Boss dead — the altar's run is complete.
        const wasBoss = this.boss;
        this.boss = 0;
        this.onBossKilled(wasBoss);
        return;
      }
    }

    // Boss tier — only the champion mob; nothing else to spawn.
    if (this.tier >= this.cfg.tiers.length) return;

    const tier = this.cfg.tiers[this.tier];
    if (this.killsAtTier >= tier.killsToAdvance) {
      this.tier++;
      this.killsAtTier = 0;
      dirty = true;
      // If we just rolled past the last regular tier, summon the boss.
      if (this.tier >= this.cfg.tiers.length) {
        this.spawnBoss();
        this._notify();
        return;
      }
    }

    const need = tier.capAlive - this.spawned.size;
    for (let i = 0; i < need; i++) {
      const mob = this.spawnOne(tier.kinds);
      if (mob) {
        this.spawned.add(mob.serial >>> 0);
        dirty = true;
      }
    }
    if (dirty) this._notify();
  }

  spawnOne(kinds) {
    const kind = kinds[(Math.random() * kinds.length) | 0];
    const pos = this.randomPosNearAltar();
    return this.deps.spawnFactory(this.world, kind, pos);
  }

  spawnBoss() {
    const pos = { x: this.cfg.cx, y: this.cfg.cy, z: this.cfg.cz, map: this.cfg.map };
    const mob = this.deps.spawnFactory(this.world, this.cfg.bossKind, pos);
    if (mob) this.boss = mob.serial >>> 0;
  }

  onBossKilled(serial) {
    // Hook for the script registering this altar — by default we just
    // log + reset. The script can override to drop a power-scroll cluster
    // or apply a virtue tier.
    this.bossKilledAt = Date.now();
    if (this.onBossDeath) this.onBossDeath(serial);
    this.tier = 0;
    this.killsAtTier = 0;
    this.spawned.clear();
    this._notify();
  }

  randomPosNearAltar() {
    const r = this.cfg.radius;
    const dx = Math.floor((Math.random() - 0.5) * 2 * r);
    const dy = Math.floor((Math.random() - 0.5) * 2 * r);
    return { x: this.cfg.cx + dx, y: this.cfg.cy + dy, z: this.cfg.cz, map: this.cfg.map };
  }

  status() {
    const bossMob = this.boss ? this.world.mobiles.get(this.boss) : null;
    return {
      name: this.cfg.name,
      active: this.active,
      tier: this.tier,
      tiersTotal: this.cfg.tiers.length,
      killsAtTier: this.killsAtTier,
      killsToAdvance: this.cfg.tiers[this.tier]?.killsToAdvance ?? 0,
      spawnedAlive: this.spawned.size,
      bossSerial: this.boss,
      bossHp: bossMob?.hp ?? 0,
      bossHpMax: bossMob?.hpMax ?? 0,
    };
  }

  /**
   * PHASE BT: send the current status to every nearby client. Wired by
   * the script-side script (apps/scripts/src/spawns/champions.js) which
   * provides `deps.broadcastStatus(world, cfg, status)` so this module
   * doesn't have to import the protocol layer.
   */
  _notify() {
    if (!this.deps?.broadcastStatus) return;
    try { this.deps.broadcastStatus(this.world, this.cfg, this.status()); }
    catch (e) { console.error('[champ] broadcast failed:', e); }
  }
}
