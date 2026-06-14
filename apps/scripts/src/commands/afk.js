// FAZA GG — `[afk` away-from-keyboard toggle.
//
// Sets `mob.afk = true` so other players can see "(AFK)" in single-
// click responses (LookReq). Auto-cleared on movement / speech (caller
// hooks need to clear). Toggle re-fires the system message.

export default function register(api) {
  if (!api.commands) return () => {};

  const spec = {
    name: 'afk',
    help: '[afk — toggle "Away From Keyboard" status.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      sender.afk = !sender.afk;
      ctx.state.sendSystemMessage(sender.afk ? 'You are AFK.' : 'You are back.');
    },
  };

  if (api.lifecycle?.command?.(spec)) return () => {};

  api.commands.register(spec);
  return () => api.commands.unregister('afk');
}
