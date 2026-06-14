import { mobileBySerial } from '../../_entities.js';
// [corpse — GM command: kill the targeted mobile, producing a corpse container.

export default function (api) {
  const { commands, targeting, corpse, world } = api;
  if (!corpse) return;

  commands.register({
    name: 'corpse',
    help: 'Target a mobile to kill it and drop a corpse.',
    run: (ctx) => {
      const state = ctx.state;
      if (!state) return;
      targeting.request(state, (resp) => {
        if (resp.cancelled || !resp.targetSerial) return;
        const mob = mobileBySerial({ world }, resp.targetSerial);
        if (!mob) return;
        corpse.killMobile(world, mob);
        state.sendSystemMessage?.(`${mob.name ?? 'the creature'} has fallen.`);
      });
    },
  });

  return () => commands.unregister('corpse');
}
