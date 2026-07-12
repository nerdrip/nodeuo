// `[boat` — player-facing boat controls. The hull is represented by a
// regular world item, while planks, tillerman and galleon cannons are
// attached objects managed by apps/server/src/systems/boats.js.
//
// Subcommands:
//   spawn               place a rowboat under your feet (must be on water)
//   board               step onto an adjacent boat — auto-locks position
//   leave               step off the boat
//   forward [n]         move the boat n tiles in your facing direction (default 1)
//   left / right        rotate facing 90°
//   stop                stop continuous sailing
//
// Movement broadcasts a 0xF3 worldItemSA to nearby clients (snap to the
// new tile, no animation in this round). Riders and attached objects move
// with the boat.

import { spawnNPC } from '../../npcs/vendors/_spawn.js';
import { moveItem, moveMobile } from '../../_movement.js';
import { allItems, sendToClientsNear } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';
const BOAT_ITEM = 0x3E94; // classic small-ship sprite
const MAX_RIDER_RANGE = 1;

function isWaterTile(tileId) {
  if (tileId >= 0x00A8 && tileId <= 0x00AB) return true;
  if (tileId >= 0x0136 && tileId <= 0x0137) return true;
  return false;
}
function isWaterStatic(tileId) { return tileId >= 0x1796 && tileId <= 0x17B2; }
function isWaterAt(api, facet, x, y) {
  const land = api.landProvider?.landAt?.(facet, x, y);
  if (land && isWaterTile(land.tileId)) return true;
  const statics = api.landProvider?.staticsAt?.(facet, x, y) ?? [];
  return statics.some((s) => isWaterStatic(s.tileId));
}

const FACING_DELTAS = {
  N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0],
};
const FACING_ROTATE_LEFT  = { N: 'W', W: 'S', S: 'E', E: 'N' };
const FACING_ROTATE_RIGHT = { N: 'E', E: 'S', S: 'W', W: 'N' };

function broadcastWorldItem(api, item) {
  if (!api.protocol?.worldItemSA) return;
  const wi = api.protocol.worldItemSA({
    serial: item.serial, itemId: item.itemId, hue: item.hue,
    amount: 1, x: item.x, y: item.y, z: item.z,
  });
  sendToClientsNear(api, item, wi);
}

function broadcastBoatPos(api, boat) {
  broadcastWorldItem(api, boat);
}

function broadcastBoatAttachments(api, boat) {
  if (!boat?.boat) return;
  for (const serial of [...(boat.boat.planks ?? []), ...(boat.boat.cannons ?? [])]) {
    const item = itemBySerial(api, serial);
    if (item) broadcastWorldItem(api, item);
  }
}

function moveBoatAttachments(api, boat, dx, dy) {
  const moved = api.boats?.moveAttachedObjects?.(boat, dx, dy);
  if (moved != null) return moved;
  let count = 0;
  for (const serial of [...(boat?.boat?.planks ?? []), ...(boat?.boat?.cannons ?? [])]) {
    const item = itemBySerial(api, serial);
    if (!item) continue;
    moveItem(api, item, { x: item.x + dx, y: item.y + dy, z: item.z, map: item.map });
    count++;
  }
  const tiller = boat?.boat?.tillermanSerial ? mobileBySerial(api, boat.boat.tillermanSerial) : null;
  if (tiller) {
    moveMobile(api, tiller, { x: tiller.x + dx, y: tiller.y + dy, z: tiller.z, map: tiller.map });
    broadcastMobilePos(api, tiller);
    count++;
  }
  return count;
}

function broadcastMobilePos(api, mob) {
  if (!api.protocol?.mobileMoving) return;
  const moving = api.protocol.mobileMoving({
    serial: mob.serial, body: mob.body,
    x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue,
    flags: mob.flags, notoriety: mob.notoriety,
  });
  sendToClientsNear(api, mob, moving);
}

function findBoatNear(api, mob, range = MAX_RIDER_RANGE) {
  const found = api.game?.findItemNear?.(mob, (it) => !!it.boat, { range })
    ?? api.query?.findItemNear?.(mob, (it) => !!it.boat, range);
  if (found) return found;
  for (const it of allItems(api)) {
    if (!it.boat) continue;
    if (it.map !== mob.map) continue;
    if (Math.abs(it.x - mob.x) > range) continue;
    if (Math.abs(it.y - mob.y) > range) continue;
    return it;
  }
  return null;
}

function currentBoat(api, mob, range = 3) {
  const boarded = mob?._boardedBoat ? itemBySerial(api, mob._boardedBoat) : null;
  return boarded?.boat ? boarded : findBoatNear(api, mob, range);
}

function showBoatStatus(api, ctx, boat) {
  const stats = api.boats?.stats?.(boat);
  if (!stats) {
    ctx.state.sendSystemMessage('No boat is nearby.');
    return;
  }
  const summary = `${stats.name}: ${stats.hp}/${stats.hpMax} HP (${stats.hpPercent}%), `
    + `armor ${stats.armorPercent}%, condition ${stats.condition}, speed x${stats.speedMultiplier}.`;
  if (!api.gumps?.send) {
    ctx.state.sendSystemMessage(summary);
    return;
  }
  const course = stats.course
    ? `${stats.course.points} point(s), ${stats.course.running ? 'running' : 'stopped'}${stats.course.loop ? ', loop' : ''}`
    : 'not programmed';
  const texts = [
    stats.name,
    `Hull: ${stats.hullKind}    Condition: ${stats.condition}`,
    `Integrity: ${stats.hp} / ${stats.hpMax} (${stats.hpPercent}%)`,
    `Armor: ${stats.armorPercent}%    Effective speed: x${stats.speedMultiplier}`,
    `Sails: ${stats.sailState}    Anchor: ${stats.anchored ? 'down' : 'up'}`,
    `Cannons: ${stats.cannonCount}    Autopilot: ${course}`,
  ];
  const hpWidth = Math.max(0, Math.min(300, Math.round(300 * stats.hp / stats.hpMax)));
  const hpHue = stats.hpPercent <= 25 ? 0x0021 : stats.hpPercent <= 60 ? 0x0030 : 0x0044;
  const layout = [
    'page 0', 'resizepic 0 0 5054 390 210',
    'checkertrans 12 12 366 186',
    'text 25 20 1152 0', 'text 25 52 1152 1', 'text 25 77 1152 2',
    'gumppic 25 104 2053', `gumppic 25 104 2054 hue=${hpHue}`,
    `checkertrans ${25 + hpWidth} 104 ${300 - hpWidth} 14`,
    'text 25 126 1152 3', 'text 25 151 1152 4', 'text 25 176 1152 5',
  ].join(' ');
  api.gumps.send(ctx.state, { x: 90, y: 70, gumpId: 0x424F4154, layout, texts });
}

function toggleNavalRange(api, ctx, boat, off = false) {
  const P = api.protocol;
  const state = ctx.state;
  const capability = P?.NodeUOCapability?.NavalPreview;
  if (!boat?.boat) {
    state.sendSystemMessage('No boat is nearby.');
    return;
  }
  if (!state.supportsNodeUO?.(capability) || !P?.extNodeUONaval) {
    const ranges = (boat.boat.cannons ?? [])
      .map((serial) => P && api.systems?.cannons?.cannonProfile?.(itemBySerial(api, serial)))
      .filter(Boolean)
      .map((c) => `${c.kind}:${c.range}`);
    state.sendSystemMessage(ranges.length
      ? `Cannon ranges (tiles): ${ranges.join(', ')}. Visual lanes require the NodeUO web client.`
      : 'This boat has no mounted cannons.');
    return;
  }
  if (off || state._navalPreviewSerial === (boat.serial >>> 0)) {
    state.send(P.extNodeUONaval({ kind: P.NodeUONavalMessage.HideRange, payload: {} }));
    state._navalPreviewSerial = 0;
    return;
  }
  const cannons = (boat.boat.cannons ?? []).map((serial) => {
    const item = itemBySerial(api, serial);
    const profile = api.systems?.cannons?.cannonProfile?.(item);
    if (!item || !profile) return null;
    return {
      serial: item.serial >>> 0,
      dx: (item.x | 0) - (boat.x | 0),
      dy: (item.y | 0) - (boat.y | 0),
      facing: profile.facing,
      range: profile.range,
      ready: profile.stage === 'primed' && profile.cooldownRemainingMs <= 0,
      kind: profile.kind,
    };
  }).filter(Boolean);
  if (!cannons.length) {
    state.sendSystemMessage('This boat has no mounted cannons.');
    return;
  }
  state.send(P.extNodeUONaval({
    kind: P.NodeUONavalMessage.ShowRange,
    payload: {
      boatSerial: boat.serial >>> 0,
      x: boat.x | 0, y: boat.y | 0, z: boat.z | 0,
      cannons,
      revision: Date.now(),
      expiresAt: Date.now() + 30_000,
    },
  }));
  state._navalPreviewSerial = boat.serial >>> 0;
  state.sendSystemMessage('Naval range preview enabled for 30 seconds. Use [boat range off to hide it.');
}

export default function register(api) {
  if (!api.commands || !api.items || !api.protocol || !api.landProvider) return () => {};

  api.commands.register({
    name: 'boat',
    help: '[boat <status|spawn|board|leave|sail|turn|anchor|autopilot|repair|range>',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'status' || sub === 'stats' || !sub) {
        showBoatStatus(api, ctx, currentBoat(api, mob));
        return;
      }

      if (sub === 'autopilot' || sub === 'course') {
        const boat = currentBoat(api, mob);
        const system = api.systems?.servuoMultis;
        if (!system?.configureBoatCourse) {
          ctx.state.sendSystemMessage('The autopilot system is unavailable.');
          return;
        }
        system.configureBoatCourse(ctx, boat, ctx.args.slice(1));
        return;
      }

      if (sub === 'repair') {
        const boat = currentBoat(api, mob);
        if (api.boats?.hasPilotRights && !api.boats.hasPilotRights(boat, mob)) {
          ctx.state.sendSystemMessage('You lack the right to repair this boat.');
          return;
        }
        const mode = String(ctx.args[1] ?? 'ship').toLowerCase();
        const result = api.systems?.servuoMultis?.repairBoat?.(boat, mode === 'emergency' ? 'emergency' : 'ship');
        ctx.state.sendSystemMessage(result?.ok
          ? `Boat repaired: ${result.hp}/${result.max} HP.`
          : `Cannot repair: ${result?.reason ?? 'repair system unavailable'}.`);
        return;
      }

      if (sub === 'range') {
        toggleNavalRange(api, ctx, currentBoat(api, mob), String(ctx.args[1] ?? '').toLowerCase() === 'off');
        return;
      }

      if (sub === 'spawn') {
        if (!isWaterAt(api, mob.map ?? 1, mob.x, mob.y)) {
          ctx.state.sendSystemMessage('You must be on water to spawn a boat.');
          return;
        }
        // `[boat spawn [hull]` — default rowboat, or a named hull from
        // BOAT_HULLS (small/medium/large/galleon/britannian/tokuno/
        // orc/gargish). Galleon-class hulls use `placeGalleon` which
        // mounts cannons; rowboat + base hulls drop the simple item.
        const hullArg = String(ctx.args[1] ?? '').toLowerCase();
        const GALLEON_HULLS = new Set(['britannian', 'tokuno', 'orc', 'gargish', 'galleon']);
        if (hullArg && GALLEON_HULLS.has(hullArg) && api.boats?.placeGalleon) {
          try {
            const galleon = api.boats.placeGalleon(api, {
              kind: hullArg, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
              facing: 'N', ownerSerial: mob.serial >>> 0,
            });
            // Broadcast spawn to nearby clients.
            broadcastBoatPos(api, galleon);
            broadcastBoatAttachments(api, galleon);
            try {
              const tiller = spawnNPC(api, mob, {
                name: 'a tillerman', body: 0x190, hue: 0x0481,
                notoriety: 7, invulnerable: true,
                keywords: ['forward', 'stop', 'left', 'right', 'unfurl', 'furl'],
                fields: { _tillerman: true },
              });
              api.boats?.setTillerman?.(galleon, tiller);
            } catch (e) {
              api.log?.('boat: tillerman spawn failed: ' + e.message);
            }
            ctx.state.sendSystemMessage(
              `A ${hullArg} galleon takes form upon the waves, cannons primed.`,
            );
          } catch (e) {
            ctx.state.sendSystemMessage(`Cannot spawn that hull: ${e.message}`);
          }
          return;
        }
        // Base hulls (small/medium/large) — share the simple rowboat
        // codepath but read graphic + HP from BOAT_HULLS so the boat
        // sprite reflects the size class.
        const BASE_HULLS = new Set(['small', 'medium', 'large']);
        const hullCfg = BASE_HULLS.has(hullArg)
          ? api.boats?._HULLS?.[hullArg]
          : null;
        const boatItemId = hullCfg?.graphic ?? BOAT_ITEM;
        const boatLabel = hullCfg?.label ?? 'a rowboat';
        const boat = createItem(api, api.world, {
          itemId: boatItemId, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
          name: boatLabel, movable: false,
        });
        boat.boat = {
          facing: 'N', riders: new Set(), planks: [],
          sailState: 'stop', anchored: true,
          ownerSerial: mob.serial >>> 0,
          boatHp: hullCfg?.hpMax ?? 1000, boatHpMax: hullCfg?.hpMax ?? 1000,
          armor: hullCfg?.armor ?? 0.05,
          speedMultiplier: hullCfg?.speedMultiplier ?? 1.15,
          hullKind: hullArg || 'rowboat',
        };
        // FAZA BL: spawn 4 plank items, one per side. Players double-
        // click a plank to board / leave (closer to ServUO BaseBoat
        // semantics — `[boat board` text command stays as fallback).
        // Each plank's `boatPlank` field points back at the boat serial
        // so the use-handler can resolve which boat to mount.
        const PLANK_ITEM = 0x3EAA; // open plank (north-facing)
        for (const [dx, dy, side] of [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']]) {
          const plank = createItem(api, api.world, {
            itemId: PLANK_ITEM, x: mob.x + dx, y: mob.y + dy, z: mob.z,
            map: mob.map, name: 'a plank', movable: false,
          });
          plank.boatPlank = { boatSerial: boat.serial, side };
          boat.boat.planks.push(plank.serial);
          // Spawn-broadcast already filtered.
          if (api.protocol?.worldItemSA) {
            const wi = api.protocol.worldItemSA({
              serial: plank.serial, itemId: plank.itemId, hue: 0,
              amount: 1, x: plank.x, y: plank.y, z: plank.z,
            });
            sendToClientsNear(api, plank, wi);
          }
        }
        broadcastBoatPos(api, boat);
        // ServUO `BaseBoat.cs` spawns a tillerman NPC at the helm. We
        // mint a no-shop invulnerable human anchored to the boat tile
        // and bind it via the existing `api.boats.setTillerman` API.
        // Speech keywords ('forward', 'stop', 'left', 'right') route
        // through the standard boat-cmd path so players can helm by
        // voice instead of typing the chat command.
        try {
          const tiller = spawnNPC(api, mob, {
            name: 'a tillerman',
            body: 0x190, hue: 0x0481,
            notoriety: 7, invulnerable: true,
            keywords: ['forward', 'stop', 'left', 'right', 'unfurl', 'furl'],
            fields: { _tillerman: true },
          });
          api.boats?.setTillerman?.(boat, tiller);
        } catch (e) {
          api.log?.('boat: tillerman spawn failed: ' + e.message);
        }
        ctx.state.sendSystemMessage('A rowboat appears with 4 planks and a tillerman.');
        return;
      }

      if (sub === 'board') {
        const boat = findBoatNear(api, mob);
        if (!boat) { ctx.state.sendSystemMessage('No boat is adjacent.'); return; }
        boat.boat.riders.add(mob.serial >>> 0);
        mob._boardedBoat = boat.serial >>> 0;
        moveMobile(api, mob, { x: boat.x, y: boat.y, z: boat.z, map: boat.map });
        broadcastMobilePos(api, mob);
        ctx.state.sendSystemMessage('You climb aboard the rowboat.');
        return;
      }

      if (sub === 'leave') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        // BUGFIX #6 (FAZA AK): the previous code stripped the rider tag
        // and tried to step toward the nearest non-water tile — but if
        // the boat was anchored mid-ocean, no neighbour was dry, the
        // for-loop fell through with no break, mob.x/y stayed on water,
        // AND the rider tag was already cleared. The player ended up
        // "off the boat" but standing on the water diamond, unable to
        // re-board (findBoatNear matches range 1 — they were ON the
        // boat tile, distance 0, which IS in range 1, so re-board did
        // work; but every step thereafter was a movement-rej because
        // resolveStep refuses water). Solution: PRE-CHECK for any dry
        // adjacent tile. If none, refuse the disembark and keep the
        // rider on the boat with a clear message.
        let stepX = -1, stepY = -1;
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const nx = mob.x + dx, ny = mob.y + dy;
          if (!isWaterAt(api, mob.map ?? 1, nx, ny)) { stepX = nx; stepY = ny; break; }
        }
        if (stepX < 0) {
          ctx.state.sendSystemMessage('There is no shore to step on.');
          return;
        }
        if (boat?.boat) boat.boat.riders.delete(mob.serial >>> 0);
        delete mob._boardedBoat;
        moveMobile(api, mob, { x: stepX, y: stepY, z: mob.z, map: mob.map });
        broadcastMobilePos(api, mob);
        ctx.state.sendSystemMessage('You step off the boat.');
        return;
      }

      if (sub === 'forward') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (!api.boats?.hasPilotRights?.(boat, mob)) {
          ctx.state.sendSystemMessage('You lack the right to pilot this boat.'); return;
        }
        if (boat.boat.anchored || boat.boat.wrecked || (boat.boat.sailsDisabledUntil ?? 0) > Date.now()) {
          ctx.state.sendSystemMessage('The boat cannot move while anchored, wrecked, or its sails are disabled.'); return;
        }
        const n = Math.max(1, Math.min(20, Number(ctx.args[1] ?? 1) | 0));
        const [dx, dy] = FACING_DELTAS[boat.boat.facing];
        let moved = 0;
        for (let i = 0; i < n; i++) {
          const nx = boat.x + dx, ny = boat.y + dy;
          if (!isWaterAt(api, boat.map ?? 1, nx, ny)) break;
          moveItem(api, boat, { x: nx, y: ny, z: boat.z, map: boat.map });
          moveBoatAttachments(api, boat, dx, dy);
          for (const rs of boat.boat.riders) {
            const r = mobileBySerial(api, rs);
            if (r) {
              moveMobile(api, r, { x: nx, y: ny, z: r.z, map: boat.map });
              broadcastMobilePos(api, r);
            }
          }
          moved++;
        }
        broadcastBoatPos(api, boat);
        broadcastBoatAttachments(api, boat);
        ctx.state.sendSystemMessage(`The rowboat sails ${moved} tile${moved === 1 ? '' : 's'} ${boat.boat.facing}.`);
        return;
      }

      if (sub === 'left' || sub === 'right') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (!api.boats?.hasPilotRights?.(boat, mob)) {
          ctx.state.sendSystemMessage('You lack the right to pilot this boat.'); return;
        }
        const table = sub === 'left' ? FACING_ROTATE_LEFT : FACING_ROTATE_RIGHT;
        const facing = table[boat.boat.facing];
        if (api.boats?.setFacing) api.boats.setFacing(boat, facing);
        else boat.boat.facing = facing;
        ctx.state.sendSystemMessage(`The rowboat now faces ${boat.boat.facing}.`);
        return;
      }

      if (sub === 'stop') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (boat?.boat) {
          api.boats?.setSailState?.(boat, 'stop');
          ctx.state.sendSystemMessage('Sails are furled. The boat drifts to a stop.');
        } else {
          ctx.state.sendSystemMessage('You are not on a boat.');
        }
        return;
      }

      // Continuous-sail commands — leverage api.boats tick.
      if (sub === 'sail') {
        const speed = String(ctx.args[1] ?? '').toLowerCase();
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat?.boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (!api.boats) { ctx.state.sendSystemMessage('The sails refuse to respond.'); return; }
        if (!api.boats.hasPilotRights(boat, mob)) {
          ctx.state.sendSystemMessage('You lack the right to pilot this boat.'); return;
        }
        const ok = api.boats.setSailState(boat, speed);
        if (!ok) {
          ctx.state.sendSystemMessage('Speed must be slow / medium / full / stop. Anchored boats cannot sail.');
          return;
        }
        ctx.state.sendSystemMessage(`Sails ${speed}. Heading ${boat.boat.facing}.`);
        return;
      }

      // Anchor controls.
      if (sub === 'anchor') {
        const what = String(ctx.args[1] ?? 'drop').toLowerCase();
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat?.boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (!api.boats) return;
        if (!api.boats.hasPilotRights(boat, mob)) {
          ctx.state.sendSystemMessage('You lack the right to anchor this boat.'); return;
        }
        if (what === 'raise' || what === 'up') {
          api.boats.raiseAnchor(boat);
          ctx.state.sendSystemMessage('Anchor raised.');
        } else {
          api.boats.dropAnchor(boat);
          ctx.state.sendSystemMessage('Anchor dropped.');
        }
        return;
      }

      // Owner / key management.
      if (sub === 'claim') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat?.boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (boat.boat.ownerSerial) {
          ctx.state.sendSystemMessage('This boat already has an owner.'); return;
        }
        boat.boat.ownerSerial = mob.serial >>> 0;
        ctx.state.sendSystemMessage('You now own this boat. Spawn keys with `[boat key`.');
        return;
      }

      if (sub === 'key') {
        const boatSer = mob._boardedBoat;
        const boat = boatSer ? itemBySerial(api, boatSer) : null;
        if (!boat?.boat) { ctx.state.sendSystemMessage('You are not on a boat.'); return; }
        if (boat.boat.ownerSerial !== (mob.serial >>> 0)) {
          ctx.state.sendSystemMessage('Only the owner can mint keys.'); return;
        }
        const key = api.game?.mobile?.giveItem?.(mob, {
          itemId: 0x1010,
          name: 'a boat key',
          hue: 0x44E,
        }, { randomGrid: true });
        if (!key) {
          ctx.state.sendSystemMessage('You have no backpack for the key.');
          return;
        }
        key.boatKey = boat.serial >>> 0;
        boat.boat.keys ??= [];
        // Note: keys list stores key SERIALS, not mobile serials. The
        // hasPilotRights check accepts a key serial (item) or owner mobile.
        boat.boat.keys.push(key.serial >>> 0);
        ctx.state.sendSystemMessage('A key falls into your pack.');
        return;
      }

      ctx.state.sendSystemMessage(
        'Usage: [boat <status|spawn|board|leave|forward|left|right|stop|sail|anchor|autopilot|repair|range|claim|key>',
      );
    },
  });

  // Boat-deed item: double-click → spawns a rowboat under the user.
  // Same plank+rider machinery as `[boat spawn` but ownership is set
  // automatically and the deed is consumed. ServUO equivalent: a
  // BoatDeed with `OnDoubleClick` that calls `Multi.Construct`.
  const deedHook = (world, item, user) => {
    const deed = item.boatDeed;
    if (!deed && item.script !== 'servuo-boat-deed' && item.script !== 'boat-deed') return false;
    if (!isWaterAt(api, user.map ?? 1, user.x, user.y)) {
      user.client?.sendSystemMessage?.('You must be on water to launch a boat.');
      return true;
    }
    const hullKind = String(deed?.hullKind ?? 'small').toLowerCase();
    const hull = api.boats?._HULLS?.[hullKind] ?? api.boats?._HULLS?.small;
    let boat = null;
    if (api.boats?.placeGalleon && hull) {
      try {
        boat = api.boats.placeGalleon(api, {
          kind: hullKind in api.boats._HULLS ? hullKind : 'small',
          x: user.x, y: user.y, z: user.z, map: user.map,
          facing: deed?.facing ?? 'N',
          ownerSerial: user.serial >>> 0,
          name: deed?.name,
        });
      } catch (e) {
        api.log?.(`[boat-deed] placeGalleon failed: ${e.message}`);
      }
    }
    if (!boat) {
      boat = createItem(api, world, {
        itemId: hull?.graphic ?? BOAT_ITEM,
        x: user.x, y: user.y, z: user.z, map: user.map,
        name: deed?.name ?? hull?.label ?? 'a small ship',
        movable: false,
      });
      boat.boat = {
        facing: deed?.facing ?? 'N', riders: new Set(), planks: [],
        sailState: 'stop', anchored: false,
        ownerSerial: user.serial >>> 0,
        keys: [], boatHp: hull?.hpMax ?? 1000, boatHpMax: hull?.hpMax ?? 1000,
        hullKind,
      };
      api.world._boats ||= new Set();
      api.world._boats.add(boat.serial >>> 0);
    }
    boat.boat.anchored = false;
    boat.boat.keys ??= [];
    boat.boat.planks ??= [];
    if (boat.boat.planks.length === 0) {
      const plankSlots = hullKind === 'small'
        ? [[0, -1, 'N'], [0, 1, 'S']]
        : [[0, -1, 'N'], [1, 0, 'E'], [0, 1, 'S'], [-1, 0, 'W']];
      for (const [dx, dy, side] of plankSlots) {
        const plank = createItem(api, world, {
          itemId: 0x3EAA,
          x: boat.x + dx, y: boat.y + dy, z: boat.z,
          map: boat.map, name: 'a plank', movable: false,
        });
        plank.boatPlank = { boatSerial: boat.serial, side };
        plank.servuoClasses = ['PlanksContext'];
        boat.boat.planks.push(plank.serial);
        broadcastBoatPos(api, plank);
      }
    }
    broadcastBoatPos(api, boat);
    destroyItemBySerial(api, item.serial);
    user.client?.sendSystemMessage?.('A boat is launched, and a key falls into your pack.');
    const key = createItem(api, world, {
      itemId: 0x1010, x: user.x, y: user.y, z: user.z, map: user.map,
      name: 'a boat key', container: user.backpack, hue: 0x44E,
    });
    key.boatKey = boat.serial >>> 0;
    boat.boat.keys.push(key.serial >>> 0);
    return true;
  };
  api.templates?.addUseItemHook?.(deedHook);

  // FAZA LA / BUGFIX #140: register a pre-template useItem hook
  // instead of the old `api.templates.useItem = wrapper` monkey-patch
  // (which threw "Cannot assign to read only property 'useItem'" at
  // script init because ES module exports are read-only). The hook
  // chain in templates.js short-circuits when a hook returns truthy.
  const plankHook = (world, item, user) => {
    const plank = item.boatPlank;
    if (!plank) return false;
    const boat = itemBySerial({ world }, plank.boatSerial >>> 0);
    if (!boat?.boat) {
      user.client?.sendSystemMessage?.('That plank leads nowhere.');
      return true;
    }
    const dist = Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y));
    if (dist > 2) {
      user.client?.sendSystemMessage?.('You must stand near the plank.');
      return true;
    }
    const isOnBoat = (user._boardedBoat >>> 0) === (boat.serial >>> 0);
    if (isOnBoat) {
      boat.boat.riders.delete(user.serial >>> 0);
      delete user._boardedBoat;
      const sideDelta = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }[plank.side];
      if (sideDelta) {
        moveMobile(api, user, { x: user.x + sideDelta[0], y: user.y + sideDelta[1], z: user.z, map: user.map });
      }
      broadcastMobilePos(api, user);
      user.client?.sendSystemMessage?.('You step off the boat.');
    } else {
      boat.boat.riders.add(user.serial >>> 0);
      user._boardedBoat = boat.serial >>> 0;
      moveMobile(api, user, { x: boat.x, y: boat.y, z: boat.z, map: boat.map });
      broadcastMobilePos(api, user);
      user.client?.sendSystemMessage?.('You climb the plank onto the boat.');
    }
    return true;
  };
  api.templates?.addUseItemHook?.(plankHook);

  return () => {
    api.commands.unregister('boat');
    // Hook stays registered — no per-script unregister API; reload-
    // cycle is rare enough to accept the leak.
  };
}
