// Teleporter / moongate item-script.
//
// ServUO `Teleporter.cs` is a static decoration with a hidden trigger:
// stepping onto its tile sends the mobile to `PointDest` on `MapDest`.
// We mirror that with a lifecycle script that reads `item.teleportTo`
// and applies the move on `onWalkOn`. Used for dungeon entrances,
// public moongates, and quest-driven shortcut tiles.
//
// Item shape:
//   item.script = 'teleporter'
//   item.teleportTo = { x, y, z, map }     destination
//   item.creatures = false                  (default true) — admin can
//                                          set false to gate humans only
//   item.message = "You step through the moongate."  (optional)
//
// FAZA AUDIT: extended to mirror ServUO `Teleporter.cs` knobs:
//   item.requireKarma = number              minimum karma to use
//   item.requireFame  = number              minimum fame
//   item.requireLevel = number              minimum mobile level
//   item.requireItemId = number             must carry an item with this id
//   item.cooldownMs    = number             per-mobile lockout (default 1500)
//   item.pairSerial    = number             paired teleporter (two-way)
//
// The cooldown stops the bouncing-back-and-forth loop you'd otherwise
// see when both ends of a pair re-trigger the second walk-on event.

import { mobileUpdate, mobileMoving, extMapChange } from '@uo/protocol';
import { findInPack } from '../../../_inventory.js';
import { moveMobile } from '../../../_movement.js';
import { nearbyClients } from '../../../_spatial.js';

const DEFAULT_COOLDOWN_MS = 1500;
const recentArrival = new WeakMap();   // mob → { itemSerial, until }

function* clientsNear(world, center, range = 18, self = null) {
  yield* nearbyClients({ world, game: world?._scriptGame, query: world?._scriptQuery }, center, self, range);
}

export default function buildTeleporterScript() {
  return {
    name: 'teleporter',
    onWalkOn(world, item, mob) {
      if (!mob || !item.teleportTo) return;
      // Cooldown guard: if this mob just arrived from the paired
      // teleporter (or from any teleporter within the cooldown window),
      // ignore the event — otherwise the destination's own onWalkOn
      // would bounce us back.
      const now = Date.now();
      const prev = recentArrival.get(mob);
      if (prev && prev.until > now) {
        // Same item triggering again within cooldown? Definite re-bounce.
        // Different item? Still suppress to give the destination's
        // onWalkOn time to settle the mob.
        return;
      }
      // Optional creature filter — many UO teleporters refuse pets/
      // monsters (e.g. moongates, dungeon entrance shortcuts).
      if (item.creatures === false && !mob.client) return;
      // Conditional gates.
      if (typeof item.requireKarma === 'number' && (mob.karma ?? 0) < item.requireKarma) {
        mob.client?.sendSystemMessage?.('A force prevents you from passing.');
        return;
      }
      if (typeof item.requireFame === 'number' && (mob.fame ?? 0) < item.requireFame) {
        mob.client?.sendSystemMessage?.('You are not yet renowned enough to pass.');
        return;
      }
      if (typeof item.requireLevel === 'number' && (mob.level ?? 0) < item.requireLevel) {
        mob.client?.sendSystemMessage?.('You are not experienced enough to pass.');
        return;
      }
      if (typeof item.requireItemId === 'number') {
        const scriptApi = { world, game: world._scriptGame, query: world._scriptQuery };
        const hasItem = !!findInPack(scriptApi, mob, (it) =>
          (it.itemId | 0) === (item.requireItemId | 0));
        if (!hasItem) {
          mob.client?.sendSystemMessage?.('Something is required to pass through here.');
          return;
        }
      }
      const dest = item.teleportTo;
      const prevMap = mob.map;
      moveMobile({ world, game: world._scriptGame, ops: world._scriptOps }, mob, {
        x: dest.x, y: dest.y, z: dest.z, map: typeof dest.map === 'number' ? dest.map : mob.map,
      });
      // Cross-facet teleport: tell the client to flip facets via 0xBF 0x08.
      // The client tile-renderer destroys its chunk visuals on `facet:changed`
      // and re-streams the destination map's bins. Without this, players
      // arrived at the right (x, y) but the wrong terrain rendered.
      const facetChanged = mob.client && mob.map !== prevMap;
      if (facetChanged) {
        try { mob.client.send(extMapChange(mob.map)); } catch { /* ignore */ }
      }
      // Stamp arrival to suppress the destination's onWalkOn re-trigger
      // for `cooldownMs` ms.
      recentArrival.set(mob, {
        itemSerial: item.serial,
        until: now + (item.cooldownMs ?? DEFAULT_COOLDOWN_MS),
      });
      // Notify the mobile's own client.
      if (mob.client) {
        mob.client.send(mobileUpdate({
          serial: mob.serial, body: mob.body,
          hue: mob.hue ?? 0, flags: mob.flags ?? 0,
          x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction ?? 0,
        }));
        if (item.message) mob.client.sendSystemMessage?.(item.message);
      }
      // Tell observers at the destination the mob just arrived.
      const moving = mobileMoving({
        serial: mob.serial, body: mob.body,
        x: mob.x, y: mob.y, z: mob.z,
        direction: mob.direction ?? 0, hue: mob.hue ?? 0,
        flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
      });
      for (const m of clientsNear(world, mob, 18, mob)) {
        m.client.send(moving);
      }
    },
  };
}
