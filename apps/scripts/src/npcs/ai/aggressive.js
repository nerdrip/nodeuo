// Aggressive monster behavior — scans nearby players, chases the closest one
// within aggro range, and melee-swings at them on a fixed cadence. Uses
// `api.combat.damage` + `api.combat.animate`, so damage and take-hit visuals
// reuse the same wire packets players already see.
//
// Creature stats live in data/config/monsters.json and are loaded via data.js into
// `api.monsters`. This script is purely behavior + a spawn command.

import { applyOutfit } from '../../items/behaviors/clothing-presets.js';
import { _OUTFIT_TABLE_FOR_TEST as OUTFIT_TABLE } from '../vendors/_spawn.js';
import { allItems, allMobiles, nearbyClients, sendToClientsNear } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
import { createMobile } from '../../_mobiles.js';
import { stampStealable } from '../../items/definitions/stealable-pool.js';
// Monster archetypes (kind name → ServUO `names.xml` pool). Each kind
// rolls a unique name on spawn so dungeons stop being staffed with twenty
// identical "a daemon"s. Adding more pools is mechanical — append the
// kind on the left and the matching `<namelist type="…">` on the right.
const MONSTER_NAME_POOLS = {
  daemon: 'daemon', 'arch-daemon': 'daemon', 'arch-demon': 'daemon',
  'evil-mage': 'evil mage', 'evil-mage-lord': 'evil mage lord',
  'ancient-lich': 'ancient lich', lich: 'ancient lich', 'lich-lord': 'ancient lich',
  'shadow-knight': 'shadow knight', 'demon-knight': 'demon knight',
  'darknight-creeper': 'darknight creeper', impaler: 'impaler',
  'ethereal-warrior': 'ethereal warrior', centaur: 'centaur', pixie: 'pixie',
  ratman: 'ratman', 'ratman-archer': 'ratman', 'ratman-mage': 'ratman',
  lizardman: 'lizardman', savage: 'savage', 'savage-rider': 'savage rider',
  'savage-shaman': 'savage shaman', 'golem-controller': 'golem controller',
};

// Humanoid body ids that should pull from the human male/female pool
// when there's no monster-specific pool. 400/401 = canon human; 605/606
// elf; 666/667 gargoyle (npc-names.js inferRace handles the routing).
const HUMANOID_BODIES = new Set([400, 401, 605, 606, 666, 667]);

function configuredAiBehavior(cfg = {}) {
  if (typeof cfg.ai === 'string' && cfg.ai.trim()) {
    const requested = cfg.ai.trim();
    // Names preserved from ServUO's AIType enum which do not have separate
    // Node behaviors. Map them to the equivalent runtime implementation.
    if (requested === 'melee') return 'aggressive';
    if (requested === 'passive') {
      const body = cfg.body | 0;
      return body >= 200 && body < 400 ? 'animal' : 'wander';
    }
    return requested;
  }
  // The extracted ServUO catalogue historically lost AIType.AI_Animal.
  // Recover it for passive low-body creatures instead of attaching the
  // melee aggressor loop to cats, rabbits, cows and rats.
  const body = cfg.body | 0;
  if (body >= 200 && body < 400 && (cfg.aggroRange ?? 6) <= 0) return 'animal';
  return 'aggressive';
}

export function desiredAiForMob(mob, cfg) {
  // Wild-template AI must never override ownership. The deferred
  // reconciliation pass used to turn freshly summoned daemons/elementals
  // hostile again one event-loop turn after `summonOne` attached pet AI.
  if (mob.controlled && (mob.controlMaster >>> 0)) return 'pet';
  const configured = configuredAiBehavior(cfg);
  const saved = typeof mob.aiBehavior === 'string' ? mob.aiBehavior.trim() : '';
  // Older startup code replaced an unavailable-yet specialised behavior
  // with `aggressive` and persisted that fallback. Recover from config.
  if (!saved || (saved === 'aggressive' && configured !== 'aggressive')) return configured;
  return saved;
}

function freshAiState(mob, kind, previous = null) {
  return {
    targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
    home: { x: mob.homeX ?? mob.x, y: mob.homeY ?? mob.y },
    kind,
    ...(previous ?? {}),
  };
}

/** Correct temporary fallback bindings after the remaining AI modules have
 * registered. This is intentionally shard-wide and scheduled only a handful
 * of times during script boot; doing the same full scan after every monster
 * spawn was O(spawns * mobiles) and could also overwrite fresh pet bindings. */
function reconcileAiBindings(api) {
  let corrected = 0;
  for (const mob of allMobiles(api)) {
    if (mob.isPlayer || mob.client || mob.vendorKind || !mob.kind) continue;
    const cfg = api.monsters.get(mob.kind);
    if (!cfg) continue;
    const desired = desiredAiForMob(mob, cfg);
    if (!api.ai?.behaviors?.has?.(desired)) continue;
    const binding = api.ai.bindings?.get?.(mob.serial);
    if (binding?.behavior === desired) continue;
    try {
      api.ai.attach(mob, desired, freshAiState(mob, mob.kind, binding?.state));
      mob.aiBehavior = desired;
      if (mob.kind === 'rat' && (mob.body | 0) === 238 && mob.name === 'a giant rat') {
        mob.name = cfg.name ?? 'a rat';
      }
      corrected++;
    } catch (e) {
      api.log?.(`[aggressive] AI reconcile ${mob.kind}/${desired} failed: ${e.message}`);
    }
  }
  if (corrected) api.log?.(`npcs/aggressive: restored ${corrected} specialised AI binding(s)`);
  return corrected;
}


/** Heuristic preset picker for humanoid monsters. Templates in
 *  monsters.json don't ship an outfit field, so brigands / evil-mages /
 *  ronin / chaos dragoons all spawned naked through `[xmlload` and
 *  `spawner.tick`. Map cfg metadata (name keywords + magery + body) to
 *  one of the OUTFIT presets defined in items/clothing-presets.js. */
function pickHumanoidPreset(kind, cfg) {
  const HUMAN_BODIES = new Set([400, 401, 0x190, 0x191]);
  if (!HUMAN_BODIES.has(cfg.body | 0)) return null;
  const name = (kind || cfg.name || '').toLowerCase();
  // Order matters — most specific first.
  if (name.includes('mage')   || name.includes('lich')  || name.includes('necro')
      || name.includes('zealot') || (cfg.magery | 0) >= 60) {
    return 'mage';
  }
  if (name.includes('ninja')  || name.includes('ronin') || name.includes('shadow')) {
    return 'bandit';
  }
  if (name.includes('brigand') || name.includes('bandit') || name.includes('thief')
      || name.includes('pirate') || name.includes('rogue')) {
    return 'bandit';
  }
  if (name.includes('knight')  || name.includes('warrior') || name.includes('dragoon')
      || name.includes('paladin') || name.includes('champion')) {
    return 'warrior';
  }
  if (name.includes('lord') || name.includes('noble') || name.includes('king')
      || name.includes('queen') || name.includes('count')) {
    return 'noble';
  }
  // Fallback for nameless humanoid spawns.
  return 'peasant';
}

function dirTowards(dx, dy) {
  const angle = Math.atan2(dy, dx);
  return (Math.round(angle / (Math.PI / 4)) + 10) & 7;
}

/**
 * Walk toward `dir` using api.ai.stepMobile (which honors land/static
 * walkability). If blocked, try the two adjacent diagonals so mobs can
 * navigate around walls instead of grinding in place.
 *
 * `stepMobile` returns true on a pure FACING change (when the mob's
 * direction differs from `d`) — the previous tryStep took that as a
 * successful step and short-circuited, leaving the mob to twitch
 * between facings without ever translating, leaving aggressive NPCs idle.
 * Now we snapshot the position
 * before calling stepMobile and only treat a coord change as a
 * real walk; a turn returns true but is RETRIED in the same tick
 * to actually take the step (one extra stepMobile call with the
 * mob now facing the target direction).
 *
 * @returns {boolean} true if the mob actually moved or finished turning.
 */
function tryStep(api, mob, dir) {
  if (!api.ai?.stepMobile) return false;
  const tryDirs = [dir & 7, (dir + 1) & 7, (dir + 7) & 7];
  for (const d of tryDirs) {
    const x0 = mob.x | 0, y0 = mob.y | 0;
    // Call as a method so `this` resolves to the AIScheduler instance
    // — `stepMobile` reads `this.world` to fire onWalkOn/onWalkOff
    // hooks. The previous local-variable extraction stripped the
    // binding and the AI tick crashed every 500ms with "Cannot read
    // properties of undefined (reading 'world')".
    const turnedOrMoved = api.ai.stepMobile(mob, d);
    if (!turnedOrMoved) continue;
    // Moved this tile? Done.
    if (mob.x !== x0 || mob.y !== y0) return true;
    // Pure turn — facing now matches `d`. Retry once at the same
    // direction to attempt the walk on the same tick. If still
    // blocked (impassable tile), fall through to the next diagonal.
    const x1 = mob.x | 0, y1 = mob.y | 0;
    if (api.ai.stepMobile(mob, d) && (mob.x !== x1 || mob.y !== y1)) return true;
  }
  // No diagonal walked. If we managed even a turn we still return
  // true so the caller broadcasts the facing flip; otherwise the mob
  // is truly boxed in and the caller will path-plan / wait.
  return (mob.direction & 7) === (dir & 7);
}

function findNearestPlayer(api, world, mob, range) {
  let best = null;
  let bestDist = range + 1;
  // Friend gate: a summoned aggressive mob (Blade Spirits, Energy
  // Vortex) carries `team` set to its caster's serial AND `summonedBy`.
  // Without these checks the vortex picked its own caster as the
  // nearest hostile and turned around to attack them. Mirror ServUO
  // BaseCreature.IsEnemy: same team / summonedBy / controlMaster ⇒
  // friendly, skip.
  const myTeam       = mob.team | 0;
  const summonedBy   = mob.summonedBy >>> 0;
  const controlMaster = mob.controlMaster >>> 0;
  if (api.ai?.nearestOnline) {
    return api.ai.nearestOnline(mob, range, (other) => {
      if (myTeam && (other.team | 0) === myTeam) return false;
      if (summonedBy && (other.serial >>> 0) === summonedBy) return false;
      if (controlMaster && (other.serial >>> 0) === controlMaster) return false;
      return true;
    });
  }
  // Sector-indexed scan — only walk mobiles within `range` tiles of
  // the mob. 200 NPCs × 500 world.mobiles × 2 ticks/sec = 200 k iter/s
  // on the old linear path; the indexed scan is O(N_in_radius) instead.
  // Falls back to linear when the sectors index isn't populated (test
  // fixtures that bypass createMobile).
  const gameScan = api?.game?.mobilesNear?.(mob, { range, self: mob });
  if (gameScan) {
    for (const other of gameScan) {
      if (!other || other === mob) continue;
      if (!other.client || other.map !== mob.map) continue;
      if (other.ghost || (other.hp ?? 0) <= 0) continue;
      if (myTeam && (other.team | 0) === myTeam) continue;
      if (summonedBy && (other.serial >>> 0) === summonedBy) continue;
      if (controlMaster && (other.serial >>> 0) === controlMaster) continue;
      const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
      if (d < bestDist) { best = other; bestDist = d; }
    }
    return best ? { target: best, dist: bestDist } : null;
  }
  const sectorScan = world.sectors?.mobileSerialsNear
    ?.bind(world.sectors, mob.map, mob.x, mob.y, range);
  if (sectorScan) {
    for (const serial of sectorScan()) {
      const other = mobileBySerial({ world }, serial);
      if (!other || other === mob) continue;
      if (!other.client || other.map !== mob.map) continue;
      if (other.ghost || (other.hp ?? 0) <= 0) continue;
      if (myTeam && (other.team | 0) === myTeam) continue;
      if (summonedBy && (other.serial >>> 0) === summonedBy) continue;
      if (controlMaster && (other.serial >>> 0) === controlMaster) continue;
      const d = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
      if (d < bestDist) { best = other; bestDist = d; }
    }
    return best ? { target: best, dist: bestDist } : null;
  }
  for (const other of allMobiles({ world })) {
    if (!other.client || other.map !== mob.map) continue;
    if (other.ghost) continue;
    if ((other.hp ?? 0) <= 0) continue;
    if (myTeam && (other.team | 0) === myTeam) continue;
    if (summonedBy && (other.serial >>> 0) === summonedBy) continue;
    if (controlMaster && (other.serial >>> 0) === controlMaster) continue;
    const dx = Math.abs(other.x - mob.x);
    const dy = Math.abs(other.y - mob.y);
    const d = Math.max(dx, dy);
    if (d < bestDist) { best = other; bestDist = d; }
  }
  return best ? { target: best, dist: bestDist } : null;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol) {
    api.log('npc/aggressive: ai/combat/protocol missing; skipping');
    return () => {};
  }
  if (!api.monsters) {
    api.log('npc/aggressive: api.monsters missing; skipping');
    return () => {};
  }

  const FALLBACK = {
    name: 'a monster', body: 0x0011, hue: 0, hp: 50, str: 30, notoriety: 5,
    aggroRange: 6, attackInterval: 2000,
  };
  const cfgFor = (kind) => api.monsters.get(kind) ?? FALLBACK;

  api.ai.registerBehavior({
    name: 'aggressive',
    initState() {
      return {
        targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
        home: null, kind: null,
        fleeUntil: 0,
        // Cached A* route + how stale it is. We re-plan when the path
        // is empty, the target moved >2 tiles since planning, or a
        // step came back blocked. Replanning every tick would be safe
        // but burn CPU — once per few seconds is plenty.
        path: null, pathTargetX: 0, pathTargetY: 0, pathPlannedAt: 0,
      };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      const cfg = cfgFor(state.kind);
      const now = ctx.now;

      // Flee when below 20% HP; commit to fleeing for at least 3s so the
      // monster doesn't immediately turn back around. A higher `bravery`
      // (set in monsters.json for dragons/lich) shrinks the threshold.
      // Audit #30 P2 #7 — ServUO `BaseCreature.CheckFlee` returns false
      // outright when `HitsMax >= 500`. Dragons, peerless bosses, and
      // champion end-bosses never flee; previously a 4000-HP balron
      // would sprint away at 800 HP, exploitable by chip-pull players.
      const hpFrac = (mob.hp ?? 0) / Math.max(1, mob.hpMax ?? 1);
      const bravery = cfg.bravery ?? 0;
      const fleeThreshold = Math.max(0, 0.20 - bravery * 0.05);
      if (hpFrac <= fleeThreshold && (mob.hpMax | 0) < 500) {
        state.fleeUntil = Math.max(state.fleeUntil, now + 3000);
        // Bug-hunt #6 P3 #8 — keep AI awake during a flee window so a
        // hibernating mob doesn't freeze mid-retreat. Mirrors the
        // `_fleeingUntil` check in `world/ai.js` step gate.
        mob._fleeingUntil = state.fleeUntil;
      }

      let target = state.targetSerial ? mobileBySerial({ world: ctx.world }, state.targetSerial) : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost || target.map !== mob.map)) target = null;
      if (!target && state.fleeUntil <= now) {
        target = api.ai.groupTarget?.(mob, now) ?? null;
        const found = target ? null : findNearestPlayer(api, ctx.world, mob, cfg.aggroRange ?? 6);
        target ??= found?.target ?? null;
        state.targetSerial = target?.serial ?? 0;
        if (target) api.ai.publishGroupTarget?.(mob, target);
      }

      // Flee mode: run away from the last threat (if any) or from the
      // mobile's home (if no threat is remembered, just scatter).
      if (state.fleeUntil > now) {
        if (now >= state.nextStepAt) {
          state.nextStepAt = now + 350;
          const threat = target ?? findNearestPlayer(api, ctx.world, mob, 12)?.target;
          const fdx = threat ? mob.x - threat.x : (Math.random() < 0.5 ? -1 : 1);
          const fdy = threat ? mob.y - threat.y : (Math.random() < 0.5 ? -1 : 1);
          const dir = dirTowards(fdx, fdy);
          if (tryStep(api, mob, dir)) ctx.broadcastMove(mob);
        }
        return;
      }

      if (!target) {
        // Lazy-init home if missing — happens when the AI was attached
        // without a state arg (initState() leaves home: null) and the
        // first targetless tick would otherwise crash on state.home.x.
        if (!state.home) state.home = { x: mob.x, y: mob.y };
        if (now >= state.nextStepAt &&
            (Math.abs(mob.x - state.home.x) > 1 || Math.abs(mob.y - state.home.y) > 1)) {
          state.nextStepAt = now + 600;
          const dir = dirTowards(state.home.x - mob.x, state.home.y - mob.y);
          if (tryStep(api, mob, dir)) ctx.broadcastMove(mob);
        }
        return;
      }

      const dx = target.x - mob.x;
      const dy = target.y - mob.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));

      // Spellcaster branch: if the mob has a spell list, prefer ranged casts
      // once we're in sight but out of melee reach. Keeps us from closing
      // into melee for free damage and gives the player time to respond to
      // visible cast animations. Mana is regenerated by regen.js.
      if (cfg.spells && cfg.spells.length > 0 && dist >= 2 && dist <= (cfg.spellRange ?? 10)) {
        if (now >= state.nextCastAt) {
          const spell = pickSpell(cfg.spells, mob);
          if (spell) {
            castAtTarget(api, mob, target, spell);
            state.nextCastAt = now + (cfg.castInterval ?? 2500);
            return;
          }
        }
      }

      if (dist > 1) {
        if (now < state.nextStepAt) return;
        state.nextStepAt = now + 400;
        // Naive line-of-sight chase first (fast). If that step is
        // blocked, fall back to A* through `api.ai.findPath` so the
        // monster can route around walls instead of grinding into
        // them. Cached path is consumed one direction per tick and
        // invalidated when the target drifts far from where we
        // planned.
        const naiveDir = dirTowards(dx, dy);
        if (tryStep(api, mob, naiveDir)) {
          ctx.broadcastMove(mob);
          state.path = null; // line of sight again — drop the cache
          state.pathIndex = 0;
          return;
        }
        const targetDrift = Math.max(
          Math.abs(target.x - state.pathTargetX),
          Math.abs(target.y - state.pathTargetY),
        );
        // Cross-facet recall invalidation. If the target switched maps
        // since planning, the cached A* route walks the mob to phantom
        // coordinates on the wrong facet. The drift check alone misses
        // this — recalling Brit→Skara puts the target near the same x/y
        // numerically. `pathTargetMap` defaults to mob.map at plan
        // time so paths planned before stamping it (legacy saves) just
        // replan normally.
        const targetMapDrift = state.pathTargetMap != null
          && target.map !== state.pathTargetMap;
        if (!state.path || (state.pathIndex ?? 0) >= state.path.length || targetDrift > 2 || targetMapDrift ||
            (now - state.pathPlannedAt) > 5000) {
          if (api.ai.findPath) {
            state.path = api.ai.findPath(mob, target.x, target.y, { maxNodes: 250 }) ?? [];
          } else {
            state.path = [];
          }
          state.pathIndex = 0;
          state.pathTargetX = target.x;
          state.pathTargetY = target.y;
          state.pathTargetMap = target.map;
          state.pathPlannedAt = now;
        }
        if (state.path && (state.pathIndex ?? 0) < state.path.length) {
          // Indexing avoids Array.shift() copying the remaining A* route on
          // every step, which mattered when many monsters chased at once.
          const plannedDir = state.path[state.pathIndex ?? 0];
          state.pathIndex = (state.pathIndex ?? 0) + 1;
          if (tryStep(api, mob, plannedDir)) ctx.broadcastMove(mob);
          else { state.path = null; state.pathIndex = 0; } // map changed under us — replan next tick
        }
        return;
      }

      if (now < state.nextAttackAt) return;
      state.nextAttackAt = now + (cfg.attackInterval ?? 2000);
      const dir = dirTowards(dx, dy);
      if ((mob.direction & 7) !== dir) {
        mob.direction = dir;
        ctx.broadcastMove(mob);
      }
      api.combat.animate(ctx.world, mob, 0x04);
      // Use the shared swing formulas so monsters and players play by the
      // same rules. A monster's `weaponSkill` is a hint that effectiveSkill
      // falls back to when the mobile has no skills dict.
      if (api.combat.hitChance && Math.random() >= api.combat.hitChance(mob, target)) {
        api.combat.animate(ctx.world, target, 0x14, { frameCount: 3 });
        return;
      }
      const dmg = api.combat.rollDamage
        ? api.combat.rollDamage(mob, target)
        : Math.max(1, Math.floor((cfg.str ?? 30) / 10));
      api.combat.damage(ctx.world, target, dmg, mob);
      api.combat.animate(ctx.world, target, 0x14, { frameCount: 5 });
      if ((target.hp ?? 0) <= 0) {
        state.targetSerial = 0;
        if (api.corpse?.killMobile) {
          try { api.corpse.killMobile(ctx.world, target); }
          catch (e) { console.error('[ai/aggressive] killMobile threw:', e); }
        }
      }
    },
  });

  api.commands.register({
    name: 'spawnmob',
    access: 'Admin',
    help: '[spawnmob <kind> — direct mobile spawn; use [mobs for the visual catalogue.',
    run(ctx, args) {
      const kinds = api.monsters.kinds();
      if (!args[0]) {
        ctx.state.sendSystemMessage('Choose a creature in the visual [mobs catalogue, or use [spawnmob <kind>.');
        return;
      }
      const kind = args[0].trim().toLowerCase();
      if (!api.monsters.get(kind)) {
        ctx.state.sendSystemMessage(`Unknown kind. Try: ${kinds.join(', ')}.`);
        return;
      }
      const mob = spawnAggressive(api, ctx.world, kind, {
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
      });
      if (mob) ctx.state.sendSystemMessage(`Spawned ${api.monsters.get(kind).name} (0x${mob.serial.toString(16)}).`);
    },
  });

  if (api.spawner && api.ctx) {
    api.ctx.spawnFactory = (world, kind, pos) => {
      // Monster path — hostile mobs from the catalog.
      if (api.monsters.get(kind)) {
        return spawnAggressive(api, world, kind, pos);
      }
      // Vendor fallback — ServUO XmlSpawner files (`Spawns/trammel.xml`
      // et al.) declare banker / blacksmith / tailor / etc. as the
      // spawn kind. Those aren't monsters; they live in vendor.js
      // VENDOR_KINDS. Route them to `api.vendors.spawnAt` so the bank
      // gets its banker even though the spawner was registered with a
      // non-monster kind. The resulting mob keeps `spawnerId` stamped
      // by the spawner so respawn after death works the same way.
      if (api.vendors?.hasKind?.(kind)) {
        try { return api.vendors.spawnAt(kind, pos); }
        catch (e) { api.log?.(`[spawnFactory] vendor ${kind} threw: ${e.message}`); return null; }
      }
      return null;
    };
  }

  // Reattach `aggressive` AI to every saved-and-restored monster. The
  // behavior binding lives ONLY in the in-memory `ai.bindings` Map —
  // persistence.js round-trips the mob's `kind` field but not the AI
  // binding itself, so a server restart leaves every wild creature
  // standing dumbly. Walk world.mobiles, find anyone with a known
  // monster `kind` that isn't a player, and re-attach. Mirrors the
  // identical pass in npcs/vendor.js (line 1127).
  //
  // Backfill: legacy saves predating the `mob.kind` stamp (PHASE HQ)
  // landed on disk WITHOUT the field. A simple name → kind reverse
  // index lets us recover the binding so old orcs/wolves/lichs aren't
  // permanently inert. Build the index once, look up by exact name —
  // skip ambiguous templates that share a name (rare, mostly bosses).
  const kindByName = new Map();
  for (const k of api.monsters.kinds?.() ?? []) {
    const cfg = api.monsters.get(k);
    if (!cfg?.name) continue;
    if (kindByName.has(cfg.name)) {
      kindByName.set(cfg.name, null);     // mark ambiguous
    } else {
      kindByName.set(cfg.name, k);
    }
  }
  let reattached = 0;
  let backfilled = 0;
  for (const mob of allMobiles(api)) {
    if (mob.isPlayer || mob.client) continue;
    if (mob.vendorKind) continue;          // vendors handle themselves
    if (api.ai?.bindings?.has?.(mob.serial)) continue;
    let kind = mob.kind;
    if (!kind && mob.name) {
      const guess = kindByName.get(mob.name);
      if (guess && api.monsters.get(guess)) {
        kind = guess;
        mob.kind = kind;                   // stamp so next save round-trips it
        backfilled++;
      }
    }
    if (!kind) continue;
    const cfg = api.monsters.get(kind);
    if (!cfg) continue;
    stampStealable(mob);
    // Persisted `mob.aiBehavior` wins (set by spawnAggressive). Saves
    // predating the field fall back to the cfg.ai dispatch table just
    // like a fresh spawn. Unknown behavior name → generic aggressive.
    const desiredAi = desiredAiForMob(mob, cfg);
    const aiBehavior = api.ai?.behaviors?.has?.(desiredAi) ? desiredAi : 'aggressive';
    // Preserve the intended behavior even if its module is registered later
    // in this same script-load pass. A deferred reconciliation below swaps
    // the temporary aggressive binding once all AI modules are available.
    mob.aiBehavior = desiredAi;
    try {
      api.ai.attach(mob, aiBehavior, freshAiState(mob, kind));
      reattached++;
    } catch (e) { console.error('[aggressive] reattach AI threw:', e); }
  }
  if (reattached > 0) {
    api.log?.(`npcs/aggressive: reattached AI to ${reattached} restored monster(s)${backfilled ? ` (${backfilled} backfilled by name)` : ''}`);
  }

  return () => {
    api.ai.unregisterBehavior('aggressive');
    api.commands.unregister?.('spawnmob');
    if (api.ctx && api.ctx.spawnFactory) api.ctx.spawnFactory = null;
  };
}

/**
 * Create an aggressive mobile with loot/gold/behavior attached and broadcast
 * it to nearby players. Shared by `[spawnmob` and the global spawner.
 */
function spawnAggressive(api, world, kind, pos) {
  const cfg = api.monsters.get(kind);
  if (!cfg) return null;
  // Roll a personal name when there's a matching pool. Three buckets:
  //   - monster-archetype pool (daemon, lich, savage, etc.) per
  //     MONSTER_NAME_POOLS — overrides cfg.name when present.
  //   - humanoid body (400/401/605/606/666/667) without an archetype pool
  //     → pull from the per-race human pool ("Aldwin", "Brigitte").
  //   - everything else (rats, dragons, named bosses) keeps cfg.name.
  // pos.name (when provided by a caller) always wins — that's how
  // regional-npcs + boss-spawners pin canon characters in place.
  let displayName = pos?.name ?? null;
  if (!displayName) {
    const poolKey = MONSTER_NAME_POOLS[kind];
    if (poolKey) displayName = api.names?.pickMonster?.(poolKey);
    if (!displayName && HUMANOID_BODIES.has(cfg.body | 0)) {
      displayName = api.names?.pickForMob?.({ body: cfg.body });
    }
  }

  // Dynamic imports register AI behaviors throughout the same script-load
  // pass. Reconcile progressively, then once more after an explicit hot
  // reload event. Five bounded scans replace the previous scan-per-spawn.
  const schedule = api.lifecycle?.setTimeout?.bind(api.lifecycle) ?? setTimeout;
  for (const delay of [0, 100, 250, 500, 1000]) {
    schedule(() => reconcileAiBindings(api), delay);
  }
  api.lifecycle?.event?.('scripts:reloaded', () => reconcileAiBindings(api));

  if (!displayName) displayName = cfg.name;
  const mob = createMobile(api, world, {
    name: displayName, body: cfg.body, hue: cfg.hue ?? 0,
    x: pos.x, y: pos.y, z: pos.z, map: pos.map,
    notoriety: cfg.notoriety,
    hp: cfg.hp, hpMax: cfg.hp,
    str: cfg.str,
    // `weaponSkill` is consumed by combat-formulas.effectiveWeaponSkill as a
    // fallback for mobiles without a `skills` dict. Roughly a third of str
    // matches the "untrained but big" feel — wolves brawl, dragons swing.
    weaponSkill: cfg.weaponSkill ?? Math.min(100, Math.floor((cfg.str ?? 30) * 0.7)),
    armor: cfg.armor ?? Math.floor((cfg.str ?? 30) / 10),
    // Spellcasters need mana + int so regen.js can refill their mana pool
    // between casts. Non-casters leave these undefined (regen short-circuits
    // when manaMax is missing).
    int: cfg.int,
    mana: cfg.mana ?? cfg.manaMax,
    manaMax: cfg.manaMax,
    tameable: !!cfg.tameable,
    tameMinSkill: cfg.tameMinSkill,
    tameMaxSkill: cfg.tameMaxSkill,
    controlSlots: cfg.controlSlots ?? 1,
  });
  // Stamp `kind` so persistence MOBILE_EXT_KEYS round-trips it; without
  // this the AI reattach pass at script-load can't tell what behavior
  // each restored mob should run, and every wild creature stands inert.
  mob.kind = kind;
  mob.homeX = pos.x; mob.homeY = pos.y;
  const [goldLo, goldHi] = cfg.gold ?? [0, 0];
  mob.gold = goldLo + Math.floor(Math.random() * Math.max(1, goldHi - goldLo + 1));
  // Named loot table (resolved by corpse.dropLoot via the loot registry).
  // Wave 9: bosses + champions chain a rare-drop table for artifact /
  // high-budget magic-item drops. Identification heuristic:
  //   - cfg.specialAbilities present (extracted boss flag), or
  //   - cfg.loot === 'boss-hoard' / 'champion-hoard' (authored bosses), or
  //   - cfg.rare === true (manual override on a regular monster).
  // The runtime accepts mob.lootTable as `string` OR `string[]`.
  let lootTables = cfg.loot ?? null;
  const isBoss = !!cfg.specialAbilities || cfg.loot === 'boss-hoard' || cfg.rare === true;
  const isChampion = cfg.loot === 'champion-hoard';
  if (isBoss || isChampion) {
    const base = Array.isArray(lootTables) ? lootTables : (lootTables ? [lootTables] : []);
    const rare = isChampion ? 'champion-rare-drop' : 'boss-rare-drop';
    if (!base.includes(rare)) base.push(rare);
    lootTables = base;
  }
  mob.lootTable = lootTables;
  // ServUO `BaseCreature.AIType` dispatches to one of ~14 specialized
  // BaseAI subclasses (MageAI / NecromancerAI / ArcherAI / NinjaAI /
  // ThiefAI / BerserkerAI / AnimalAI / OrcScoutAI / …). Our equivalent
  // is a `cfg.ai` string on each monsters.json template — 284 entries
  // declare it but the previous code always attached the generic
  // `aggressive` behavior, so liches / mystics / archers / ronin all
  // ran the melee-only loop (with the small `cfg.spells` branch
  // partially compensating for casters). Honour `cfg.ai` when the
  // matching behavior is registered; fall back to `aggressive` for
  // anything unknown so a stray `ai: "noodle"` typo doesn't make the
  // mob inert. The behavior name is stamped on `mob.aiBehavior` so
  // re-attach after restart picks the right one (handled below).
  const desiredAi = configuredAiBehavior(cfg);
  const aiBehavior = api.ai?.behaviors?.has?.(desiredAi) ? desiredAi : 'aggressive';
  mob.aiBehavior = desiredAi;
  // State keys are the union of every AI's expected fields so attach()
  // can short-circuit each behavior's initState() while still feeding
  // mage/caster paths the `nextCastAt` they need (a missing field
  // makes `now >= state.nextCastAt` evaluate NaN → false → no casts).
  api.ai.attach(mob, aiBehavior, freshAiState(mob, kind));
  // PHASE CY: per-spawn paragon roll. ServUO's BaseCreature flags ~5%
  // of natural spawns as paragon; they get ×4 HP, ×2 damage, an
  // orange hue, and "a paragon ..." prefix on their name. Plus a
  // beefier loot drop (handled by the corpse.dropLoot multiplier when
  // `mob.paragon` is set).
  if (api.systems?.paragons?.maybeParagon) {
    api.systems.paragons.maybeParagon(mob, cfg);
  }
  stampStealable(mob);
  // Dress humanoids. Templates in monsters.json don't ship outfits so
  // brigands / evil-mages / ronin / chaos-dragoons spawned NAKED
  // through every spawner path (xmlload, classic dungeons, spawner
  // ticks at end of [createworld). Pick a preset by kind/cfg
  // heuristic and apply via the existing clothing-presets helper.
  // Templates may explicitly opt out by setting `outfit: 'none'`.
  if (cfg.outfit !== 'none') {
    const preset = cfg.outfit ?? pickHumanoidPreset(kind, cfg);
    if (preset && typeof preset === 'string') {
      const def = OUTFIT_TABLE?.[preset];
      if (def) {
        try { applyOutfit(api, world, mob, def); }
        catch (e) { api.log?.(`[spawnAggressive] outfit ${preset} failed: ${e.message}`); }
      }
    }
  }
  // Build the equipment payload so the initial mobileIncoming carries
  // the worn pieces — without this the client renders a frame of nudity
  // until the next equip update arrives.
  const equipment = [];
  const wornItems = api.game?.inventory?.childrenOf?.(mob) ?? allItems({ world });
  for (const it of wornItems) {
    if (!api.game?.inventory?.childrenOf && it.parent !== mob.serial) continue;
    if (!it.layer) continue;
    equipment.push({
      serial: it.serial, itemId: it.itemId, layer: it.layer, hue: it.hue ?? 0,
    });
  }
  const incoming = api.protocol.mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags,
    notoriety: mob.notoriety, equipment,
  });
  // 0xA1 healthUpdate seeds m.hp / m.hpMax on the client. Without it
  // health-lines-manager.draw() short-circuits per-mob (`if (typeof
  // m.hp !== 'number')`) and the overhead HP bar never appears. 0x78 mobileIncoming
  // doesn't carry HP fields, so we have to send a separate 0xA1.
  const healthPkt = api.protocol.healthUpdate?.({
    serial: mob.serial,
    current: mob.hp ?? mob.hpMax ?? 1,
    max: mob.hpMax ?? mob.hp ?? 1,
  });
  // BUGFIX #67 (PHASE CY): visibility-gate. spawnAggressive runs on
  // EVERY natural spawner tick — ~10 per minute on a populated shard.
  // The previous global loop was probably the worst single source of
  // wasted bandwidth; a 50-player shard with one spawn meant 50
  // mobileIncoming packets all but one of them dropped on the
  // visibility-cull on the receiving side. Filter at the source.
  for (const other of nearbyClients(api, mob)) {
    other.client.send(incoming);
    if (healthPkt) other.client.send(healthPkt);
  }
  return mob;
}

/**
 * Pick a spell from the mob's spell list that we can currently afford.
 * Weighted random across affordable entries; returns null if none fit the
 * current mana pool so the caller falls back to melee.
 */
function pickSpell(spells, mob) {
  const mana = mob.mana ?? 0;
  const affordable = spells.filter((s) => (s.mana ?? 0) <= mana);
  if (affordable.length === 0) return null;
  // Equal weights for now — if we want dragon to favor Fireball over
  // Magic Arrow later, add `weight:` per spell.
  return affordable[Math.floor(Math.random() * affordable.length)];
}

/**
 * Emit a ranged spell attack: cast anim on the caster, moving projectile
 * effect from caster→target, sound, and damage through combat.damage so
 * the target's own status bar refreshes identically to any other hit.
 */
function castAtTarget(api, mob, target, spell) {
  mob.mana = Math.max(0, (mob.mana ?? 0) - (spell.mana ?? 0));
  // Face the target before the animation.
  const tdx = target.x - mob.x;
  const tdy = target.y - mob.y;
  const face = (Math.round(Math.atan2(tdy, tdx) / (Math.PI / 4)) + 10) & 7;
  mob.direction = face;
  api.combat.animate(api.world, mob, 0x10 /* Cast */);
  const fx = api.protocol.huedEffect({
    kind: api.protocol.EffectKind?.Moving ?? 1,
    from: mob.serial, to: target.serial,
    itemId: spell.graphicId ?? 0x36E4,
    fromX: mob.x, fromY: mob.y, fromZ: mob.z,
    toX: target.x, toY: target.y, toZ: target.z,
    speed: spell.fxSpeed ?? 7, duration: 0,
    fixedDirection: 1, explodes: spell.explodes ?? 0,
    hue: spell.hue ?? 0, renderMode: 0,
  });
  sendToClientsNear(api, mob, fx);
  if (spell.soundId != null) {
    const pkt = api.protocol.playSound({ soundId: spell.soundId, x: target.x, y: target.y, z: target.z });
    sendToClientsNear(api, target, pkt);
  }
  const [lo, hi] = spell.damage ?? [6, 12];
  const dmg = lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
  api.combat.damage(api.world, target, dmg, mob);
  api.combat.animate(api.world, target, 0x14, { frameCount: 5 });
}
