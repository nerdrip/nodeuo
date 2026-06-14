import { spawnNPC } from './_spawn.js';
import { allMobiles } from '../../_spatial.js';

// Healer NPC behavior.
//
// ServUO's `Wandering Healer` (Scripts/Mobiles/Healers/*.cs) has two jobs:
// raise nearby ghosts and top up wounded mobiles. We model the same two
// branches here — resurrect takes priority over heal because a ghost can't
// fight back and it's the more impactful intervention.
//
// Healing amount scales off the healer's int; players get the full amount,
// NPCs are capped so a healer escort doesn't trivialize combat.

const HEAL_RANGE   = 8;     // tiles (Chebyshev)
const RESS_RANGE   = 2;     // must be adjacent-ish to raise a ghost
const COOLDOWN_MS  = 3000;  // one action per tick
const WOUND_FRAC   = 0.9;   // only heal when hp < 90% of max

function distanceTo(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function findGhost(world, healer) {
  for (const other of allMobiles({ world })) {
    if (!other.ghost) continue;
    if (other.map !== healer.map) continue;
    if (distanceTo(healer, other) > RESS_RANGE) continue;
    return other;
  }
  return null;
}

function findWounded(world, healer) {
  let best = null;
  let bestDeficit = 0;
  for (const other of allMobiles({ world })) {
    if (other === healer) continue;
    if (other.ghost) continue;
    if (other.map !== healer.map) continue;
    // Only heal friendlies (notoriety 1 = Innocent, 2 = Ally). Skip
    // monsters so a town healer never tops up an orc mid-guard-fight.
    const noto = other.notoriety ?? 1;
    if (noto !== 1 && noto !== 2) continue;
    const hp = other.hp ?? 0;
    const max = other.hpMax ?? 1;
    if (hp <= 0) continue;
    if (hp / max >= WOUND_FRAC) continue;
    if (distanceTo(healer, other) > HEAL_RANGE) continue;
    const deficit = max - hp;
    if (deficit > bestDeficit) { best = other; bestDeficit = deficit; }
  }
  return best;
}

function broadcastHealFx(api, healer, target) {
  if (!api.protocol?.huedEffect) return;
  const fx = api.protocol.huedEffect({
    kind: api.protocol.EffectKind?.FromSource ?? 0,
    from: target.serial, to: target.serial,
    itemId: 0x376A,
    fromX: target.x, fromY: target.y, fromZ: target.z,
    toX: target.x, toY: target.y, toZ: target.z,
    speed: 9, duration: 10,
    fixedDirection: 1, explodes: 0,
    hue: 0, renderMode: 0,
  });
  for (const other of allMobiles(api)) {
    if (!other.client) continue;
    if (other.map !== target.map) continue;
    if (Math.abs(other.x - target.x) > 18) continue;
    if (Math.abs(other.y - target.y) > 18) continue;
    other.client.send(fx);
  }
}

function broadcastHp(api, target) {
  if (!api.protocol?.healthUpdate) return;
  const pkt = api.protocol.healthUpdate({
    serial: target.serial, current: target.hp ?? 0, max: target.hpMax ?? 0,
  });
  if (target.client) target.client.send(pkt);
  // Nearby players also see the refreshed bar in their "recent targets" UI.
  for (const other of allMobiles(api)) {
    if (!other.client || other === target) continue;
    if (other.map !== target.map) continue;
    if (Math.abs(other.x - target.x) > 18) continue;
    if (Math.abs(other.y - target.y) > 18) continue;
    other.client.send(pkt);
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.ai) {
    api.log('npc/healer: api.ai missing; skipping');
    return () => {};
  }

  api.ai.registerBehavior({
    name: 'healer',
    initState() {
      return { nextActAt: 0, home: null };
    },
    tick(ctx, mob, state) {
      if (state.home === null) state.home = { x: mob.x, y: mob.y };
      if (ctx.now < state.nextActAt) return;

      // 1) Resurrect any ghost in melee range.
      const ghost = findGhost(ctx.world, mob);
      if (ghost && api.corpse?.resurrectMobile) {
        // Audit #34 P2 #2 — ServUO `Healer.CheckResurrect` refuses
        // murderers (kills ≥ 5) and criminally-flagged ghosts. Was a
        // free pass — reds could shrine-bounce at the nearest NPC.
        if ((ghost.kills | 0) >= 5) {
          ctx.broadcastSpeech(mob, "Thou'rt not a decent and good person. I shall not resurrect thee.", 0x0026);
          state.nextActAt = ctx.now + COOLDOWN_MS;
          return;
        }
        if ((ghost.criminalUntil ?? 0) > Date.now()) {
          ctx.broadcastSpeech(mob, "Thou art a criminal. I shall not resurrect thee.", 0x0026);
          state.nextActAt = ctx.now + COOLDOWN_MS;
          return;
        }
        try { api.corpse.resurrectMobile(ctx.world, ghost); }
        catch (e) { console.error('[healer] resurrectMobile threw:', e); return; }
        ctx.broadcastSpeech(mob, 'Thou shalt walk again, child.', 0x0044);
        broadcastHealFx(api, mob, ghost);
        state.nextActAt = ctx.now + COOLDOWN_MS;
        return;
      }

      // 2) Heal a wounded friendly.
      const patient = findWounded(ctx.world, mob);
      if (patient) {
        const int = mob.int ?? 50;
        const base = 10 + Math.floor(int / 10);
        const amount = patient.client ? base : Math.min(base, 15);
        patient.hp = Math.min(patient.hpMax ?? 0, (patient.hp ?? 0) + amount);
        broadcastHealFx(api, mob, patient);
        broadcastHp(api, patient);
        ctx.broadcastSpeech(mob, 'Be at peace.', 0x0044);
        state.nextActAt = ctx.now + COOLDOWN_MS;
        return;
      }

      // 3) Idle drift toward home — healers don't wander far.
      if (api.ai.stepMobile && state.home) {
        const dx = state.home.x - mob.x;
        const dy = state.home.y - mob.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          const angle = Math.atan2(dy, dx);
          const dir = (Math.round(angle / (Math.PI / 4)) + 10) & 7;
          if (api.ai.stepMobile(mob, dir)) ctx.broadcastMove(mob);
        }
        state.nextActAt = ctx.now + 1500;
      }
    },
  });

  // Spawn a healer at the caller's feet — mirror [crier.
  api.commands.register({
    name: 'healer',
    help: '[healer — spawn a wandering healer at your feet',
    run(ctx) {
      const tmpl = api.npcs?.get('healer') ?? {
        name: 'Sister Margery', title: 'the healer',
        body: 0x0191, hue: 33770, hp: 80, int: 90, notoriety: 1,
      };
      // FAZA CB: route through spawnNPC so the healer arrives wearing a
      // robe + has equipment broadcast in the same mobileIncoming as the
      // body. The previous loop sent equipment=[] so the paperdoll
      // re-sync had to fire before any worn item rendered.
      const npc = spawnNPC(api, ctx.sender, {
        name: tmpl.name, body: tmpl.body, hue: tmpl.hue ?? 0,
        kind: 'healer', outfit: 'mage',
        notoriety: tmpl.notoriety ?? 1,
        hp: tmpl.hp ?? 80, hpMax: tmpl.hp ?? 80,
        invulnerable: false,
        behavior: 'healer',
        fields: { title: tmpl.title, str: tmpl.str, dex: tmpl.dex, int: tmpl.int },
      });
      ctx.state.sendSystemMessage(`Healer 0x${npc.serial.toString(16)} appears.`);
    },
  });

  return () => {
    api.ai.unregisterBehavior('healer');
    api.commands.unregister?.('healer');
  };
}
