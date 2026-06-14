import { allMobiles, nearbyClients } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

// `[house` admin/player command — manages housing.
//
//   [house place <w> <h>      Drop a new house centred on the player.
//                              Default size 7x7. Limited to one per player
//                              for now; further claims are rejected.
//   [house remove              Delete the house you're standing inside.
//                              Owner only.
//   [house info                Show ownership + lockdown count for the
//                              house at your feet (or "no house").
//   [house lock                Target an item; lock it down (must be
//                              standing in your own house).
//   [house release             Target an item; release it (owner/co-only).
//   [house friend <name>       Add a friend by player name.
//   [house ban <name>          Ban a player by name.
//
// The HouseRegistry instance is created in main.js bootstrap and
// exposed via api.houses (FAZA M part 2 will wire the lockdown ACL
// into the pickup handler so a non-owner trying to take a locked
// item gets refused).

export default function register(api) {
  if (!api.commands) return () => {};
  if (!api.houses) {
    api.log('commands/house: api.houses not wired yet; skipping');
    return () => {};
  }

  api.commands.register({
    name: 'house',
    help: '[house <place|remove|info|lock|release|friend|ban>',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'place') {
        if (api.houses.housesOf(mob.serial).length > 0) {
          ctx.state.sendSystemMessage('You already own a house.');
          return;
        }
        const w = Math.max(3, Math.min(15, Number(ctx.args[1] ?? 7) | 0));
        const h = Math.max(3, Math.min(15, Number(ctx.args[2] ?? 7) | 0));
        const x1 = mob.x - (w >> 1), y1 = mob.y - (h >> 1);
        const x2 = x1 + w - 1, y2 = y1 + h - 1;
        // Overlap check.
        for (let cx = x1; cx <= x2; cx++) {
          for (let cy = y1; cy <= y2; cy++) {
            if (api.houses.houseAt(cx, cy, mob.map)) {
              ctx.state.sendSystemMessage('That area overlaps an existing house.');
              return;
            }
          }
        }
        const house = api.houses.place(mob, { x1, y1, x2, y2, map: mob.map ?? 1 });

        // Spawn the actual structure as world items so every client sees
        // walls + a wood-plank floor without any client-side change. The
        // items are immovable and tagged `house` so we can sweep them
        // when the house is removed. We send each as a 0xF3 worldItemSA
        // to nearby clients so they appear without a relog.
        //
        // Tile ids follow ServUO `Multis`/`HouseFoundation` defaults:
        //   0x0064  = stone foundation block (used for the perimeter)
        //   0x0496  = wooden floor planks
        //   0x0006  = stone wall N-S
        //   0x0007  = stone wall E-W
        //   0x0021  = wooden door (south wall midpoint)
        const FLOOR  = 0x0496;
        const WALL_NS = 0x0006;
        const WALL_EW = 0x0007;
        const DOOR    = 0x0021;
        house.spawnedItems = [];
        const broadcastSpawn = (item) => {
          house.spawnedItems.push(item.serial);
          const wi = api.protocol?.worldItemSA?.({
            serial: item.serial, itemId: item.itemId, hue: item.hue,
            amount: item.amount, x: item.x, y: item.y, z: item.z,
          });
          // BUGFIX #65 (FAZA CW): visibility-gate. Building a 10×10
          // house can spawn 100+ items; without filter that's 100×N
          // packets to every connected client globally.
          if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
        };
        const z = mob.z | 0;
        // Floor — every tile inside the bounds gets a plank.
        for (let cx = x1; cx <= x2; cx++) {
          for (let cy = y1; cy <= y2; cy++) {
            const it = createItem(api, api.world, {
              itemId: FLOOR, x: cx, y: cy, z, map: mob.map ?? 1,
              name: 'house floor', movable: false,
            });
            it.house = house.id;
            broadcastSpawn(it);
          }
        }
        // Walls — perimeter, with a single door in the south face.
        const doorX = x1 + ((x2 - x1) >> 1);
        for (let cx = x1; cx <= x2; cx++) {
          // North wall.
          const itN = createItem(api, api.world, {
            itemId: WALL_EW, x: cx, y: y1, z, map: mob.map ?? 1,
            name: 'house wall', movable: false,
          });
          itN.house = house.id;
          broadcastSpawn(itN);
          // South wall — substitute door at the centre.
          const isDoor = cx === doorX;
          const itS = createItem(api, api.world, {
            itemId: isDoor ? DOOR : WALL_EW, x: cx, y: y2, z, map: mob.map ?? 1,
            name: isDoor ? 'house door' : 'house wall', movable: false,
          });
          itS.house = house.id;
          broadcastSpawn(itS);
        }
        for (let cy = y1 + 1; cy < y2; cy++) {
          // West wall.
          const itW = createItem(api, api.world, {
            itemId: WALL_NS, x: x1, y: cy, z, map: mob.map ?? 1,
            name: 'house wall', movable: false,
          });
          itW.house = house.id;
          broadcastSpawn(itW);
          // East wall.
          const itE = createItem(api, api.world, {
            itemId: WALL_NS, x: x2, y: cy, z, map: mob.map ?? 1,
            name: 'house wall', movable: false,
          });
          itE.house = house.id;
          broadcastSpawn(itE);
        }

        ctx.state.sendSystemMessage(`House #${house.id} placed (${w}×${h}, ${house.spawnedItems.length} pieces).`);
        return;
      }

      if (sub === 'remove') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage('You are not inside a house.'); return; }
        if (api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may remove a house.');
          return;
        }
        // Despawn every wall / floor / door spawned at place time. We send
        // 0x1D RemoveEntity to nearby clients first so the tiles disappear
        // immediately instead of waiting for a chunk re-stream.
        if (house.spawnedItems?.length) {
          for (const serial of house.spawnedItems) {
            const item = itemBySerial(api, serial);
            if (!item) continue;
            const rm = api.protocol?.removeEntity?.(serial);
            // BUGFIX #65: visibility-gate.
            if (rm) for (const m of nearbyClients(api.world, item)) m.client.send(rm);
            destroyItemBySerial(api, serial);
          }
        }
        api.houses.remove(house.id);
        ctx.state.sendSystemMessage(`House #${house.id} removed.`);
        return;
      }

      if (sub === 'info') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage('You are not inside a house.'); return; }
        ctx.state.sendSystemMessage(
          `House #${house.id} owner=${house.ownerName} (${house.x1},${house.y1})-(${house.x2},${house.y2}) ` +
          `lockdowns=${house.lockdowns.size} friends=${house.friends.size} bans=${house.bans.size}`,
        );
        return;
      }

      if (sub === 'gump') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage('You are not inside a house.'); return; }
        const nameOf = (s) => {
          const m = mobileBySerial(api, s | 0);
          return (m?.name ?? `#${(s | 0).toString(16)}`).replace(/[|;]/g, '_');
        };
        const toCsv = (set) => Array.from(set ?? []).map(nameOf).join(',');
        const cap = api.houses.capsForHouse?.(house)
                 ?? { lockdowns: 0, secures: 0 };
        const payload = [
          house.id,
          house.ownerName.replace(/[|;]/g, '_'),
          `${house.lockdowns.size}/${cap.lockdowns ?? 0}`,
          `${(house.secures?.size ?? 0)}/${cap.secures ?? 0}`,
          toCsv(house.friends),
          toCsv(house.coowners),
          toCsv(house.bans),
        ].join('|');
        ctx.state.sendSystemMessage?.(`@@OPEN_HOUSE_GUMP@@${payload}`);
        return;
      }

      if (sub === 'lock') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house || !api.houses.canLockDown(house, mob)) {
          ctx.state.sendSystemMessage('You cannot lock anything down here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage('Lock down which item?');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          house.lockdowns.add(picked.serial >>> 0);
          ctx.state.sendSystemMessage(`Locked down. (Total: ${house.lockdowns.size})`);
        }, { kind: 0 });
        return;
      }

      if (sub === 'release') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house || !api.houses.canLockDown(house, mob)) {
          ctx.state.sendSystemMessage('You cannot release lockdowns here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage('Release which item?');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          house.lockdowns.delete(picked.serial >>> 0);
          ctx.state.sendSystemMessage(`Released. (Total: ${house.lockdowns.size})`);
        }, { kind: 0 });
        return;
      }

      if (sub === 'friend' || sub === 'ban' || sub === 'coowner' || sub === 'unfriend' || sub === 'unban' || sub === 'uncoowner') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house || api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may modify the access list.');
          return;
        }
        const name = String(ctx.args[1] ?? '').toLowerCase();
        if (!name) { ctx.state.sendSystemMessage(`Usage: [house ${sub} <name>`); return; }
        let target = null;
        for (const m of allMobiles(api)) {
          if ((m.name ?? '').toLowerCase() === name) { target = m; break; }
        }
        if (!target) { ctx.state.sendSystemMessage(`Player "${name}" not found.`); return; }
        const s = target.serial >>> 0;
        switch (sub) {
          case 'friend':
            house.friends.add(s); house.bans.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is now a friend of the house.`);
            break;
          case 'unfriend':
            house.friends.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is no longer a friend.`);
            break;
          case 'coowner':
            house.coowners.add(s); house.friends.add(s); house.bans.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is now a co-owner.`);
            break;
          case 'uncoowner':
            house.coowners.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is no longer a co-owner.`);
            break;
          case 'ban':
            house.bans.add(s);
            house.friends.delete(s); house.coowners.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is now banned from the house.`);
            break;
          case 'unban':
            house.bans.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is no longer banned.`);
            break;
        }
        return;
      }

      if (sub === 'secure' || sub === 'unsecure') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        // Bug-hunt #7 B2: was checking canLockDown (lockdown cap) instead
        // of canSecure (secure cap). Players could secure unlimited
        // containers up to the lockdown ceiling. ServUO secure ceiling is
        // a separate, much smaller cap (4 on small foundation).
        if (!house || !api.houses.canSecure?.(house, mob)) {
          ctx.state.sendSystemMessage('You cannot manage secures here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage(`${sub === 'secure' ? 'Secure' : 'Unsecure'} which container?`);
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const item = itemBySerial(api, picked.serial);
          if (!item || !item.container) {
            ctx.state.sendSystemMessage('That is not a container.');
            return;
          }
          house.secures ??= new Set();
          if (sub === 'secure') {
            house.secures.add(picked.serial >>> 0);
            // ServUO `BaseHouse.AddSecure`: a secure also consumes a
            // lockdown slot. Bug-hunt #7 B2.
            house.lockdowns?.add?.(picked.serial >>> 0);
            item.house = house.id;
            ctx.state.sendSystemMessage(`Secured. (Total: ${house.secures.size})`);
          } else {
            house.secures.delete(picked.serial >>> 0);
            house.lockdowns?.delete?.(picked.serial >>> 0);
            ctx.state.sendSystemMessage(`Unsecured. (Total: ${house.secures.size})`);
          }
        }, { kind: 0 });
        return;
      }

      if (sub === 'transfer') {
        // `[house transfer <name>` — owner mints a transfer deed for a
        // named recipient. ServUO requires the owner to be standing
        // inside the house; we follow that to make ownership intent
        // unambiguous.
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage('You must be inside the house to transfer it.'); return; }
        if (api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may transfer this house.');
          return;
        }
        const name = String(ctx.args[1] ?? '').toLowerCase();
        if (!name) { ctx.state.sendSystemMessage('Usage: [house transfer <name>'); return; }
        let target = null;
        for (const m of allMobiles(api)) {
          if (!m.client) continue;
          if ((m.name ?? '').toLowerCase() === name) { target = m; break; }
        }
        if (!target) { ctx.state.sendSystemMessage(`Player "${name}" must be online to accept a deed.`); return; }
        if (target.serial === mob.serial) { ctx.state.sendSystemMessage('You cannot transfer the house to yourself.'); return; }
        if ((api.houses.housesOf?.(target.serial) ?? []).length > 0) {
          ctx.state.sendSystemMessage(`${target.name} already owns a house.`);
          return;
        }
        // Lazy import so the command stays usable even if the item-
        // scripts module hasn't initialised yet at command-registration
        // time (tests / startup race).
        import('../../items/scripts/tools/house-transfer-deed.js')
          .then(({ mintHouseTransferDeed }) => {
            const deed = mintHouseTransferDeed(api, house, mob, target);
            if (!deed) { ctx.state.sendSystemMessage('Could not mint the deed.'); return; }
            ctx.state.sendSystemMessage(
              `A transfer deed for "${house.sign?.title ?? 'this house'}" has been placed in ${target.name}'s pack. They have 7 days to accept.`,
            );
          })
          .catch(() => ctx.state.sendSystemMessage('Transfer deed module unavailable.'));
        return;
      }

      if (sub === 'acl' || sub === 'access') {
        const house = api.houses.houseAt(mob.x, mob.y, mob.map);
        if (!house) { ctx.state.sendSystemMessage('You are not in a house.'); return; }
        const fmt = (set) => [...set].slice(0, 8).map((s) => `0x${s.toString(16)}`).join(', ') || '(none)';
        ctx.state.sendSystemMessage(`House owner: 0x${(house.ownerSerial >>> 0).toString(16)}`);
        ctx.state.sendSystemMessage(`Co-owners: ${fmt(house.coowners)}`);
        ctx.state.sendSystemMessage(`Friends:   ${fmt(house.friends)}`);
        ctx.state.sendSystemMessage(`Bans:      ${fmt(house.bans)}`);
        ctx.state.sendSystemMessage(`Lockdowns: ${house.lockdowns.size}    Secures: ${house.secures?.size ?? 0}`);
        return;
      }

      ctx.state.sendSystemMessage(
        'Usage: [house <place|remove|info|lock|release|friend|unfriend|coowner|uncoowner|ban|unban|secure|unsecure|transfer|acl>',
      );
    },
  });

  return () => api.commands.unregister('house');
}
