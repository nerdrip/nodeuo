// Lantern — burning light source with a 10-minute fuel timer. Toggles on
// double-click (lit/unlit), self-extinguishes when the timer runs out.
//
// Like the torch, we capture the unlit art id from items.json so that
// the lit/unlit pair is configurable per template instead of hard-coded.
// Default unlit id is 0x0A22 (the canonical unlit lantern graphic).

import { broadcastItemUpdate, pushPersonalLight, resolveWearerLight } from '../_shared/broadcast.js';

const LANTERN_LIT_ID   = 0x0A25;
const LANTERN_UNLIT_ID = 0x0A22;
const BURN_TIME_MS = 10 * 60_000;
const LANTERN_LIGHT_LEVEL = 11;

export default function buildLanternScript(api) {
  return {
    name: 'lantern',
    hasTick: true,
    onCreate(_w, item) {
      item._burnRemainingMs = BURN_TIME_MS;
      item._unlitId ??= item.itemId === LANTERN_LIT_ID ? LANTERN_UNLIT_ID : item.itemId;
    },
    onTick(world, item, dt) {
      if (!item._lit) return;
      item._burnRemainingMs = (item._burnRemainingMs ?? BURN_TIME_MS) - dt;
      if (item._burnRemainingMs <= 0) {
        item._lit = false;
        item.itemId = item._unlitId ?? LANTERN_UNLIT_ID;
        broadcastItemUpdate(api, world, item);
        const li = resolveWearerLight(world, item);
        if (li) pushPersonalLight(api, li.wearer, 0);
      }
    },
    onUse(world, item) {
      item._unlitId ??= item.itemId === LANTERN_LIT_ID ? LANTERN_UNLIT_ID : item.itemId;
      item._lit = !item._lit;
      item.itemId = item._lit ? LANTERN_LIT_ID : (item._unlitId ?? LANTERN_UNLIT_ID);
      broadcastItemUpdate(api, world, item);
      // Push 0x4E PersonalLight halo to the wearer (if equipped) so
      // the client's light-overlay brightens the area around them.
      // User report 2026-05-18: lantern toggled on but no glow.
      const li = resolveWearerLight(world, item);
      if (li) pushPersonalLight(api, li.wearer, li.level);
      return true;
    },
    onEquip(_w, item, mob) {
      if (item._lit) pushPersonalLight(api, mob, LANTERN_LIGHT_LEVEL);
    },
    onUnequip(_w, item, mob) {
      if (mob) pushPersonalLight(api, mob, 0);
    },
  };
}
