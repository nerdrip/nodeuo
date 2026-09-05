// `[ethics` — Hero/Evil alignment commands.
//   [ethics                 — show your alignment + tier
//   [ethics join hero       — join Hero side (needs 5000+ fame)
//   [ethics join evil       — join Evil side (needs <-5000 karma)
//   [ethics leave           — drop alignment
//   [ethics powers          — list powers your tier unlocks
//   [ethics use <powerId> [serial] — invoke a power (cursor for targeted powers)

import { resolveMobileArg } from '../_targeting-helpers.js';

export default function register(api) {
  if (!api.commands || !api.ethics) return () => {};
  const { commands, ethics } = api;

  commands.register({
    name: 'ethics',
    help: '[ethics [join hero|join evil|leave|powers|use <id>] — Hero/Evil alignment.',
    access: 'Player',
    run(ctx) {
      const args = ctx.args ?? [];
      const sub = (args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      if (!sub) {
        const align = ethics.alignmentOf(mob);
        if (!align) { ctx.state.sendSystemMessage('You are unaligned.'); return; }
        const t = ethics.tierOf(mob);
        ctx.state.sendSystemMessage(
          `Alignment: ${align.toUpperCase()}.  Tier: ${t.name}.  Power: ${mob.ethicPower ?? 0}/1000.`,
        );
        return;
      }
      if (sub === 'join') {
        const side = (args[1] ?? '').toLowerCase();
        const res = ethics.join(mob, side);
        if (!res.ok) {
          ctx.state.sendSystemMessage(`Cannot join ${side}: ${res.reason}.`);
        } else {
          ctx.state.sendSystemMessage(`You have joined the ${side === 'hero' ? 'Heroes' : 'Evil'}.`);
        }
        return;
      }
      if (sub === 'leave') {
        if (ethics.leave(mob)) ctx.state.sendSystemMessage('You renounce your alignment.');
        else ctx.state.sendSystemMessage('You are not aligned.');
        return;
      }
      if (sub === 'powers') {
        const align = ethics.alignmentOf(mob);
        if (!align) { ctx.state.sendSystemMessage('You must align first.'); return; }
        const list = align === 'evil' ? ethics.EVIL_POWERS : ethics.HERO_POWERS;
        const tier = ethics.tierOf(mob);
        const tierIdx = ethics.listTiers().findIndex((t) => t.name === tier.name);
        ctx.state.sendSystemMessage(`${align.toUpperCase()} powers (your tier: ${tier.name}):`);
        for (const p of list) {
          const lock = tierIdx < p.minTier ? ' [LOCKED]' : '';
          ctx.state.sendSystemMessage(`  ${p.id.padEnd(22)} cost=${p.cost}  ${p.name}${lock}`);
        }
        return;
      }
      if (sub === 'use') {
        const id = args[1];
        if (!id) { ctx.state.sendSystemMessage('Usage: [ethics use <powerId>'); return; }
        const invoke = (target = null) => {
          const res = ethics.invokePower(mob, id, target, api.world);
          if (!res.ok) ctx.state.sendSystemMessage(`Cannot invoke ${id}: ${res.reason}.`);
          else ctx.state.sendSystemMessage(`You invoke ${res.power.name}.`);
        };
        const power = ethics.findPower(mob, id);
        if (power?.requiresTarget) {
          resolveMobileArg(api, ctx, 2, (target) => {
            if (target) invoke(target);
          }, { promptText: `Target a mobile for ${power.name}.` });
        } else {
          invoke();
        }
        return;
      }
      ctx.state.sendSystemMessage('Unknown subcommand. Try: [ethics, [ethics join <side>, [ethics powers, [ethics use <id>.');
    },
  });

  return () => commands.unregister('ethics');
}
