// `[top <stat>` — global leaderboard query for player-tracked stats.
// Mirrors ServUO `Scripts/Engines/MyRunUO` ladder generation + cuts the
// HTTP roundtrip — we just walk the live mobile registry. Keeps the
// query simple: reads every mobile with a `client` (online players) +
// the persistent player record fallback if the offline accounts/saves
// expose player-owned SQLite rows without scanning the entire world.
//
// Stats:
//   fame   karma   gold   kills   pkills   skills   stat   hp   level

import { normalizeSkillValue } from '../../_rules.js';
import { allMobiles } from '../../_spatial.js';

const STAT_ALIASES = {
  fame:   (m) => m.fame ?? 0,
  karma:  (m) => m.karma ?? 0,
  gold:   (m) => m.gold ?? 0,
  kills:  (m) => m.kills ?? 0,
  pkills: (m) => m.pkills ?? 0,
  skills: (m) => Object.values(m.skills ?? {}).reduce((a, b) => a + normalizeSkillValue(b), 0),
  stat:   (m) => (m.str ?? 0) + (m.dex ?? 0) + (m.int ?? 0),
  hp:     (m) => m.hpMax ?? 0,
};

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'top',
    help: '[top <fame|karma|gold|kills|pkills|skills|stat|hp> — show top 10.',
    access: 'Player',
    run(ctx, args) {
      const which = String(args[0] ?? 'fame').toLowerCase();
      const reader = STAT_ALIASES[which];
      if (!reader) {
        ctx.state.sendSystemMessage(
          `Available stats: ${Object.keys(STAT_ALIASES).join(', ')}`);
        return;
      }
      const players = [...allMobiles(api)]
        .filter((m) => m.isPlayer || m.client)
        .map((m) => ({ name: m.name, value: reader(m) | 0 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
      if (!players.length) {
        ctx.state.sendSystemMessage('No players are tracked.');
        return;
      }
      ctx.state.sendSystemMessage(`Top 10 by ${which}:`);
      for (let i = 0; i < players.length; i++) {
        ctx.state.sendSystemMessage(
          `  ${(i + 1).toString().padStart(2, ' ')}. ${players[i].name}: ${players[i].value}`);
      }
    },
  });

  return () => api.commands.unregister('top');
}
