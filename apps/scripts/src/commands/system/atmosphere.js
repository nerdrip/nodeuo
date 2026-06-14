// [weather <kind> [intensity] — broadcast weather to every online client.
// [season  <id>              — change client season.
//
//   kinds: dry, rain, storm, fierce, snow
//   seasons: spring(0), summer(1), fall(2), winter(3), desolation(4)

import { sendToOnline } from '../../_spatial.js';

export default function (api) {
  const { commands, protocol, dayNight } = api;

  const kinds = {
    dry: protocol.WeatherKind.Dry,
    rain: protocol.WeatherKind.Rain,
    storm: protocol.WeatherKind.Storm,
    fierce: protocol.WeatherKind.FierceStorm,
    snow: protocol.WeatherKind.Snow,
  };

  function broadcast(bytes) {
    sendToOnline(api, bytes);
  }

  commands.register({
    name: 'weather',
    help: 'Set weather (dry|rain|storm|fierce|snow) [intensity].',
    run: (ctx) => {
      const [kindName, intensityRaw] = ctx.args;
      const kind = kinds[String(kindName ?? '').toLowerCase()];
      if (kind === undefined) { ctx.reply('Unknown weather kind.'); return; }
      const intensity = Math.max(0, Math.min(70, Number(intensityRaw ?? 10) | 0));
      // Persist on dayNight so new logins receive the current weather.
      // Without this the new client walks into a sunny world while every
      // existing player still sees rain — leading to "weather doesn't
      // sync" reports the moment a second player joins.
      if (dayNight) {
        dayNight.weatherKind = kind;
        dayNight.weatherIntensity = intensity;
      }
      broadcast(protocol.weather({ kind, intensity }));
    },
  });

  commands.register({
    name: 'season',
    help: 'Set season id (0..4).',
    run: (ctx) => {
      const id = Math.max(0, Math.min(4, Number(ctx.args[0] ?? 1) | 0));
      // Same reasoning as weather — bind the season to the dayNight
      // singleton so subsequent logins receive the GM-set value.
      if (dayNight) dayNight.season = id;
      broadcast(protocol.seasonChange(id, 1));
    },
  });

  // ─────────────────────────────────────────────────────────────────
  // Day/night manual override — pause the auto-cycle at a fixed light
  // level. ServUO has these as `[setlight` plus the `[day` / `[night`
  // shortcuts. Useful for testing dungeon glow / torch radius without
  // waiting 12 in-game minutes for the next cycle phase.
  //
  //   [day                 — bright (level 0)
  //   [night               — pitch-dark (level 30)
  //   [time <0-30>         — pin to specific level (0 brightest)
  //   [time auto           — release override, resume auto-cycle
  // ─────────────────────────────────────────────────────────────────
  commands.register({
    name: 'day',
    help: '[day — pin world light to bright (level 0) until [time auto.',
    access: 'Admin',
    run: () => { if (dayNight?.forceLevel) dayNight.forceLevel(0); },
  });
  commands.register({
    name: 'night',
    help: '[night — pin world light to dark (level 30) until [time auto.',
    access: 'Admin',
    run: () => { if (dayNight?.forceLevel) dayNight.forceLevel(30); },
  });
  // ServUO uses `[SetLightLevel`; we shorten to `[setlight`. Named
  // distinctly from the player-side `[time` clock command (which lives
  // in `commands/time.js` and reads day-night state without setting it).
  commands.register({
    name: 'setlight',
    help: '[setlight <0-30|auto> — pin world light to the given level (0 brightest, 30 darkest), or `auto` to resume the day-night cycle.',
    access: 'Admin',
    run: (ctx) => {
      const arg = String(ctx.args[0] ?? '').toLowerCase();
      if (!dayNight) { ctx.state?.sendSystemMessage?.('day-night cycle not available'); return; }
      if (arg === 'auto' || arg === 'cycle' || arg === 'resume') {
        dayNight.clearForce?.();
        ctx.state?.sendSystemMessage?.(`Light: auto-cycle resumed (current level: ${dayNight.currentLevel()}).`);
        return;
      }
      const n = Number(arg);
      if (!Number.isFinite(n)) {
        ctx.state?.sendSystemMessage?.('Usage: [setlight <0-30|auto>');
        return;
      }
      const lvl = Math.max(0, Math.min(30, n | 0));
      dayNight.forceLevel?.(lvl);
      ctx.state?.sendSystemMessage?.(`Light: pinned to level ${lvl} (use [setlight auto to resume the cycle).`);
    },
  });

  return () => {
    commands.unregister('weather');
    commands.unregister('season');
    commands.unregister('day');
    commands.unregister('night');
    commands.unregister('setlight');
  };
}
