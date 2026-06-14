// [events recent|kinds|clear — view the recent shard event log.

export default function register(api) {
  if (!api.commands || !api.systems?.shardEvents) {
    api.log?.('cmd/events: missing shardEvents');
    return () => {};
  }
  const E = api.systems.shardEvents;

  api.commands.register({
    name: 'events',
    help: '[events [recent|kinds|clear] [kind]',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? 'recent').toLowerCase();
      switch (sub) {
        case 'recent':
        case '': {
          const filter = args?.[1] ?? null;
          const list = E.recent(20, filter);
          if (list.length === 0) { ctx.state.sendSystemMessage('No recent events.'); return; }
          for (const ev of list) {
            const ts = new Date(ev.ts).toISOString().slice(11, 19);
            ctx.state.sendSystemMessage(`  [${ts}] ${ev.kind.padEnd(20)} ${ev.message}`);
          }
          return;
        }
        case 'kinds': {
          ctx.state.sendSystemMessage(`Known event kinds: ${E.SHARD_EVENT_KINDS.join(', ')}`);
          return;
        }
        case 'clear': {
          if ((ctx.sender?.accessLevel ?? 0) < 2) {
            ctx.state.sendSystemMessage('Admin only.');
            return;
          }
          E.clear();
          ctx.state.sendSystemMessage('Event log cleared.');
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [events recent [kind] | kinds | clear');
      }
    },
  });
  return () => {};
}
