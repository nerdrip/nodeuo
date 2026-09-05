import path from 'node:path';
import { promises as fsp } from 'node:fs';

export function resolveSaveIntervalMs(env = process.env) {
  const explicit = env.UO_SAVE_INTERVAL_MS ?? env.UO_AUTOSAVE_INTERVAL_MS;
  if (explicit != null) {
    const raw = Number(explicit);
    if (!Number.isFinite(raw)) return 180_000;
    if (raw <= 0) return 0;
    return Math.max(30_000, Math.round(raw));
  }
  return 180_000;
}

/** Owns autosave coalescing and serializes auxiliary writers that share
 * fixed temporary paths. The coordinator exposes one lifecycle boundary so
 * shutdown cannot leave a follow-up timer or an overlapping sidecar write. */
export function createSaveCoordinator({
  world, saveDir, houses, dayNight, every,
  requestWorldSave, serializeBazaar, serializeBoards,
  saveBazaar, saveWorldState, env = process.env,
}) {
  let autoSaveRunning = false;
  let autoSaveAgain = false;
  let followupTimer = null;
  let auxiliarySaveTail = Promise.resolve();

  function requestAuxiliarySave(reason = 'manual') {
    const task = auxiliarySaveTail.catch(() => {}).then(async () => {
      const stalls = serializeBazaar();
      const boards = serializeBoards();
      const bbPath = path.join(saveDir, 'bulletin-boards.json');
      const [houseResult] = await Promise.all([
        Promise.resolve({ bytes: 0, format: 'sqlite-meta' }),
        saveBazaar(stalls, saveDir),
        saveWorldState({ dayNight: dayNight.serialize?.() ?? null }, saveDir),
        fsp.mkdir(saveDir, { recursive: true })
          .then(() => fsp.writeFile(bbPath, JSON.stringify(boards), 'utf8')),
      ]);
      return {
        reason,
        houseBytes: houseResult?.bytes ?? 0,
        houses: houses.houses.size,
        stalls: stalls.length,
        boards: boards.boards.length,
      };
    });
    auxiliarySaveTail = task;
    return task;
  }

  async function runAutoSavePass(reason = 'interval') {
    if (autoSaveRunning) {
      autoSaveAgain = true;
      return;
    }
    autoSaveRunning = true;
    try {
      const { bytes, ms } = await requestWorldSave(world, saveDir);
      console.log(`[uo-node] auto-saved (${reason}; mobiles=${world.mobiles.size}, items=${world.items.size}, ${bytes}B, ${ms}ms)`);
    } catch (error) {
      console.error(`[uo-node] auto-save failed: ${error.message}`);
    } finally {
      autoSaveRunning = false;
      if (autoSaveAgain) {
        autoSaveAgain = false;
        clearTimeout(followupTimer);
        followupTimer = setTimeout(() => runAutoSavePass('coalesced'), 1000);
        followupTimer.unref?.();
      }
    }

    try {
      const aux = await requestAuxiliarySave(reason);
      if (aux.houses > 0) {
        console.log(`[uo-node] auto-saved houses (n=${aux.houses}, ${aux.houseBytes}B)`);
      }
    } catch (error) {
      console.error(`[uo-node] auxiliary save failed: ${error.message}`);
    }
  }

  const intervalMs = resolveSaveIntervalMs(env);
  const timer = intervalMs > 0
    ? every('world-save', intervalMs, () => runAutoSavePass())
    : null;
  if (timer) timer.unref?.();
  else console.log('[uo-node] auto-save disabled (UO_SAVE_INTERVAL_MS=0).');

  return {
    intervalMs,
    timer,
    requestAuxiliarySave,
    runAutoSavePass,
    stop() {
      clearTimeout(followupTimer);
      followupTimer = null;
    },
  };
}
