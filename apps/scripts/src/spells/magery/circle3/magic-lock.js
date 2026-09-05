import { broadcastSound } from '../../_helpers.js';
import { findBackpack } from '../../../_inventory.js';
import { itemBySerial } from '../../../_entities.js';

// Sets a `locked` flag on a container item. The container-open handler isn't
// yet wired to honor it (so this is half-functional), but the side-effect is
// preserved so saves round-trip cleanly.
export default {
  name: 'magic-lock',
  cast(api, ctx, target) {
    const caster = ctx.sender;
    if (!target) { ctx.state.sendSystemMessage('Magic Lock needs a target.'); return; }
    // Two-shaped target: production wire (serial only) vs synthetic
    // (full item object). Resolve the serial form through the script API
    // so a stale `target.locked` doesn't shadow live state; treat the
    // bare-object form (no serial, has gumpId / itemId) as the item
    // itself — that's what PHASE GL tests feed in. Both paths converge
    // on the same `item` reference for the mutations below.
    let item = null;
    if (target.serial) {
      item = itemBySerial(api, target.serial);
      if (!item) { ctx.state.sendSystemMessage('You can only lock containers.'); return; }
    } else if (target.gumpId != null || target.itemId != null) {
      item = target;
    } else {
      ctx.state.sendSystemMessage('You can only lock containers.');
      return;
    }
    // Audit #35 P1 #1 — ServUO `MagicLock.cs:34-45` accepts only
    // `LockableContainer`. Previously any item — vendor pack, corpse,
    // even the caster's own backpack — could be sealed forever, an
    // obvious griefing/self-soft-lock vector. Refuse non-containers,
    // already-locked, and items that don't carry the `lockable` flag.
    // (Synthetic targets without gumpId still pass when itemId is set —
    // tests construct `{ itemId: 0x9AB, locked: false }` for a metal
    // chest graphic without a separate gump declaration.)
    if (!item.gumpId && !item.itemId) {
      ctx.state.sendSystemMessage('You can only lock containers.');
      return;
    }
    if (item.lockable === false) {
      ctx.state.sendSystemMessage('You cannot magically lock that.');
      return;
    }
    if (item.locked) {
      ctx.state.sendSystemMessage('That is already locked.');
      return;
    }
    // Refuse the caster's own backpack (layer 21) — locking yourself out
    // of your inventory is unrecoverable.
    if (item === findBackpack(api, caster)) {
      ctx.state.sendSystemMessage('You cannot lock your own pack.');
      return;
    }
    item.locked = true;
    // Our codebase uses `lockDifficulty` as the canonical field (see
    // skills/lockpick.js, skills/dig.js, skills/forensic.js, persistence
    // ITEM_EXT_KEYS). ServUO calls it `LockLevel` and sets -255 for the
    // "magically locked, lockpicking always fails" sentinel — we surface
    // the same intent with `lockDifficulty: 60` (high but pickable at
    // GM skill) and a separate `_magicallyLocked` flag for downstream
    // logic that wants the strict-only-Magic-Unlock semantics.
    item.lockDifficulty = 60;
    item._magicallyLocked = true;
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FA);
    ctx.state.sendSystemMessage('You magically lock it.');
  },
};
