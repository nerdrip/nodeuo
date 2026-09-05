import { allMobiles } from '../../_spatial.js';
// PHASE EH — `[massres` mass-resurrect.
//
// ServUO has a `[ResAll` GM command. We expose a player-side variant
// that requires high virtue rank in Compassion AND a steep cost (500
// virtue points). Targets every ghost player within 12 tiles.

const RANGE = 12;
const COST = 500;
const REQUIRED_RANK = 10000;   // Seeker

export default function register(api) {
  if (!api.commands || !api.systems?.virtues) return () => {};

  api.commands.register({
    name: 'massres',
    help: '[massres — revive all nearby ghost allies (costs 500 Compassion).',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const compassion = sender.virtues?.compassion | 0;
      if (compassion < REQUIRED_RANK) {
        ctx.state.sendSystemMessage('You lack the rank in Compassion for this rite.');
        return;
      }
      if (compassion < COST) {
        ctx.state.sendSystemMessage('Insufficient Compassion to invoke.');
        return;
      }
      const ghosts = [];
      for (const m of allMobiles(api)) {
        if (!m.client || !m.ghost) continue;
        if (m.map !== sender.map) continue;
        if (Math.abs(m.x - sender.x) > RANGE || Math.abs(m.y - sender.y) > RANGE) continue;
        ghosts.push(m);
      }
      if (ghosts.length === 0) {
        ctx.state.sendSystemMessage('There are no fallen allies nearby.');
        return;
      }
      api.systems.virtues.spendVirtue?.(sender, 'compassion', COST);
      let revived = 0;
      for (const g of ghosts) {
        try {
          api.ctx?.corpse?.resurrectMobile?.(api.world, g, sender);
          revived += 1;
        } catch (e) { api.log?.(`massres: ${e.message}`); }
      }
      ctx.state.sendSystemMessage(`You revive ${revived} ally${revived === 1 ? '' : 's'}.`);
    },
  });

  return () => api.commands.unregister('massres');
}
