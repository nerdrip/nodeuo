// [where — prints the region(s) at the caller's current position.

export default function (api) {
  const { commands, regions } = api;
  if (!regions) return;

  const spec = {
    name: 'where',
    help: 'Report the region(s) you are standing in.',
    access: 'Player',
    run: (ctx) => {
      const mob = ctx.state?.mobile;
      if (!mob) return;
      const hits = regions.at(mob.map ?? 1, mob.x, mob.y);
      if (hits.length === 0) {
        ctx.state.sendSystemMessage?.('You are in the wild.');
      } else {
        ctx.state.sendSystemMessage?.(`You are in: ${hits.map((r) => r.name).join(' > ')}`);
      }
    },
  };

  if (api.lifecycle?.command?.(spec)) return () => {};

  commands.register(spec);
  return () => commands.unregister('where');
}
