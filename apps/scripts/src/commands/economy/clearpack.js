import { descendantsOf, findBackpack } from '../../_inventory.js';
import { mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
// `[clearpack` — admin tool. Empties the target mobile's backpack
// (drops every contained item from the world). Targeted via the
// standard 0x6C cursor; pick a mobile or your own avatar to wipe
// THEIR pack.
//
// Use cases:
//   - test-character cleanup ("I just want a fresh empty pack")
//   - moderation: confiscate stolen / contraband loot from a player
//   - QA reset before reproducing a bug that involves item state
//
// Equipped items (worn on layers 1..29) are LEFT ALONE — only the
// backpack contents (recursive: nested containers + their contents)
// get destroyed. Player keeps their armor/weapon/clothing.
//
// Persistence: the deletion is applied to `world.items` immediately;
// the next auto-save records the empty pack. There is no undo.

export default function register(api) {
  if (!api.commands || !api.items || !api.world) return () => {};

  api.commands.register({
    name: 'clearpack',
    help: '[clearpack — target a mobile to empty its backpack (worn items survive). Use [clearpack me to clear your own.',
    access: 'Admin',
    run(ctx, args) {
      const sender = ctx.sender;
      // Shortcut: `[clearpack me` skips the cursor and clears self.
      if (args[0]?.toLowerCase() === 'me') {
        const r = clearMobBackpack(api, sender);
        ctx.state.sendSystemMessage(`Cleared own backpack — destroyed ${r.removed} item(s).`);
        return;
      }
      // Otherwise solicit target. `targeting.request` is the primitive
      // 0x6C cursor; we want kind=0 (object/entity).
      const req = api.ctx?.handlers?.targeting?.request ?? api.targeting?.request;
      if (!req) {
        ctx.state.sendSystemMessage('Targeting unavailable on this shard.');
        return;
      }
      ctx.state.sendSystemMessage('Target a mobile to clear their backpack. Right-click to cancel.');
      req(ctx.state, (picked) => {
        if (!picked) {
          ctx.state.sendSystemMessage('Clearpack cancelled.');
          return;
        }
        const targetSerial = (picked.serial >>> 0);
        const target = mobileBySerial(api, targetSerial);
        if (!target) {
          ctx.state.sendSystemMessage('Pick must be a mobile.');
          return;
        }
        const r = clearMobBackpack(api, target);
        ctx.state.sendSystemMessage(
          `Cleared ${target.name ?? '0x' + targetSerial.toString(16)}'s backpack — destroyed ${r.removed} item(s).`,
        );
        if (target.client) {
          target.client.sendSystemMessage?.('An admin has cleared your backpack.');
        }
        api.log?.(`[clearpack] ${sender.name} cleared 0x${targetSerial.toString(16)} (${r.removed} items)`);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister?.('clearpack');
}

/**
 * Find the backpack on `mob` (worn item at layer 21) then recursively
 * destroy every item parented to it. Returns `{ removed }` count.
 */
function clearMobBackpack(api, mob) {
  const pack = findBackpack(api, mob);
  if (!pack) return { removed: 0 };
  const victims = new Set([...descendantsOf(api, pack)].map((it) => it.serial));
  // Destroy in reverse dependency order — leaf items first (children
  // before their containers) so destroyItem never sees a parent
  // that's already gone.
  const list = [...victims].sort((a, b) => b - a);
  let removed = 0;
  for (const s of list) {
    try {
      destroyItemBySerial(api, s);
      removed++;
    } catch (e) {
      api.log?.(`[clearpack] destroyItem 0x${s.toString(16)}: ${e.message}`);
    }
  }
  return { removed };
}
