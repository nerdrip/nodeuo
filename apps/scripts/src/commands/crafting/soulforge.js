import { createItem } from '../../_items.js';
// `[soulforge` admin cmd — place a Soulforge addon at the GM's feet.
// Used by builders + players who need an Imbuing station nearby. The
// item-script (`soulforge.js`) stamps `_soulforge: true` on the
// instance so `[imbue` / `[unravel` proximity gate recognises it.

export default function (api) {
  if (!api.commands || !api.items) return () => {};

  api.commands.register({
    name: 'soulforge',
    help: '[soulforge — admin: place a Soulforge at your feet.',
    access: 'GameMaster',
    run(ctx) {
      const mob = ctx.sender;
      const it = createItem(api, api.world, {
        itemId: 0x4277, hue: 0,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: 'Soulforge',
        movable: false,
      });
      it.script = 'soulforge';
      it._soulforge = true;
      ctx.state.sendSystemMessage(
        `Soulforge 0x${it.serial.toString(16)} placed. Stand within 2 tiles to imbue.`,
      );
    },
  });

  return () => api.commands.unregister('soulforge');
}
