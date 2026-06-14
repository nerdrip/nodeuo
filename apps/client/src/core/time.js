// Global clock. Mirrors ClassicUO's Time class (Game/Time.cs).
// `ticks` is monotonically increasing milliseconds since boot.
// `delta` is seconds since last tick (use for animation/physics).

export const Time = {
  ticks: 0,
  delta: 0,
  _last: 0,
};

export function tickClock(now) {
  if (Time._last === 0) Time._last = now;
  Time.delta = (now - Time._last) / 1000;
  if (Time.delta < 0) Time.delta = 0;
  if (Time.delta > 0.5) Time.delta = 0.5;
  Time.ticks = now;
  Time._last = now;
}
