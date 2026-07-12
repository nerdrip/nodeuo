// [effect <itemId> — play a stationary graphical effect at the caller's feet.
// [boom       — fireball + sound demo.

export default function (api) {
  const { commands, effects } = api;
  if (!effects) return;

  commands.register({
    name: 'effect',
    help: 'Play a graphical effect. Usage: [effect <itemId> [hue]',
    run: (ctx) => {
      const mob = ctx.state?.mobile;
      if (!mob) return;
      const itemId = parseInt(ctx.args[0] ?? '', 10);
      if (!Number.isFinite(itemId)) { ctx.state.sendSystemMessage?.('Usage: [effect <itemId> [hue]'); return; }
      const hue = parseInt(ctx.args[1] ?? '0', 10) || 0;
      effects.playAt(api.world, mob, { itemId, hue, duration: 15 });
    },
  });

  commands.register({
    name: 'boom',
    help: 'Play a fireball-and-flash demo effect at your feet.',
    hidden: true,
    run: (ctx) => {
      const mob = ctx.state?.mobile;
      if (!mob) return;
      effects.playAt(api.world, mob, { itemId: 0x36BD, hue: 0, duration: 20 });
      effects.playAt(api.world, mob, { itemId: 0x3728, hue: 0x04EC, duration: 20, renderMode: 4 });
    },
  });

  return () => {
    commands.unregister('effect');
    commands.unregister('boom');
  };
}
