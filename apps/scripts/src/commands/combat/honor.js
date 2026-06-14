import { mobileBySerial } from '../../_entities.js';
// FAZA DH — `[honor` virtue invocation.
//
// ServUO's Honor virtue (Skills/AnimalLore.cs + Misc/Virtues.cs) lets
// the player target an enemy creature and "honor" it before combat:
// the bond costs Honor virtue points, applies a +20% damage modifier
// to the player's attacks against THAT specific target, and on kill
// returns 2× the Honor spent so killing honoured fights actually
// builds rank. If the player flees the duel or dies, the honor is
// forfeit (lost without refund).
//
// Cost: 100 honor virtue per invocation. Available at any rank ≥
// Follower (4000 base).

const HONOR_COST = 100;
const HONOR_MIN  = 4000;
const HONOR_REWARD_MULT = 2;
const HONOR_DAMAGE_BONUS = 0.20;

export default function register(api) {
  if (!api.commands || !api.targeting || !api.systems?.virtues) return () => {};

  api.commands.register({
    name: 'honor',
    help: '[honor — target a creature to honour the duel (+20% damage, refund × 2 on kill).',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const honor = sender.virtues?.honor | 0;
      if (honor < HONOR_MIN) {
        ctx.state.sendSystemMessage('You lack the rank in Honor for this rite.');
        return;
      }
      if (honor < HONOR_COST) {
        ctx.state.sendSystemMessage('You have insufficient Honor to invoke.');
        return;
      }
      ctx.state.sendSystemMessage('Whom do you wish to honour?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('You decline to honour.');
          return;
        }
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target) {
          ctx.state.sendSystemMessage('That creature is gone.');
          return;
        }
        if (target.client) {
          ctx.state.sendSystemMessage('You cannot honour another player.');
          return;
        }
        // Spend the virtue + tag the target. Combat reads
        // `sender._honoredTargetSerial` and applies the damage bonus.
        api.systems.virtues.spendVirtue?.(sender, 'honor', HONOR_COST);
        api.systems.virtues.pushVirtues?.(sender);
        sender._honoredTargetSerial = target.serial >>> 0;
        sender._honoredCost = HONOR_COST;
        ctx.state.sendSystemMessage(
          `You honour ${target.name ?? 'the creature'}. Strike well.`,
        );
      }, { kind: 0 /* mobile */ });
    },
  });

  return () => api.commands.unregister('honor');
}

// Hook: combat code calls this on every hit to scale damage against
// the honoured target. Returns the multiplier (1.0 if not honoured).
export function honorDamageMultiplier(attacker, victim) {
  if (!attacker?._honoredTargetSerial) return 1.0;
  if ((attacker._honoredTargetSerial >>> 0) !== (victim?.serial >>> 0)) return 1.0;
  return 1.0 + HONOR_DAMAGE_BONUS;
}

// Hook: corpse.killMobile calls this to refund 2× the spent honor
// when the honoured target dies, then clears the bond.
export function honorOnKill(api, killer, victim) {
  if (!killer?._honoredTargetSerial) return;
  if ((killer._honoredTargetSerial >>> 0) !== (victim?.serial >>> 0)) return;
  const spent = killer._honoredCost | 0;
  if (spent > 0 && api?.systems?.virtues?.awardVirtue) {
    api.systems.virtues.awardVirtue(killer, 'honor', spent * HONOR_REWARD_MULT);
  }
  delete killer._honoredTargetSerial;
  delete killer._honoredCost;
}

export const _HONOR_CONST = Object.freeze({
  HONOR_COST, HONOR_MIN, HONOR_REWARD_MULT, HONOR_DAMAGE_BONUS,
});
