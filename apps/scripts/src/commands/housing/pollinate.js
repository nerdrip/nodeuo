// `[pollinate` — cross-pollinate two plants (src + dst). ServUO
// `BasePlant.OnDoubleClick → PollinationGump`. We use a two-step
// target so the player picks src first, then dst.
//
// Both plants must be at the 'plant' or 'full' growth stage. Result:
// dst.plant.pollinated = true; on next harvest the seeds carry the
// child hue from the cross.

import { itemBySerial } from '../../_entities.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'pollinate',
    help: '[pollinate — pick two plants (source then destination) to cross-pollinate.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Pick the SOURCE plant (donor pollen).');
      api.targeting.request(ctx.state, (picked1) => {
        if (!picked1?.serial) return;
        const src = itemBySerial(api, picked1.serial >>> 0);
        if (!src?.plant) {
          ctx.state.sendSystemMessage('Source is not a plant.');
          return;
        }
        ctx.state.sendSystemMessage('Now pick the DESTINATION plant.');
        api.targeting.request(ctx.state, (picked2) => {
          if (!picked2?.serial) return;
          const dst = itemBySerial(api, picked2.serial >>> 0);
          if (!dst?.plant) {
            ctx.state.sendSystemMessage('Destination is not a plant.');
            return;
          }
          if (src === dst) {
            ctx.state.sendSystemMessage('Cannot pollinate a plant with itself.');
            return;
          }
          const ok = api.systems?.plants?.pollinate?.(src, dst);
          if (!ok) {
            ctx.state.sendSystemMessage('Both plants must be at least Plant stage.');
            return;
          }
          ctx.state.sendSystemMessage(
            `Pollinated! Child hue: ${dst.plant.parents?.childHue ?? 'unknown'}.`);
        }, { kind: 0 });
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('pollinate');
}
