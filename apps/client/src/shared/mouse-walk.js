import { TILE_HALF_W } from './iso.js';

/** Hysteretic walk/run selection for held-RMB movement. The wider enter
 * threshold and narrower exit threshold prevent cadence flapping when the
 * cursor hovers around the run boundary. */
export function resolveMouseRunState(distanceSq, wasRunning = false, shift = false) {
  // Keep a useful walking band around the avatar. The old ~59 px run
  // threshold was inside the character sprite on a scaled UI, so normal RMB
  // steering was practically always classified as running. Far cursor = run;
  // Shift remains the explicit immediate-run override.
  const enter = TILE_HALF_W * 4.5;
  const exit = TILE_HALF_W * 3.5;
  let autoRun = !!wasRunning;
  if (autoRun) {
    if (distanceSq < exit * exit) autoRun = false;
  } else if (distanceSq > enter * enter) {
    autoRun = true;
  }
  return { autoRun, run: !!shift || autoRun };
}
