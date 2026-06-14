// [freeze / [unfreeze — GM tool that prevents a target mobile from issuing
// further movement requests until thawed. Mirrors ServUO Commands/General/
// Freeze.cs which pushes Mobile.Frozen = true and blocks 0x02 movement
// packets server-side. Frozen mobiles still receive damage and can be
// targeted; only their own input is silenced.

import { resolveMobileArg } from '../_targeting-helpers.js';
import { allMobiles } from '../../_spatial.js';

export default function (api) {
  const { commands, world } = api;

  commands.register({
    name: 'freeze',
    help: 'Target a mobile to prevent it from moving.',
    access: 'GameMaster',
    run: (ctx) => {
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        m.frozen = true;
        ctx.state.sendSystemMessage(`${m.name ?? 'Target'} is frozen.`);
      });
    },
  });

  commands.register({
    name: 'unfreeze',
    help: 'Target a frozen mobile to release it.',
    access: 'GameMaster',
    run: (ctx) => {
      resolveMobileArg(api, ctx, 0, (m) => {
        if (!m) return;
        m.frozen = false;
        ctx.state.sendSystemMessage(`${m.name ?? 'Target'} is released.`);
      });
    },
  });

  commands.register({
    name: 'freezeall',
    help: 'Freeze every NPC within <radius> tiles (default 12).',
    access: 'GameMaster',
    run: (ctx) => {
      const caller = ctx.state?.mobile;
      if (!caller) return;
      const radius = Math.max(1, Math.min(50, parseInt(ctx.args?.[0] ?? '12', 10) || 12));
      let n = 0;
      for (const m of allMobiles({ world })) {
        if (m === caller || m.client) continue;
        if (Math.abs(m.x - caller.x) > radius) continue;
        if (Math.abs(m.y - caller.y) > radius) continue;
        m.frozen = true;
        n++;
      }
      ctx.state.sendSystemMessage(`Froze ${n} mobile(s) within ${radius} tiles.`);
    },
  });

  commands.register({
    name: 'unfreezeall',
    help: 'Release every frozen NPC within <radius> tiles (default 24).',
    access: 'GameMaster',
    run: (ctx) => {
      const caller = ctx.state?.mobile;
      if (!caller) return;
      const radius = Math.max(1, Math.min(64, parseInt(ctx.args?.[0] ?? '24', 10) || 24));
      let n = 0;
      for (const m of allMobiles({ world })) {
        if (!m.frozen) continue;
        if (Math.abs(m.x - caller.x) > radius) continue;
        if (Math.abs(m.y - caller.y) > radius) continue;
        m.frozen = false;
        n++;
      }
      ctx.state.sendSystemMessage(`Released ${n} mobile(s).`);
    },
  });

  return () => {
    commands.unregister('freeze');
    commands.unregister('unfreeze');
    commands.unregister('freezeall');
    commands.unregister('unfreezeall');
  };
}
