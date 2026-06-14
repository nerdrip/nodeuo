// FAZA DY — `[hire` mercenary command.
//
// ServUO's `Engines/Hires/HireFighter.cs` lets the player hire armed
// NPCs by paying gold up-front. The hireling follows the master like
// a pet, fights for them, and dismisses (or starves) when their pay
// is exhausted. We ship the irreducible core: spawn a hireling for a
// fixed cost, with a 24-hour pay timer the master must top up.
//
// `[hire fighter|warrior|archer|mage|thief|bard|paladin|beggar` — hireable
// humanoid roles.
// `[dismiss` — release adjacent hireling.
// `[pay` — top up the active hireling's wage timer.

import { applyOutfit, _PRESETS_FOR_TEST as OUTFIT_PRESETS } from '../../items/behaviors/clothing-presets.js';
import { equipped, packItems } from '../../_inventory.js';
import { allMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
import { createMobile, destroyMobileBySerial } from '../../_mobiles.js';

const HIRE_ROLES = Object.freeze({
  warrior: {
    kind: 'hireling-warrior',
    name: 'warrior for hire',
    display: 'warrior',
    cost: 1000,
    body: 0x190,
    hue: 0x44E,
    hp: 110,
    str: 90,
    dex: 80,
    int: 40,
    weaponSkill: 70,
    armor: 25,
    outfit: 'warrior',
    skills: { 28: 700, 41: 700, 6: 550 },
  },
  archer: {
    kind: 'hireling-archer',
    name: 'archer for hire',
    display: 'archer',
    cost: 1500,
    body: 0x190,
    hue: 0x83A,
    hp: 90,
    str: 70,
    dex: 95,
    int: 45,
    weaponSkill: 75,
    armor: 18,
    outfit: 'bandit',
    skills: { 28: 650, 32: 750, 6: 450 },
  },
  mage: {
    kind: 'hireling-mage',
    name: 'mage for hire',
    display: 'mage',
    cost: 2000,
    body: 0x190,
    hue: 0x481,
    hp: 75,
    str: 55,
    dex: 70,
    int: 100,
    mana: 100,
    weaponSkill: 40,
    armor: 12,
    outfit: 'mage',
    skills: { 17: 700, 26: 750, 27: 650, 47: 650 },
  },
  thief: {
    kind: 'hireling-thief',
    name: 'thief for hire',
    display: 'thief',
    cost: 1500,
    body: 0x190,
    hue: 0x023F,
    hp: 85,
    str: 65,
    dex: 100,
    int: 60,
    weaponSkill: 60,
    armor: 14,
    outfit: 'bandit',
    skills: { 22: 700, 29: 650, 34: 700, 48: 650, 43: 600 },
  },
  bard: {
    kind: 'hireling-bard',
    name: 'bard for hire',
    display: 'bard',
    cost: 1800,
    body: 0x190,
    hue: 0x021E,
    hp: 80,
    str: 60,
    dex: 75,
    int: 95,
    mana: 80,
    weaponSkill: 45,
    armor: 10,
    outfit: 'noble',
    skills: { 10: 650, 16: 650, 23: 650, 30: 750 },
  },
  paladin: {
    kind: 'hireling-paladin',
    name: 'paladin for hire',
    display: 'paladin',
    cost: 2200,
    body: 0x190,
    hue: 0x07A1,
    hp: 130,
    str: 95,
    dex: 75,
    int: 70,
    mana: 70,
    weaponSkill: 78,
    armor: 32,
    outfit: 'warrior',
    skills: { 18: 700, 28: 750, 41: 750, 52: 750 },
  },
  beggar: {
    kind: 'hireling-beggar',
    name: 'beggar for hire',
    display: 'beggar',
    cost: 250,
    body: 0x190,
    hue: 0x021E,
    hp: 55,
    str: 45,
    dex: 55,
    int: 45,
    weaponSkill: 25,
    armor: 5,
    outfit: 'peasant',
    skills: { 7: 700, 44: 300 },
  },
});
const HIRE_ROLE_ALIASES = Object.freeze({
  fighter: 'warrior',
  warrior: 'warrior',
  archer: 'archer',
  mage: 'mage',
  thief: 'thief',
  bard: 'bard',
  paladin: 'paladin',
  beggar: 'beggar',
});
const HIRE_COST = Object.freeze(Object.fromEntries(
  Object.entries(HIRE_ROLE_ALIASES).map(([alias, role]) => [alias, HIRE_ROLES[role].cost]),
));
const HIRE_USAGE = Object.keys(HIRE_ROLE_ALIASES).join('|');
const PAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PAY_COST_PER_INTERVAL = 500;

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  // Server parity #9 #6: walk gold-piles via reverse parent index +
  // the player's backpack rather than two full world.items walks.
  function _packGoldIter(mob) {
    const out = [];
    for (const it of packItems(api, mob)) {
      if (it.itemId === 0x0EED) out.push(it);
    }
    return out;
  }
  function findGold(mob) {
    let total = 0;
    for (const it of _packGoldIter(mob)) total += it.amount | 0;
    return total;
  }
  function consumeGold(mob, cost) {
    let remaining = cost;
    for (const it of _packGoldIter(mob)) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, it.amount | 0);
      it.amount -= take;
      remaining -= take;
      // Audit #41 P1 #12 — raw `items.delete` bypasses destroyItem so
      // parent index + removeEntity broadcast leak. Use the canonical
      // destroyItem path with an imported fallback for test stubs.
      if (it.amount <= 0) {
        try { destroyItemBySerial(api, it.serial); }
        catch { /* already spent */ }
      } else {
        try { api.broadcast?.itemUpdate?.(api.world, it); } catch { /* advisory */ }
      }
    }
    return cost - remaining; // amount actually paid
  }
  function roleDefinition(input) {
    const alias = String(input ?? '').toLowerCase();
    const role = HIRE_ROLE_ALIASES[alias];
    return role ? { role, def: HIRE_ROLES[role] } : null;
  }
  function applyRoleOutfit(npc, def) {
    if (!def.outfit || !api.templates || !OUTFIT_PRESETS[def.outfit]) return;
    try {
      applyOutfit(api, api.world, npc, OUTFIT_PRESETS[def.outfit]);
    } catch (e) {
      api.log?.(`[hire] outfit ${def.outfit} failed: ${e.message}`);
    }
  }
  function equipmentFor(npc) {
    const equipment = [];
    for (const it of equipped(api, npc)) {
      if (!it.layer) continue;
      equipment.push({
        serial: it.serial,
        itemId: it.itemId,
        layer: it.layer,
        hue: it.hue ?? 0,
      });
    }
    return equipment;
  }

  api.commands.register({
    name: 'hire',
    help: `[hire <${HIRE_USAGE}> — hire an NPC follower (costs gold).`,
    access: 'Player',
    run(ctx) {
      const roleInfo = roleDefinition(ctx.args[0]);
      if (!roleInfo) {
        ctx.state.sendSystemMessage(`Usage: [hire <${HIRE_USAGE}>`);
        return;
      }
      const { role, def } = roleInfo;
      const sender = ctx.sender;
      const cost = def.cost;
      if (findGold(sender) < cost) {
        ctx.state.sendSystemMessage(`You need ${cost} gold to hire a ${def.display}.`);
        return;
      }
      consumeGold(sender, cost);
      const npc = createMobile(api, api.world, {
        name: def.name,
        body: def.body,
        hue: def.hue,
        x: sender.x, y: sender.y, z: sender.z, map: sender.map,
        notoriety: 1,
        hp: def.hp, hpMax: def.hp,
        mana: def.mana ?? def.int,
        manaMax: def.mana ?? def.int,
        str: def.str, dex: def.dex, int: def.int,
        skills: { ...def.skills },
      });
      npc.kind = def.kind;
      npc.controlMaster = sender.serial >>> 0;
      npc.team = sender.serial >>> 0;
      npc.hireRole = role;
      npc.weaponSkill = def.weaponSkill;
      npc.armor = def.armor;
      npc.paidUntil = Date.now() + PAY_INTERVAL_MS;
      applyRoleOutfit(npc, def);
      api.ai?.attach?.(npc, 'pet', { command: 'follow', targetSerial: 0 });
      const incoming = api.protocol?.mobileIncoming?.({
        serial: npc.serial, body: npc.body, x: npc.x, y: npc.y, z: npc.z,
        direction: npc.direction ?? 0, hue: npc.hue,
        flags: npc.flags ?? 0, notoriety: npc.notoriety,
        equipment: equipmentFor(npc),
      });
      if (incoming) {
        if (api.game?.sendToClientsNear) {
          api.game.sendToClientsNear(npc, incoming, { self: npc });
        } else {
          for (const m of allMobiles(api)) {
            if (!m.client || m === npc || m.map !== npc.map) continue;
            if (Math.abs(m.x - npc.x) > 18 || Math.abs(m.y - npc.y) > 18) continue;
            m.client.send(incoming);
          }
        }
      }
      ctx.state.sendSystemMessage(
        `${npc.name} pledges to follow you. Wage: ${PAY_COST_PER_INTERVAL} gold per day.`,
      );
    },
  });

  api.commands.register({
    name: 'dismiss',
    help: '[dismiss — release the adjacent hireling.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      let target = null;
      const iter = api.game?.mobilesNear?.(sender, { range: 2, self: sender })
        ?? api.query?.mobilesNear?.(sender, 2, sender)
        ?? allMobiles(api);
      for (const m of iter) {
        if (!m.hireRole) continue;
        if ((m.controlMaster >>> 0) !== (sender.serial >>> 0)) continue;
        if (Math.max(Math.abs(m.x - sender.x), Math.abs(m.y - sender.y)) > 2) continue;
        target = m; break;
      }
      if (!target) {
        ctx.state.sendSystemMessage('No hireling adjacent.');
        return;
      }
      target.controlMaster = 0;
      target.team = 0;
      delete target.hireRole;
      delete target.paidUntil;
      api.ai?.detach?.(target);
      api.ai?.attach?.(target, 'wander');
      ctx.state.sendSystemMessage(`${target.name} departs.`);
    },
  });

  api.commands.register({
    name: 'pay',
    help: '[pay — top up your hirelings\' wages by 24 hours.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const own = [];
      for (const m of allMobiles(api)) {
        if (!m.hireRole) continue;
        if ((m.controlMaster >>> 0) !== (sender.serial >>> 0)) continue;
        own.push(m);
      }
      if (own.length === 0) {
        ctx.state.sendSystemMessage('You have no hirelings.');
        return;
      }
      const totalCost = PAY_COST_PER_INTERVAL * own.length;
      if (findGold(sender) < totalCost) {
        ctx.state.sendSystemMessage(`You need ${totalCost} gold to pay all hirelings.`);
        return;
      }
      consumeGold(sender, totalCost);
      const now = Date.now();
      for (const m of own) m.paidUntil = Math.max(m.paidUntil ?? now, now) + PAY_INTERVAL_MS;
      ctx.state.sendSystemMessage(
        `Paid ${totalCost} gold. ${own.length} hireling${own.length === 1 ? '' : 's'} renewed.`,
      );
    },
  });

  // Server parity #10 #5 — periodic sweep that fires every minute and
  // dismisses hirelings whose `paidUntil` ran out. Without this they
  // serve forever for free. ServUO `BaseHire.OnThink` runs every
  // 30 min; we sweep more often but only act when expired.
  const tickHirelingWages = () => {
    try {
      const now = Date.now();
      for (const m of allMobiles(api)) {
        if (!m?.hireRole || !m.paidUntil) continue;
        if (now < m.paidUntil) continue;
        // Wage expired — desert. Detach AI + destroy mob.
        api.ai?.detach?.(m);
        try { destroyMobileBySerial(api, m.serial); }
        catch { /* already dismissed */ }
        const master = m.controlMaster ? mobileBySerial(api, m.controlMaster) : null;
        master?.client?.sendSystemMessage?.(
          `Your ${m.hireRole} ${m.name ?? 'hireling'} leaves you, unpaid.`,
        );
      }
    } catch (e) { console.error('[hire] wage sweep threw:', e); }
  };
  const sweepInterval = api.lifecycle?.setInterval?.(tickHirelingWages, 60_000)
    ?? setInterval(tickHirelingWages, 60_000);
  sweepInterval.unref?.();

  return () => {
    clearInterval(sweepInterval);
    api.commands.unregister('hire');
    api.commands.unregister('dismiss');
    api.commands.unregister('pay');
  };
}

export const _HIRE_CONST = Object.freeze({
  HIRE_COST, HIRE_ROLE_ALIASES, HIRE_ROLES, PAY_INTERVAL_MS, PAY_COST_PER_INTERVAL,
});
