import { allMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
// Pet AI behavior — drives a creature whose `controlMaster` points at a
// player. Mirrors ServUO's `BaseCreature.AIType_Animal` plus the BaseAI
// command states (Follow / Stay / Attack / Guard) collapsed into one
// state machine because we don't have separate AI subclasses.
//
// State stored in the binding: `{ command, targetSerial, nextStepAt,
// nextAttackAt, fleeUntil }`. Players issue commands via the [pet
// command (typed in chat) which mutates this state. The behaviour is
// otherwise reactive: it reads `mob.controlMaster` each tick, paths to
// the master when in 'follow', stands still when in 'stay', closes
// to and attacks when in 'attack', and watches for aggressors when
// in 'guard'.
//
// We do NOT replicate ServUO's loyalty/hunger system in this round —
// pets are persistently bound until the player releases them with
// `[pet release`. Stable system (rented for 30 days) is FAZA J cont.

const FOLLOW_RANGE = 6;
const REPLAN_DRIFT = 3;

function distanceTo(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function dirTowards(dx, dy) {
  if (dx === 0) return dy < 0 ? 0 : 4;
  if (dy === 0) return dx < 0 ? 6 : 2;
  if (dx > 0)   return dy < 0 ? 1 : 3;
  return            dy < 0 ? 7 : 5;
}

function tryStep(api, mob, dir) {
  // api.ai.stepMobile is the canonical mobile-mover that runs the
  // ServUO MovementImpl checks. Try the chosen direction first, then
  // the two adjacent diagonals so a pet can route around obstacles
  // without an A* call. Mirrors the helper in aggressive.js.
  if (!api.ai?.stepMobile) return false;
  const tryDirs = [dir & 7, (dir + 1) & 7, (dir + 7) & 7];
  for (const d of tryDirs) {
    if (api.ai.stepMobile(mob, d)) return true;
  }
  return false;
}

export default function (api) {
  api.ai.registerBehavior({
    name: 'pet',
    initState() {
      return {
        // BUGFIX #49 (FAZA CG): pet command state used to live ONLY in
        // the per-binding state — but bindings are runtime-only, never
        // serialised. Every server restart blindly reset every pet
        // back to 'follow' even if the player had ordered them to
        // 'stay' or 'guard'. We now read `mob.petCommand` (persisted
        // via MOBILE_EXT_KEYS in persistence.js) as the source of
        // truth, with state.command kept as a transient mirror.
        command: 'follow',
        targetSerial: 0,
        nextStepAt: 0,
        nextAttackAt: 0,
        path: null, pathTargetX: 0, pathTargetY: 0, pathPlannedAt: 0,
      };
    },
    tick(ctx, mob, state) {
      // FAZA CG: sync command from persisted field if present. Mutators
      // (the [pet command + speech parser) write `mob.petCommand` so
      // both old and new instances see the same intent across restart.
      if (mob.petCommand && mob.petCommand !== state.command) {
        state.command = mob.petCommand;
      }
      // FAZA CG: drain _heardSpeech for "all <verb>" commands from the
      // master. Other speakers' chatter is filtered by the speech-push
      // gate in handlers.js (we set _speechKeywords = ['all'] when the
      // pet is bound), so this loop only sees relevant utterances.
      const queue = mob._heardSpeech;
      if (Array.isArray(queue) && queue.length > 0) {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry?.text || !entry.speaker) continue;
          // Only the master's speech triggers commands.
          if ((entry.speaker.serial >>> 0) !== (mob.controlMaster >>> 0)) continue;
          const lc = String(entry.text).toLowerCase().trim();
          if (!lc.startsWith('all ')) continue;
          const verb = lc.slice(4).split(/\s+/)[0];
          if (verb === 'follow' || verb === 'come') {
            mob.petCommand = state.command = 'follow';
            state.targetSerial = 0;
          } else if (verb === 'stay' || verb === 'wait' || verb === 'stop') {
            mob.petCommand = state.command = 'stay';
            state.targetSerial = 0;
          } else if (verb === 'guard') {
            mob.petCommand = state.command = 'guard';
            state.targetSerial = 0;
          } else if (verb === 'kill' || verb === 'attack') {
            // "all kill" needs a target — pet attacks the master's
            // last attacked mobile (combatant) if no explicit one.
            mob.petCommand = state.command = 'attack';
            const combatant = (entry.speaker.combatant ?? entry.speaker.client?.combatant) | 0;
            if (combatant) state.targetSerial = combatant >>> 0;
          } else if (verb === 'release') {
            // Speech-driven release — same effect as `[pet release`.
            // BH #13 B9 — also drop from _pets reverse index so hunger
            // tick stops naming the ex-master in "your pet is starving"
            // messages.
            mob.controlMaster = 0;
            if (ctx.world?._pets) ctx.world._pets.delete(mob.serial);
            mob.notoriety = 3;
            mob.petCommand = state.command = 'follow';
            api.ai?.attach?.(mob, 'wander');
            ctx.broadcastSpeech?.(mob, '*looks at you and wanders off*', 0x35);
            return;
          } else {
            continue;            // unknown verb — keep scanning
          }
          ctx.broadcastSpeech?.(mob, '*nods*', 0x35);
          break;
        }
      }

      const master = mob.controlMaster
        ? mobileBySerial({ world: ctx.world }, mob.controlMaster >>> 0)
        : null;

      if (!master) {
        // Master gone (logged out forever / deleted). Fall back to
        // wandering in place — caller can re-bind via [tame.
        return;
      }
      // BUGFIX #5 (FAZA AJ): when the master logs out we keep their
      // mobile in `world.mobiles` so the next login rebinds the same
      // character — but `master.client === null`. Without this guard,
      // the pet kept following the offline master's last position
      // (path-finding to a ghost), draining CPU and confusing
      // bystanders. While the master is offline, the pet idles in
      // place; on master login the pet resumes follow on the next
      // tick (master.client becomes non-null).
      if (!master.client) {
        return;
      }

      const now = ctx.now;
      const dx = master.x - mob.x;
      const dy = master.y - mob.y;
      const distMaster = distanceTo(mob, master);

      // ── ATTACK / GUARD branches ─────────────────────────────────────
      // Both share a target; guard auto-picks any aggressor of master.
      let target = state.targetSerial
        ? mobileBySerial({ world: ctx.world }, state.targetSerial >>> 0)
        : null;
      if (target && ((target.hp ?? 0) <= 0 || target.ghost || target.map !== mob.map)) {
        target = null;
        state.targetSerial = 0;
      }

      // Audit #34 P3 #8 — pets in non-guard modes (follow/come/stay)
      // ignored damage to their master. ServUO `BaseCreature.OnDamage`
      // propagates: any aggressor of the master who hit within the
      // last 8 s and is within 12 tiles becomes the pet's auto target.
      // The combat tick stamps `_lastDamageBy`/`_lastDamageAt` on
      // every defender. Skip when already in guard (which has its
      // own AoE aggressor scan).
      if (!target && state.command !== 'guard'
          && state.command !== 'stay' /* stay = literally don't move */) {
        const lastBy = master._lastDamageBy | 0;
        const lastAt = master._lastDamageAt | 0;
        if (lastBy && now - lastAt < 8000) {
          const aggressor = mobileBySerial({ world: ctx.world }, lastBy >>> 0);
          if (aggressor && !aggressor.ghost && (aggressor.hp ?? 0) > 0
              && aggressor.map === mob.map
              && distanceTo(mob, aggressor) <= 12) {
            target = aggressor;
            state.targetSerial = aggressor.serial >>> 0;
          }
        }
      }

      if (state.command === 'guard' && !target) {
        // BH #13 B8 — was full world.mobiles walk per pet per tick
        // (50 pets × 5-50k mobs/sec). Sector-aware fan-out.
        const sectors = ctx.world.sectors;
        const iter = sectors?.mobileSerialsNear
          ? (function* () {
              for (const s of sectors.mobileSerialsNear(master.map, master.x, master.y, 8)) {
                const m = mobileBySerial({ world: ctx.world }, s);
                if (m) yield m;
              }
            })()
          : allMobiles({ world: ctx.world });
        for (const other of iter) {
          if (other === mob || other === master) continue;
          if (other.ghost || (other.hp ?? 0) <= 0) continue;
          const noto = other.notoriety ?? 1;
          if (noto === 1 || noto === 2) continue; // friendly
          if (distanceTo(other, master) > 8) continue;
          target = other;
          state.targetSerial = other.serial >>> 0;
          break;
        }
      }

      if ((state.command === 'attack' || state.command === 'guard') && target) {
        const tdx = target.x - mob.x;
        const tdy = target.y - mob.y;
        const tdist = Math.max(Math.abs(tdx), Math.abs(tdy));

        if (tdist > 1) {
          if (now < state.nextStepAt) return;
          state.nextStepAt = now + 350;
          const nDir = dirTowards(tdx, tdy);
          if (tryStep(api, mob, nDir)) {
            ctx.broadcastMove(mob);
            state.path = null;
            return;
          }
          // Path-find around obstacles, same trick as aggressive.
          const drift = Math.max(
            Math.abs(target.x - state.pathTargetX),
            Math.abs(target.y - state.pathTargetY),
          );
          if (!state.path || state.path.length === 0 || drift > REPLAN_DRIFT
              || (now - state.pathPlannedAt) > 4000) {
            state.path = api.ai.findPath
              ? (api.ai.findPath(mob, target.x, target.y, { maxNodes: 200 }) ?? [])
              : [];
            state.pathTargetX = target.x; state.pathTargetY = target.y;
            state.pathPlannedAt = now;
          }
          if (state.path?.length) {
            const planned = state.path.shift();
            if (tryStep(api, mob, planned)) ctx.broadcastMove(mob);
            else state.path = null;
          }
          return;
        }

        // Within melee range — swing.
        if (now < state.nextAttackAt) return;
        const cfg = api.monsters?.get?.(mob.kind) ?? {};
        state.nextAttackAt = now + (mob.attackInterval ?? cfg.attackInterval ?? 1800);
        const dir = dirTowards(tdx, tdy);
        if ((mob.direction & 7) !== dir) {
          mob.direction = dir;
          ctx.broadcastMove(mob);
        }
        api.combat?.animate?.(ctx.world, mob, 0x04);
        if (api.combat?.hitChance && Math.random() >= api.combat.hitChance(mob, target)) {
          // miss
          api.combat.animate(ctx.world, target, 0x14, { frameCount: 3 });
          return;
        }
        if (api.combat?.rollDamage) {
          let dmg = api.combat.rollDamage(mob, target) + (mob._petBonusDamage | 0);
          if (mob._petFireBreath && Math.random() < 0.12) dmg += Math.max(5, Math.floor((mob.str | 0) / 20));
          if (mob._petPoisonAttack && Math.random() < 0.18) {
            try { api.poison?.apply?.(ctx.world, target, 1, mob); } catch { /* optional */ }
          }
          target.hp = Math.max(0, (target.hp ?? 0) - dmg);
          if (target.client) {
            target.client.send(api.protocol.damagePacket?.({ serial: target.serial, amount: dmg }));
            target.client.send(api.protocol.healthUpdate?.({
              serial: target.serial, current: target.hp, max: target.hpMax ?? 50,
            }));
          }
          if (target.hp <= 0) {
            api.corpse?.killMobile?.(ctx.world, target);
            state.targetSerial = 0;
          }
        }
        return;
      }

      // ── STAY ────────────────────────────────────────────────────────
      if (state.command === 'stay') {
        // Idle. Don't move. Pet still receives orders via [pet command.
        return;
      }

      // ── FOLLOW ─────────────────────────────────────────────────────
      if (distMaster > FOLLOW_RANGE) {
        if (now < state.nextStepAt) return;
        state.nextStepAt = now + 400;
        const nDir = dirTowards(dx, dy);
        if (tryStep(api, mob, nDir)) {
          ctx.broadcastMove(mob);
          state.path = null;
          return;
        }
        // A* fallback for obstacles (river, fence corner).
        const drift = Math.max(
          Math.abs(master.x - state.pathTargetX),
          Math.abs(master.y - state.pathTargetY),
        );
        if (!state.path || state.path.length === 0 || drift > REPLAN_DRIFT
            || (now - state.pathPlannedAt) > 4000) {
          state.path = api.ai.findPath
            ? (api.ai.findPath(mob, master.x, master.y, { maxNodes: 200 }) ?? [])
            : [];
          state.pathTargetX = master.x; state.pathTargetY = master.y;
          state.pathPlannedAt = now;
        }
        if (state.path?.length) {
          const planned = state.path.shift();
          if (tryStep(api, mob, planned)) ctx.broadcastMove(mob);
          else state.path = null;
        }
      }
    },
  });

  return () => { api.ai.unregisterBehavior?.('pet'); };
}
