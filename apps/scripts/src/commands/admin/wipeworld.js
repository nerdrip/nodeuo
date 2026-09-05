// `[wipeworld` — full reset of world content.
//
// Goes further than `[deleteworld`: it tears down EVERY non-player
// resident and forgets every "applied" flag so the next `[createworld`
// rebuilds from scratch. Use when:
//   - generated state got corrupt and you want a clean slate
//   - you changed the extracted catalog and need a full reseed
//   - a partial `[createworld` left some stages applied and others not
//
// Removed:
//   - all items NOT parented to a player (decorations, houses, signs,
//     doors, teleporters, moongates, decay-eligible loot, etc.)
//   - all NPC mobiles (anything without `isPlayer`) and their inventory
//   - every spawner's tracked-serial set; definitions stay dormant so the
//     next `[createworld` works without restarting the server
//   - per-facet idempotency flags (`world._<thing>Applied`)
//   - the `world._createWorldDone` population state (set explicitly false)
//
// Survives:
//   - player mobiles + everything they're carrying / wearing
//   - accounts, profiles, save metadata
//
// Forces an immediate save so a crash before the auto-save tick
// doesn't resurrect the wiped content from the last on-disk snapshot.

import { allMobiles, allItems } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
import { destroyMobileBySerial } from '../../_mobiles.js';
import { removeRegisteredWorldContent } from '../../_world-content.js';

const RESET_MARKERS = [
  '_decorationApplied', '_signsApplied', '_doorsApplied',
  // TelGen uses `_telesApplied`; `_teleportersApplied` existed only in the
  // old WipeWorld list and therefore never reset the real marker.
  '_telesApplied', '_teleportersApplied', '_moongatesApplied',
  '_xmlSpawnersApplied', '_treasureChestsApplied',
];

function isPlayerOwned(world, item) {
  let current = item;
  const visited = new Set();
  // Nested bags are not limited to eight levels in the data model.  Follow
  // the complete chain while still protecting against corrupt parent loops.
  while (current?.parent && visited.size < 256) {
    const parentSerial = current.parent >>> 0;
    if (!parentSerial || visited.has(parentSerial)) return false;
    visited.add(parentSerial);
    const parentMobile = mobileBySerial({ world }, parentSerial);
    if (parentMobile?.isPlayer || parentMobile?.client) return true;
    current = itemBySerial({ world }, parentSerial) ?? null;
  }
  return false;
}

function notifyRemoved(api, victims) {
  const packetFor = api.protocol?.removeEntity;
  if (typeof packetFor !== 'function') return 0;
  let packets = 0;
  for (const viewer of allMobiles({ world: api.world })) {
    const state = viewer.client;
    if (!state) continue;
    const visibleItems = state._visibleItems;
    const visibleMobiles = state._visibleMobiles;
    const visibleSerials = new Set([...(visibleItems ?? []), ...(visibleMobiles ?? [])]);
    for (const serial of visibleSerials) {
      const stale = !itemBySerial(api, serial) && !mobileBySerial(api, serial);
      if (!stale && !victims.has(serial)) continue;
      try {
        state.send?.(packetFor(serial));
        packets++;
      } catch { /* a disconnect during a destructive command is harmless */ }
      visibleItems?.delete?.(serial);
      visibleMobiles?.delete?.(serial);
    }
  }
  return packets;
}

function clearGenerationMarkers(world) {
  for (const key of RESET_MARKERS) {
    const marker = world[key];
    if (marker?.clear) marker.clear();
    else delete world[key];
  }
  // `Spawner.tick()` deliberately stops only for the explicit `false`
  // value. Deleting this property made the tick eligible again immediately.
  world._createWorldDone = false;
  world._createWorldVersion = 0;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'wipeworld',
    help: '[wipeworld — clear every world item, NPC and live spawn. Player characters + possessions survive.',
    access: 'Admin',
    run(ctx) {
      const world = api.world;
      ctx.state.sendSystemMessage('WipeWorld: tearing down generated content…');

      // Close the generation gate before the first destroy hook runs. This
      // prevents a due spawner / world script from filling the world in the
      // middle of the reset.
      clearGenerationMarkers(world);

      // Tear down script-owned controllers and their deterministic physical
      // landmarks before the fixed-point sweep. This prevents timers from
      // retaining references to items that WipeWorld is about to destroy.
      let seedItemsRemoved = 0;
      try {
        const seeded = removeRegisteredWorldContent(api);
        seedItemsRemoved = seeded.removed ?? 0;
      } catch (e) { api.log?.(`[wipeworld] runtime landmarks: ${e.message}`); }

      // 1) Forget the live occupants but retain definitions. The false
      //    population gate above keeps every group dormant until a complete
      //    `[createworld` succeeds.
      let spawnersReset = 0;
      try {
        if (typeof api.spawner?.resetRuntime === 'function') {
          ({ groupsReset: spawnersReset } = api.spawner.resetRuntime());
        } else if (api.spawner?.groups) {
          spawnersReset = api.spawner.groups.size;
          for (const group of api.spawner.groups.values()) {
            group.spawnedSerials?.clear?.();
            group.nextSpawnAt = Number.MAX_SAFE_INTEGER;
          }
        }
      } catch (e) { api.log?.(`[wipeworld] spawner clear: ${e.message}`); }

      // Stateful systems keep serials outside the World maps. Drop those
      // references as well or a restock timer can recreate old content after
      // CreateWorld reopens the population gate.
      let runtimeSystemsReset = 0;
      let housesReset = 0;
      try {
        // Sigils are logical singleton records rather than World entities.
        // Clear them explicitly so the next `[createworld` rebuilds all five
        // instead of incorrectly reporting them as already present.
        runtimeSystemsReset += api.systems?.sigils?.resetSigils?.()?.removed ?? 0;
        runtimeSystemsReset += api.systems?.camps?.reset?.()?.campsRemoved ?? 0;
        for (const spawn of api.systems?.miniChampion?.listMiniChamps?.() ?? []) {
          spawn.stop?.();
          runtimeSystemsReset++;
        }
        housesReset = api.houses?.reset?.() ?? 0;
        api.systems?.maginciaBazaar?.deserializeStalls?.([]);
        api.systems?.bulletinBoard?.deserializeBoards?.({ nextPostSerial: 1, boards: [] });
        api.systems?.itemHistory?.clearAll?.();
      } catch (e) { api.log?.(`[wipeworld] runtime systems: ${e.message}`); }

      // 2) Kill every NPC mobile (anything without `isPlayer`). Their
      //    worn / contained items go with them via destroyMobile, so we
      //    don't need a second sweep over `world.items` for backpack
      //    contents.
      let mobsKilled = 0;
      let itemsRemoved = seedItemsRemoved;
      const removedSerials = new Set();

      // Destroy hooks are allowed to create follow-up entities. Sweep to a
      // fixed point so a corpse, replacement creature or scripted residue
      // created during teardown cannot survive this command.
      for (let pass = 0; pass < 8; pass++) {
        const mobVictims = [];
        for (const mobile of allMobiles({ world })) {
          if (mobile.isPlayer || mobile.client) continue;
          mobVictims.push(mobile.serial >>> 0);
        }
        const itemVictims = [];
        for (const item of allItems({ world })) {
          if (isPlayerOwned(world, item)) continue;
          itemVictims.push(item.serial >>> 0);
        }
        if (mobVictims.length === 0 && itemVictims.length === 0) break;

        for (const serial of mobVictims) {
          try {
            if (mobileBySerial(api, serial)) {
              destroyMobileBySerial(api, serial);
              mobsKilled++;
              removedSerials.add(serial);
            }
          } catch (e) { api.log?.(`[wipeworld] mob ${serial.toString(16)}: ${e.message}`); }
        }
        for (const serial of itemVictims) {
          try {
            if (itemBySerial(api, serial)) {
              destroyItemBySerial(api, serial);
              itemsRemoved++;
              removedSerials.add(serial);
            }
          } catch (e) { api.log?.(`[wipeworld] item ${serial.toString(16)}: ${e.message}`); }
        }
      }

      // 3) The fixed-point pass above removed every non-player-owned item.
      // Rebuild every spatial accelerator from the authoritative Maps. This
      // also eliminates stale teleporter/door/sector entries left by older
      // saves or scripts that bypassed the normal destruction facade.
      try { world.enableSpatialIndexes?.(); }
      catch (e) { api.log?.(`[wipeworld] spatial rebuild: ${e.message}`); }
      try { api.systems?.playerVendor?.rebuildVendorIndex?.(world); }
      catch (e) { api.log?.(`[wipeworld] vendor index rebuild: ${e.message}`); }

      // Remove already-rendered entities before the positional refresh. A
      // plain Map deletion is invisible to both the classic 0x1D protocol
      // cache and our browser client's scene graph.
      const removalPackets = notifyRemoved(api, removedSerials);

      // 5) Snap every connected player back to a safe town tile so they
      //    aren't left standing on a now-deleted teleporter / decoration.
      //    Trinsic Gate: 54 statics, walls + roofs verified column-major.
      const SAFE = { x: 1825, y: 2728, z: 0, map: 1 };
      const protocol = api.protocol;
      for (const m of allMobiles({ world })) {
        if (!m.client) continue;
        try {
          const teleported = api.game?.mobile?.teleport?.(m, SAFE, {
            state: m.client,
            refresh: m.client,
          });
          if (!teleported) {
            m.x = SAFE.x; m.y = SAFE.y; m.z = SAFE.z; m.map = SAFE.map;
            world.sectors?.moveMobile?.(m);
          }
          // Sector-index rebind — without this the server's neighbour
          // lookup keeps returning the OLD position's sector, so move
          // acks from the client (now positioned at SAFE) fail every
          // 3 s with "Movement desync — resyncing." and admin chat
          // commands (`[where`, `[set`, etc.) get dispatched against
          // the wrong region until next reload. Mirrors the same call
          // every other teleport path (recall, gate, GM tp) makes.
          if (!teleported && protocol?.mobileUpdate) {
            m.client.send(protocol.mobileUpdate({
              serial: m.serial, body: m.body, hue: m.hue ?? 0, flags: m.flags ?? 0,
              x: m.x, y: m.y, z: m.z, direction: m.direction ?? 0,
            }));
          }
          // Re-stream nearby content through the resync helper so the
          // viewport doesn't stay empty after the wipe.
          if (!teleported) api.ctx?.handlers?.refreshSurroundings?.(m.client);
        } catch (e) { api.log?.(`[wipeworld] respawn ${m.name}: ${e.message}`); }
      }

      const remainingNpcs = [...allMobiles({ world })]
        .filter((mobile) => !mobile.isPlayer && !mobile.client).length;
      const remainingWorldItems = [...allItems({ world })]
        .filter((item) => !isPlayerOwned(world, item)).length;

      // 6) Force an immediate save so a crash before the next auto-save
      //    tick doesn't resurrect the wiped content.
      try {
        const r = api.persistence?.requestSave?.(world, api.persistence.saveDir);
        if (r?.then) {
          r.then(({ bytes, ms }) => {
            ctx.state.sendSystemMessage(`  Saved: ${(bytes/1024)|0} KB in ${ms} ms`);
          }).catch((e) => api.log?.(`[wipeworld] save: ${e.message}`));
        }
      } catch (e) { api.log?.(`[wipeworld] save trigger: ${e.message}`); }
      try {
        const r = api.persistence?.requestAuxiliarySave?.('wipeworld');
        if (r?.then) r.catch((e) => api.log?.(`[wipeworld] auxiliary save: ${e.message}`));
      } catch (e) { api.log?.(`[wipeworld] auxiliary save trigger: ${e.message}`); }

      ctx.state.sendSystemMessage(
        `WipeWorld done. -${itemsRemoved} items, -${mobsKilled} mobs, ` +
        `${spawnersReset} spawner groups/${runtimeSystemsReset} runtime systems/` +
        `${housesReset} houses reset; ` +
        `residual world=${remainingWorldItems} items/${remainingNpcs} mobs, ` +
        `client removals=${removalPackets}.`,
      );
    },
  });

  return () => api.commands.unregister?.('wipeworld');
}
