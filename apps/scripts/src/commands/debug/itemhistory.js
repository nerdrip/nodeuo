// [itemhistory <hexSerial> — admin: dump the lifecycle log of an item.
// Helpful for debugging duplication / loot-rollback / lost-item reports.

export default function register(api) {
  if (!api.commands) return () => {};
  const itemHistory = api.systems?.itemHistory;
  if (!itemHistory) {
    api.log?.('itemhistory: item history system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'itemhistory',
    help: '[itemhistory <hexSerial> | [itemhistory stats',
    access: 'GM',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      if (sub === 'stats') {
        ctx.state.sendSystemMessage(`Tracked items: ${itemHistory.trackedCount()}`);
        return;
      }
      const serial = parseInt(args?.[0], 16) || 0;
      if (!serial) { ctx.state.sendSystemMessage('Usage: [itemhistory <hexSerial>'); return; }
      const log = itemHistory.historyOf(serial);
      if (log.length === 0) { ctx.state.sendSystemMessage('No history for that serial.'); return; }
      ctx.state.sendSystemMessage(`Item 0x${serial.toString(16)} — ${log.length} event(s):`);
      for (const e of log.slice(0, 30)) {
        const ts = new Date(e.ts).toISOString().slice(11, 19);
        const who = e.who ? `by 0x${e.who.toString(16)}` : '';
        const where = e.where ? `@${e.where}` : '';
        ctx.state.sendSystemMessage(`  [${ts}] ${e.kind.padEnd(10)} ${who} ${where}`);
      }
    },
  });
  return () => {};
}
