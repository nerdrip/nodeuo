import { createItem } from '../../_items.js';
import { registerSigil } from '../../_sigils.js';

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'placesigil',
    help: '[placesigil <town> — admin: place a faction sigil at your feet.',
    access: 'Admin',
    run(ctx, args) {
      const town = String(args?.[0] ?? '').toLowerCase();
      if (!town) {
        ctx.state.sendSystemMessage('Usage: [placesigil <britain|magincia|minoc|trinsic|yew>');
        return;
      }
      try {
        registerSigil(api, town, ctx.sender.x, ctx.sender.y, ctx.sender.map);
      } catch (error) {
        ctx.state.sendSystemMessage(error.message);
        return;
      }
      const item = createItem(api, api.world, {
        itemId: 0x1869, hue: 0x44,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
        name: `Sigil of ${town}`, movable: true,
        _sigilTown: town, scripts: ['sigil'],
      });
      ctx.state.sendSystemMessage(
        `Sigil for ${town} placed${item ? ` (0x${item.serial.toString(16)})` : ''}.`,
      );
    },
  });
  return () => api.commands.unregister('placesigil');
}
