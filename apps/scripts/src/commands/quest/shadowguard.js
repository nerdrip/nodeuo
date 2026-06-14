// `[shadow` — Shadowguard tower (Stygian Abyss endgame dungeon).
//
//   [shadow start <room>   — enter a room (bar|orchard|belfry|armory|fountain|roof)
//   [shadow status         — show party's room progress
//   [shadow clear <room>   — GM force-clear a room (testing)
//   [shadow leave          — abandon current run + restore pre-entry coords
//
// ServUO `Scripts/Services/Shadowguard/`:
//   - 5 rooms, each cleared independently. Roof unlocks when all 5 done.
//   - 30 min per-room timeout; failure = state reset.
//   - On roof clear, drops a Minax shadowguard artifact (one per party).
//
// We layer this on the existing `systems/bosses/shadowguard.js` state tracker.
// The command:
//   - teleports the party into the room's spawn pad
//   - spawns the room's boss via `api.ctx.spawnFactory`
//   - hooks the boss death (via `corpse.addKillHook`) to `clearRoom`
//   - on roof kill rolls a random artifact from the SHADOWGUARD_ARTIFACTS
//     pool and drops it on the boss tile

import { moveMobile } from '../../_movement.js';
import { sendToOnline } from '../../_spatial.js';
import { createItem } from '../../_items.js';
import { createMobile } from '../../_mobiles.js';

// Canonical Shadowguard room spawn coords on the Tokuno facet
// (map=3 / Ilshenar Stygian Abyss). Each entry: teleport pad + boss
// drop tile. Coords aligned with the ServUO `Tables\TC2Shadowguard.cs`
// record set; nothing magic about them other than being inside the
// dungeon's region polygon.
const ROOM_COORDS = {
  bar:      { padX: 502, padY: 2192, padZ: 0, bossX: 506, bossY: 2196, bossZ: 0, map: 1 },
  orchard:  { padX: 514, padY: 2192, padZ: 0, bossX: 518, bossY: 2196, bossZ: 0, map: 1 },
  belfry:   { padX: 526, padY: 2192, padZ: 0, bossX: 530, bossY: 2196, bossZ: 0, map: 1 },
  armory:   { padX: 538, padY: 2192, padZ: 0, bossX: 542, bossY: 2196, bossZ: 0, map: 1 },
  fountain: { padX: 550, padY: 2192, padZ: 0, bossX: 554, bossY: 2196, bossZ: 0, map: 1 },
  roof:     { padX: 502, padY: 2230, padZ: 0, bossX: 506, bossY: 2234, bossZ: 0, map: 1 },
};

// ServUO `Items/Artifacts/Shadowguard/` — roof drop pool.
const SHADOWGUARD_ARTIFACTS = [
  { name: 'Anon\'s Spellbook',       itemId: 0x0EFA, hue: 0x47E },
  { name: 'Captain John\'s Hat',     itemId: 0x1714, hue: 0x47E },
  { name: 'Cuffs of the Archmage',   itemId: 0x1714, hue: 0x489 },
  { name: 'Eternal Guardian Staff',  itemId: 0x13F8, hue: 0x501 },
  { name: 'Hawkwind\'s Robe',        itemId: 0x1F03, hue: 0x489 },
  { name: 'Juo\'nar\'s Grimoire',    itemId: 0x0EFA, hue: 0x44E },
  { name: 'Minax\'s Sandals',        itemId: 0x170D, hue: 0x044 },
  { name: 'Mocking Sword',           itemId: 0x13B7, hue: 0x47E },
  { name: 'Pixie Swatter',           itemId: 0x143E, hue: 0x47E },
  { name: 'Rum-Soaked Cloth',        itemId: 0x1F9F, hue: 0x21  },
  { name: 'Shroud of the Condemned', itemId: 0x1F03, hue: 0x44E },
];

const ROOM_TIMEOUT_MS = 30 * 60 * 1000;

/** Per-mob pre-entry position so we can teleport everyone back when
 *  the party leaves or wipes. */
const _preEntryPos = new Map();          // mobSerial → {x,y,z,map, party}

function partyOf(api, mob) {
  return api.party?.getParty?.(mob) ?? { id: `solo-${mob.serial}`, members: [mob] };
}

function teleport(api, mob, x, y, z, map) {
  moveMobile(api, mob, { x, y, z, map });
}

function saveEntry(mob, partyId) {
  _preEntryPos.set(mob.serial, {
    x: mob.x, y: mob.y, z: mob.z, map: mob.map ?? 1, partyId,
  });
}

function restoreEntry(api, mob) {
  const pos = _preEntryPos.get(mob.serial);
  if (!pos) return false;
  teleport(api, mob, pos.x, pos.y, pos.z, pos.map);
  _preEntryPos.delete(mob.serial);
  return true;
}

function spawnRoomBoss(api, room, shadowguard) {
  const cfg = shadowguard.SHADOWGUARD_BOSSES[room];
  const coords = ROOM_COORDS[room];
  if (!cfg || !coords) return null;
  const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
  let mob = null;
  if (factory) {
    try {
      mob = factory(api.world, cfg.kind, {
        x: coords.bossX, y: coords.bossY, z: coords.bossZ, map: coords.map,
      });
    } catch { /* fall through */ }
  }
  if (!mob) {
    // Fallback to a generic mob if the kind template is missing — the
    // gameplay loop still works, just with placeholder stats.
    mob = createMobile(api, api.world, {
      name: cfg.kind, body: 0x1A,
      x: coords.bossX, y: coords.bossY, z: coords.bossZ, map: coords.map,
      hp: cfg.hp, hpMax: cfg.hp,
      str: 600, dex: 200, int: 400,
      fame: cfg.fame, karma: -cfg.fame,
      notoriety: 5,
      kind: cfg.kind,
    });
  }
  if (mob) mob._shadowguardRoom = room;
  return mob;
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const shadowguard = api.systems?.shadowguard;
  if (!shadowguard) {
    api.log?.('shadowguard: system unavailable');
    return () => {};
  }

  // Kill hook — once per Shadowguard boss, advance the party state.
  api.corpse?.addKillHook?.((_world, victim, killer) => {
    const room = victim?._shadowguardRoom;
    if (!room) return;
    const party = killer ? partyOf(api, killer) : null;
    if (!party) return;
    if (room === 'roof') {
      const ok = shadowguard.killRoof(party);
      if (ok) {
        // Drop a random artifact on the corpse tile.
        const pick = SHADOWGUARD_ARTIFACTS[(Math.random() * SHADOWGUARD_ARTIFACTS.length) | 0];
        if (pick) {
          try {
            const item = createItem(api, api.world, {
              itemId: pick.itemId, hue: pick.hue, name: pick.name,
              x: victim.x, y: victim.y, z: victim.z, map: victim.map,
              movable: true,
            });
            if (item) item.artifact = pick.name;
          } catch (e) { api.log?.(`[shadow] artifact drop failed: ${e.message}`); }
        }
        // Shard announce.
        const pkt = api.protocol?.unicodeMessage?.({
          text: `${killer.name ?? 'A hero'} has cleared the Shadowguard Roof!`,
          hue: 0x35, font: 3, name: 'System',
        });
        if (pkt) sendToOnline(api, pkt);
      }
    } else {
      shadowguard.clearRoom(party, room);
    }
  });

  api.commands.register({
    name: 'shadow',
    help: '[shadow start <room>|status|clear <room>|leave — Shadowguard tower.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const room = String(ctx.args[1] ?? '').toLowerCase();
      const mob = ctx.sender;
      const party = partyOf(api, mob);

      if (sub === 'status') {
        const p = shadowguard.progress(party);
        for (const r of p.rooms) {
          ctx.state.sendSystemMessage(
            `  ${r.room.padEnd(10)} — ${r.cleared ? 'CLEARED' : 'open'}`,
          );
        }
        ctx.state.sendSystemMessage(
          p.roofUnlocked ? '★ Roof unlocked — use [shadow start roof.' :
                           'Clear all 5 rooms to unlock the Roof.',
        );
        return;
      }

      if (sub === 'start') {
        if (!ROOM_COORDS[room]) {
          ctx.state.sendSystemMessage('Rooms: bar, orchard, belfry, armory, fountain, roof');
          return;
        }
        shadowguard.ensureState(party);
        if (room === 'roof' && !shadowguard.progress(party).roofUnlocked) {
          ctx.state.sendSystemMessage('Clear all 5 rooms before entering the Roof.');
          return;
        }
        if (room !== 'roof' && shadowguard.progress(party).rooms.find((r) => r.room === room)?.cleared) {
          ctx.state.sendSystemMessage(`The ${room} is already cleared.`);
          return;
        }
        const started = shadowguard.startRoom(party, room);
        const coords = ROOM_COORDS[room];
        // Teleport every party member who's nearby (≤8 tiles).
        const members = party.members ?? [mob];
        for (const m of members) {
          if (!m) continue;
          const dist = Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y));
          if (dist > 8 || m.map !== mob.map) continue;
          saveEntry(m, party.id);
          teleport(api, m, coords.padX, coords.padY, coords.padZ, coords.map);
          m.client?.sendSystemMessage?.(`Entering Shadowguard — ${room.toUpperCase()}.`);
        }
        const boss = spawnRoomBoss(api, room, shadowguard);
        if (!boss) {
          ctx.state.sendSystemMessage('The room spawn failed — try again.');
          return;
        }
        // Schedule a timeout — if not cleared in 30 min, restore party.
        const partyId = party.id;
        setTimeout(() => {
          if (shadowguard.progress(party).rooms.find((r) => r.room === room)?.cleared) return;
          for (const m of party.members ?? []) {
            if (_preEntryPos.get(m.serial)?.partyId === partyId) {
              restoreEntry(api, m);
              m.client?.sendSystemMessage?.(`Shadowguard timeout — you are pulled out of ${room}.`);
            }
          }
        }, ROOM_TIMEOUT_MS).unref?.();
        if (started) ctx.state.sendSystemMessage(`The ${room} boss appears!`);
        return;
      }

      if (sub === 'clear') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage('GM only.');
          return;
        }
        if (!room || (room !== 'roof' && !shadowguard.SHADOWGUARD_BOSSES[room])) {
          ctx.state.sendSystemMessage('Usage: [shadow clear <room>');
          return;
        }
        if (room === 'roof') shadowguard.killRoof(party);
        else shadowguard.clearRoom(party, room);
        ctx.state.sendSystemMessage(`Forced clear: ${room}.`);
        return;
      }

      if (sub === 'leave') {
        let n = 0;
        for (const m of party.members ?? [mob]) {
          if (restoreEntry(api, m)) n++;
        }
        ctx.state.sendSystemMessage(`Pulled ${n} party member(s) out of Shadowguard.`);
        return;
      }

      ctx.state.sendSystemMessage('Usage: [shadow start <room>|status|clear <room>|leave');
    },
  });

  return () => api.commands.unregister('shadow');
}
