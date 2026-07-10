import { worldToScreenX, worldToScreenY } from './iso.js';

/**
 * Derive the visible lifetime of a graphic effect.
 *
 * Fixed effects use the protocol's 50 ms duration units. Moving effects in
 * ClassicUO are distance/speed driven and ignore that duration for travel;
 * treating duration as flight time makes common arrows take several seconds.
 */
export function effectLifetimeMs(info = {}) {
  if (Number.isFinite(info.lifetime) && info.lifetime > 0) return info.lifetime;
  if ((info.type | 0) !== 0) {
    return Math.max(200, (info.duration | 0) * 50);
  }

  const sx = Number(info.sx) || 0;
  const sy = Number(info.sy) || 0;
  const sz = Number(info.sz) || 0;
  const tx = Number(info.tx) || 0;
  const ty = Number(info.ty) || 0;
  const tz = Number(info.tz) || 0;
  const dx = worldToScreenX(tx, ty) - worldToScreenX(sx, sy);
  const dy = worldToScreenY(tx, ty, tz) - worldToScreenY(sx, sy, sz);
  const distancePx = Math.hypot(dx, dy);
  const speed = Math.max(1, info.speed | 0);
  const pixelsPerSecond = (speed + 1) * 100;
  return Math.max(100, Math.min(10_000, (distancePx / pixelsPerSecond) * 1000));
}
