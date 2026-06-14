import { mobileBySerial } from '../../_entities.js';
// FAZA DI — `[sacrifice` virtue invocation.
//
// ServUO Sacrifice virtue (Misc/Virtues.cs): the player can spend
// 100 virtue points to either auto-resurrect themselves on death or
// resurrect a nearby ghost without using a shrine. We ship the latter
// (active rite) — the self-revive form fires automatically out of
// shrines.js.
//
// Cost: 100 sacrifice virtue per cast. Min rank: Follower (4000).

const SACRIFICE_COST = 100;
const SACRIFICE_MIN  = 4000;
const SACRIFICE_RANGE = 4;

export default function register(api) {
  if (!api.commands || !api.targeting || !api.systems?.virtues) return () => {};

  api.commands.register({
    name: 'sacrifice',
    help: '[sacrifice — target a fallen ally to revive them at the cost of Sacrifice virtue.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const sacrifice = sender.virtues?.sacrifice | 0;
      if (sacrifice < SACRIFICE_MIN) {
        ctx.state.sendSystemMessage('You lack the rank in Sacrifice for this rite.');
        return;
      }
      if (sacrifice < SACRIFICE_COST) {
        ctx.state.sendSystemMessage('You have insufficient Sacrifice to invoke.');
        return;
      }
      ctx.state.sendSystemMessage('Whom do you wish to revive?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('You decline.');
          return;
        }
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target) {
          ctx.state.sendSystemMessage('They are gone.');
          return;
        }
        if (!target.ghost) {
          ctx.state.sendSystemMessage('They do not require resurrection.');
          return;
        }
        if (target.map !== sender.map
            || Math.abs(target.x - sender.x) > SACRIFICE_RANGE
            || Math.abs(target.y - sender.y) > SACRIFICE_RANGE) {
          ctx.state.sendSystemMessage('They are too far away.');
          return;
        }
        // Spend the virtue, revive the target. resurrectMobile will
        // award Compassion to `sender` (FAZA DG) — the Sacrifice rite
        // is double-virtue: spend 100 sacrifice, gain ~200 compassion.
        api.systems.virtues.spendVirtue?.(sender, 'sacrifice', SACRIFICE_COST);
        if (api.ctx?.corpse?.resurrectMobile) {
          api.ctx.corpse.resurrectMobile(api.world, target, sender);
        }
        ctx.state.sendSystemMessage(
          `You sacrifice your virtue to revive ${target.name ?? 'them'}.`,
        );
      }, { kind: 0 /* mobile */ });
    },
  });

  return () => api.commands.unregister('sacrifice');
}

export const _SACRIFICE_CONST = Object.freeze({
  SACRIFICE_COST, SACRIFICE_MIN, SACRIFICE_RANGE,
});
