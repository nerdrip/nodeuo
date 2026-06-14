// `[murderdecay` — admin sweep + status for the murder-count decay loop.
//
//   [murderdecay status        — list every online player with kills > 0
//                                + their time to next decay
//   [murderdecay sweep         — force a `notoriety.decayMurders` pass
//                                (normally runs on the 10-min housekeeping
//                                interval — this is the manual hook)
//   [murderdecay clear <name>  — (Admin) zero a specific player's kill
//                                count + clear murder/criminal flags

import { decayMurders, recomputeNotoriety } from '../../_notoriety.js';
import { allMobiles } from '../../_spatial.js';

const MURDER_KILL_DECAY_MS = 8 * 60 * 60 * 1000;       // ServUO default 8h

function fmtMs(ms) {
  if (ms <= 0) return 'now';
  const h = ms / 3_600_000;
  if (h >= 1) return `${h.toFixed(1)}h`;
  return `${Math.ceil(ms / 60_000)}m`;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'murderdecay',
    help: '[murderdecay status|sweep|clear <name> — murder count decay controls.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const access = ctx.state?.account?.accessLevel ?? 'Player';
      const isStaff = access === 'GM' || access === 'Admin' || access === 'Seer';

      if (sub === 'status' || sub === '') {
        const now = Date.now();
        const rows = [];
        for (const mob of allMobiles(api)) {
          if (!mob.client && !mob.isPlayer) continue;
          const kills = mob.kills | 0;
          if (kills <= 0) continue;
          const oldest = mob._oldestKillAt ?? 0;
          const due = Math.max(0, oldest + MURDER_KILL_DECAY_MS - now);
          rows.push({ name: mob.name ?? 'unknown', kills, due });
        }
        if (rows.length === 0) {
          ctx.state.sendSystemMessage?.('No online murderers tracked.');
          return;
        }
        rows.sort((a, b) => b.kills - a.kills);
        ctx.state.sendSystemMessage?.(`Murder decay (${rows.length} entries):`);
        for (const r of rows.slice(0, 20)) {
          ctx.state.sendSystemMessage?.(
            `  ${r.name.padEnd(20)} kills=${r.kills}  next decay in ${fmtMs(r.due)}`,
          );
        }
        if (rows.length > 20) {
          ctx.state.sendSystemMessage?.(`  …${rows.length - 20} more.`);
        }
        return;
      }

      if (sub === 'sweep') {
        if (!isStaff) {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        const changed = decayMurders(api, api.world, Date.now());
        ctx.state.sendSystemMessage?.(`Decay sweep complete — ${changed} mobile(s) lost a kill.`);
        return;
      }

      if (sub === 'clear') {
        if (!isStaff) {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        const name = ctx.args.slice(1).join(' ').trim().toLowerCase();
        if (!name) { ctx.state.sendSystemMessage?.('Usage: [murderdecay clear <name>'); return; }
        let touched = 0;
        for (const mob of allMobiles(api)) {
          if ((mob.name ?? '').toLowerCase() !== name) continue;
          mob.kills = 0;
          mob._oldestKillAt = 0;
          mob._latestKillAt = 0;
          mob.criminalUntil = 0;
          try { recomputeNotoriety(api, mob, Date.now()); } catch { /* ignore */ }
          touched++;
        }
        ctx.state.sendSystemMessage?.(
          touched > 0 ? `Cleared murder state on ${touched} mob(s) named "${name}".`
                      : `No mob named "${name}" found.`,
        );
        return;
      }

      ctx.state.sendSystemMessage?.('Usage: [murderdecay status|sweep|clear <name>');
    },
  });

  return () => api.commands.unregister('murderdecay');
}
