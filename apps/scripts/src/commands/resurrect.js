import { allMobiles } from '../_spatial.js';
// `[res [name]` — resurrect a dead player ghost. With no argument, resurrects
// the sender (useful during solo testing).

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.corpse?.resurrectMobile) {
    api.log('commands/resurrect: api.corpse.resurrectMobile missing; skipping');
    return () => {};
  }
  api.commands.register({
    name: 'res',
    help: 'res [name] — resurrect a ghost (self if no name given)',
    run(ctx, args) {
      const state = ctx.state;
      if (!state?.mobile) return;
      const targetName = (args[0] ?? '').trim();
      let target;
      if (!targetName) {
        target = state.mobile;
      } else {
        const lower = targetName.toLowerCase();
        for (const m of allMobiles({ world: ctx.world })) {
          if (m.name?.toLowerCase() === lower) { target = m; break; }
        }
      }
      if (!target) {
        state.sendSystemMessage(`No mobile named "${targetName}".`);
        return;
      }
      if (!target.ghost) {
        state.sendSystemMessage(`${target === state.mobile ? 'You are' : target.name + ' is'} not dead.`);
        return;
      }
      api.corpse.resurrectMobile(ctx.world, target);
    },
  });
}
