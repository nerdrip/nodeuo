import { allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { demolishMultiWithDeed } from './placemulti.js';
import { openHouseManagement, syncRegistryHouseToMulti } from './multi-house-bridge.js';

// These ServUO helper classes are represented by command verbs, the house
// registry transaction and the 0xD8 custom-house packet handler below rather
// than one JS class per target/gump/packet.
export const SERVUO_HOUSE_MANAGEMENT_CLASSES = [
  'HouseKickTarget', 'HouseBanTarget', 'HouseAccessTarget', 'CoOwnerTarget',
  'HouseFriendTarget', 'HouseOwnerTarget', 'ConfirmCommitGump',
  'DesignStateGeneral', 'DesignStateDetailed', 'HouseTeleporterTypeGump',
];

function selectedHouse(api, state, mob, requestedId = null) {
  if (requestedId != null) {
    const id = Number(requestedId) | 0;
    const requested = api.houses.get?.(id);
    // An id sent by the rich gump is accepted only for the house that this
    // connection actually opened. This makes destructive actions precise
    // without allowing arbitrary remote `[house remove <id>` calls.
    if (!requested || requested.map !== (mob.map ?? 1) || (state?._activeHouseId | 0) !== id) return null;
    return requested;
  }
  const underfoot = api.houses.houseAt(mob.x, mob.y, mob.map);
  if (underfoot) return underfoot;
  const active = api.houses.get?.(state?._activeHouseId);
  if (!active || active.map !== (mob.map ?? 1)) return null;
  const sx = active.sign?.x ?? active.x1;
  const sy = active.sign?.y ?? active.y1;
  return Math.max(Math.abs((mob.x | 0) - sx), Math.abs((mob.y | 0) - sy)) <= 4 ? active : null;
}

// `[house` is the single player-facing housing command. Physical placement
// is intentionally deed/multi-driven; this command manages an existing home.
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
// exposed via api.houses (PHASE M part 2 will wire the lockdown ACL
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
    help: '[house [gump|customize|info|lock|release|friend|coowner|ban|secure|transfer|remove]',
    access: 'Player',
    run(ctx) {
      let sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (!sub) sub = 'gump';

      // Houses are physical multis placed through deeds/the GM multi browser.
      if (sub === 'place') {
        ctx.state.sendSystemMessage('Use a house deed to place a canonical house foundation.');
        return;
      }

      if (sub === 'remove') {
        const requestedId = ctx.args[1] == null ? null : ctx.args[1];
        const house = selectedHouse(api, ctx.state, mob, requestedId);
        if (!house) { ctx.state.sendSystemMessage('Open the house sign while standing nearby, then try again.'); return; }
        if (api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may remove a house.');
          return;
        }
        const looseItems = [...(house.spawnedItems ?? []), ...(house.customItemSerials ?? [])];
        const demolition = demolishMultiWithDeed(api, ctx.state, mob, {
          multiId: house.multiId,
          facet: house.map,
          instanceId: house.multiInstance,
          name: `deed to ${house.sign?.title ?? `house #${house.id}`}`,
          extraSerials: looseItems,
        });
        if (!demolition.ok) {
          const reason = demolition.reason === 'no-backpack'
            ? 'you need a backpack to receive the placement deed'
            : demolition.reason === 'structure-missing'
              ? 'the registered structure could not be found'
              : demolition.reason === 'deed-create-failed'
                ? 'the placement deed could not be prepared'
                : `${demolition.failed?.length ?? 0} house parts could not be removed`;
          ctx.state.sendSystemMessage(`Demolition stopped: ${reason}. No placement deed was returned; you may retry safely.`);
          return;
        }
        api.houses.remove(house.id);
        ctx.state._activeHouseId = null;
        ctx.state.sendSystemMessage(
          `House #${house.id} demolished. ${demolition.removed} parts were removed and its placement deed is in your backpack.`,
        );
        return;
      }

      if (sub === 'info') {
        const house = selectedHouse(api, ctx.state, mob);
        if (!house) { ctx.state.sendSystemMessage('You are not inside a house.'); return; }
        ctx.state.sendSystemMessage(
          `House #${house.id} owner=${house.ownerName} (${house.x1},${house.y1})-(${house.x2},${house.y2}) ` +
          `lockdowns=${house.lockdowns.size} friends=${house.friends.size} bans=${house.bans.size}`,
        );
        return;
      }

      if (sub === 'gump') {
        const house = selectedHouse(api, ctx.state, mob);
        if (!house) { ctx.state.sendSystemMessage('You are not inside a house.'); return; }
        if (!openHouseManagement(api, ctx.state, mob, house)) {
          ctx.state.sendSystemMessage(`House #${house.id}: owner ${house.ownerName}, access ${api.houses.roleOf(house, mob.serial)}.`);
        }
        return;
      }

      if (sub === 'customize' || sub === 'design') {
        const house = selectedHouse(api, ctx.state, mob);
        if (!house) { ctx.state.sendSystemMessage('Stand by your house sign first.'); return; }
        if (api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may customize this house.'); return;
        }
        if (!house.customizable) {
          ctx.state.sendSystemMessage('This is a classic house. Only customizable foundations can enter design mode.'); return;
        }
        if (!api.houses.beginEditing(house, mob)) {
          ctx.state.sendSystemMessage('Could not start house customization.'); return;
        }
        ctx.state._activeHouseId = house.id;
        const serial = house.multiSerial ?? house.id;
        const packet = api.protocol?.extHouseCustomization?.({
          serial, type: 4, x: -1, y: -1, z: -1,
        });
        if (packet) ctx.state.send?.(packet);
        else ctx.state.sendSystemMessage('House customization protocol is unavailable.');
        const revision = api.protocol?.extHouseRevision?.({
          serial, revision: house.revision | 0,
        });
        if (revision) ctx.state.send?.(revision);
        return;
      }

      if (sub === 'rename') {
        const house = selectedHouse(api, ctx.state, mob);
        if (!house || api.houses.roleOf(house, mob.serial) !== 'owner') {
          ctx.state.sendSystemMessage('Only the owner may rename this house.'); return;
        }
        const title = ctx.args.slice(1).join(' ').trim().replace(/[|\r\n]/g, ' ').slice(0, 60);
        if (!title) { ctx.state.sendSystemMessage('Usage: [house rename <name>'); return; }
        house.sign = { ...(house.sign ?? {}), title };
        syncRegistryHouseToMulti(api, house);
        ctx.state.sendSystemMessage(`House renamed to "${title}".`);
        return;
      }

      if (sub === 'lock') {
        const house = selectedHouse(api, ctx.state, mob);
        if (!house || !api.houses.canLockDown(house, mob)) {
          ctx.state.sendSystemMessage('You cannot lock anything down here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage('Lock down which item?');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const liveItem = itemBySerial(api, picked.serial >>> 0);
          const role = api.houses.roleOf(house, mob.serial);
          if ((role !== 'owner' && role !== 'coowner')
              || selectedHouse(api, ctx.state, mob) !== house) {
            ctx.state.sendSystemMessage('House access or your location changed; lockdown cancelled.');
            return;
          }
          if (!liveItem || liveItem.parent != null || api.houses.houseAt(liveItem.x, liveItem.y, liveItem.map) !== house) {
            ctx.state.sendSystemMessage('The item must be on the floor inside this house.');
            return;
          }
          if (liveItem._multiInstance != null || liveItem._customHouseId != null) {
            ctx.state.sendSystemMessage('Structural house pieces cannot be locked down.');
            return;
          }
          if (house.lockdowns.has(liveItem.serial >>> 0)) {
            ctx.state.sendSystemMessage('That item is already locked down.');
            return;
          }
          if (!api.houses.canLockDown(house, mob)) {
            ctx.state.sendSystemMessage('This house has reached its lockdown limit.');
            return;
          }
          liveItem._movableBeforeLockdown ??= liveItem.movable !== false;
          liveItem.movable = false;
          liveItem.lockedDown = true;
          liveItem.house = house.id;
          house.lockdowns.add(liveItem.serial >>> 0);
          api.houses.markChanged?.();
          syncRegistryHouseToMulti(api, house);
          ctx.state.sendSystemMessage(`Locked down. (Total: ${house.lockdowns.size})`);
        }, { kind: 0 });
        return;
      }

      if (sub === 'release') {
        const house = selectedHouse(api, ctx.state, mob);
        const releaseRole = house ? api.houses.roleOf(house, mob.serial) : 'visitor';
        if (!house || (releaseRole !== 'owner' && releaseRole !== 'coowner')) {
          ctx.state.sendSystemMessage('You cannot release lockdowns here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage('Release which item?');
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const liveItem = itemBySerial(api, picked.serial >>> 0);
          const role = api.houses.roleOf(house, mob.serial);
          if ((role !== 'owner' && role !== 'coowner')
              || selectedHouse(api, ctx.state, mob) !== house) {
            ctx.state.sendSystemMessage('House access or your location changed; release cancelled.');
            return;
          }
          if (!liveItem || !house.lockdowns.has(liveItem.serial >>> 0)) {
            ctx.state.sendSystemMessage('That item is not locked down by this house.');
            return;
          }
          if (house.secures?.has?.(liveItem.serial >>> 0)) {
            ctx.state.sendSystemMessage('Unsecure that container before releasing it.');
            return;
          }
          house.lockdowns.delete(liveItem.serial >>> 0);
          liveItem.movable = liveItem._movableBeforeLockdown !== false;
          delete liveItem._movableBeforeLockdown;
          liveItem.lockedDown = false;
          if (liveItem.house === house.id) delete liveItem.house;
          api.houses.markChanged?.();
          syncRegistryHouseToMulti(api, house);
          ctx.state.sendSystemMessage(`Released. (Total: ${house.lockdowns.size})`);
        }, { kind: 0 });
        return;
      }

      if (sub === 'friend' || sub === 'ban' || sub === 'coowner' || sub === 'unfriend' || sub === 'unban' || sub === 'uncoowner') {
        const house = selectedHouse(api, ctx.state, mob);
        const accessRole = house ? api.houses.roleOf(house, mob.serial) : 'visitor';
        const coownerAction = sub === 'coowner' || sub === 'uncoowner';
        if (!house || (accessRole !== 'owner' && (accessRole !== 'coowner' || coownerAction))) {
          ctx.state.sendSystemMessage(coownerAction
            ? 'Only the owner may modify co-owners.'
            : 'Only the owner or a co-owner may modify this access list.');
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
        if (s === (house.ownerSerial >>> 0)) {
          ctx.state.sendSystemMessage('The owner already has full access and cannot be added to an ACL list.');
          return;
        }
        switch (sub) {
          case 'friend':
            house.friends.add(s); house.coowners.delete(s); house.bans.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is now a friend of the house.`);
            break;
          case 'unfriend':
            house.friends.delete(s);
            ctx.state.sendSystemMessage(`${target.name} is no longer a friend.`);
            break;
          case 'coowner':
            house.coowners.add(s); house.friends.delete(s); house.bans.delete(s);
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
        syncRegistryHouseToMulti(api, house);
        return;
      }

      if (sub === 'secure' || sub === 'unsecure') {
        const house = selectedHouse(api, ctx.state, mob);
        // Bug-hunt #7 B2: was checking canLockDown (lockdown cap) instead
        // of canSecure (secure cap). Players could secure unlimited
        // containers up to the lockdown ceiling. ServUO secure ceiling is
        // a separate, much smaller cap (4 on small foundation).
        const secureRole = house ? api.houses.roleOf(house, mob.serial) : 'visitor';
        const mayManage = secureRole === 'owner' || secureRole === 'coowner';
        if (!house || !mayManage) {
          ctx.state.sendSystemMessage('You cannot manage secures here.');
          return;
        }
        if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
        ctx.state.sendSystemMessage(`${sub === 'secure' ? 'Secure' : 'Unsecure'} which container?`);
        api.targeting.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const item = itemBySerial(api, picked.serial);
          const liveRole = api.houses.roleOf(house, mob.serial);
          if ((liveRole !== 'owner' && liveRole !== 'coowner')
              || selectedHouse(api, ctx.state, mob) !== house) {
            ctx.state.sendSystemMessage('House access or your location changed; secure operation cancelled.');
            return;
          }
          if (!item || !item.container || item.parent != null
              || api.houses.houseAt(item.x, item.y, item.map) !== house) {
            ctx.state.sendSystemMessage('Target a container on the floor inside this house.');
            return;
          }
          house.secures ??= new Set();
          if (sub === 'secure') {
            if (house.secures.has(item.serial >>> 0)) {
              ctx.state.sendSystemMessage('That container is already secure.');
              return;
            }
            if (!api.houses.canSecure?.(house, mob)) {
              ctx.state.sendSystemMessage('This house has reached its secure-container limit.');
              return;
            }
            if (!house.lockdowns.has(item.serial >>> 0) && !api.houses.canLockDown(house, mob)) {
              ctx.state.sendSystemMessage('This house has reached its lockdown limit.');
              return;
            }
            house.secures.add(picked.serial >>> 0);
            // ServUO `BaseHouse.AddSecure`: a secure also consumes a
            // lockdown slot. Bug-hunt #7 B2.
            if (!house.lockdowns.has(picked.serial >>> 0)) {
              house.lockdowns.add(picked.serial >>> 0);
              item._secureAddedLockdown = true;
              item._movableBeforeLockdown ??= item.movable !== false;
              item.movable = false;
              item.lockedDown = true;
            }
            item.house = house.id;
            ctx.state.sendSystemMessage(`Secured. (Total: ${house.secures.size})`);
          } else {
            if (!house.secures.delete(picked.serial >>> 0)) {
              ctx.state.sendSystemMessage('That container is not secured by this house.');
              return;
            }
            if (item._secureAddedLockdown) {
              house.lockdowns?.delete?.(picked.serial >>> 0);
              item.movable = item._movableBeforeLockdown !== false;
              delete item._movableBeforeLockdown;
              delete item._secureAddedLockdown;
              item.lockedDown = false;
            }
            if (!house.lockdowns.has(item.serial >>> 0) && item.house === house.id) delete item.house;
            ctx.state.sendSystemMessage(`Unsecured. (Total: ${house.secures.size})`);
          }
          api.houses.markChanged?.();
          syncRegistryHouseToMulti(api, house);
        }, { kind: 0 });
        return;
      }

      if (sub === 'transfer') {
        // `[house transfer <name>` — owner mints a transfer deed for a
        // named recipient. ServUO requires the owner to be standing
        // inside the house; we follow that to make ownership intent
        // unambiguous.
        const house = selectedHouse(api, ctx.state, mob);
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
        const house = selectedHouse(api, ctx.state, mob);
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
        'Usage: [house <gump|customize|rename|remove|info|lock|release|friend|unfriend|coowner|uncoowner|ban|unban|secure|unsecure|transfer|acl>',
      );
    },
  });

  return () => api.commands.unregister('house');
}
