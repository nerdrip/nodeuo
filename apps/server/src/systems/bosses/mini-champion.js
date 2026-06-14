// Mini Champion System — port of ServUO `Services/MiniChampionSystem/`.
// A pared-down champion spawn: one tier of replenished mobs, then a
// boss-class "mini champion" that drops a small reward when killed.
// Used in revamped dungeon corners where a full ChampionAltar would be
// over-tuned (Wrong, Despise side-rooms, Covetous level 3 etc.).
//
// Each `MiniChampType` ships a 4-kind pool + a mini-boss kind. The
// spawn keeps `capAlive` adds up at all times; once `killsToAdvance`
// total kills land, the boss spawns. Boss death resets the spawn.
//
// Coordinates ship from `apps/scripts/src/spawns/mini-champions.js`
// (content); this engine module only owns the lifecycle.

/** @typedef {import('../../world/world.js').World} World */
/** @typedef {import('../../world/world.js').Mobile} Mobile */

export const MINI_CHAMP_TYPES = {
  abyss:     { kinds: ['imp', 'gargoyle', 'fire-gargoyle', 'daemon-bridge'],         boss: 'imp-lord',          loot: 'minor-artifact' },
  arachnid:  { kinds: ['giant-spider', 'dread-spider', 'frost-spider', 'recluse'],   boss: 'navrey-mini',       loot: 'minor-artifact' },
  coldblood: { kinds: ['lizardman', 'serpent', 'giant-serpent', 'snake'],            boss: 'silver-serpent',    loot: 'minor-artifact' },
  forest:    { kinds: ['orc', 'orc-mage', 'troll', 'ettin'],                         boss: 'orc-bomber-mini',   loot: 'minor-artifact' },
  vermin:    { kinds: ['rat', 'giant-rat', 'sewer-rat', 'plague-rat'],               boss: 'rat-king-mini',     loot: 'minor-artifact' },
  undead:    { kinds: ['skeleton', 'zombie', 'wraith', 'lich'],                      boss: 'lich-lord-mini',    loot: 'minor-artifact' },
};

/**
 * @typedef {Object} MiniChampConfig
 * @property {string} name              short id, e.g. 'wrong-undead'
 * @property {keyof typeof MINI_CHAMP_TYPES} type
 * @property {number} map
 * @property {number} cx
 * @property {number} cy
 * @property {number} cz
 * @property {number} radius            spawn-spread radius around (cx, cy)
 * @property {number} [capAlive=4]
 * @property {number} [killsToAdvance=12]
 * @property {number} [respawnMs=60_000] auto-reset window after boss kill
 */

export class MiniChampionSpawn {
  /**
   * @param {World} world
   * @param {MiniChampConfig} cfg
   * @param {{ spawnFactory: (w:World, kind:string, pos:object)=>Mobile|null, despawn?:(w:World, serial:number)=>void, dropLoot?:(w:World, mob:Mobile, kind:string)=>void }} deps
   */
  constructor(world, cfg, deps) {
    if (!MINI_CHAMP_TYPES[cfg.type]) {
      throw new Error(`MiniChampionSpawn: unknown type "${cfg.type}"`);
    }
    this.world = world;
    this.cfg = { capAlive: 4, killsToAdvance: 12, respawnMs: 60_000, ...cfg };
    this.deps = deps;
    this.active = false;
    this.kills = 0;
    this.spawned = new Set();
    this.boss = 0;
    this.completedAt = 0;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.kills = 0;
    this.spawned.clear();
    this.boss = 0;
    this.completedAt = 0;
  }

  stop() {
    this.active = false;
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
  }

  tick() {
    if (!this.active) return;
    // Auto-restart window after a clear.
    if (!this.boss && this.completedAt
        && Date.now() - this.completedAt >= (this.cfg.respawnMs | 0)) {
      this.completedAt = 0;
      this.kills = 0;
    }
    // Reap dead minions.
    for (const serial of [...this.spawned]) {
      const m = this.world.mobiles.get(serial);
      if (!m || (m.hp ?? 0) <= 0 || m.ghost) {
        this.spawned.delete(serial);
        this.kills++;
      }
    }
    // Boss check.
    if (this.boss) {
      const b = this.world.mobiles.get(this.boss);
      if (!b || (b.hp ?? 0) <= 0) {
        const wasBoss = this.boss;
        this.boss = 0;
        this.completedAt = Date.now();
        this.onBossKilled(wasBoss);
        return;
      }
      return;             // boss alive — pause minion refills
    }
    if (this.completedAt) return;   // in cooldown
    if (this.kills >= this.cfg.killsToAdvance) {
      this.spawnBoss();
      return;
    }
    const need = this.cfg.capAlive - this.spawned.size;
    const pool = MINI_CHAMP_TYPES[this.cfg.type].kinds;
    for (let i = 0; i < need; i++) {
      const kind = pool[(Math.random() * pool.length) | 0];
      const mob = this.deps.spawnFactory(this.world, kind, this._randomPos());
      if (mob) this.spawned.add(mob.serial >>> 0);
    }
  }

  spawnBoss() {
    const bossKind = MINI_CHAMP_TYPES[this.cfg.type].boss;
    const pos = { x: this.cfg.cx, y: this.cfg.cy, z: this.cfg.cz, map: this.cfg.map };
    const mob = this.deps.spawnFactory(this.world, bossKind, pos);
    if (mob) {
      this.boss = mob.serial >>> 0;
      mob.fame = (mob.fame | 0) || 5_000;
    }
  }

  onBossKilled(serial) {
    const lootKind = MINI_CHAMP_TYPES[this.cfg.type].loot;
    try { this.deps.dropLoot?.(this.world, this.world.mobiles.get(serial), lootKind); }
    catch (e) { console.error('[mini-champ] dropLoot failed:', e); }
  }

  _randomPos() {
    const r = this.cfg.radius;
    return {
      x: this.cfg.cx + Math.floor((Math.random() - 0.5) * 2 * r),
      y: this.cfg.cy + Math.floor((Math.random() - 0.5) * 2 * r),
      z: this.cfg.cz,
      map: this.cfg.map,
    };
  }

  status() {
    const bossMob = this.boss ? this.world.mobiles.get(this.boss) : null;
    return {
      name: this.cfg.name,
      type: this.cfg.type,
      active: this.active,
      kills: this.kills,
      killsToAdvance: this.cfg.killsToAdvance,
      spawnedAlive: this.spawned.size,
      bossSerial: this.boss,
      bossHp: bossMob?.hp ?? 0,
      bossHpMax: bossMob?.hpMax ?? 0,
      cooldownUntil: this.completedAt ? this.completedAt + this.cfg.respawnMs : 0,
    };
  }
}

const _registry = new Map();
export function registerMiniChamp(spawn) {
  _registry.set(spawn.cfg.name, spawn);
  return spawn;
}
export function getMiniChamp(name) { return _registry.get(name) ?? null; }
export function listMiniChamps() { return [..._registry.values()]; }
export function tickAll() { for (const s of _registry.values()) s.tick(); }
