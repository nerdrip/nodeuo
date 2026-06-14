// [damage <n>  — inflict N damage on yourself (dev-only).
// [anim <id>   — play an animation action on your mobile.
// [hurt        — short demo: anim 0x14 (takehit) + 5 damage.

export default function (api) {
  const { commands, combat, world } = api;
  if (!combat) return;

  commands.register({
    name: 'damage',
    help: 'Damage yourself by N hit points.',
    run: (ctx) => {
      if (!ctx.state?.mobile) return;
      const n = Math.max(1, Number(ctx.args[0] ?? 5) | 0);
      combat.damage(world, ctx.state.mobile, n);
    },
  });

  commands.register({
    name: 'anim',
    help: 'Play an animation action (0..0x22).',
    run: (ctx) => {
      if (!ctx.state?.mobile) return;
      const id = Math.max(0, Number(ctx.args[0] ?? 0x21) | 0); // salute default
      combat.animate(world, ctx.state.mobile, id);
    },
  });

  commands.register({
    name: 'hurt',
    help: 'Play take-hit anim + 5 damage.',
    run: (ctx) => {
      if (!ctx.state?.mobile) return;
      combat.animate(world, ctx.state.mobile, 0x14);
      combat.damage(world, ctx.state.mobile, 5);
    },
  });

  return () => {
    commands.unregister('damage');
    commands.unregister('anim');
    commands.unregister('hurt');
  };
}
