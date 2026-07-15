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
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.cyclePeriodMs = opts.cyclePeriodMs ?? 24 * 60_000;
    this.bright = opts.brightLevel ?? 0;
    this.dark = opts.darkLevel ?? 12;
    /** Current world season (0 Spring, 1 Summer, 2 Fall, 3 Winter, 4 Desolation).
     *  GM-controlled via `[season <id>` (atmosphere command); new logins read
     *  whatever's set so they enter on the right palette. */
    this.season = opts.season ?? 1;
    /** Current weather kind + intensity (last broadcast). New logins receive
     *  this so they match what existing clients see. */
    this.weatherKind = 0xFE; // Dry
    this.weatherIntensity = 0;
    this.weatherTemperature = 0;
    /** @type {NodeJS.Timeout | null} */
    this._timer = null;
    // A brand-new shard starts at noon. Persisted shards restore their
    // authored clock below, so restarts do not reset the phase.
    this._startedAt = Date.now() - this.cyclePeriodMs * 0.5;
    this._lastLevel = -1;
  }

  /** Current light level for the current time. When a manual override
   *  is active (`forceLevel`) the cycle is paused at that value until
   *  `clearForce()` is called. Admin `[day` / `[night` / `[time` toggle
   *  this. */
  currentLevel(now = Date.now()) {
    if (Number.isFinite(this._forcedLevel)) return this._forcedLevel | 0;
    const hour = this.hourOfDay(now);
    // ServUO LightCycle parity: night 00:00-04:00, dawn 04:00-06:00,
    // daylight 06:00-22:00, dusk 22:00-24:00.
    if (hour < 4) return this.dark;
    if (hour < 6) return Math.round(this.dark * (1 - (hour - 4) / 2) + this.bright * ((hour - 4) / 2));
    if (hour < 22) return this.bright;
    return Math.round(this.bright * (1 - (hour - 22) / 2) + this.dark * ((hour - 22) / 2));
  }

  /** In-world UO clock hour (0..24). Scripts such as the disturbing
   *  portrait need the same shard clock as `[time`, not local wall time. */
  hourOfDay(now = Date.now()) {
    const elapsed = ((now - this._startedAt) % this.cyclePeriodMs + this.cyclePeriodMs) % this.cyclePeriodMs;
    return (elapsed / this.cyclePeriodMs) * 24;
  }

  currentPhase(now = Date.now()) {
    const hour = this.hourOfDay(now);
    if (hour < 4) return 'night';
    if (hour < 6) return 'dawn';
    if (hour < 22) return 'day';
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
    // Weather has its own schedule and must continue even while rounded
    // light stays unchanged through the long daytime/night plateaus.
    this._maybeRotateWeather();
    const level = this.currentLevel();
    if (level === this._lastLevel) return;
    this._lastLevel = level;
    const bytes = overallLightLevel(level);
    for (const m of this.world.mobiles.values()) {
      if (m.client?.sendCosmetic) m.client.sendCosmetic(bytes, 'world-light');
      else if (m.client) m.client.send(bytes);
    }
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
    // Roll: 60 % Dry, 20 % Rain, 12 % Snow, 5 % fierce storm,
    // 3 % storm brewing. Wire kind 3 is not a heatwave.
    const r = Math.random();
    let kind = 0xFE, intensity = 0, temperature = 0;
    if      (r < 0.60) { kind = 0xFE; intensity = 0; }
    else if (r < 0.80) { kind = 0x00; intensity = 30 + Math.floor(Math.random() * 40); temperature = 8; }
    else if (r < 0.92) { kind = 0x02; intensity = 30 + Math.floor(Math.random() * 30); temperature = -12; }
    else if (r < 0.97) { kind = 0x01; intensity = 50 + Math.floor(Math.random() * 30); temperature = 5; }
    else               { kind = 0x03; intensity = 35; temperature = 3; }
    this.weatherKind = kind;
    this.weatherIntensity = intensity;
    this.weatherTemperature = temperature;
    if (typeof this._broadcastWeather === 'function') {
      try { this._broadcastWeather(kind, intensity, temperature); }
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
      weatherTemperature: this.weatherTemperature,
      nextWeatherAt: this._nextWeatherAt ?? 0,
      forcedLevel: Number.isFinite(this._forcedLevel) ? this._forcedLevel : null,
    };
  }
  deserialize(state) {
    if (!state || typeof state !== 'object') return;
    if (Number.isFinite(state.startedAt)) this._startedAt = state.startedAt;
    if (Number.isFinite(state.season)) this.season = state.season;
    if (Number.isFinite(state.weatherKind)) this.weatherKind = state.weatherKind;
    if (Number.isFinite(state.weatherIntensity)) this.weatherIntensity = state.weatherIntensity;
    if (Number.isFinite(state.weatherTemperature)) this.weatherTemperature = state.weatherTemperature;
    if (Number.isFinite(state.nextWeatherAt)) this._nextWeatherAt = state.nextWeatherAt;
    if (Number.isFinite(state.forcedLevel)) this._forcedLevel = Math.max(0, Math.min(30, state.forcedLevel | 0));
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
