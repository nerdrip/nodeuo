// FAZA GH — `[time` shows the in-world day/night clock.
//
// ServUO `Engines/SunCycle.cs`: a continuous 8-minute day-night cycle.
// We surface the current phase + clock for the player.

export default function register(api) {
  if (!api.commands || !api.dayNight) return () => {};

  api.commands.register({
    name: 'time',
    help: '[time — show the current in-world hour.',
    access: 'Player',
    run(ctx) {
      const dn = api.dayNight;
      const hour = dn.hourOfDay?.() ?? -1;
      const phase = dn.currentPhase?.() ?? 'unknown';
      if (hour >= 0) {
        ctx.state.sendSystemMessage(
          `It is ${hour.toFixed(1)} hours past midnight (${phase}).`,
        );
      } else {
        ctx.state.sendSystemMessage(`Sky: ${phase}.`);
      }
    },
  });

  return () => api.commands.unregister('time');
}
