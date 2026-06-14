// `[hunt-egg` — Easter egg hunt trigger. Player-facing. Active only
// during the 7-day window ending Easter Sunday (per systems/events/easter.js)
// unless admin overrides via `[easter on`. Rate-limited to one egg
// per 60 s per player to keep macros from farming.
//
// `[easter on|off|status` — admin override mirroring the Halloween cmd.

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};
  const easter = api.systems?.easter;
  if (!easter) {
    api.log?.('hunt-egg: easter system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'hunt-egg',
    help: '[hunt-egg — search for an Easter egg (active only during the holiday window).',
    access: 'Player',
    run(ctx) {
      if (!easter.isActive()) {
        ctx.state.sendSystemMessage('The egg hunt is not currently running.');
        return;
      }
      const now = Date.now();
      const last = ctx.sender._lastEggAt ?? 0;
      if (now - last < 60_000) {
        ctx.state.sendSystemMessage('You found one too recently — try again in a minute.');
        return;
      }
      ctx.sender._lastEggAt = now;
      const egg = easter.deliverEgg(api, ctx.sender);
      if (!egg) ctx.state.sendSystemMessage('You search but find nothing this time.');
    },
  });

  api.commands.register({
    name: 'easter',
    help: '[easter on|off|clear|status — admin override for the Easter event window.',
    access: 'GM',
    run(ctx) {
      const arg = String(ctx.args ?? '').trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        easter.setOverride(arg);
        ctx.state.sendSystemMessage(`Easter override → ${arg}`);
        return;
      }
      if (arg === 'clear' || arg === 'auto') {
        easter.setOverride(null);
        ctx.state.sendSystemMessage('Easter override cleared — auto by date.');
        return;
      }
      ctx.state.sendSystemMessage(
        `Easter is currently ${easter.isActive() ? 'ACTIVE' : 'INACTIVE'}. Use on/off/clear.`);
    },
  });

  return () => {
    api.commands.unregister('hunt-egg');
    api.commands.unregister('easter');
  };
}
