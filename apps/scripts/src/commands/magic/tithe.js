// `[tithe <gold>` — donate gold from your pack at a paladin altar to
// build Tithing Points used by Chivalry abilities. ServUO requires the
// player to be standing at an altar; we relax that to "anywhere" for
// MVP, but flag the donation as needing-altar so a future region check
// can refuse it elsewhere.
//
// 1 gold = 1 tithing point. Cap at 10 000 (ServUO default).
// Chivalry spells cost from `mob.tithingPoints` instead of mana —
// see `cast.js` for the dispatcher hook (PHASE AI part 2).

import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

const TITHE_CAP = 10_000;

function isInPack(world, item, mob) {
  let parent = item?.parent;
  for (let depth = 0; depth < 8 && parent != null; depth++) {
    if (parent === mob.serial) return true;
    parent = itemBySerial({ world }, parent)?.parent;
  }
  return false;
}

function destroyWorldItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  api.commands.register({
    name: 'tithe',
    help: '[tithe <amount> — donate gold for tithing points (max 10,000).',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      // Server parity #9 #9 — must stand within 2 tiles of an altar.
      // Altars carry `_altar: true` or itemId in the canonical 0x1814..
      // 0x1817 range (Britain / Trinsic shrines). GM bypass.
      const isStaff = mob.client?.account?.accessLevel === 'GM'
                   || mob.client?.account?.accessLevel === 'Admin';
      if (!isStaff) {
        const sectors = api.world.sectors;
        const nearAltar = (() => {
          const probe = (it) => {
            if (!it || it.map !== mob.map) return false;
            if (Math.max(Math.abs(it.x - mob.x), Math.abs(it.y - mob.y)) > 2) return false;
            if (it._altar) return true;
            const id = it.itemId | 0;
            return id >= 0x1814 && id <= 0x1817;
          };
          if (sectors?.itemSerialsNear) {
            for (const s of sectors.itemSerialsNear(mob.map, mob.x, mob.y, 2)) {
              if (probe(itemBySerial(api, s))) return true;
            }
            return false;
          }
          for (const it of allItems(api)) if (probe(it)) return true;
          return false;
        })();
        if (!nearAltar) {
          ctx.state.sendSystemMessage('You must stand near a paladin altar to tithe.');
          return;
        }
      }
      const requested = Math.max(1, Number(ctx.args[0] ?? 1) | 0);
      mob.tithingPoints ??= 0;
      const room = TITHE_CAP - mob.tithingPoints;
      if (room <= 0) {
        ctx.state.sendSystemMessage(`Your tithe is already at ${TITHE_CAP}.`);
        return;
      }
      const giving = Math.min(requested, room);

      // Find a gold pile anywhere inside pack containers. This keeps
      // tithing compatible with players who keep gold in sub-bags.
      let pile = null;
      const iter = allItems(api);
      for (const it of iter) {
        if (!isInPack(api.world, it, mob)) continue;
        if (it.itemId !== 0x0EED) continue;
        if ((it.amount | 0) < giving) continue;
        pile = it; break;
      }
      if (!pile) {
        ctx.state.sendSystemMessage('You do not have enough gold in your pack.');
        return;
      }
      pile.amount -= giving;
      if (pile.amount <= 0) {
        destroyWorldItem(api, pile);
        if (mob.client) mob.client.send(api.protocol.removeEntity(pile.serial));
      } else if (mob.client) {
        mob.client.send(api.protocol.containerContentUpdate({
          serial: pile.serial, itemId: pile.itemId, amount: pile.amount,
          hue: pile.hue ?? 0, gridX: 0, gridY: 0, gridLocation: 0,
        }, pile.parent ?? mob.serial));
      }
      mob.tithingPoints += giving;
      ctx.state.sendSystemMessage(
        `Tithed ${giving}. Tithing points: ${mob.tithingPoints}/${TITHE_CAP}.`,
      );
    },
  });

  return () => api.commands.unregister('tithe');
}
