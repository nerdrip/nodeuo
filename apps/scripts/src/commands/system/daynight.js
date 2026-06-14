// [daynight on|off — toggle the automatic day/night light cycle.

export default function (api) {
  const { commands, dayNight } = api;
  if (!dayNight) return;

  commands.register({
    name: 'daynight',
    help: 'Toggle the day/night cycle. Usage: [daynight on|off',
    run: (ctx) => {
      const arg = (ctx.args[0] ?? '').toLowerCase();
      if (arg === 'on') {
        dayNight.start();
        ctx.state?.sendSystemMessage?.('Day/night cycle enabled.');
      } else if (arg === 'off') {
        dayNight.stop();
        ctx.state?.sendSystemMessage?.('Day/night cycle disabled.');
      } else {
        ctx.state?.sendSystemMessage?.('Usage: [daynight on|off');
      }
    },
  });

  return () => commands.unregister('daynight');
}
