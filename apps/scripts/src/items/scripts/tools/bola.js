import { destroyItemBySerial } from '../../../_items.js';
import { mobileBySerial } from '../../../_entities.js';
import { childrenOf } from '../../../_inventory.js';
// Bola — ServUO `Items/Weapons/Special/Bola.cs`.
//
// A throwable item that dismounts and briefly roots the target. Not the
// same as the "Bola Ball" weapon entry in weapons-extra.js (which is a
// melee-throw weapon for the throwing skill) — the bola item itself is
// a consumable throw with these specific gameplay effects:
//
//   • OnUse → target prompt (must be in range 6, line-of-sight)
//   • Caster must NOT be mounted/flying
//   • Caster must wait 10 s between throws (cooldown)
//   • Target loses mount + is dismounted for 4 s
//   • Target is rooted (`_paralyzedUntil`) for 3 s
//   • Bola is consumed on a successful throw

const COOLDOWN_MS = 10_000;
const cooldown = new WeakMap();

export default function buildBola(api) {
  return {
    name: 'bola',
    onUse(world, item, user) {
      if (!user?.client) return true;
      const now = Date.now();
      const last = cooldown.get(user) ?? 0;
      if (now - last < COOLDOWN_MS) {
        user.client.sendSystemMessage?.('You must wait before throwing another bola.');
        return true;
      }
      // ServUO: caster cannot be mounted or flying.
      if (_isMounted(world, user)) {
        user.client.sendSystemMessage?.('You cannot throw a bola while mounted.');
        return true;
      }
      if (user._gargoyleFlying) {
        user.client.sendSystemMessage?.('You cannot throw a bola while flying.');
        return true;
      }
      if (!api.targeting?.request) return true;
      user.client.sendSystemMessage?.('Target the mounted opponent.');
      api.targeting.request(user.client, (picked) => {
        if (!picked?.serial) return;
        const target = mobileBySerial({ world }, picked.serial >>> 0);
        if (!target || target === user) {
          user.client.sendSystemMessage?.('Bad target.');
          return;
        }
        const dx = Math.abs((target.x | 0) - (user.x | 0));
        const dy = Math.abs((target.y | 0) - (user.y | 0));
        if (Math.max(dx, dy) > 6 || target.map !== user.map) {
          user.client.sendSystemMessage?.('Out of range.');
          return;
        }
        // Throw animation + sound — ServUO uses anim 0x09 (throwing).
        try { api.combat?.animate?.(world, user, 0x09); } catch { /* */ }
        try { api.combat?.playSoundNear?.(world, user, 0x238); } catch { /* */ }

        cooldown.set(user, now);
        // Dismount if target was mounted (layer 25 = mount item).
        let dismounted = false;
        for (const it of childrenOf({ world }, target)) {
          if (it.layer === 25) {
            try { world?._items?.unwear?.(target, it); } catch { /* */ }
            target._dismountedUntil = Date.now() + 4_000;
            dismounted = true;
            break;
          }
        }
        if (target._gargoyleFlying) {
          target._gargoyleFlying = false;
          dismounted = true;
        }
        // Root for 3 s regardless of whether the target was mounted.
        target._paralyzedUntil = Date.now() + 3_000;
        target.client?.sendSystemMessage?.(
          dismounted
            ? 'You are tangled by a bola and thrown from your mount!'
            : 'You are tangled by a bola and rooted in place!',
        );
        user.client.sendSystemMessage?.(`Bola lands on ${target.name ?? 'them'}.`);
        // Consume the bola.
        try { destroyItemBySerial(api, item.serial); } catch { /* */ }
      });
      return true;
    },
  };
}

function _isMounted(world, mob) {
  for (const it of childrenOf({ world }, mob)) {
    if (it.layer === 25) return true;
  }
  return false;
}
