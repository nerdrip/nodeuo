// PHASE CZ — `[teleporter <x> <y> [z] [map]` admin command.
//
// Spawns a teleporter tile at the player's feet that whisks anyone
// stepping on it to the supplied destination. Sister command for
// the moongate flow used by dungeon entrances and public travel.
//
// The actual movement logic lives in `apps/scripts/src/items/scripts/
// world/teleporter.js` (lifecycle onWalkOn). This command is just
// the GM-side spawning helper.

import { nearbyClients } from '../../_spatial.js';
import { createItem } from '../../_items.js';

const TELEPORTER_GUMP_ITEM_ID = 0x1BC3;   // moongate-tile graphic

export default function register(api) {
  if (!api.commands || !api.items) return () => {};
  // Pair-link helper: keeps state across two `[teleporter pair` calls
  // so the second invocation links to the first.
  let pendingPair = null;

  api.commands.register({
    name: 'teleporter',
    help: '[teleporter <x> <y> [z] [map] [graphic] — drop a teleporter tile at your feet.\n[teleporter pair — link two teleporters (call twice).\n[teleporter karma <amt> <x> <y> [z] [map] — gate by karma.',
    access: 'GameMaster',
    run(ctx, args) {
      // Two-way pair: first call records caller's position, second call
      // creates a teleporter at the second position teleporting back to
      // the first AND retroactively configures the first to point at
      // the second.
      if (args[0] === 'pair') {
        if (!pendingPair) {
          pendingPair = {
            x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
          };
          ctx.state.sendSystemMessage('Stand at the SECOND endpoint and run [teleporter pair again.');
          return;
        }
        // Spawn endpoint A → B
        const aItem = createItem(api, api.world, {
          itemId: TELEPORTER_GUMP_ITEM_ID, hue: 0,
          x: pendingPair.x, y: pendingPair.y, z: pendingPair.z, map: pendingPair.map,
          name: 'a moongate', movable: false,
        });
        aItem.script = 'teleporter';
        aItem.teleportTo = { x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map };
        // Spawn endpoint B → A
        const bItem = createItem(api, api.world, {
          itemId: TELEPORTER_GUMP_ITEM_ID, hue: 0,
          x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
          name: 'a moongate', movable: false,
        });
        bItem.script = 'teleporter';
        bItem.teleportTo = pendingPair;
        aItem.pairSerial = bItem.serial;
        bItem.pairSerial = aItem.serial;
        // Broadcast both endpoints to nearby clients.
        for (const it of [aItem, bItem]) {
          const wi = api.protocol?.worldItemSA?.({
            serial: it.serial, itemId: it.itemId, hue: it.hue,
            amount: 1, x: it.x, y: it.y, z: it.z,
          });
          if (wi) for (const m of nearbyClients(api.world, it)) m.client.send(wi);
        }
        ctx.state.sendSystemMessage(
          `Two-way teleporter created: (${pendingPair.x},${pendingPair.y}) ↔ (${ctx.sender.x},${ctx.sender.y}).`,
        );
        pendingPair = null;
        return;
      }
      // Karma-gated variant.
      if (args[0] === 'karma') {
        const minKarma = parseInt(args[1], 10) | 0;
        const tx = parseInt(args[2], 10);
        const ty = parseInt(args[3], 10);
        if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
          ctx.state.sendSystemMessage('Usage: [teleporter karma <amt> <x> <y> [z] [map]');
          return;
        }
        const tz = args[4] != null ? parseInt(args[4], 10) | 0 : ctx.sender.z;
        const tmap = args[5] != null ? parseInt(args[5], 10) | 0 : ctx.sender.map;
        const item = createItem(api, api.world, {
          itemId: TELEPORTER_GUMP_ITEM_ID, hue: 0x44C,        // blue-tinted to hint at the gate
          x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
          name: 'a virtuous moongate', movable: false,
        });
        item.script = 'teleporter';
        item.teleportTo = { x: tx, y: ty, z: tz, map: tmap };
        item.requireKarma = minKarma;
        const wi = api.protocol?.worldItemSA?.({
          serial: item.serial, itemId: item.itemId, hue: item.hue,
          amount: 1, x: item.x, y: item.y, z: item.z,
        });
        if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
        ctx.state.sendSystemMessage(
          `Karma-gated teleporter (≥${minKarma}) → (${tx},${ty},${tz}) on map ${tmap}.`,
        );
        return;
      }
      if ((args?.length ?? 0) < 2) {
        ctx.state.sendSystemMessage('Usage: [teleporter <x> <y> [z] [map] [graphic]');
        return;
      }
      const x = parseInt(args[0], 10);
      const y = parseInt(args[1], 10);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        ctx.state.sendSystemMessage('Invalid x/y coordinates.');
        return;
      }
      const z = args[2] != null ? parseInt(args[2], 10) | 0 : ctx.sender.z;
      const map = args[3] != null ? parseInt(args[3], 10) | 0 : ctx.sender.map;
      // Optional explicit graphic; auto-resolve from housedata teleprts
      // when the caller passes a small category index, or validate against
      // teleprts.txt when they pass a raw graphic id.
      let graphic = TELEPORTER_GUMP_ITEM_ID;
      if (args[4] != null) {
        const requested = parseInt(args[4], 10) | 0;
        if (requested >= 0 && requested < 16 && api.housedata?.raw?.teleprts) {
          const cat = api.housedata.raw.teleprts[requested];
          const piece = cat?.styles?.[0]?.pieces?.[0];
          if (piece) graphic = piece;
        } else if (requested >= 0x100) {
          if (api.housedata?.houseRole?.(requested) === 'teleporter') {
            graphic = requested;
          } else {
            ctx.state.sendSystemMessage(
              `Graphic 0x${requested.toString(16)} is not in teleprts.txt — falling back to moongate.`,
            );
          }
        }
      }
      const item = createItem(api, api.world, {
        itemId: graphic, hue: 0,
        x: ctx.sender.x, y: ctx.sender.y, z: ctx.sender.z, map: ctx.sender.map,
        name: 'a moongate', movable: false,
      });
      item.script = 'teleporter';
      item.teleportTo = { x, y, z, map };
      const wi = api.protocol?.worldItemSA?.({
        serial: item.serial, itemId: item.itemId, hue: item.hue,
        amount: 1, x: item.x, y: item.y, z: item.z,
      });
      if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
      ctx.state.sendSystemMessage(
        `Teleporter linked: (${ctx.sender.x},${ctx.sender.y}) → (${x},${y},${z}) on map ${map}.`,
      );
    },
  });
  return () => api.commands.unregister('teleporter');
}
