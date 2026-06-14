// Day/night auto-cycle.
//
// Ticks every `intervalMs`, advances the overall light level smoothly between
// `brightLevel` (day) and `darkLevel` (night), and broadcasts 0x4F to all
// connected clients.

import { overallLightLevel } from '@uo/protocol';

/** @typedef {Object} DayNightOptions
 * @property {number} [intervalMs]      time between ticks
 * @property {number} [cyclePeriodMs]   full bright→dark→bright cycle duration
 * @property {number} [brightLevel]     usually 0 (brightest)
 * @property {number} [darkLevel]       usually 0x1F (darkest)
 */

export class DayNightCycle {
  /**
   * @param {import('./world/world.js').World} world
   * @param {DayNightOptions} [opts]
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.cyclePeriodMs = opts.cyclePeriodMs ?? 24 * 60_000;
    this.bright = opts.brightLevel ?? 0;
    this.dark = opts.darkLevel ?? 0x1E;
    /** Current world season (0 Spring, 1 Summer, 2 Fall, 3 Winter, 4 Desolation).
     *  GM-controlled via `[season <id>` (atmosphere command); new logins read
     *  whatever's set so they enter on the right palette. */
    this.season = opts.season ?? 1;
    /** Current weather kind + intensity (last broadcast). New logins receive
     *  this so they match what existing clients see. */
    this.weatherKind = 0xFE; // Dry
    this.weatherIntensity = 0;
    /** @type {NodeJS.Timeout | null} */
    this._timer = null;
    this._startedAt = Date.now();
    this._lastLevel = -1;
  }

  /** Current light level for the current time. When a manual override
   *  is active (`forceLevel`) the cycle is paused at that value until
   *  `clearForce()` is called. Admin `[day` / `[night` / `[time` toggle
   *  this. */
  currentLevel(now = Date.now()) {
    if (Number.isFinite(this._forcedLevel)) return this._forcedLevel | 0;
    const t = ((now - this._startedAt) % this.cyclePeriodMs) / this.cyclePeriodMs;
    // Simple cosine: t=0 → bright, t=0.5 → dark, t=1 → bright.
    const phase = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
    return Math.round(this.bright + phase * (this.dark - this.bright));
  }

  /** In-world UO clock hour (0..24). Scripts such as the disturbing
   *  portrait need the same shard clock as `[time`, not local wall time. */
  hourOfDay(now = Date.now()) {
    const elapsed = ((now - this._startedAt) % this.cyclePeriodMs + this.cyclePeriodMs) % this.cyclePeriodMs;
    return (elapsed / this.cyclePeriodMs) * 24;
  }

  currentPhase(now = Date.now()) {
    const hour = this.hourOfDay(now);
    if (hour < 4 || hour >= 20) return 'night';
    if (hour < 8) return 'dawn';
    if (hour < 16) return 'day';
    return 'dusk';
  }

  /** Pin the world light level to `level` (0..30, clamped). Broadcasts
   *  the new level to every connected client. Idempotent. */
  forceLevel(level) {
    const lvl = Math.max(0, Math.min(30, level | 0));
    this._forcedLevel = lvl;
    this._lastLevel = -1;    // force re-broadcast on next tick
    this.tick();
  }

  /** Release the manual override so the auto-cycle resumes. */
  clearForce() {
    this._forcedLevel = undefined;
    this._lastLevel = -1;
    this.tick();
  }

  tick() {
    const level = this.currentLevel();
    if (level === this._lastLevel) return;
    this._lastLevel = level;
    const bytes = overallLightLevel(level);
    for (const m of this.world.mobiles.values()) {
      if (m.client) m.client.send(bytes);
    }
    this._maybeRotateWeather();
  }

  /** Weather rotation — every 5 minutes pick a new pattern with
   *  weighted RNG. Mostly Dry, occasional Rain/Snow/Storm. Each
   *  pattern broadcasts the canonical 0x65 weather packet so clients
   *  see falling rain / snow without us writing a per-tile particle
   *  system. Mirrors ServUO `Weather.cs` periodic mood swings. */
  _maybeRotateWeather() {
    const now = Date.now();
    if (!this._nextWeatherAt) this._nextWeatherAt = now + 5 * 60_000;
    if (now < this._nextWeatherAt) return;
    this._nextWeatherAt = now + 5 * 60_000;
    // Roll: 60 % Dry, 20 % Rain, 12 % Snow, 5 % Storm, 3 % heatwave.
    const r = Math.random();
    let kind = 0xFE, intensity = 0;
    if      (r < 0.60) { kind = 0xFE; intensity = 0; }
    else if (r < 0.80) { kind = 0x00; intensity = 30 + Math.floor(Math.random() * 40); } // rain
    else if (r < 0.92) { kind = 0x02; intensity = 30 + Math.floor(Math.random() * 30); } // snow
    else if (r < 0.97) { kind = 0x01; intensity = 50 + Math.floor(Math.random() * 30); } // storm
    else               { kind = 0x03; intensity = 0; }                                    // heat
    this.weatherKind = kind; this.weatherIntensity = intensity;
    if (typeof this._broadcastWeather === 'function') {
      try { this._broadcastWeather(kind, intensity); }
      catch { /* advisory */ }
    }
  }

  /** Late-bound broadcaster — main.js wires this to a function that
   *  sends the 0x65 weather packet to every connected client. Keeps
   *  day-night.js decoupled from protocol module. */
  setWeatherBroadcaster(fn) { this._broadcastWeather = fn || null; }

  /** Snapshot for persistence — bug-hunt #8 #11. Without round-tripping
   *  these the shard reboot resets time-of-day to "phase 0 = bright"
   *  and clears active weather; a restart at wallclock midnight leaves
   *  players in noon light. */
  serialize() {
    return {
      startedAt: this._startedAt,
      season: this.season,
      weatherKind: this.weatherKind,
      weatherIntensity: this.weatherIntensity,
      nextWeatherAt: this._nextWeatherAt ?? 0,
    };
  }
  deserialize(state) {
    if (!state || typeof state !== 'object') return;
    if (Number.isFinite(state.startedAt)) this._startedAt = state.startedAt;
    if (Number.isFinite(state.season)) this.season = state.season;
    if (Number.isFinite(state.weatherKind)) this.weatherKind = state.weatherKind;
    if (Number.isFinite(state.weatherIntensity)) this.weatherIntensity = state.weatherIntensity;
    if (Number.isFinite(state.nextWeatherAt)) this._nextWeatherAt = state.nextWeatherAt;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}
