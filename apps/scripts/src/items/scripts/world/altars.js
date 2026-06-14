// Altars — virtue / shrine / chaos altars. Activated on `[use` (double
// click), they apply a buff or grant a flagged status. Mirrors ServUO
// `Items/Decorative/Altar.cs` and the per-shrine `Items/Special/...`.
//
// Each altar variant differs in:
//   buff name, duration, range gating, optional offering reagent.
//
// All altars share the same structure so we can ship them as siblings
// of the same builder.

function blessEffect(api, world, mob, label, ticks = 60) {
  api.statusEffects?.apply?.(world, mob, `altar:${label}`, { ticks, intensity: 1 });
  mob.client?.sendSystemMessage?.(`You feel the blessing of ${label}.`);
}

export function buildVirtueAltar(api) {
  // Compassion / Honor / Justice / Sacrifice / Honesty / Spirituality /
  // Humility / Valor — eight virtues. The altar reads `item.virtue` so
  // a single script powers every variant; items.json sets the attribute.
  return {
    name: 'virtue-altar',
    onUse(world, item, user) {
      if (Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y)) > 2) {
        user.client?.sendSystemMessage?.('You must be closer to invoke the altar.');
        return true;
      }
      const v = String(item.virtue ?? 'Honor');
      blessEffect(api, world, user, v, 600); // 10 minutes
      // Per-virtue accrual hook (existing system in server/systems/rewards/virtues.js).
      api.virtues?.invoke?.(world, user, v);
      return true;
    },
  };
}

export function buildPeerlessChaosAltar(api) {
  return {
    name: 'chaos-altar',
    onUse(world, item, user) {
      if (Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y)) > 2) {
        user.client?.sendSystemMessage?.('You must be closer to invoke the altar.');
        return true;
      }
      // Chaos altar grants a brief damage bonus + criminal flag.
      api.statusEffects?.apply?.(world, user, 'altar:chaos', { ticks: 120, intensity: 1 });
      user.client?.sendSystemMessage?.('You feel a surge of dark power. You are marked.');
      user.notoriety = 4; // Criminal
      return true;
    },
  };
}

export function buildHealingAltar(_api) {
  return {
    name: 'healing-altar',
    onUse(world, item, user) {
      if (Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y)) > 2) {
        user.client?.sendSystemMessage?.('You must be closer to invoke the altar.');
        return true;
      }
      // Restore 50% HP / Mana / Stam in one shot.
      const heal = (max, cur) => Math.min(max, (cur ?? 0) + Math.ceil((max ?? 0) * 0.5));
      user.hp   = heal(user.hpMax,   user.hp);
      user.mana = heal(user.manaMax, user.mana);
      user.stam = heal(user.stamMax, user.stam);
      user.client?.sendSystemMessage?.('Warmth fills your body. You are restored.');
      return true;
    },
  };
}

export function buildResurrectionAltar(api) {
  return {
    name: 'resurrection-altar',
    onUse(world, item, user) {
      if (Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y)) > 2) {
        user.client?.sendSystemMessage?.('You must be closer to invoke the altar.');
        return true;
      }
      // Only useful while dead — for living players the altar is inert.
      if (!user.ghost && (user.hp ?? 0) > 0) {
        user.client?.sendSystemMessage?.('You have no need of resurrection.');
        return true;
      }
      // Server resurrection is implemented in corpse.js / handler 0x2C —
      // we route through it so res penalties / stat loss apply.
      api.corpse?.resurrect?.(world, user);
      user.client?.sendSystemMessage?.('You have been resurrected.');
      return true;
    },
  };
}
