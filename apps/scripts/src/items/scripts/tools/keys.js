import { createItem, destroyItemBySerial } from '../../../_items.js';
import { itemBySerial } from '../../../_entities.js';
// Keys + KeyRing — ServUO `Items/Skill Items/Misc/Key.cs` and
// `Items/Skill Items/Misc/SkeletonKey.cs`.
//
// Three item-scripts in one module:
//
//   • `key`             — a regular bound key. On double-click it
//                          prompts a target; if the target's serial
//                          matches `item.keyValue` (set at item creation
//                          time by the locking entity — usually a
//                          house door, chest, or boat plank) the
//                          target opens. Otherwise nothing happens.
//   • `skeleton-key`    — a single-use universal key. Always unlocks
//                          the targeted lockable on double-click, then
//                          consumes itself. Master skeleton keys
//                          (`item.master`) survive use and have no
//                          breakage roll.
//   • `key-ring`        — a container-like item that swallows the keys
//                          dropped onto it. Double-click prints a menu
//                          listing each held key + an "Add Key" prompt;
//                          single-click a key in the menu unlocks the
//                          targeted lock. Storage is a numeric list on
//                          `item.keys: [{ value, label }]`.

export function buildKeyScript(api) {
  return {
    name: 'key',
    onUse(world, item, user) {
      if (!user?.client) return true;
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target the lock to unlock.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const tgt = itemBySerial({ world }, picked.serial >>> 0);
        if (!tgt) { user.client.sendSystemMessage?.('That is not a lockable.'); return; }
        if ((tgt.lockValue | 0) === 0) {
          user.client.sendSystemMessage?.('That is not locked.');
          return;
        }
        if ((item.keyValue | 0) !== (tgt.lockValue | 0)) {
          user.client.sendSystemMessage?.('This key does not fit.');
          return;
        }
        tgt.locked = false;
        user.client.sendSystemMessage?.('The lock clicks open.');
      });
      return true;
    },
  };
}

export function buildSkeletonKeyScript(api) {
  return {
    name: 'skeleton-key',
    onUse(world, item, user) {
      if (!user?.client) return true;
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target the lock to pick.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const tgt = itemBySerial({ world }, picked.serial >>> 0);
        if (!tgt) { user.client.sendSystemMessage?.('Not lockable.'); return; }
        if (!tgt.locked && (tgt.lockValue | 0) === 0) {
          user.client.sendSystemMessage?.('That is not locked.');
          return;
        }
        tgt.locked = false;
        tgt.lockValue = 0;
        user.client.sendSystemMessage?.('The skeleton key worms into the lock — click!');
        // Single-use unless master variant. ServUO master skeleton key
        // has 75 charges, regular = 1.
        if (item.master) {
          item.charges = Math.max(0, (item.charges | 0 || 75) - 1);
          if (item.charges <= 0) {
            try { destroyItemBySerial(api, item.serial); } catch { /* */ }
          }
        } else {
          try { destroyItemBySerial(api, item.serial); } catch { /* */ }
        }
      });
      return true;
    },
  };
}

export function buildKeyRingScript(api) {
  return {
    name: 'key-ring',
    onUse(world, item, user) {
      if (!user?.client) return true;
      item.keys ??= [];
      if (item.keys.length === 0) {
        user.client.sendSystemMessage?.('The keyring is empty. Drop a key onto it to add.');
        return true;
      }
      // Surface the held keys + offer to unlock with the first match.
      user.client.sendSystemMessage?.(`Keyring (${item.keys.length} keys):`);
      for (let i = 0; i < item.keys.length; i++) {
        const k = item.keys[i];
        user.client.sendSystemMessage?.(`  [${i + 1}] ${k.label ?? 'a key'} (0x${(k.value >>> 0).toString(16)})`);
      }
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target the lock — the ring will try each key.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const tgt = itemBySerial({ world }, picked.serial >>> 0);
        if (!tgt) { user.client.sendSystemMessage?.('Not lockable.'); return; }
        const want = (tgt.lockValue | 0);
        if (want === 0) { user.client.sendSystemMessage?.('That is not locked.'); return; }
        const found = item.keys.find((k) => (k.value | 0) === want);
        if (!found) {
          user.client.sendSystemMessage?.('No key on the ring fits this lock.');
          return;
        }
        tgt.locked = false;
        user.client.sendSystemMessage?.(`The ${found.label ?? 'key'} clicks the lock open.`);
      });
      return true;
    },
    // Drop hook — when a regular key is dropped onto the ring, swallow
    // it into the keys[] array and destroy the source item. The engine
    // calls onDrop with (world, container, droppedItem, dropper).
    onDrop(world, ring, dropped, _dropper) {
      if (!dropped || dropped.kind !== 'key') return false;
      ring.keys ??= [];
      if (ring.keys.length >= 25) {
        _dropper?.client?.sendSystemMessage?.('The keyring is full.');
        return false;
      }
      ring.keys.push({
        value: dropped.keyValue | 0,
        label: dropped.label ?? dropped.name ?? 'a key',
      });
      try { destroyItemBySerial(api, dropped.serial); } catch { /* */ }
      _dropper?.client?.sendSystemMessage?.(`Added a key to the ring (${ring.keys.length}).`);
      return true;
    },
  };
}

// Convenience export used by the item-scripts registry.
export default function buildKeysFamily(api) {
  // Three separate scripts share the module; the registry expects a
  // single default — wire only the regular key. Caller imports the
  // named builders for the other two.
  return buildKeyScript(api);
}

// Stamp a fresh keyValue onto a lockable + return a bound key item.
// Helper used by house deeds,
// boat keys, treasure chests, etc.
export function mintBoundKey(api, lockable, opts = {}) {
  const value = (lockable.lockValue | 0) || (1 + Math.floor(Math.random() * 0xFFFFFF));
  lockable.lockValue = value;
  if (opts.lock !== false) lockable.locked = true;
  return createItem(api, api.world, {
    itemId: opts.itemId ?? 0x1010,    // OSI key.mul graphic
    kind: 'key',
    label: opts.label ?? 'a key',
    parent: opts.parent ?? null,
    keyValue: value,
    script: 'key',
  });
}
