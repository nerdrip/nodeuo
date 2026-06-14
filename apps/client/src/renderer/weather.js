// Weather — particle overlay for rain / snow / storm. Mirrors ClassicUO
// `Game/Weather.cs`. Server tells us via 0x65 SetWeather:
//
//   kind: 0=rain, 1=fierce-storm, 2=snow, 3=storm-approach, 4=storm-brewing,
//         0xFE/0xFF = stop
//   particles: 0..70 (count cap)
//   temperature: -127..+127 (used as ambient hue tint; we approximate)
//
// Implementation choices for browser:
//   - Single Pixi Graphics primitive cleared+drawn per frame (cheap).
//   - Particles live in a typed array {x,y,vx,vy,life}; recycled, no GC.
//   - Mounted on the *UI* (un-transformed) layer so the storm doesn't tilt
//     when the player zooms or pans — looks much better than world-anchored
//     particles in iso projection.
//   - Wind angle oscillates with a sine wave (CUO `windOscill`).

import { Graphics } from 'pixi.js';
import { bus } from '../core/event-bus.js';
import { camera } from './camera.js';

// Audit #32 P1 #4 — CUO `Game/Weather.cs:13-22` canonical enum:
//   WT_RAIN=0, WT_STORM_APPROACH=1, WT_SNOW=2, WT_STORM_BREWING=3
// Earlier we defined 5 values with KIND_FIERCE=1 + KIND_APPROACH=3 +
// KIND_BREWING=4. Result: server code 3 (STORM_BREWING) mapped to our
// rain-storm renderer; snow-storm shards never appeared. Re-key
// canonically. The old KIND_FIERCE alias is kept (=1) for any local
// caller that imports it, but server-emitted values now route right.
const KIND_APPROACH = 1;
const KIND_FIERCE   = 1;   // alias — same visual treatment
const KIND_SNOW     = 2;
const KIND_BREWING  = 3;
const KIND_OFF      = 0xFE;

export function weatherTemperatureTint(temperature = 0) {
  const temp = Math.max(-127, Math.min(127, temperature | 0));
  if (temp === 0) return null;
  const amount = Math.min(1, Math.abs(temp) / 127);
  return {
    color: temp > 0 ? 0xffb060 : 0x80b8ff,
    alpha: 0.025 + amount * 0.075,
  };
}

class Particle {
  constructor() { this.alive = false; this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.life = 0; }
}

export class Weather {
  /** @param {import('pixi.js').Container} parent */
  constructor(parent) {
    this.parent = parent;
    this._gfx = new Graphics();
    this._gfx.eventMode = 'none';
    parent.addChild(this._gfx);
    this._particles = [];
    this._max = 0;
    this._kind = KIND_OFF;
    this._wind = 0;
    this._windPhase = 0;
    this._temp = 0;
    this._lastTick = performance.now();
    this._unsubs = [
      bus.on('atmosphere:weather', (info) => this.set(info)),
      bus.on('frame:tick', (t) => this._tick(t)),
      bus.on('weather:flash', ({ durationMs = 220 } = {}) => {
        this._flashUntil = performance.now() + durationMs;
      }),
    ];
  }

  set({ kind = KIND_OFF, particles = 0, temperature = 0 } = {}) {
    this._kind = kind & 0xff;
    this._max = Math.max(0, Math.min(80, particles | 0));
    this._temp = temperature | 0;
    if (this._kind === KIND_OFF || this._kind === 0xFF || this._max === 0) {
      this._particles.length = 0;
      this._gfx.clear();
      return;
    }
    while (this._particles.length < this._max) this._particles.push(new Particle());
    if (this._particles.length > this._max) this._particles.length = this._max;
  }

  _spawn(p, w, h, originX = 0, originY = 0) {
    p.alive = true;
    p.x = originX + Math.random() * w;
    p.y = originY - 10 - Math.random() * 30;
    // BREWING uses the snow spawn shape (slow drift) per audit #32 P1 #4.
    if (this._kind === KIND_SNOW || this._kind === KIND_BREWING) {
      p.vx = (Math.random() - 0.5) * 30 + this._wind;
      p.vy = 30 + Math.random() * 20;
      p.life = 5 + Math.random();
    } else {
      // Rain / storm — fast falling streaks.
      const base = this._kind === KIND_APPROACH ? 320 : 220;
      p.vx = this._wind * 1.2 + (Math.random() - 0.5) * 20;
      p.vy = base + Math.random() * 80;
      p.life = 1 + Math.random();
    }
  }

  _tick(now) {
    const dt = Math.min(0.1, (now - this._lastTick) / 1000);
    this._lastTick = now;
    if (this._kind === KIND_OFF || this._kind === 0xFF || this._max === 0) return;
    // Constrain to the game viewport rect — Weather mounts on the
    // worldOverlay container which spans the full window, but the
    // user-resizable game area is camera.viewX..viewW. Painting rain
    // across the full window made streaks appear in the dark-blue
    // chrome to the right/below the game viewport (user report
    // 2026-05-19 "burza nie na obszarze gry tylko na całej reszcie").
    const vx = camera.viewX | 0;
    const vy = camera.viewY | 0;
    const w  = Math.max(64, camera.viewW | 0);
    const h  = Math.max(64, camera.viewH | 0);

    this._windPhase += dt * 0.4;
    const targetWind = (this._kind === KIND_FIERCE || this._kind === KIND_APPROACH) ? 90 : 30;
    this._wind = Math.sin(this._windPhase) * targetWind;

    // Lightning flash + thunder SFX — only during a heavy rain / storm.
    // Average gap ~6s with high jitter so it doesn't strobe.  Each flash
    // emits a brief screen-white plus a delayed thunder sample (sound id
    // 0x028 in the canonical UO sound bank), distance modelled by a
    // random delay so it feels environmental, not synced.
    if (this._kind === KIND_APPROACH || this._kind === KIND_FIERCE) {
      this._nextFlashAt ??= now + 4000 + Math.random() * 4000;
      if (now >= this._nextFlashAt) {
        this._nextFlashAt = now + 4500 + Math.random() * 6500;
        bus.emit('weather:flash', { durationMs: 220 });
        const thunderDelay = 250 + (Math.random() * 1800) | 0;
        setTimeout(() => bus.emit('audio:sfx', { sound: 0x0028, x: 0, y: 0, z: 0, ambient: true }),
                   thunderDelay);
      }
    } else {
      this._nextFlashAt = null;
    }

    this._gfx.clear();
    // Audit #32 P1 #4 — STORM_BREWING (CUO 3) shows snow shards with a
    // dim sky tint; STORM_APPROACH (CUO 1) is heavy rain. Treat BREWING
    // as snow-render so the visual matches what the server intended.
    const isSnow = this._kind === KIND_SNOW || this._kind === KIND_BREWING;
    const colour = isSnow ? 0xffffff : 0x6ea0c0;
    const alpha  = this._kind === KIND_BREWING ? 0.45 : 0.7;

    // Temperature tint — 0x65 carries a signed-ish ambient temperature
    // byte. CUO folds this into the scene weather mood; in the browser
    // renderer we apply a very light viewport wash: warm amber for heat,
    // cool blue for cold. Temperature 0 is a strict no-op.
    const tint = weatherTemperatureTint(this._temp);
    if (tint) this._gfx.rect(vx, vy, w, h).fill(tint);

    // Lightning flash overlay — only inside the game viewport.
    if (this._flashUntil && now < this._flashUntil) {
      const t = (this._flashUntil - now) / 220;
      this._gfx.rect(vx, vy, w, h).fill({ color: 0xFFFFFF, alpha: 0.55 * t });
    }

    for (const p of this._particles) {
      if (!p.alive) { this._spawn(p, w, h, vx, vy); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      // Recycle when the particle leaves the viewport rect.
      if (p.life <= 0 || p.y > vy + h + 8
          || p.x < vx - 16 || p.x > vx + w + 16) {
        p.alive = false; continue;
      }
      if (isSnow) {
        this._gfx.rect(p.x, p.y, 2, 2).fill({ color: colour, alpha });
      } else {
        const lx = p.x - p.vx * 0.025;
        const ly = p.y - p.vy * 0.025;
        this._gfx.moveTo(lx, ly).lineTo(p.x, p.y).stroke({ color: colour, width: 1, alpha });
      }
    }
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    try { this._gfx.destroy(); } catch { /* noop */ }
  }
}
