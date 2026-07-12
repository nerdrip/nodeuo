// `[season <0..4>` — broadcast a SeasonChange packet to everyone.
// 0 Spring, 1 Summer, 2 Fall, 3 Winter, 4 Desolation.
// Region-driven season overrides (set via `region.season` and applied
// in main.js's region transition broadcaster) still fire on the next
// region entry — this command is for shard-wide cosmetic events
// (Halloween → Desolation, Christmas → Winter, etc).
//
// Mirrors ServUO `Commands/Generic/Season.cs`.

import { sendToOnline } from '../../_spatial.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  const NAMES = ['Spring', 'Summer', 'Fall', 'Winter', 'Desolation'];

  api.commands.register({
    name: 'season',
    help: 'season <0..4> — set the visual season (0 spring … 4 desolation)',
    access: 'GM',
    run(ctx) {
      const args = String(ctx.args ?? '').trim().split(/\s+/).filter(Boolean);
      if (!args.length) {
        ctx.state.sendSystemMessage(`Usage: [season <0..4>  (current: ${NAMES.join(', ')})`);
        return;
      }
      const v = Math.max(0, Math.min(4, parseInt(args[0], 10) || 0));
      // Persist shard-wide season in the authoritative atmosphere state so
      // clients logging in after this broadcast receive the same season.
      if (api.dayNight) api.dayNight.season = v;
      const pkt = api.protocol.seasonChange(v, 1);
      const n = sendToOnline(api, pkt);
      ctx.state.sendSystemMessage(`Season → ${NAMES[v]} (broadcast to ${n} client(s)).`);
    },
  });

  return () => api.commands.unregister('season');
}
