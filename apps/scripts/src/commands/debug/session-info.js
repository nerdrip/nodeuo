// Session-info commands — [ping / [playtime / [version / [lfg
//
// Light QoL commands every player can run.
//   [ping       — round-trip a sentinel back to the client; reports ms.
//   [playtime   — how long since this character last logged in.
//   [version    — server version banner + commit (if available).
//   [lfg <text> — broadcast a "looking for group" notice across the shard.

const SERVER_VERSION = '0.1.0';     // bumped manually with semver-style ship.
const LFG_COOLDOWN_MS = 60_000;     // 1 message per minute per player.
const _lfgCooldown = new WeakMap();

import { sendSystemMessageToOnline } from '../../_spatial.js';

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'ping',
    help: '[ping — round-trip latency probe.',
    access: 'Player',
    run(ctx) {
      const t = Date.now();
      // Round-trip is symbolic — the response is generated server-side; for
      // a real latency probe the client would have to echo a token. We at
      // least show "server alive" + uptime as a sanity check.
      const uptime = (process.uptime() | 0);
      ctx.state.sendSystemMessage(
        `pong — server uptime ${uptime}s, ts ${t}.`,
      );
    },
  });

  api.commands.register({
    name: 'playtime',
    help: '[playtime — how long ago you logged in.',
    access: 'Player',
    run(ctx) {
      const acc = ctx.state?.account;
      if (!acc?.lastLogin) {
        ctx.state.sendSystemMessage('No login timestamp on record.');
        return;
      }
      const since = Date.now() - new Date(acc.lastLogin).getTime();
      const hh = (since / 3_600_000) | 0;
      const mm = ((since % 3_600_000) / 60_000) | 0;
      const ss = ((since % 60_000) / 1_000) | 0;
      ctx.state.sendSystemMessage(
        `You have been logged in for ${hh}h ${mm}m ${ss}s.`,
      );
    },
  });

  api.commands.register({
    name: 'version',
    help: '[version — server version banner.',
    access: 'Player',
    run(ctx) {
      const node = process.version;
      ctx.state.sendSystemMessage(
        `UO-Node v${SERVER_VERSION} (Node.js ${node}, platform ${process.platform})`,
      );
    },
  });

  api.commands.register({
    name: 'lfg',
    help: '[lfg <text> — broadcast a "looking for group" notice (1/min).',
    access: 'Player',
    run(ctx) {
      const text = (ctx.args ?? []).join(' ').trim();
      if (!text) {
        ctx.state.sendSystemMessage('Usage: [lfg <what activity / where>.');
        return;
      }
      if (text.length > 80) {
        ctx.state.sendSystemMessage('Keep it under 80 characters.');
        return;
      }
      const now = Date.now();
      const last = _lfgCooldown.get(ctx.sender) ?? 0;
      if (now - last < LFG_COOLDOWN_MS) {
        const left = ((LFG_COOLDOWN_MS - (now - last)) / 1000) | 0;
        ctx.state.sendSystemMessage(`Wait ${left}s before broadcasting again.`);
        return;
      }
      _lfgCooldown.set(ctx.sender, now);
      const tag = `[LFG] ${ctx.sender.name ?? 'someone'}: ${text}`;
      const n = sendSystemMessageToOnline(api, tag);
      ctx.state.sendSystemMessage(`LFG broadcast to ${n} player(s).`);
    },
  });

  return () => {
    for (const n of ['ping', 'playtime', 'version', 'lfg']) {
      api.commands.unregister(n);
    }
  };
}
