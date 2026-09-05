// `[race <human|elf|gargoyle>` — assign a race to the sender (or to a
// targeted player when the caller is a GM). Wires `systems/race.js` so
// the body swap + passive bag get applied + broadcast to every viewer.

import { allMobiles } from '../_spatial.js';
import { equipmentForMobile } from '../_equipment.js';

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'race',
    help: '[race <human|elf|gargoyle> — switch your race.',
    access: 'Player',
    run(ctx, args) {
      const which = String(args[0] ?? '').toLowerCase();
      if (which === 'abilities' || which === 'gump' || which === 'book') {
        // Phase H.2 — open the racial abilities book overlay.
        const race = ctx.sender?.race ?? 'human';
        ctx.state.sendSystemMessage?.(`@@OPEN_RACIAL_GUMP@@${race}`);
        return;
      }
      if (!['human', 'elf', 'gargoyle'].includes(which)) {
        ctx.state.sendSystemMessage('Usage: [race human|elf|gargoyle | abilities');
        return;
      }
      if (api.systems?.race?.assignRace?.(ctx.sender, which)) {
        ctx.state.sendSystemMessage(`You are now a ${which}.`);
        // Broadcast the body change so observers re-paint the avatar.
        if (api.protocol?.mobileIncoming) {
          const incoming = api.protocol.mobileIncoming({
            serial: ctx.sender.serial, body: ctx.sender.body,
            x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z,
            direction: ctx.sender.direction ?? 0, hue: ctx.sender.hue ?? 0,
            flags: ctx.sender.flags ?? 0, notoriety: ctx.sender.notoriety ?? 1,
            equipment: equipmentForMobile(api, ctx.sender),
          });
          for (const o of allMobiles(api)) {
            if (!o.client) continue;
            if (o.map !== ctx.sender.map) continue;
            if (Math.abs(o.x - ctx.sender.x) > 18 || Math.abs(o.y - ctx.sender.y) > 18) continue;
            o.client.send(incoming);
          }
        }
      }
    },
  });

  // Gargoyle Stone Form toggle. Speech `[stoneform`.
  api.commands.register({
    name: 'stoneform',
    help: '[stoneform — Gargoyle Stone Form ability.',
    access: 'Player',
    run(ctx) {
      const on = api.systems?.race?.toggleStoneForm?.(ctx.sender);
      if (ctx.sender.race !== 'gargoyle') {
        ctx.state.sendSystemMessage('Only gargoyles may take stone form.');
        return;
      }
      ctx.state.sendSystemMessage(on
        ? 'Your skin hardens to stone.'
        : 'Your skin softens.');
    },
  });

  return () => {
    api.commands.unregister('race');
    api.commands.unregister('stoneform');
  };
}
