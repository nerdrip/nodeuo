// Elemental Special Abilities — adds per-kind passive procs on hit.
//
// ServUO `Mobiles/Monsters/*Elemental*.cs` gives each elemental a
// signature "on-attack" passive: Fire elementals splash burn, Cold
// elementals chill (slow), Earth elementals knock back, Air elementals
// dispel buffs, Energy/Lightning chain-lightning to a nearby foe.
//
// We hook a `combat:hit` listener (via the world event bus) and check
// the attacker's kind. Each kind has a flat 25% proc chance per hit.

import { moveMobile } from '../_movement.js';
import { allMobiles } from '../_spatial.js';

const ELEMENTAL_PROCS = {
  'fire-elemental': {
    chance: 0.25,
    apply: (api, attacker, defender) => {
      defender._burnUntil = Math.max(defender._burnUntil ?? 0, Date.now() + 4000);
      defender._burnDpt = Math.max(defender._burnDpt ?? 0, 3);
      defender.client?.sendSystemMessage?.('A burning ember sears you!');
      try { api.statusEffects?.apply?.(defender, { name: 'burning', durationMs: 4000 }); }
      catch { /* status optional */ }
      void attacker;
    },
  },
  'cold-elemental': {
    chance: 0.25,
    apply: (api, _attacker, defender) => {
      defender._chillSlowUntil = Date.now() + 3000;
      defender._chillStepMs = 600;          // walker.js reader (step throttle)
      defender.client?.sendSystemMessage?.('Frost numbs your limbs.');
      try { api.statusEffects?.apply?.(defender, { name: 'chilled', durationMs: 3000 }); }
      catch { /* optional */ }
    },
  },
  'earth-elemental': {
    chance: 0.25,
    apply: (api, attacker, defender) => {
      // Knock back 1 tile in the attacker→defender direction.
      const dx = Math.sign(defender.x - attacker.x);
      const dy = Math.sign(defender.y - attacker.y);
      if (dx !== 0 || dy !== 0) {
        moveMobile(api, defender, {
          x: (defender.x | 0) + dx,
          y: (defender.y | 0) + dy,
          z: defender.z,
          map: defender.map,
        });
      }
      defender.client?.sendSystemMessage?.('A heavy stone shoulder slams into you!');
    },
  },
  'air-elemental': {
    chance: 0.25,
    apply: (api, _attacker, defender) => {
      // Strip ONE buff status effect.
      const eff = defender._statusEffects ?? defender.effects;
      if (Array.isArray(eff) && eff.length > 0) {
        // Drop the first buff-flavour effect (heuristic: not a debuff).
        const idx = eff.findIndex((e) =>
          !/curse|poison|bleed|burn|chill|paralyz|stun|wound/i.test(e.name ?? ''));
        if (idx >= 0) {
          eff.splice(idx, 1);
          defender.client?.sendSystemMessage?.('A swirling wind disperses one of your spells.');
        }
      }
    },
  },
  'energy-vortex': {
    chance: 0.20,
    apply: (api, attacker, defender) => {
      // Chain-lightning to a second nearby foe (within 3 tiles).
      for (const m of allMobiles(api)) {
        if (m === defender || m === attacker) continue;
        if (m.map !== defender.map) continue;
        const dx = Math.abs(m.x - defender.x), dy = Math.abs(m.y - defender.y);
        if (Math.max(dx, dy) > 3) continue;
        if ((m.notoriety | 0) === 2) continue;       // skip townfolk
        const dmg = 8 + Math.floor(Math.random() * 4);
        try {
          api.combat?.damage?.(m, dmg, { damageType: { energy: 100 }, source: attacker });
        } catch { /* combat optional */ }
        m.client?.sendSystemMessage?.('A chain of lightning arcs into you!');
        break;
      }
    },
  },
  'lightning-elemental': {
    chance: 0.25,
    apply: (api, _attacker, defender) => {
      const dmg = 6 + Math.floor(Math.random() * 4);
      try {
        api.combat?.damage?.(defender, dmg, { damageType: { energy: 100 }, source: _attacker });
      } catch { /* combat optional */ }
      defender.client?.sendSystemMessage?.('Lightning crackles across your armor!');
    },
  },
  'poison-elemental': {
    chance: 0.30,
    apply: (api, _attacker, defender) => {
      try { api.systems?.poison?.applyPoison?.(defender, { level: 2 }); }
      catch { /* optional */ }
      defender.client?.sendSystemMessage?.('Toxic mist seeps into your wounds.');
    },
  },
};

export default function register(api) {
  if (!api.world?.events?.on) return () => {};

  const onHit = (payload) => {
    const attacker = payload?.attacker ?? payload?.source;
    const defender = payload?.defender ?? payload?.target;
    if (!attacker || !defender) return;
    const proc = ELEMENTAL_PROCS[attacker.kind];
    if (!proc) return;
    if (Math.random() >= proc.chance) return;
    try { proc.apply(api, attacker, defender); }
    catch (e) { api.log?.(`[elemental-procs] ${attacker.kind} threw: ${e.message}`); }
  };

  const unsub = api.lifecycle?.event?.('combat:hit', onHit)
    ?? api.world.events.on('combat:hit', onHit);

  return () => {
    if (!api.lifecycle) {
      try { unsub?.(); } catch { /* ignore */ }
    }
  };
}
