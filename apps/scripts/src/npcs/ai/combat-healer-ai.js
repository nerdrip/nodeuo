// Combat Healer AI — for NPC allies that should keep the rest of the
// party alive. Selects the lowest-HP friendly within heal range and casts
// Greater Heal (or bandage when oom). Cures poison too. Falls back to
// melee-self-defense if attacked.
//
// Mirrors ServUO `HealerAI.cs`. Distinct from the world `healer.js` NPC
// (which resurrect ghosts at shrines / town squares).

// Server parity #9 #6 — sector-aware fan-out for healer scans. Was a
// full world.mobiles walk per healer per tick (≥1/s) — Doom pull burned
// CPU on healers. Falls back when sectors unavailable.
import { nearbyClients, nearbyMobiles } from '../../_spatial.js';

function* _nearby(api, world, healer, range) {
  yield* nearbyMobiles(api?.world ? api : world, healer, null, range);
}

function findHealTarget(api, world, healer, range) {
  let best = null, bestFrac = 0.85;     // skip if everyone above 85% HP
  for (const m of _nearby(api, world, healer, range)) {
    if (m === healer) continue;
    if (m.map !== healer.map) continue;
    const dx = Math.abs(m.x - healer.x), dy = Math.abs(m.y - healer.y);
    if (Math.max(dx, dy) > range) continue;
    if (m.ghost) continue;
    // Only heal allies: party members, controlMaster, or other peaceful
    // NPCs sharing the same notoriety bracket.
    const sameParty = healer.party && m.party === healer.party;
    const sameMaster = healer.controlMaster && healer.controlMaster === m.controlMaster;
    const isMaster = healer.controlMaster === m.serial;
    const peer = m.notoriety === healer.notoriety && !m.client;
    if (!sameParty && !sameMaster && !isMaster && !peer) continue;
    const frac = (m.hp ?? 0) / Math.max(1, m.hpMax ?? 1);
    if (frac < bestFrac) { bestFrac = frac; best = m; }
  }
  return best;
}

function findPoisoned(api, world, healer, range) {
  for (const m of _nearby(api, world, healer, range)) {
    if (m.map !== healer.map) continue;
    if (Math.max(Math.abs(m.x - healer.x), Math.abs(m.y - healer.y)) > range) continue;
    if (!m.effects?.some(e => e.name === 'poison')) continue;
    const sameParty = healer.party && m.party === healer.party;
    const sameMaster = healer.controlMaster && healer.controlMaster === m.controlMaster;
    if (sameParty || sameMaster || m === healer) return m;
  }
  return null;
}

function* _clientsNear(api, world, center, range = 18) {
  yield* nearbyClients(api?.world ? api : world, center, null, range);
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai || !api.combat || !api.protocol) {
    api.log('npc/combat-healer-ai: missing api; skipping');
    return () => {};
  }

  api.ai.registerBehavior({
    name: 'combat-healer',
    initState() { return { nextActionAt: 0, healRange: 6 }; },
    tick(ctx, mob, state) {
      const now = ctx.now;
      if (now < state.nextActionAt) return;

      // Mana regen.
      mob.mana = Math.min(mob.manaMax ?? 50, (mob.mana ?? 0) + 0.05);

      // Cure poison first — that's an instant kill if untreated long enough.
      const poisoned = findPoisoned(api, ctx.world, mob, state.healRange);
      if (poisoned && (mob.mana ?? 0) >= 6) {
        mob.mana -= 6;
        if (poisoned.effects) {
          poisoned.effects = poisoned.effects.filter(e => e.name !== 'poison');
        }
        api.combat.animate(ctx.world, mob, 0x10);
        api.combat.animate(ctx.world, poisoned, 0x14, { frameCount: 3 });
        // Subtle sparkle effect.
        try {
          const fx = api.protocol.huedEffect({
            kind: api.protocol.EffectKind?.Stationary ?? 0,
            from: poisoned.serial, to: poisoned.serial,
            itemId: 0x373A,
            fromX: poisoned.x, fromY: poisoned.y, fromZ: poisoned.z,
            toX:   poisoned.x, toY:   poisoned.y, toZ:   poisoned.z,
            speed: 8, duration: 12, fixedDirection: 1, explodes: 0,
            hue: 0x40, renderMode: 0,
          });
          for (const o of _clientsNear(api, ctx.world, poisoned, 18)) o.client.send(fx);
        } catch { /* fx is nice-to-have */ }
        state.nextActionAt = now + 1500;
        return;
      }

      // Heal lowest-HP ally.
      const target = findHealTarget(api, ctx.world, mob, state.healRange);
      if (target) {
        if ((mob.mana ?? 0) >= 11) {
          // Greater Heal: 25-35 HP.
          mob.mana -= 11;
          const heal = 25 + Math.floor(Math.random() * 11);
          target.hp = Math.min(target.hpMax ?? 50, (target.hp ?? 0) + heal);
          api.combat.animate(ctx.world, mob, 0x10);
          // Broadcast updated HP so any open status bars refresh.
          try {
            const upd = api.protocol.healthUpdate({
              serial: target.serial, current: target.hp, max: target.hpMax ?? 50,
            });
            for (const o of _clientsNear(api, ctx.world, target, 18)) o.client.send(upd);
            if (target.client) target.client.send(upd);
          } catch { /* swallow */ }
          state.nextActionAt = now + 2500;
          return;
        }
      }
      state.nextActionAt = now + 1000; // idle cycle
    },
  });

  return () => api.ai.unregisterBehavior('combat-healer');
}
