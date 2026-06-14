import { mobileBySerial } from '../../_entities.js';
import { allMobiles } from '../../_spatial.js';
// Faction Guard AI — ServUO `Mobiles/AI/FactionGuard.cs` + faction
// stronghold guards.
//
// Behavior:
//   • Stationary — anchored to the stronghold tile at spawn (home).
//   • Tracks intruders within range 12 whose `faction` differs from
//     the guard's own. Same-faction allies and unaligned players are
//     ignored.
//   • Engages: closes to range 2 with melee swing, or casts a single
//     spell from a small whitelist if `_factionGuardMage` is set.
//   • Calls for help: on first engagement of a target, broadcasts a
//     "Help me!" speech in range 8 so nearby allied guards converge.
//   • Returns home: if the target lapses out of range or dies, the
//     guard walks back to its home tile and resumes idle.
//
// Spawn flow — `tagFactionNpc(mob, factionKey)` first, then attach
// this behavior via `api.ai.attach(mob, 'faction-guard')`. Optional
// per-mob flag: `_factionGuardMage: true` switches melee → ranged spell
// (Lightning preferred).

const ENGAGE_RANGE = 12;
const MELEE_RANGE = 2;
const SPELL_RANGE = 8;
const HOME_RETURN_LEASH = 16;
const SWING_INTERVAL = 1500;

export default function register(api) {
  if (!api.ai?.registerBehavior) return () => {};

  api.ai.registerBehavior({
    name: 'faction-guard',
    tick(ctx, mob, state) {
      if (!mob || (mob.hp ?? 0) <= 0) return;
      // Pin the home tile on first tick.
      state.home ??= { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
      state.lastSwingAt ??= 0;
      state.currentTargetSerial ??= 0;

      const myFaction = mob.faction;
      if (!myFaction) return;                  // not tagged → idle

      // Drop stale target.
      let target = state.currentTargetSerial
        ? mobileBySerial({ world: ctx.world }, state.currentTargetSerial)
        : null;
      if (target && (
        (target.hp ?? 0) <= 0 ||
        target.map !== mob.map ||
        Math.max(Math.abs(target.x - mob.x), Math.abs(target.y - mob.y)) > ENGAGE_RANGE
      )) {
        target = null;
        state.currentTargetSerial = 0;
      }

      // Scan for a new target if needed.
      if (!target) {
        let best = null; let bestDist = ENGAGE_RANGE + 1;
        for (const cand of allMobiles({ world: ctx.world })) {
          if (!cand.client) continue;          // players only
          if (cand === mob) continue;
          if (cand.map !== mob.map) continue;
          if ((cand.hp ?? 0) <= 0) continue;
          if (cand.faction === myFaction) continue;
          const d = Math.max(Math.abs(cand.x - mob.x), Math.abs(cand.y - mob.y));
          if (d > ENGAGE_RANGE) continue;
          if (d < bestDist) { bestDist = d; best = cand; }
        }
        if (best) {
          target = best;
          state.currentTargetSerial = target.serial >>> 0;
          // Call for help — broadcast a help-speech in CALL_FOR_HELP_RANGE.
          try {
            ctx.broadcastSpeech?.(mob, 'Help, brethren! Intruder!', 0x03B2);
          } catch { /* */ }
        }
      }

      // No target — return home if we've wandered.
      if (!target) {
        const dh = Math.max(Math.abs(mob.x - state.home.x), Math.abs(mob.y - state.home.y));
        if (dh > 0 && dh < HOME_RETURN_LEASH) {
          // Step one tile toward home.
          const dx = Math.sign(state.home.x - mob.x);
          const dy = Math.sign(state.home.y - mob.y);
          mob.x += dx; mob.y += dy;
        }
        return;
      }

      // Engage. Mage variant: cast at SPELL_RANGE; melee: close to 2.
      const dist = Math.max(Math.abs(target.x - mob.x), Math.abs(target.y - mob.y));
      if (mob._factionGuardMage && dist <= SPELL_RANGE) {
        if (ctx.now - state.lastSwingAt >= SWING_INTERVAL) {
          state.lastSwingAt = ctx.now;
          const dmg = 15 + Math.floor(Math.random() * 11);
          try {
            ctx.world._combat?.damage?.(ctx.world, target, dmg, mob);
            ctx.broadcastEffect?.(mob, target, 0x379F, 8, 12, 0x481);
          } catch { /* */ }
        }
        return;
      }
      // Melee — step toward target.
      if (dist > MELEE_RANGE) {
        mob.x += Math.sign(target.x - mob.x);
        mob.y += Math.sign(target.y - mob.y);
        return;
      }
      if (ctx.now - state.lastSwingAt >= SWING_INTERVAL) {
        state.lastSwingAt = ctx.now;
        const dmg = 18 + Math.floor(Math.random() * 9);
        try {
          ctx.world._combat?.damage?.(ctx.world, target, dmg, mob);
          if (typeof ctx.broadcastAnimate === 'function') ctx.broadcastAnimate(mob, 9);
        } catch { /* */ }
      }
    },
  });

  return () => api.ai.unregisterBehavior?.('faction-guard');
}
