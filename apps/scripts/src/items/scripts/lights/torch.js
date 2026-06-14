// Torch — toggles between the items.json-declared "unlit" graphic and
// the canonical lit-torch graphic (0x0A12). Equipping puts it in hand,
// unequipping snuffs the flame so the player doesn't carry a magical
// glowing wand around in their pack.
//
// BUGFIX #48 (FAZA CF): the previous implementation hard-coded the toggle
// pair as 0x0A25 ↔ 0x0A12 — but 0x0A25 is the LIT LANTERN graphic, not
// an unlit torch (real UO art id 0x0F6B / 3947 is the unlit torch we
// declare in items.json). On first use the torch flipped to the wrong
// art, and the items.json default was lost forever. Now we capture the
// original id on first use and toggle against it.

import { broadcastItemUpdate, pushPersonalLight, resolveWearerLight } from '../_shared/broadcast.js';

const TORCH_LIT_ID = 0x0A12;

export default function buildTorchScript(api) {
  const lightDecay = api.systems?.lightDecay;
  const snuff = (item) => {
    item._lit = false;
    item.itemId = item._unlitId ?? 0x0F6B;
    try { broadcastItemUpdate(api, api.world, item); } catch { /* advisory */ }
    // Burnout timer fired — kill the wearer's halo too.
    const li = resolveWearerLight(api.world, item);
    if (li) pushPersonalLight(api, li.wearer, 0);
  };
  return {
    name: 'torch',
    onUse(world, item, user) {
      // Capture the natural unlit graphic on first use so subsequent
      // toggles return to the correct items.json default. _unlitId is
      // persisted via ITEM_EXT_KEYS by the persistence whitelist —
      // FAZA CF adds it there so server restarts don't lose the round
      // trip.
      item._unlitId ??= item.itemId === TORCH_LIT_ID ? 0x0F6B : item.itemId;
      const goingLit = !item._lit;
      item._lit = goingLit;
      item.itemId = goingLit ? TORCH_LIT_ID : item._unlitId;
      user?.client?.sendSystemMessage?.(
        goingLit ? 'You light the torch.' : 'You snuff the torch.',
      );
      // Burn-out timer — torches burn ~1h before snuffing themselves.
      if (goingLit) lightDecay?.arm?.(item.serial, item, lightDecay?.BURN_TIMES?.torch ?? 3_600_000, snuff);
      else          lightDecay?.disarm?.(item.serial);
      broadcastItemUpdate(api, world, item);
      // Personal light halo — push 0x4E to the wearer so the screen
      // brightens around them. Was: client stayed dungeon-dark with a
      // lit torch in hand (user report 2026-05-18).
      const li = resolveWearerLight(world, item);
      if (li) pushPersonalLight(api, li.wearer, li.level);
      return true;
    },
    onEquip(_w, item, mob) {
      mob?.client?.sendSystemMessage?.('You hold the torch aloft.');
      // If the torch was lit before equipping, push the halo now.
      if (item._lit) pushPersonalLight(api, mob, 9);
    },
    onUnequip(_w, item, mob) {
      // Auto-snuff when unequipped (UO behaviour). Restore to the
      // captured unlit graphic, not a hard-coded constant.
      if (item._lit) {
        item.itemId = item._unlitId ?? 0x0F6B;
        item._lit = false;
        lightDecay?.disarm?.(item.serial);
      }
      // Drop the halo regardless of lit-state — the item left the
      // wearer's hand so they're no longer carrying its light.
      if (mob) pushPersonalLight(api, mob, 0);
    },
    onDestroy(_w, item) {
      lightDecay?.disarm?.(item.serial);
      delete item._lit; delete item._unlitId;
    },
  };
}
