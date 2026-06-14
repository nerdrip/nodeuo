// FAZA CV — weapon special-ability queue.
//
// ServUO models AOS specials as primary / secondary picks per weapon,
// activated via the war-mode ability bar. The user clicks an icon
// (or runs a macro), the ability is QUEUED on the player, and the
// next successful swing consumes the mana cost and applies the
// special's effect.
//
// We expose this as a chat command for now: `[wpn primary` and
// `[wpn secondary` toggle a queue slot. Actual swing-time consumption
// is the responsibility of `combat.attackTickAll` (it consumes
// `state.queuedAbility` and runs the ability handler from the table
// below).
//
// The minimum viable port covers two staple specials so the queue
// path is testable end-to-end; more abilities can be added by
// dropping entries into `ABILITIES`.

import { normalizeSkillValue } from '../_rules.js';
import { nearbyMobiles } from '../_spatial.js';

const ABILITIES = {
  // ---- Tier 1 (mana 25-30) ---------------------------------------------
  'armor-ignore': {
    label: 'Armor Ignore',
    mana: 30,
    onHit({ mob, target, baseDamage }) {
      const bonus = Math.max(1, Math.floor(baseDamage * 0.25));
      target.hp = Math.max(0, (target.hp ?? 0) - bonus);
      mob.client?.sendSystemMessage?.(`Armor Ignore: +${bonus} damage.`);
      return bonus;
    },
  },
  'concussion-blow': {
    label: 'Concussion Blow',
    mana: 25,
    onHit({ mob, target, baseDamage }) {
      const bonus = Math.max(1, Math.floor(baseDamage * 0.1));
      target.hp = Math.max(0, (target.hp ?? 0) - bonus);
      target.mana = Math.max(0, (target.mana ?? 0) - 10);
      mob.client?.sendSystemMessage?.(`Concussion Blow lands! +${bonus} damage.`);
      return bonus;
    },
  },
  'crushing-blow': {
    label: 'Crushing Blow',
    mana: 25,
    onHit({ mob, target, baseDamage }) {
      // ServUO CrushingBlow: ×1.5 damage. Effect already applied via
      // base swing; we top up the missing 50%.
      const bonus = Math.max(1, Math.floor(baseDamage * 0.5));
      target.hp = Math.max(0, (target.hp ?? 0) - bonus);
      mob.client?.sendSystemMessage?.(`Crushing Blow! +${bonus} damage.`);
      return bonus;
    },
  },
  'paralyzing-blow': {
    label: 'Paralyzing Blow',
    mana: 30,
    onHit({ mob, target, ctx }) {
      if (!mob?._weapon) mob._moveDelayUntil = Date.now() + 3_000; // ServUO Fists.MoveDelayTimer.
      // 2-second paralyze on the target. Use status-effects if wired.
      const ms = 2000;
      target.paralyzedUntil = Date.now() + ms;
      ctx?.statusEffects?.apply?.(target, { name: 'paralyze', durationMs: ms });
      mob.client?.sendSystemMessage?.('Paralyzing Blow lands!');
      return 0;
    },
  },
  'bleed-attack': {
    label: 'Bleed Attack',
    mana: 30,
    onHit({ mob, target, baseDamage, ctx }) {
      // 5 ticks × ~baseDamage/8 = ~60% extra over 5s. We apply once
      // here as a tick-driver via statusEffects so the bleed continues
      // even if the attacker walks away.
      const tickDmg = Math.max(1, Math.floor(baseDamage / 8));
      ctx?.statusEffects?.apply?.(target, {
        name: 'bleed', durationMs: 5000,
        data: { tickDmg, source: mob.serial },
      });
      mob.client?.sendSystemMessage?.('Bleed Attack inflicted!');
      return 0;
    },
  },
  'disarm': {
    label: 'Disarm',
    mana: 25,
    onHit({ mob, target, ctx }) {
      if (!mob?._weapon) mob._moveDelayUntil = Date.now() + 3_000; // ServUO Fists.MoveDelayTimer.
      // Force the target to drop their currently equipped weapon to
      // their backpack. ServUO `DisarmAttack.cs` sets a 5-second cd.
      const wpn = target?._weapon;
      if (!wpn) {
        mob.client?.sendSystemMessage?.('Disarm: target has no weapon.');
        return 0;
      }
      try {
        ctx?.combat?.unequipWeapon?.(target);
      } catch { /* combat may not expose unequip — fall through */ }
      target.disarmedUntil = Date.now() + 5000;
      mob.client?.sendSystemMessage?.('Disarm strikes home!');
      return 0;
    },
  },
  'dismount': {
    label: 'Dismount',
    mana: 20,
    onHit({ mob, target }) {
      // Drop the target off their mount. Model: clear the mount field
      // and broadcast a body update so observer clients refresh.
      if (target?.mount) {
        target.mount = null;
        target.mountId = 0;
        mob.client?.sendSystemMessage?.('Dismount: foe is unhorsed!');
      }
      target.dismountedUntil = Date.now() + 10_000;
      return 0;
    },
  },
  'mortal-strike': {
    label: 'Mortal Strike',
    mana: 30,
    onHit({ mob, target, ctx }) {
      // ServUO MortalStrike: target cannot be healed for 6s.
      const ms = 6000;
      target.mortalWoundUntil = Date.now() + ms;
      ctx?.statusEffects?.apply?.(target, { name: 'mortal-strike', durationMs: ms });
      mob.client?.sendSystemMessage?.('Mortal Strike! Healing is disabled on the foe.');
      return 0;
    },
  },
  'double-strike': {
    label: 'Double Strike',
    mana: 30,
    onHit({ mob, target, baseDamage, ctx }) {
      // Apply a second swing of equal damage. The first swing already
      // landed via the base combat tick, so we just re-deal.
      const dmg = Math.max(1, baseDamage);
      try { ctx?.combat?.damage?.(ctx.world, target, dmg, mob); }
      catch {
        target.hp = Math.max(0, (target.hp ?? 0) - dmg);
      }
      mob.client?.sendSystemMessage?.(`Double Strike: extra ${dmg} damage.`);
      return dmg;
    },
  },
  'whirlwind-attack': {
    label: 'Whirlwind Attack',
    mana: 15,
    onHit({ mob, baseDamage, ctx }) {
      // ServUO Whirlwind: hit every hostile in melee range for half-damage.
      const world = ctx?.world;
      if (!world) return 0;
      const aoe = Math.max(1, Math.floor(baseDamage / 2));
      let hits = 0;
      const candidates = nearbyMobiles(ctx, mob, mob, 1);
      for (const m of candidates) {
        if (m === mob) continue;
        if (m.map !== mob.map) continue;
        if (Math.abs(m.x - mob.x) > 1 || Math.abs(m.y - mob.y) > 1) continue;
        if ((m.hp ?? 0) <= 0) continue;
        try { ctx?.combat?.damage?.(world, m, aoe, mob); }
        catch { m.hp = Math.max(0, (m.hp ?? 0) - aoe); }
        hits++;
      }
      mob.client?.sendSystemMessage?.(`Whirlwind hits ${hits} foe(s).`);
      return 0;
    },
  },
  'moving-shot': {
    label: 'Moving Shot',
    mana: 25,
    onHit({ mob, target, baseDamage }) {
      // Archery-only: allow attacking while moving. Bonus is small —
      // gameplay value is the no-cancel-on-walk handled elsewhere.
      const bonus = Math.max(1, Math.floor(baseDamage * 0.1));
      target.hp = Math.max(0, (target.hp ?? 0) - bonus);
      mob.client?.sendSystemMessage?.('Moving Shot fires.');
      return bonus;
    },
  },
  'infectious-strike': {
    label: 'Infectious Strike',
    mana: 15,
    onHit({ mob, target, ctx }) {
      // Poison the target. We apply a generic poison status; the
      // poison module's tick handler will progress damage.
      try {
        const rawPoisoning = mob.skills?.[31] ?? mob.skills?.['31'] ?? 50;
        const poisoning = normalizeSkillValue(rawPoisoning);
        const lvl = Math.min(4, Math.floor(poisoning / 25));
        ctx?.poison?.apply?.(target, lvl);
      } catch { /* poison module optional */ }
      mob.client?.sendSystemMessage?.('Infectious Strike poisons the foe.');
      return 0;
    },
  },
};

// Per-weapon-itemId Primary / Secondary mapping. Keys are bare itemIds (no
// hue / amount). When the player runs `[wpn primary` we look up their
// currently equipped weapon and pick the primary slot from this table; if
// the weapon is unknown we fall back to (armor-ignore, concussion-blow)
// which is the ServUO default for "blade-like" weapons.
const PRIMARY_BY_WEAPON = new Map([
  // Swords / blades — armor-ignore + concussion-blow
  [0x13B6, ['armor-ignore', 'concussion-blow']],   // longsword
  [0x13B9, ['armor-ignore', 'concussion-blow']],   // viking sword
  [0x1441, ['armor-ignore', 'paralyzing-blow']],   // cutlass
  [0x143E, ['armor-ignore', 'whirlwind-attack']],  // halberd (2H)
  // Axes — disarm + whirlwind
  [0x0F4B, ['disarm', 'whirlwind-attack']],        // double axe
  [0x0F45, ['crushing-blow', 'dismount']],         // executioners axe
  [0x13FB, ['crushing-blow', 'whirlwind-attack']], // large battle axe
  // Maces — bleed + paralyzing-blow
  [0x143B, ['bleed-attack', 'paralyzing-blow']],   // mace
  [0x1407, ['crushing-blow', 'mortal-strike']],    // war hammer
  [0x143D, ['crushing-blow', 'concussion-blow']],  // hammer pick
  // Spears / polearms — paralyzing + dismount
  [0x1403, ['paralyzing-blow', 'dismount']],       // short spear
  [0x1405, ['paralyzing-blow', 'dismount']],       // pike
  // Fencing — disarm + paralyzing-blow
  [0x1401, ['disarm', 'paralyzing-blow']],         // dagger
  [0x1438, ['disarm', 'paralyzing-blow']],         // kryss
  // Bows — moving-shot + paralyzing-blow
  [0x13B1, ['moving-shot', 'paralyzing-blow']],    // bow
  [0x13B2, ['moving-shot', 'paralyzing-blow']],    // crossbow
  [0x26C2, ['armor-ignore', 'mortal-strike']],     // composite bow
  [0x26C3, ['mortal-strike', 'moving-shot']],      // heavy crossbow
  // Two-handers — double-strike + dismount
  [0x143A, ['double-strike', 'whirlwind-attack']], // two-handed axe (alt)
]);

function abilitiesForWeapon(weapon) {
  if (!weapon) return ['armor-ignore', 'concussion-blow'];
  const map = PRIMARY_BY_WEAPON.get(weapon.itemId | 0);
  return map ?? ['armor-ignore', 'concussion-blow'];
}

export const _ABILITIES_FOR_TEST = ABILITIES;

export default function register(api) {
  if (!api.commands) return () => {};

  // Publish the abilities table on the shared ctx so the combat
  // handler can look up `state.ctx.weaponAbilities[slug]` without
  // importing from the script tree (which would invert the layering).
  if (api.ctx) api.ctx.weaponAbilities = ABILITIES;

  api.commands.register({
    name: 'wpn',
    help: '[wpn <primary|secondary|none> — queue a weapon special for your next swing.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      const state = ctx.state;
      if (sub === 'none' || sub === 'off' || sub === 'clear') {
        state.queuedAbility = null;
        state.sendSystemMessage('Ability cleared.');
        return;
      }
      // Map primary / secondary to the ability for the currently
      // equipped weapon. Falls back to the blade default when the
      // weapon isn't in our table (armor-ignore / concussion-blow).
      const wpn = ctx.sender?._weapon;
      const moveDelay = ctx.sender?._moveDelayUntil ?? 0;
      if (!wpn && moveDelay > Date.now()) {
        state.sendSystemMessage(`You must wait ${Math.ceil((moveDelay - Date.now()) / 1000)} seconds to perform another unarmed move.`);
        return;
      }
      const [primary, secondary] = abilitiesForWeapon(wpn);
      const map = { primary, secondary };
      const slug = map[sub] ?? sub;
      const def = ABILITIES[slug];
      if (!def) {
        state.sendSystemMessage(
          'Usage: [wpn primary | secondary | armor-ignore | concussion-blow | none.',
        );
        return;
      }
      const mana = ctx.sender.mana ?? 0;
      if (mana < def.mana) {
        state.sendSystemMessage(
          `You lack the mana (${def.mana} required, ${mana} available).`,
        );
        return;
      }
      state.queuedAbility = slug;
      state.sendSystemMessage(`${def.label} primed for next swing.`);
    },
  });

  return () => api.commands.unregister('wpn');
}
