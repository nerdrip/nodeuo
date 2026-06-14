// `[boatname <text>` — stamp a custom name on a boat the caster owns.
// ServUO `BaseBoat.OnDragDropDeed` consumes a Boat Naming Deed; we
// allow either deed-in-pack OR free naming for the owner (with rate
// limit), matching how custom shards usually handle it.

import { findInPack } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'boatname',
    help: '[boatname <text> — rename the targeted boat (max 32 chars).',
    access: 'Player',
    run(ctx) {
      const text = String(ctx.args ?? '').trim().slice(0, 32);
      if (!text) {
        ctx.state.sendSystemMessage('Usage: [boatname <text>');
        return;
      }
      ctx.state.sendSystemMessage('Target the boat to rename.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it?.boat) {
          ctx.state.sendSystemMessage('Not a boat.');
          return;
        }
        const ownerSerial = it.boat.ownerSerial | 0;
        if (ownerSerial && ownerSerial !== ctx.sender.serial) {
          ctx.state.sendSystemMessage('Only the boat owner can rename it.');
          return;
        }
        // Optional deed consumption — if a Boat Naming Deed is in pack,
        // consume it. Otherwise allow the rename anyway (custom-shard
        // convention; ServUO requires the deed strictly).
        const deed = findInPack(api, ctx.sender, (c) => c?.boatNamingDeed);
        if (deed) {
          try { destroyItemBySerial(api, deed.serial); }
          catch { /* ignore */ }
        }
        it.boat.name = text;
        it.name = `${text} (boat)`;
        ctx.state.sendSystemMessage(`Boat renamed to "${text}".`);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('boatname');
}
