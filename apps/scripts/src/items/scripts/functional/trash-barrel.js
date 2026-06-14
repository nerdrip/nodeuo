// Trash Barrel — ServUO `Items/Misc/TrashBarrel.cs`. Drop unwanted
// loot in; the barrel converts to Cleanup Britannia points credited
// against the dropper's account, then destroys the item. Periodic
// auto-empty (60s) clears anything that lingers.
//
// Hooked via `containers.js` registration → `script: 'trash-barrel'`.

import { destroyItemBySerial } from '../../../_items.js';
import { childrenOf } from '../../../_inventory.js';
import { itemBySerial } from '../../../_entities.js';
import { allMobiles } from '../../../_spatial.js';

const EMPTY_DELAY_MS = 3 * 60_000;

function registerTrashCommands(api) {
  const register = api.lifecycle?.command?.bind(api.lifecycle) ?? api.commands?.register?.bind(api.commands);
  if (!register || !api.commands) return;
  register({
    name: 'trash',
    help: '[trash appraise <itemSerial> — appraise Clean Up Britannia turn-in points.',
    access: 'Player',
    run(ctx, args) {
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub !== 'appraise') {
        ctx.state.sendSystemMessage?.('Usage: [trash appraise <itemSerial>');
        return;
      }
      const serial = (/^0x/i.test(args?.[1] ?? '') ? parseInt(args[1], 16) : parseInt(args?.[1], 10)) >>> 0;
      if (!serial) {
        ctx.state.sendSystemMessage?.('Usage: [trash appraise <itemSerial>');
        return;
      }
      const item = itemBySerial(api, serial);
      if (!item) {
        ctx.state.sendSystemMessage?.('No such item.');
        return;
      }
      const pts = api.systems?.cleanup?.pointsFor?.(item) ?? 0;
      if (pts > 0) ctx.state.sendSystemMessage?.(`${item.name ?? 'That item'} is worth about ${pts} Clean Up Britannia point(s).`);
      else ctx.state.sendSystemMessage?.('This item has no turn-in value for Clean Up Britannia.');
    },
  });
}

export default function buildTrashBarrel(api) {
  registerTrashCommands(api);
  return {
    name: 'trash-barrel',
    hasTick: true,
    onCreate(_world, barrel) {
      barrel.emptyAt ??= 0;
      barrel.container = true;
      barrel.gumpId ||= 0x003E;
      barrel.servuoClasses ??= ['TrashBarrel', 'BaseTrash', 'CleanupArray', 'AppraiseforCleanup', 'EmptyTimer'];
    },
    onUse(_world, barrel, user) {
      const state = user?.client;
      if (!state) return true;
      state.sendSystemMessage?.('Drop unwanted items here, or use [trash appraise <item> to check Clean Up Britannia value.');
      const remaining = Math.max(0, (barrel.emptyAt ?? 0) - Date.now());
      if (remaining > 0) state.sendSystemMessage?.(`The trash will empty in ${Math.ceil(remaining / 1000)} second(s).`);
      return true;
    },
    // Server parity #5 — turn-in flow. Drop hooks into Cleanup Britannia
    // and credits the dropper's account points proportional to the item.
    onDrop(world, barrel, item, droppedBy) {
      if (!item || !droppedBy) return false;
      const acc = droppedBy.client?.account ?? droppedBy.account;
      if (acc) {
        try {
          const pts = api.systems?.cleanup?.turnIn?.(acc, world, item) ?? 0;
          if (pts > 0) {
            droppedBy.client?.sendSystemMessage?.(
              `Thank you for your donation. (+${pts} Cleanup Britannia points)`,
            );
          } else {
            destroyItemBySerial(api, item.serial);
            droppedBy.client?.sendSystemMessage?.('The barrel disposes of that.');
          }
        } catch (e) { console.error('[trash-barrel] turnIn threw:', e); }
      } else {
        try { destroyItemBySerial(api, item.serial); }
        catch { /* gone */ }
      }
      barrel.emptyAt = Date.now() + EMPTY_DELAY_MS;
      return true;     // consumed
    },
    onTick(world, barrel) {
      if (!barrel.emptyAt || Date.now() < barrel.emptyAt) return;
      let removed = 0;
      for (const child of [...childrenOf({ world }, barrel)]) {
        try {
          destroyItemBySerial({ world }, child.serial);
          removed++;
        } catch { /* ignore */ }
      }
      barrel.emptyAt = 0;
      if (removed > 0) {
        for (const m of allMobiles({ ...api, world })) {
          if (!m.client || (m.map | 0) !== (barrel.map | 0)) continue;
          if (Math.max(Math.abs((m.x | 0) - (barrel.x | 0)), Math.abs((m.y | 0) - (barrel.y | 0))) <= 8) {
            m.client.sendSystemMessage?.('The trash barrel empties itself.');
          }
        }
      }
    },
  };
}
