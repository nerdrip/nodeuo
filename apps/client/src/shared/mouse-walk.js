/** Hysteretic walk/run selection for held-RMB movement. The wider enter
 * threshold and narrower exit threshold prevent cadence flapping when the
 * cursor hovers around the run boundary. */
export function resolveMouseRunState(distanceSq, wasRunning = false, shift = false) {
  // ClassicUO `GameSceneInputHandler.MoveCharacterByMouseInput` switches to
  // running at a 190 px radius from the viewport/player centre.  Our previous
  // ~99 px threshold made an ordinary steering gesture select Run almost all
  // the time, even though the wire cadence was still correctly throttled.
  // Keep a small hysteresis band around the canonical boundary so hand jitter
  // does not alternate Walk/Run every frame.
  const enter = 190;
  const exit = 170;
  let autoRun = !!wasRunning;
  if (autoRun) {
    if (distanceSq < exit * exit) autoRun = false;
  } else if (distanceSq > enter * enter) {
    autoRun = true;
  }
  return { autoRun, run: !!shift || autoRun };
}
