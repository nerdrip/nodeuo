// `[news` — list active Town Cryer headlines.
// `[postnews <body>` — GM-only, post a new headline (24h TTL by default).
//
// Mirrors ServUO `Scripts/Services/Town Cryer/` GM gump path, collapsed
// to a chat command so any account with GM access can broadcast updates
// without a custom UI surface.

export default function register(api) {
  if (!api.commands) return () => {};
  const townCryer = api.systems?.townCryer;

  api.commands.register({
    name: 'news',
    help: '[news — list current Town Cryer headlines.',
    access: 'Player',
    run(ctx) {
      const list = townCryer?.listActiveNews?.() ?? [];
      if (list.length === 0) {
        ctx.state.sendSystemMessage('All quiet on the streets of Britannia.');
        return;
      }
      ctx.state.sendSystemMessage(`Town Cryer (${list.length} active):`);
      for (const n of list) {
        const ageH = ((Date.now() - n.postedAt) / 3600_000) | 0;
        ctx.state.sendSystemMessage(`  #${n.id} (${ageH}h ago, ${n.postedBy}): ${n.body}`);
      }
    },
  });

  api.commands.register({
    name: 'postnews',
    help: '[postnews <body> — broadcast a Town Cryer headline (GM).',
    access: 'GameMaster',
    run(ctx, args) {
      const body = (args ?? []).join(' ').trim();
      if (!body) { ctx.state.sendSystemMessage('Usage: [postnews <body>'); return; }
      const e = townCryer?.postNews?.({ body, postedBy: ctx.sender?.name ?? 'GM' });
      if (!e) { ctx.state.sendSystemMessage('Town Cryer system unavailable.'); return; }
      ctx.state.sendSystemMessage(`Headline #${e.id} posted.`);
    },
  });

  api.commands.register({
    name: 'rmnews',
    help: '[rmnews <id> — drop a headline (GM).',
    access: 'GameMaster',
    run(ctx, args) {
      const id = parseInt(args?.[0] ?? '0', 10) | 0;
      if (!id) { ctx.state.sendSystemMessage('Usage: [rmnews <id>'); return; }
      ctx.state.sendSystemMessage(townCryer?.removeNews?.(id) ? 'Removed.' : 'No such headline.');
    },
  });

  return () => {
    api.commands.unregister('news');
    api.commands.unregister('postnews');
    api.commands.unregister('rmnews');
  };
}
