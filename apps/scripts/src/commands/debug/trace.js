// `[trace on|off|status|move on|move off` — toggle the diagnostic tracer in
// `apps/server/src/trace.js`. Logs are written to server stdout with
// `[trace <category>] <message>` prefixes. Movement/visibility traces
// are muted separately because they are high-volume.
//
// The client-side trace is gated by `localStorage.uoTrace = '1'`
// (toggle in devtools) — that's separate from this server flag.

export default function register(api) {
  if (!api.commands?.register) return () => {};
  const trace = api.systems?.trace;
  if (!trace) {
    api.log?.('trace: trace system unavailable');
    return () => {};
  }
  api.commands.register({
    name: 'trace',
    help: '[trace on|off|status|move on|move off — toggle diagnostic tracing.',
    access: 'Admin',
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'status').toLowerCase();
      if (sub === 'move' || sub === 'vis') {
        const flag = String(ctx.args[1] ?? 'status').toLowerCase();
        if (flag === 'on') {
          trace.setTraceCategoryEnabled?.(sub, true);
          ctx.state?.sendSystemMessage?.(`Trace category ${sub} ON.`);
          return;
        }
        if (flag === 'off') {
          trace.setTraceCategoryEnabled?.(sub, false);
          ctx.state?.sendSystemMessage?.(`Trace category ${sub} OFF.`);
          return;
        }
        ctx.state?.sendSystemMessage?.(`Trace category ${sub} is ${trace.isTraceCategoryEnabled?.(sub) ? 'ON' : 'OFF'}.`);
        return;
      }
      if (sub === 'on') {
        trace.setTraceEnabled(true);
        ctx.state?.sendSystemMessage?.('Trace ON. Movement/visibility remain muted unless you run [trace move on or [trace vis on.');
        console.log('[trace] enabled by', ctx.sender?.name ?? '?');
        return;
      }
      if (sub === 'off') {
        trace.setTraceEnabled(false);
        ctx.state?.sendSystemMessage?.('Trace OFF.');
        console.log('[trace] disabled by', ctx.sender?.name ?? '?');
        return;
      }
      ctx.state?.sendSystemMessage?.(`Trace is ${trace.isTraceEnabled() ? 'ON' : 'OFF'}; move=${trace.isTraceCategoryEnabled?.('move') ? 'ON' : 'OFF'}, vis=${trace.isTraceCategoryEnabled?.('vis') ? 'ON' : 'OFF'}.`);
    },
  });
  return () => { try { api.commands.unregister?.('trace'); } catch { /* ignore */ } };
}
