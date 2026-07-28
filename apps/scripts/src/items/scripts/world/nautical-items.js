// High Seas item lifecycle adapters. The engine already owns boat movement,
// hull state and cannon ballistics; these scripts make the catalogue items
// actually invoke those systems when double-clicked or used as drop targets.

import { destroyItemBySerial } from '../../../_items.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { findBackpack, isInPack } from '../../../_inventory.js';
import { moveItem } from '../../../_movement.js';
import { nearbyItems, nearbyMobiles } from '../../../_spatial.js';
import { broadcastItemUpdate } from '../_shared/broadcast.js';

const WATER_RANGES = [
  [0x00A8, 0x00AB], [0x0136, 0x0137], [0x5797, 0x579C],
  [0x746E, 0x7485], [0x7490, 0x74AB], [0x74B5, 0x75D5],
];

const PLAN_HULLS = Object.freeze({
  small: 'small', medium: 'medium', large: 'large',
  'galleon-britannian': 'britannian',
  'galleon-tokuno': 'tokuno',
  'galleon-gargish': 'gargish',
  'galleon-orcish': 'orc',
});

function tell(user, text) {
  user?.client?.sendSystemMessage?.(text);
}

function currentBoat(api, world, user, range = 3) {
  const boarded = user?._boardedBoat
    ? itemBySerial({ ...api, world }, user._boardedBoat >>> 0)
    : null;
  if (boarded?.boat) return boarded;
  for (const item of nearbyItems(api?.world ? api : world, user, range)) {
    if (item?.boat) return item;
  }
  return null;
}

function authorisedBoat(api, world, user, range = 3) {
  const boat = currentBoat(api, world, user, range);
  if (!boat) {
    tell(user, 'There is no ship close enough to operate.');
    return null;
  }
  if (api.boats?.hasPilotRights && !api.boats.hasPilotRights(boat, user)) {
    tell(user, 'You do not have the key or ownership rights to that ship.');
    return null;
  }
  return boat;
}

function isWaterTile(api, map, x, y) {
  const tileId = api.landProvider?.landAt?.(map ?? 1, x | 0, y | 0)?.tileId;
  if (!Number.isInteger(tileId)) return true; // Minimal test/dev worlds have no map provider.
  return WATER_RANGES.some(([lo, hi]) => tileId >= lo && tileId <= hi);
}

function isDeepWater(api, map, x, y) {
  return [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]
    .every(([dx, dy]) => isWaterTile(api, map, x + dx, y + dy));
}

function consumeOne(api, world, item) {
  if ((item.amount ?? 1) > 1) {
    item.amount -= 1;
    broadcastItemUpdate(api, world, item);
    return;
  }
  destroyItemBySerial({ ...api, world }, item.serial);
}

export function buildShipPlans(api) {
  function launch(world, item, user, picked) {
    const x = picked?.x ?? user.x;
    const y = picked?.y ?? user.y;
    const z = picked?.z ?? user.z;
    const map = picked?.map ?? user.map ?? 1;
    if (Math.max(Math.abs((user.x | 0) - (x | 0)), Math.abs((user.y | 0) - (y | 0))) > 12) {
      tell(user, 'That launch point is too far away.');
      return;
    }
    if (!isDeepWater(api, map, x, y)) {
      tell(user, 'The ship must be launched in deep water.');
      return;
    }
    const requested = String(item.shipKind ?? 'small').toLowerCase();
    const hullKind = PLAN_HULLS[requested] ?? 'small';
    let boat;
    try {
      boat = api.boats?.placeGalleon?.(api, {
        kind: hullKind, x, y, z, map,
        ownerSerial: user.serial >>> 0,
        name: item.name?.replace(/\s*plans?.*$/i, '').trim() || undefined,
      });
    } catch (error) {
      tell(user, `The ship could not be launched: ${error.message}`);
      return;
    }
    if (!boat?.boat) {
      tell(user, 'The boat system is currently unavailable.');
      return;
    }
    boat.boat.anchored = true;
    broadcastItemUpdate(api, world, boat);
    destroyItemBySerial({ ...api, world }, item.serial);
    tell(user, `${boat.boat.name ?? boat.name ?? 'The ship'} is launched and anchored.`);
  }

  return {
    name: 'ship-plans',
    onUse(world, item, user) {
      if (!isInPack({ ...api, world }, item, user)) {
        tell(user, 'The ship plans must be in your backpack.');
        return true;
      }
      if (!api.targeting?.request || !user?.client) {
        launch(world, item, user, user);
        return true;
      }
      tell(user, 'Choose a deep-water tile where the ship should be launched.');
      api.targeting.request(user.client, (picked) => {
        if (picked) launch(world, item, user, picked);
      }, { range: 12 });
      return true;
    },
  };
}

function buildAnchorLike(name) {
  return (api) => ({
    name,
    onUse(world, _item, user) {
      const boat = authorisedBoat(api, world, user, 4);
      if (!boat) return true;
      const anchored = !!boat.boat.anchored;
      const ok = anchored ? api.boats?.raiseAnchor?.(boat) : api.boats?.dropAnchor?.(boat);
      tell(user, ok === false
        ? 'The anchor mechanism does not respond.'
        : anchored ? 'You raise the anchor.' : 'You drop the anchor.');
      return true;
    },
  });
}

export const buildShipAnchor = buildAnchorLike('ship-anchor');
export const buildMooringPost = buildAnchorLike('mooring-post');

export function buildShipWheel(api) {
  const states = ['stop', 'slow', 'medium', 'full'];
  return {
    name: 'ship-wheel',
    onUse(world, _item, user) {
      const boat = authorisedBoat(api, world, user, 4);
      if (!boat) return true;
      if (boat.boat.anchored) {
        tell(user, 'Raise the anchor before setting sail.');
        return true;
      }
      const current = states.indexOf(boat.boat.sailState ?? 'stop');
      const next = states[(Math.max(0, current) + 1) % states.length];
      const ok = api.boats?.setSailState?.(boat, next);
      tell(user, ok ? `Sail speed set to ${next}.` : 'The wheel does not respond.');
      return true;
    },
  };
}

export function buildBilgePump(api) {
  return {
    name: 'bilge-pump',
    onUse(world, _item, user) {
      const boat = authorisedBoat(api, world, user, 4);
      if (!boat) return true;
      const stats = api.boats?.stats?.(boat);
      if (!stats) return true;
      if (stats.hp >= stats.hpMax) {
        tell(user, 'The bilge is dry and the hull needs no emergency pumping.');
        return true;
      }
      const restored = Math.max(10, Math.ceil(stats.hpMax * 0.05));
      boat.boat.boatHp = Math.min(stats.hpMax, stats.hp + restored);
      boat.boat.wrecked = false;
      tell(user, `You pump out the bilge and stabilize the hull (${boat.boat.boatHp}/${stats.hpMax}).`);
      return true;
    },
  };
}

export function buildCabinDoor(api) {
  return {
    name: 'cabin-door',
    onCreate(_world, item) {
      item.door ??= { isOpen: false };
      item.solid = !item.door.isOpen;
    },
    onUse(world, item, user) {
      if (!authorisedBoat(api, world, user, 5)) return true;
      item.door ??= { isOpen: false };
      item.door.isOpen = !item.door.isOpen;
      item.solid = !item.door.isOpen;
      broadcastItemUpdate(api, world, item);
      tell(user, `You ${item.door.isOpen ? 'open' : 'close'} the cabin door.`);
      return true;
    },
  };
}

function buildNavigationDisplay(name) {
  return (api) => ({
    name,
    onUse(world, item, user) {
      const boat = currentBoat(api, world, user, 8);
      const center = boat ?? item;
      tell(user, `Position: map ${center.map ?? 1}, ${center.x | 0}, ${center.y | 0}, ${center.z | 0}.`);
      const stats = boat && api.boats?.stats?.(boat);
      if (stats) {
        tell(user, `${stats.name}: ${stats.condition}, hull ${stats.hp}/${stats.hpMax}, sails ${stats.sailState}${stats.anchored ? ', anchored' : ''}.`);
      }
      return true;
    },
  });
}

export const buildSeaChart = buildNavigationDisplay('sea-chart');
export const buildShipMapTable = buildNavigationDisplay('ship-map-table');

function buildDocking(name) {
  return (api) => ({
    name,
    onUse(world, _item, user) {
      const boat = authorisedBoat(api, world, user, 8);
      if (!boat) return true;
      const result = api.boats?.dryDockGalleon?.(api, boat, user);
      if (!result?.ok) {
        const reasons = {
          'must-be-anchored': 'Drop the anchor before dry-docking.',
          'riders-aboard': 'Everyone must leave the ship before dry-docking.',
          'not-a-boat': 'That is not a ship.',
        };
        tell(user, reasons[result?.reason] ?? 'The ship cannot be dry-docked here.');
        return true;
      }
      tell(user, 'The ship is dry-docked and its deed is placed in your backpack.');
      return true;
    },
  });
}

export const buildDock = buildDocking('dock');
export const buildDockCrane = buildDocking('dock-crane');

function normalizeCannon(item, user) {
  const previous = item.cannon && typeof item.cannon === 'object' ? item.cannon : {};
  const tier = String(previous.kind ?? previous.tier ?? 'medium').toLowerCase();
  previous.kind = tier === 'light' ? 'light' : tier === 'heavy' || tier === 'carronade' ? 'heavy' : 'medium';
  previous.stage ??= 'empty';
  previous.facing ??= Math.floor(((user?.direction ?? 0) & 7) / 2) & 3;
  previous.powderCharge ??= 0;
  previous.shotKind ??= null;
  previous.lastFiredAt ??= 0;
  item.cannon = previous;
  return previous;
}

function cannonComponent(item) {
  const tag = String(item?.tagId ?? item?.definitionId ?? '').toLowerCase();
  if (tag === 'powder-charge') return { kind: 'powder', charge: 'normal' };
  if (tag === 'powder-charge-strong') return { kind: 'powder', charge: 'heavy' };
  if (tag === 'cannon-ball-heavy') return { kind: 'cannonball-heavy' };
  if (tag === 'cannon-grape') return { kind: 'cannonball-grape' };
  if (tag === 'cannon-chain') return { kind: 'cannonball-chain' };
  if (tag === 'cannon-frost') return { kind: 'cannonball-heavy' };
  if (tag === 'cannon-flame') return { kind: 'cannonball-explosive' };
  if (tag === 'cannon-ball') return { kind: 'cannonball-light' };
  return null;
}

export function buildCannon(api) {
  return {
    name: 'cannon',
    onCreate(_world, item) { normalizeCannon(item); },
    onDrop(world, item, dropped, user) {
      const component = cannonComponent(dropped);
      if (!component) {
        tell(user, 'That is not cannon ammunition or a powder charge.');
        return { handled: true, consumeHeld: false };
      }
      const cannons = api.systems?.cannons;
      const state = normalizeCannon(item, user);
      let result;
      if (component.kind === 'powder') {
        if (state.stage === 'empty') cannons?.loadCannon?.(item, 'swab');
        result = cannons?.loadCannon?.(item, 'powder', { charge: component.charge });
      } else {
        result = cannons?.loadCannon?.(item, component.kind);
        if (result?.ok) cannons?.loadCannon?.(item, 'fuse');
      }
      if (!result?.ok) {
        const reason = String(result?.reason ?? 'wrong loading order').replace(/-/g, ' ');
        tell(user, `The cannon cannot accept that yet (${reason}).`);
        return { handled: true, consumeHeld: false };
      }
      consumeOne(api, world, dropped);
      tell(user, state.stage === 'primed' ? 'The cannon is loaded and primed.' : 'The powder charge is rammed home.');
      return true;
    },
    onUse(world, item, user) {
      const state = normalizeCannon(item, user);
      if (state.stage !== 'primed') {
        tell(user, `Cannon status: ${state.stage}. Drop a powder charge, then shot, onto the cannon.`);
        return true;
      }
      const cannons = api.systems?.cannons;
      const result = cannons?.fireCannon?.(item, {
        applyAOEDamage(impact, damage, radius, source, options = {}) {
          const center = { ...impact, z: item.z };
          for (const mob of nearbyMobiles(api?.world ? api : world, center, null, radius)) {
            api.combat?.damage?.(world, mob, damage, source, { [options.damageType ?? 'physical']: 100 });
          }
          cannons?.applyNavalImpact?.(world, api.boats, impact, damage, radius, options);
        },
      });
      if (!result?.ok) {
        tell(user, result?.reason === 'cooldown' ? 'The cannon is still cooling.' : 'The cannon fails to fire.');
        return true;
      }
      tell(user, `The cannon fires toward ${result.impact.x}, ${result.impact.y}.`);
      return true;
    },
  };
}

function buildFishingTrap(kind) {
  return (api) => {
    function returnToOwner(world, item, owner) {
      const pack = findBackpack({ ...api, world }, owner);
      item.movable = true;
      if (pack) {
        moveItem({ ...api, world }, item, {
          parent: pack.serial,
        });
        item.gridX = 40 + Math.floor(Math.random() * 80);
        item.gridY = 40 + Math.floor(Math.random() * 60);
      }
      item.trap.deployed = false;
      item.trap.readyAt = 0;
      broadcastItemUpdate(api, world, item);
    }

    function finish(world, item) {
      const owner = mobileBySerial({ ...api, world }, item.trap?.ownerSerial >>> 0);
      if (!owner) return false;
      const caught = (api.rng?.() ?? Math.random()) < 0.75;
      if (caught) {
        api.game?.mobile?.giveItem?.(owner, {
          itemId: 0x09CC,
          name: kind === 'lobster' ? 'a lobster' : 'a crab',
          weight: 1,
        }, { randomGrid: true });
        tell(owner, `You empty ${kind === 'lobster' ? 'a lobster' : 'a crab'} from the trap.`);
      } else {
        tell(owner, 'The sea creatures were too quick for the trap this time.');
      }
      returnToOwner(world, item, owner);
      return true;
    }

    function deploy(world, item, user, picked) {
      const x = picked?.x | 0;
      const y = picked?.y | 0;
      const z = picked?.z | 0;
      const map = picked?.map ?? user.map ?? 1;
      if (Math.max(Math.abs((user.x | 0) - x), Math.abs((user.y | 0) - y)) > 6) {
        tell(user, 'You need to be closer to the water.');
        return;
      }
      if (!isDeepWater(api, map, x, y)) {
        tell(user, 'You can only use this trap in deep water.');
        return;
      }
      moveItem({ ...api, world }, item, { parent: null, x, y, z, map });
      item.movable = false;
      item.trap = { kind, ownerSerial: user.serial >>> 0, deployed: true, readyAt: Date.now() + 20_000 };
      world?.syncSpatialItem?.(item);
      broadcastItemUpdate(api, world, item);
      tell(user, 'You plunge the trap into the sea. It will be ready in about 20 seconds.');
    }

    return {
      name: `${kind}-trap`,
      hasTick: true,
      onCreate(_world, item) { item.trap ??= { kind, deployed: false, readyAt: 0 }; },
      onTick(world, item) {
        if (item.trap?.deployed && Date.now() >= (item.trap.readyAt ?? Infinity)) finish(world, item);
      },
      onUse(world, item, user) {
        if (!isInPack({ ...api, world }, item, user)) {
          if ((item.trap?.ownerSerial >>> 0) !== (user.serial >>> 0)) {
            tell(user, 'That trap belongs to someone else.');
            return true;
          }
          if (Date.now() >= (item.trap?.readyAt ?? Infinity)) finish(world, item);
          else {
            returnToOwner(world, item, user);
            tell(user, 'You retrieve the trap before it catches anything.');
          }
          return true;
        }
        if (!api.targeting?.request || !user?.client) {
          deploy(world, item, user, user);
          return true;
        }
        tell(user, 'Where do you wish to use the trap?');
        api.targeting.request(user.client, (picked) => {
          if (picked) deploy(world, item, user, picked);
        }, { range: 6 });
        return true;
      },
    };
  };
}

export const buildLobsterTrap = buildFishingTrap('lobster');
export const buildCrabTrap = buildFishingTrap('crab');
