// `[sky` — describe current sky state (moons + constellation).

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'sky',
    help: '[sky — current Trammel/Felucca phases + constellation.',
    access: 'Player',
    run(ctx) {
      const facet = ctx.sender?.map | 0;
      ctx.state.sendSystemMessage(
        api.systems?.astronomy?.describeSky?.(Date.now(), facet) ?? 'The sky is quiet.',
      );
    },
  });
  return () => api.commands.unregister('sky');
}
