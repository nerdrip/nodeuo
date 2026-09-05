// PHASE DD — peerless altar lifecycle script.
//
// An altar in front of a sealed dungeon door. Dropping the right
// quest keys on it (item names matching `arenaName`'s requiredKeys
// list) triggers the unlock: keys are consumed, the using player
// (and anyone in their party near the altar) is teleported to the
// arena, and the boss is spawned at the arena's spawnAt point.
//
// Item shape:
//   item.script = 'peerless-altar'
//   item.arenaName = 'travesty'    // matches registerArena({ name })
//
// Triggered by [usepeerless on the altar (admin tooling for now —
// production would hook this into double-click via item-scripts'
// onUse). Boss-death cooldown is tracked in
// apps/server/src/systems/bosses/peerless.js.

import { moveMobile } from '../../../_movement.js';
import { mobileBySerial } from '../../../_entities.js';
import { destroyMobileBySerial } from '../../../_mobiles.js';

export default function buildPeerlessAltarScript(api) {
  return {
    name: 'peerless-altar',
    /** Player double-clicks the altar. */
    onUse(world, altar, user) {
      if (!user || !altar?.arenaName) return;
      const peerless = api.systems?.peerless;
      if (!peerless) {
        user.client?.sendSystemMessage?.('The altar is dormant.');
        return;
      }
      if (peerless.isOnCooldown(altar.arenaName)) {
        user.client?.sendSystemMessage?.('The altar still hums with recent power. Wait a while.');
        return;
      }
      const result = peerless.validateUnlock(world, altar);
      if (!result.ok) {
        if (result.reason === 'cooldown') {
          user.client?.sendSystemMessage?.('The altar is on cooldown.');
        } else if (result.reason.startsWith('missing-keys:')) {
          const missing = result.reason.slice('missing-keys:'.length);
          user.client?.sendSystemMessage?.(`The altar requires more offerings: ${missing}`);
        } else {
          user.client?.sendSystemMessage?.('The altar refuses your offering.');
        }
        return;
      }
      const def = result.def;
      const party = api.party?.partyOf?.(user.serial) ?? null;
      const instances = api.systems?.instancedPeerless;
      if (instances && !instances.claim(def.bossKind, party, user)) {
        user.client?.sendSystemMessage?.('Another party is already fighting in this arena.');
        return;
      }
      // Spawn first and consume the offering only after a real mobile exists.
      let boss = null;
      try {
        const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
        if (typeof factory !== 'function') throw new Error('spawn factory unavailable');
        boss = factory(world, def.bossKind, def.spawnAt);
        if (!boss) throw new Error(`unknown or unavailable boss kind: ${def.bossKind}`);
        boss._peerlessArenaName = def.name;
        api.systems?.peerlessBosses?.registerBossInstance?.(world, boss);
      } catch (e) {
        api.log?.(`peerless-altar: boss spawn failed: ${e?.message ?? e}`);
        instances?.release?.(def.bossKind);
        user.client?.sendSystemMessage?.('The altar cannot open the arena right now. Your offerings were preserved.');
        return;
      }
      if (!peerless.commitUnlock(world, result)) {
        destroyMobileBySerial({ ...api, world }, boss.serial);
        instances?.release?.(def.bossKind);
        user.client?.sendSystemMessage?.('The offering changed before the ritual completed. Nothing was consumed.');
        return;
      }
      // Teleport the user (and any nearby party members) into the arena.
      const partyMembers = collectPartyAtAltar(api, world, user, altar);
      for (const m of partyMembers) {
        moveMobile(api, m, def.teleportTo);
        if (m.client && api.protocol?.mobileUpdate) {
          m.client.send(api.protocol.mobileUpdate({
            serial: m.serial, body: m.body, hue: m.hue ?? 0, flags: m.flags ?? 0,
            x: m.x, y: m.y, z: m.z, direction: m.direction ?? 0,
          }));
          m.client.sendSystemMessage?.('The altar pulls you into the arena.');
        }
      }
    },
  };
}

/**
 * Find the user + their party members within 8 tiles of the altar (so
 * we don't yank players who happened to log in across the world).
 * Falls back to just the user when there's no party.
 */
function collectPartyAtAltar(api, world, user, altar) {
  const out = [user];
  const party = api.party?.partyOf?.(user.serial);
  if (!party) return out;
  for (const memberSerial of party.members ?? []) {
    if (memberSerial === user.serial) continue;
    const m = mobileBySerial({ world }, memberSerial);
    if (!m) continue;
    if (m.map !== altar.map) continue;
    if (Math.abs(m.x - altar.x) > 8 || Math.abs(m.y - altar.y) > 8) continue;
    out.push(m);
  }
  return out;
}
