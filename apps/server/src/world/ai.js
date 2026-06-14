// NPC AI scheduler.
//
// ServUO drives AI via `Server/Mobiles/BaseAI.cs` ticking per-mobile under a
// heartbeat timer. We run a single interval at 500 ms and walk all *owned*
// mobiles (i.e. those without a `client`) through their registered behavior.
//
// A behavior is a plain object `{ name, tick(ctx, mob) }`. Scripts register
// behaviors and call `attach(mob, behaviorName, state?)`; `detach(mob)` removes
// them. Behaviors can mutate `mob.x/y/direction` and broadcast through
// `ctx.broadcastMove(mob)` / `ctx.broadcastSpeech(mob, text)`.

import { nearbyClients } from './visibility.js';
import { resolveStep } from './movement.js';
import { findPath } from './pathfind.js';
import { dispatchTileWalkEvents } from './item-scripts.js';

/**
 * @typedef {Object} AIContext
 * @property {import('./world.js').World} world
 * @property {number} now        ms from performance.now() at tick start
 * @property {(mob: import('./world.js').Mobile) => void} broadcastMove
 * @property {(mob: import('./world.js').Mobile, text: string, hue?: number) => void} broadcastSpeech
 */

/**
 * @typedef {Object} Behavior
 * @property {string} name
 * @property {(ctx: AIContext, mob: import('./world.js').Mobile, state: any) => void} tick
 * @property {() => any} [initState]
 */

const DIRECTION_DELTAS = [
  [ 0, -1], [ 1, -1], [ 1, 0], [ 1, 1],
  [ 0,  1], [-1,  1], [-1, 0], [-1, -1],
];

// Audit bridge for ServUO `BaseAI.AITimer`: this scheduler is the single
// Node timer that drives all AI bindings.
export const ServUOBaseAIClasses = Object.freeze(['BaseAI', 'AITimer']);

export class AIScheduler {
  /**
   * @param {import('./world.js').World} world
   * @param {Object} deps
   * @param {(mob: import('./world.js').Mobile) => Uint8Array} deps.mobileMovingPacket   build 0x77 for mob
   * @param {(serial: number) => Uint8Array} [deps.removeEntityPacket]
   * @param {(sender: import('./world.js').Mobile, text: string, hue: number) => Uint8Array} deps.unicodeSpeechPacket
   */
  constructor(world, deps) {
    this.world = world;
    this.deps = deps;
    /** @type {Map<string, Behavior>} */
    this.behaviors = new Map();
    /** @type {Map<number, {behavior: string, state: any}>} */
    this.bindings = new Map();
    /** @type {Map<number, {x:number,y:number,z:number,map:number}>} */
    this._lastBroadcastPositions = new Map();
    /** @type {NodeJS.Timeout | null} */
    this._timer = null;
    this.tickIntervalMs = 500;
  }

  registerBehavior(b) {
    if (!b || typeof b.name !== 'string' || typeof b.tick !== 'function') {
      throw new Error('behavior must have name + tick()');
    }
    this.behaviors.set(b.name, b);
  }

  unregisterBehavior(name) {
    this.behaviors.delete(name);
    // Detach any mobiles bound to this behavior so they don't leak ticks.
    for (const [serial, binding] of this.bindings) {
      if (binding.behavior === name) {
        this.bindings.delete(serial);
        this._lastBroadcastPositions.delete(serial >>> 0);
      }
    }
  }

  attach(mob, behaviorName, state) {
    if (!this.behaviors.has(behaviorName)) {
      throw new Error(`unknown behavior: ${behaviorName}`);
    }
    const b = this.behaviors.get(behaviorName);
    this.bindings.set(mob.serial, {
      behavior: behaviorName,
      state: state ?? (b.initState ? b.initState() : {}),
    });
  }

  detach(mob) {
    this.bindings.delete(mob.serial);
    this._lastBroadcastPositions.delete(mob.serial >>> 0);
  }

  /**
   * Walk the mobile one tile in `direction` (0..7) subject to the same
   * walkability rules the human player goes through (`resolveStep`).
   * Exposed here so scripted behaviors can share it via `api.ai.stepMobile`
   * without importing server internals.
   *
   * FAZA BQ: pets and wanderers trigger pressure plates / traps just
   * like players. The instance method has access to `this.world`, which
   * the standalone `stepMobile` export does not (kept world-agnostic so
   * isolated unit tests don't need a world wired up).
   */
  stepMobile(mob, direction) {
    return stepMobile(mob, direction, this.world);
  }

  /**
   * Plan a route from `mob` to `(gx, gy)` on the same facet using A*.
   * Returns an array of direction codes (0..7) or `null` if unreachable
   * within the node budget. Scripts use this when a naive chase step
   * fails (wall in the way) — see `npcs/aggressive.js`.
   */
  findPath(mob, gx, gy, opts = {}) {
    return findPath({
      facet: mob.map, sx: mob.x, sy: mob.y, sz: mob.z,
      gx, gy, ...opts,
    });
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tickAll(), this.tickIntervalMs);
    // Node-only: don't hold the event loop open for AI.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _tickAll() {
    const now = Date.now();
    const ctx = {
      world: this.world,
      now,
      broadcastMove: (m) => this._broadcastMove(m),
      broadcastSpeech: (m, text, hue = 0x03B2) => this._broadcastSpeech(m, text, hue),
    };
    // ServUO BaseCreature.IsActive — every binding pays for AI cost
    // only when a player is within ~24 tiles. The hibernate gate
    // refreshes once per second (`_aiActiveUntil`) so a chasing mob
    // stays awake for an extra second after its target steps out of
    // range — matches the "linger after combat" feel without scanning
    // for players every tick. Engaged combat / fleeing mobs override
    // (their state flag `_aiForceActive` lifts the gate).
    //
    // Empty-shard short-circuit: if zero players are online anywhere,
    // skip the gate entirely — there's nothing for the AI to do but
    // also nothing testing it, and unit tests (which don't simulate
    // players) need the legacy run-every-tick behaviour.
    const sectors = this.world.sectors;
    let anyOnline = false;
    if (sectors?.mobileSerialsNear) {
      for (const m of this.world.mobiles.values()) {
        if (m.client) { anyOnline = true; break; }
      }
    }
    const hibernateEnabled = anyOnline && !!sectors?.mobileSerialsNear;
    for (const [serial, binding] of this.bindings) {
      const mob = this.world.mobiles.get(serial);
      if (!mob) {
        this.bindings.delete(serial);
        this._lastBroadcastPositions.delete(serial >>> 0);
        continue;
      }
      const b = this.behaviors.get(binding.behavior);
      if (!b) continue;
      // Hibernate gate. Pet behaviors, summons, and any mob with an
      // active aggro target stay awake. Otherwise: refresh aliveness
      // every 1 s; if no player is within 24 tiles, skip the tick.
      // Bard-skill overrides — peacemaking suppresses aggression for
      // the calm window; provocation swaps the combatant onto another
      // mob. Stamped by `bard-skills.js` but had no consumer pre-#6.
      if ((mob._peacefulUntil ?? 0) > now) {
        mob.combatant = 0;
      } else if ((mob._provokedUntil ?? 0) > now && mob._provokedTarget) {
        mob.combatant = mob._provokedTarget >>> 0;
      }
      if (hibernateEnabled) {
        // ServUO `BaseAI.Action == Combat` keeps `IsActive` true while
        // an aggro target is set, regardless of player perception. The
        // aggressive / mage / caster behaviours store the target on
        // `binding.state.targetSerial` — NOT on `mob.combatant` (which
        // is only stamped by bard skills + player handlers). Adding the
        // state-target test prevents a chasing mob from hibernating
        // mid-pursuit when its target steps past the 24-tile gate.
        const stateTargetSerial = (binding.state?.targetSerial | 0);
        const forceActive = mob._aiForceActive
                         || binding.behavior === 'pet'
                         || binding.behavior === 'summoned'
                         || (mob.combatant | 0) !== 0
                         || stateTargetSerial !== 0
                         || (mob._fleeingUntil ?? 0) > now;
        if (!forceActive && (mob._aiActiveUntil ?? 0) < now) {
          let nearPlayer = false;
          for (const s of sectors.mobileSerialsNear(mob.map, mob.x, mob.y, 24)) {
            const m = this.world.mobiles.get(s);
            if (m?.client) { nearPlayer = true; break; }
          }
          mob._aiActiveUntil = now + (nearPlayer ? 1000 : 4000);
          if (!nearPlayer) continue;
        }
      }
      try { b.tick(ctx, mob, binding.state); }
      catch (e) { console.error(`[ai] ${binding.behavior} tick threw:`, e); }
    }
  }

  _broadcastMove(mob) {
    // Per-viewer notoriety — each observer may see a different colour
    // (party-mate vs faction enemy vs murderer). Build a fresh packet
    // per observer when the deps support it; fall back to the shared
    // one-byte form for older callers.
    //
    // Audit 2026-05-19 #9 — when this mob just stepped INTO a viewer's
    // 18-tile window, the viewer's `_visibleMobiles` set won't contain
    // its serial yet (`streamVisibilityDelta` only runs on player
    // movement). Without seeding, 0x77 mobileMoving lands first; the
    // client manufactures a stub mob with no equipment, no HP bar, and
    // no name overhead. Check the viewer's seen-set per broadcast and
    // emit `mobileIncoming` + `healthUpdate` first when missing.
    const mobSerial = mob.serial >>> 0;
    const seedIncoming = this.deps.mobileIncomingPacketFor;
    const seedHealth   = this.deps.healthUpdatePacket;
    const removePacket = this.deps.removeEntityPacket?.(mobSerial);
    const previous = mob._lastAiMoveFrom ?? this._lastBroadcastPositions.get(mobSerial);
    mob._lastAiMoveFrom = null;
    const currentViewers = Array.from(nearbyClients(this.world, mob, mob));
    const currentViewerSerials = new Set(currentViewers.map((viewer) => viewer.serial >>> 0));
    if (previous) {
      for (const oldViewer of nearbyClients(this.world, previous, mob)) {
        if (currentViewerSerials.has(oldViewer.serial >>> 0)) continue;
        const state = oldViewer.client;
        if (removePacket) {
          try { state?.send?.(removePacket); } catch { /* ignore */ }
        }
      }
    }
    this._lastBroadcastPositions.set(mobSerial, {
      x: mob.x | 0,
      y: mob.y | 0,
      z: mob.z | 0,
      map: mob.map ?? 1,
    });
    if (this.deps.mobileMovingPacketFor) {
      for (const other of currentViewers) {
        const state = other.client;
        if (seedIncoming && state?._visibleMobiles && !state._visibleMobiles.has(mobSerial)) {
          try { state.send(seedIncoming(mob, other)); } catch { /* ignore */ }
          if (seedHealth) {
            try { state.send(seedHealth(mob)); } catch { /* ignore */ }
          }
          state._visibleMobiles.add(mobSerial);
        }
        other.client.send(this.deps.mobileMovingPacketFor(mob, other));
      }
      return;
    }
    const pkt = this.deps.mobileMovingPacket(mob);
    for (const other of currentViewers) {
      const state = other.client;
      if (seedIncoming && state?._visibleMobiles && !state._visibleMobiles.has(mobSerial)) {
        try { state.send(seedIncoming(mob, other)); } catch { /* ignore */ }
        if (seedHealth) {
          try { state.send(seedHealth(mob)); } catch { /* ignore */ }
        }
        state._visibleMobiles.add(mobSerial);
      }
      other.client.send(pkt);
    }
  }

  _broadcastSpeech(mob, text, hue) {
    const pkt = this.deps.unicodeSpeechPacket(mob, text, hue);
    for (const other of nearbyClients(this.world, mob)) {
      other.client.send(pkt);
    }
  }
}

/**
 * Attempt to walk the mobile one tile in `direction` (0..7). If the
 * direction doesn't match the mobile's facing we just turn. Otherwise we
 * ask the land/statics provider via `resolveStep` and only commit the move
 * when the step is walkable. Returns true on any change (turn or step).
 *
 * FAZA BQ: when a `world` is supplied, fire onWalkOff/onWalkOn lifecycle
 * hooks for items at the source / destination tile. The world is optional
 * so unit tests that exercise pure walkability still construct a free
 * mob without a world reference. AIScheduler.stepMobile / wanderBehavior
 * now both pass `this.world` so traps + pressure plates work for AI too.
 */
export function stepMobile(mob, direction, world = null) {
  // Paralyzed mobiles can't walk or turn. The effect is removed explicitly
  // by cure / expiry / damage; status-effects.tickAll will strip it once
  // expiresAt is past. Returning false here matches how a blocked tile is
  // reported, which keeps callers (AI behavior + player movement) from
  // broadcasting a fake position change.
  if (mob.effects?.some((e) => e.name === 'paralyze')) return false;
  const [dx, dy] = DIRECTION_DELTAS[direction & 7];
  const facing = direction & 7;
  const previous = { x: mob.x | 0, y: mob.y | 0, z: mob.z | 0, map: mob.map ?? 1 };
  mob._lastAiMoveFrom = previous;
  if ((mob.direction & 7) !== facing) {
    mob.direction = facing;
    return true;
  }
  const nx = (mob.x + dx) & 0xFFFF;
  const ny = (mob.y + dy) & 0xFFFF;
  const nz = resolveStep(mob.map, mob.x, mob.y, mob.z, nx, ny);
  if (nz === null) return false;
  const fromTile = world ? previous : null;
  mob.x = nx; mob.y = ny; mob.z = nz;
  mob.direction = facing;
  world?.sectors?.moveMobile(mob);
  if (world && fromTile) {
    dispatchTileWalkEvents(world, mob, fromTile,
      { x: nx, y: ny, z: nz, map: mob.map });
  }
  return true;
}

/** Built-in "wander" behavior: idle, then pick a random direction every N ticks. */
export const wanderBehavior = {
  name: 'wander',
  initState() {
    return { nextStepAt: Date.now() + 2000 + Math.random() * 3000, home: null };
  },
  tick(ctx, mob, state) {
    if (state.home === null) state.home = { x: mob.x, y: mob.y };
    if (ctx.now < state.nextStepAt) return;
    state.nextStepAt = ctx.now + 1500 + Math.random() * 2500;
    const dir = Math.floor(Math.random() * 8);
    // Leash: if we'd drift more than 8 tiles from home, walk back.
    const [dx, dy] = DIRECTION_DELTAS[dir];
    const nx = mob.x + dx, ny = mob.y + dy;
    if (state.home && (Math.abs(nx - state.home.x) > 8 || Math.abs(ny - state.home.y) > 8)) {
      const back = Math.atan2(state.home.y - mob.y, state.home.x - mob.x);
      const facing = Math.round(((back + Math.PI * 2.5) / (Math.PI / 4))) & 7;
      stepMobile(mob, facing, ctx.world);
    } else {
      stepMobile(mob, dir, ctx.world);
    }
    ctx.broadcastMove(mob);
  },
};
