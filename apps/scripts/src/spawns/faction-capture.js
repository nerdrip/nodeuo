// Faction stronghold capture loop — runs the `[faction-capture]` tick
// every second and exposes `[capture status` to players.
//
// On each capture-complete event we broadcast via shardEvents (which
// the Town Cryer auto-news subscription picks up) and post a message
// to every faction member.

export default function register(api) {
  if (!api.world) return () => {};
  const capture = api.systems?.factionCapture;
  const strongholds = api.systems?.factionStrongholds;
  if (!capture || !strongholds) {
    api.log?.('capture: faction capture systems unavailable');
    return () => {};
  }

  const tick = () => {
    try {
      const events = capture.tickCapture(api.world);
      for (const ev of events) {
        if (ev.kind === 'capture-start') {
          api.systems?.shardEvents?.emit?.('faction-capture-start',
            `${ev.attacker.toUpperCase()} is contesting the ${ev.name} stronghold!`,
            { stronghold: ev.stronghold, attacker: ev.attacker });
        } else if (ev.kind === 'capture-complete') {
          api.systems?.shardEvents?.emit?.('faction-capture',
            `★ ${ev.newHolder.toUpperCase()} has captured ${ev.name} from ${ev.previous}!`,
            { stronghold: ev.stronghold, previous: ev.previous, holder: ev.newHolder });
        }
      }
    } catch (e) { api.log?.(`[capture] tick threw: ${e.message}`); }
  };
  const interval = api.lifecycle?.setInterval?.(tick, 1000) ?? setInterval(tick, 1000);
  interval.unref?.();

  if (api.commands) {
    const spec = {
      name: 'capture',
      help: '[capture status — faction stronghold control overview.',
      access: 'Player',
      run(ctx) {
        ctx.state.sendSystemMessage?.('Faction Stronghold Control:');
        for (const sh of strongholds.listStrongholds()) {
          const s = capture.statusOf(sh.faction);
          const tag = s.controlling === sh.faction
            ? `held by ${s.controlling}`
            : `★ HELD BY ${s.controlling} (rival)`;
          const prog = s.capturing
            ? ` — ${(s.captureProgress * 100) | 0}% by ${s.capturing}`
            : (s.graceMs > 0 ? ` — grace ${Math.ceil(s.graceMs / 60000)}m`  : '');
          ctx.state.sendSystemMessage?.(
            `  ${sh.name.padEnd(20)} (${sh.faction.padEnd(11)}) — ${tag}${prog}`,
          );
        }
        ctx.state.sendSystemMessage?.('Faction silver pools:');
        for (const f of ['council', 'minax', 'shadowlords', 'truebrits']) {
          ctx.state.sendSystemMessage?.(`  ${f.padEnd(11)} : ${capture.silverOf(f)}`);
        }
      },
    };
    if (!api.lifecycle?.command?.(spec)) api.commands.register(spec);
  }

  return () => {
    if (!api.lifecycle) clearInterval(interval);
    if (!api.lifecycle) {
      try { api.commands?.unregister?.('capture'); } catch { /* ignore */ }
    }
  };
}
