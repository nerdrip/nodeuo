// `[trick-or-treat` — player-facing Halloween trigger. Targets an NPC
// in adjacent range and rolls a treat-or-prank outcome via the
// systems/halloween engine. Active only during October (UTC) unless
// the admin overrides via `[halloween on`.
//
// `[halloween on|off|status` — admin override for testing / forced
// event runs.

import { mobileBySerial } from '../../_entities.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};
  const halloween = api.systems?.halloween;
  if (!halloween) {
    api.log?.('halloween: halloween system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'trick-or-treat',
    help: '[trick-or-treat [gump] — ask a nearby NPC for a treat (October only); or open the costume ledger.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === 'gump' || sub === 'costumes') {
        // Faza H.2 — open the costume / treats ledger overlay.
        ctx.state.sendSystemMessage?.('@@OPEN_TOT_GUMP@@');
        return;
      }
      if (!halloween.isActive()) {
        ctx.state.sendSystemMessage('It is not the spooky season.');
        return;
      }
      ctx.state.sendSystemMessage('Trick or treat? Target an NPC.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const mob = mobileBySerial(api, picked.serial >>> 0);
        if (!mob || mob.client) {
          ctx.state.sendSystemMessage('They will not play along.');
          return;
        }
        const adj = Math.max(Math.abs(mob.x - ctx.sender.x), Math.abs(mob.y - ctx.sender.y));
        if (adj > 2 || mob.map !== ctx.sender.map) {
          ctx.state.sendSystemMessage('You must be next to the NPC.');
          return;
        }
        // Rate-limit per (player, npc) pair — once per 60 s to keep
        // people from farming an endless candy stream off a single
        // townsperson. Stamp the moment of the last give on the NPC.
        const now = Date.now();
        mob._lastTreatAt ??= new Map();
        const last = mob._lastTreatAt.get(ctx.sender.serial) ?? 0;
        if (now - last < 60_000) {
          ctx.state.sendSystemMessage('They have already given you something recently.');
          return;
        }
        mob._lastTreatAt.set(ctx.sender.serial, now);
        halloween.apply(api, mob, ctx.sender, api.world);
      }, { kind: 0 });
    },
  });

  api.commands.register({
    name: 'halloween',
    help: '[halloween on|off|status — force Halloween event on/off (admin override).',
    access: 'GM',
    run(ctx) {
      const arg = String(ctx.args ?? '').trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        halloween.setOverride(arg);
        ctx.state.sendSystemMessage(`Halloween override → ${arg}`);
        return;
      }
      if (arg === 'clear' || arg === 'auto') {
        halloween.setOverride(null);
        ctx.state.sendSystemMessage('Halloween override cleared — auto by month.');
        return;
      }
      ctx.state.sendSystemMessage(
        `Halloween is currently ${halloween.isActive() ? 'ACTIVE' : 'INACTIVE'}. Use on/off/clear.`);
    },
  });

  return () => {
    api.commands.unregister('trick-or-treat');
    api.commands.unregister('halloween');
  };
}
