// `[wipeworld` — full reset of generated content.
//
// Goes further than `[deleteworld`: it tears down EVERY non-player
// resident and forgets every "applied" flag so the next `[createworld`
// rebuilds from scratch. Use when:
//   - generated state got corrupt and you want a clean slate
//   - you changed the extracted catalog and need a full reseed
//   - a partial `[createworld` left some stages applied and others not
//
// Removed:
//   - all ground items NOT parented to a player (decorations, signs,
//     doors, teleporters, moongates, decay-eligible loot, etc.)
//   - all NPC mobiles (anything without `isPlayer`) and their inventory
//   - every spawner registration + tracked-serial set
//   - per-facet idempotency flags (`world._<thing>Applied`)
//   - the `world._createWorldDone` hard-block guard
//
// Survives:
//   - player mobiles + everything they're carrying / wearing
//   - houses (use `[housewipe` for those — they're player-built)
//   - accounts, profiles, save metadata
//
// Forces an immediate save so a crash before the auto-save tick
// doesn't resurrect the wiped content from the last on-disk snapshot.

import { moveMobile } from '../../_movement.js';
import { allMobiles, allItems } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
import { destroyMobileBySerial } from '../../_mobiles.js';

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'wipeworld',
    help: '[wipeworld — destroy every NPC + generated item + spawner registration. Players + houses survive.',
    access: 'Admin',
    run(ctx) {
      const world = api.world;
      ctx.state.sendSystemMessage('WipeWorld: tearing down generated content…');

      // 1) Drop every spawner registration so nothing tries to refill
      //    the rectangles we're about to wipe.
      let spawnersRemoved = 0;
      try {
        if (api.spawner?.groups) {
          spawnersRemoved = api.spawner.groups.size;
          api.spawner.groups.clear();
        }
      } catch (e) { api.log?.(`[wipeworld] spawner clear: ${e.message}`); }

      // 2) Kill every NPC mobile (anything without `isPlayer`). Their
      //    worn / contained items go with them via destroyMobile, so we
      //    don't need a second sweep over `world.items` for backpack
      //    contents.
      let mobsKilled = 0;
      const mobVictims = [];
      for (const m of allMobiles({ world })) {
        if (m.isPlayer) continue;
        if (m.client) continue; // belt-and-suspenders: never nuke an attached client
        mobVictims.push(m.serial);
      }
      for (const s of mobVictims) {
        try {
          destroyMobileBySerial(api, s);
          mobsKilled++;
        } catch (e) { api.log?.(`[wipeworld] mob ${s.toString(16)}: ${e.message}`); }
      }

      // 3) Wipe every ground item that isn't owned by a player. Walk the
      //    parent chain — an item nested inside a player's pack is fine,
      //    an item inside an NPC backpack we just killed (or a chest on
      //    the ground) is fair game.
      let itemsRemoved = 0;
      const itemVictims = [];
      const playerOwned = (it) => {
        let cur = it; let hops = 0;
        while (cur && hops++ < 8) {
          if (cur.parent) {
            const pmob = mobileBySerial({ world }, cur.parent);
            if (pmob?.isPlayer) return true;
            cur = itemBySerial({ world }, cur.parent) ?? null;
          } else return false;
        }
        return false;
      };
      for (const it of allItems({ world })) {
        if (playerOwned(it)) continue;
        itemVictims.push(it.serial);
      }
      for (const s of itemVictims) {
        try {
          destroyItemBySerial({ world }, s);
          itemsRemoved++;
        } catch (e) { api.log?.(`[wipeworld] item ${s.toString(16)}: ${e.message}`); }
      }

      // 4) Forget every per-stage idempotency flag so a follow-up
      //    `[createworld` re-runs from a clean slate.
      const FLAGS = [
        '_decorationApplied', '_signsApplied', '_doorsApplied',
        '_teleportersApplied', '_moongatesApplied', '_xmlSpawnersApplied',
        '_createWorldDone',
      ];
      for (const f of FLAGS) {
        try { delete world[f]; } catch { /* readonly key — nothing we can do */ }
      }

      // 5) Snap every connected player back to a safe town tile so they
      //    aren't left standing on a now-deleted teleporter / decoration.
      //    Trinsic Gate: 54 statics, walls + roofs verified column-major.
      const SAFE = { x: 1825, y: 2728, z: 0, map: 1 };
      const protocol = api.protocol;
      for (const m of allMobiles({ world })) {
        if (!m.client) continue;
        try {
          moveMobile(api, m, SAFE);
          // Sector-index rebind — without this the server's neighbour
          // lookup keeps returning the OLD position's sector, so move
          // acks from the client (now positioned at SAFE) fail every
          // 3 s with "Movement desync — resyncing." and admin chat
          // commands (`[where`, `[set`, etc.) get dispatched against
          // the wrong region until next reload. Mirrors the same call
          // every other teleport path (recall, gate, GM tp) makes.
          if (protocol?.mobileUpdate) {
            m.client.send(protocol.mobileUpdate({
              serial: m.serial, body: m.body, hue: m.hue ?? 0, flags: m.flags ?? 0,
              x: m.x, y: m.y, z: m.z, direction: m.direction ?? 0,
            }));
          }
          // Re-stream nearby content through the resync helper so the
          // viewport doesn't stay empty after the wipe.
          api.ctx?.handlers?.refreshSurroundings?.(m.client);
        } catch (e) { api.log?.(`[wipeworld] respawn ${m.name}: ${e.message}`); }
      }

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

      ctx.state.sendSystemMessage(
        `WipeWorld done. -${itemsRemoved} items, -${mobsKilled} mobs, -${spawnersRemoved} spawner groups.`,
      );
    },
  });

  return () => api.commands.unregister?.('wipeworld');
}
