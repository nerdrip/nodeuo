import { aura, broadcastEffect, broadcastSound, healthUpdateFor, mobilesNear, skillValue } from '../_helpers.js';
const CURSES = ['curse','corpse-skin','evil-omen','mind-rot','strangle','blood-oath','poison'];
// Audit #37 P2 #1 — ServUO `CleansingWindsSpell.OnTarget:51-110`:
//   heal primary + up to 3 nearby party members (radius 2)
//   per-target poison cure chance: `(10000 + (mys+sec)/2 *75 - lvl*1750)/100`
//   heal scales with Mys + max(Focus, Imbuing), then ÷ targets.length
//   each curse removed reduces heal by `3 + level%`
// Mortal-wound blocks heal entirely. Was: primary only, flat `15+mys/6`.
const PARTY_RADIUS = 2;
const MAX_PARTY_TARGETS = 3;
export default {
  name: 'cleansing-winds', school: 'mysticism', circle: 6, mana: 20,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Cleansing Winds needs a target.');
    const caster = ctx.sender;
    const mys = skillValue(caster, 56);
    const sec = Math.max(skillValue(caster, 51), skillValue(caster, 57));
    // Build target list: primary + party members within radius 2.
    const targets = [target];
    if (caster.party === target.party && caster.party) {
      for (const m of mobilesNear(api, target, PARTY_RADIUS)) {
        if (m === target || m === caster) continue;
        if (m.party !== caster.party) continue;
        targets.push(m);
        if (targets.length > MAX_PARTY_TARGETS + 1) break;
      }
    }
    let baseHeal = Math.floor((mys + sec) / 4);
    if (targets.length > 1) baseHeal = Math.floor(baseHeal / targets.length);
    for (const t of targets) {
      // Mortal Strike blocks heal.
      if ((t._mortalStrikeUntil ?? 0) > Date.now()) {
        if (t.client) t.client.sendSystemMessage('A mortal wound prevents the healing.');
        continue;
      }
      // Per-target poison-cure chance.
      const poisonLvl = t.poisonLevel | 0;
      const chance = (10000 + ((mys + sec) / 2) * 75 - poisonLvl * 1750) / 100;
      let heal = baseHeal;
      // Curse removal — each successful remove reduces this target's heal.
      for (const name of CURSES) {
        if (api.statusEffects?.has?.(t, name)) {
          if (name === 'poison' && Math.random() * 100 >= chance) continue;
          api.statusEffects.remove(t, name);
          heal = Math.max(1, heal - (3 + poisonLvl));
        }
      }
      t.hp = Math.min(t.hpMax ?? 50, (t.hp ?? 0) + heal);
      if (t.client) t.client.send(healthUpdateFor(api, t));
    }
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x376A, hue: 0x4FE }));
    broadcastSound(api, api.world, target, 0x65E);
  },
};
