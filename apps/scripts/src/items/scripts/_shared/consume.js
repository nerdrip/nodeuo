import { destroyItemBySerial } from '../../../_items.js';
// Shared helper — single-use consumable cleanup.
//
// BUGFIX #30 (PHASE BN): single-use consumables previously called
// `world.items.delete(item.serial)` directly, which skipped the
// `destroyItem()` lifecycle in apps/server/src/world/items.js — so
// onDestroy hooks never fired for consumed items, and any future
// cleanup added to destroyItem (e.g. equipment-slot bookkeeping)
// would silently leak. consumeOne() centralises the eat / consume
// / single-use path so amount-aware decrement still works AND the
// lifecycle stays consistent.


export function consumeOne(api, world, item, user) {
  if ((item.amount ?? 1) > 1) {
    item.amount -= 1;
    // BUGFIX #86 (PHASE DR): the previous decrement-only path mutated
    // server-side amount but never pushed a containerContentUpdate to
    // the user. The browser pack kept showing the pre-cast count
    // (e.g. "5x fireball scroll" after casting one) until the player
    // re-opened the bag. Same surface bug class as #62 (auto-stack on
    // drop) and #61 (cliloc placeholder) — the wire didn't catch up.
    if (user?.client && api.protocol?.containerContentUpdate) {
      user.client.send(api.protocol.containerContentUpdate({
        serial: item.serial, itemId: item.itemId, amount: item.amount,
        hue: item.hue ?? 0, gridX: 0, gridY: 0, gridLocation: 0,
      }, item.parent ?? user.serial));
    }
    return;
  }
  destroyItemBySerial({ world }, item.serial);
  if (user?.client && api.protocol?.removeEntity) {
    user.client.send(api.protocol.removeEntity(item.serial));
  }
}
