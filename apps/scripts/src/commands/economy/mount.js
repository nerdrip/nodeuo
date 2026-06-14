import { moveMobile } from '../../_movement.js';
import { nearbyClients, nearbyMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';

// `[mount` — toggle mounting / dismounting an adjacent tame horse pet.
//
// ServUO model: each mount creature has a `Rider` field and emits a
// `MountItem` on layer 25 (Mount). The player's body becomes the
// "mounted" variant (0x0190 → 0x00E2 for a horse, etc.). We mirror this
// minimally:
//   1. Player runs [mount → finds an adjacent tameable pet they own.
//   2. We swap player.body to the body+0x100 mounted equivalent.
//   3. The pet mob is removed from the world (hidden) — re-spawned on
//      dismount at the player's tile.
//
// Mount item layer is normally 25. We don't ship a per-mount art id yet
// (would need separate entries in the static atlas), so the body swap
// is the only visible change. Players see "you ride a horse" overhead
// to convey what happened.
//
// Body swap table (subset):
//   horse  → 0x0027 (rider+horse merged sprite)
//   llama  → 0x0DC
//   bull   → unsupported (no merged body) — fallback to horse swap
//
// Damage-induced dismount is handled in the central combat.damage hook
// when HP drops below 20%.

const PLAYER_FEMALE = 0x0191;

// FAZA BJ: extended mount body table — port of ServUO BaseMount kinds.
// Each entry is the rider+mount merged body id used while riding.
// Falls back to horse silhouette for anything unmapped so unusual pets
// still render readably (instead of an invisible mounted player).
const MOUNTED_BODY = {
  horse:           0x00E2, // chestnut horse rider
  'horse-pack':    0x00E4, // pack horse rider
  'horse-pal':     0x00CC, // pale horse rider
  'horse-dark':    0x00DA, // dark horse rider
  llama:           0x00DC, // llama rider
  'llama-pack':    0x0124, // pack llama rider
  ostard:          0x00DD, // forest ostard rider
  'ostard-frenz':  0x00DA, // frenzied ostard rider
  'ostard-desert': 0x00DB, // desert ostard rider
  ridgeback:       0x03EA, // savage ridgeback rider
  beetle:          0x0317, // giant beetle rider
  'swamp-dragon':  0x031A, // swamp dragon rider
  nightmare:       0x00E4, // (uses dark-horse art for now)
  'fire-steed':    0x00E2, // (red horse art)
};
function mountedBodyFor(kind) { return MOUNTED_BODY[kind] ?? 0x00E2; }

function adjacentMyPet(api, mob) {
  for (const m of nearbyMobiles(api, mob, mob, 1)) {
    if (m === mob) continue;
    if ((m.controlMaster >>> 0) !== (mob.serial >>> 0)) continue;
    if (m.map !== mob.map) continue;
    if (Math.abs(m.x - mob.x) > 1 || Math.abs(m.y - mob.y) > 1) continue;
    return m;
  }
  return null;
}

function broadcastUpdate(api, mob) {
  if (!api.protocol?.mobileMoving) return;
  const moving = api.protocol.mobileMoving({
    serial: mob.serial, body: mob.body,
    x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue,
    flags: mob.flags, notoriety: mob.notoriety,
  });
  // BUGFIX #65 (FAZA CW): visibility-gate. Mounting / dismounting body
  // change is local — only nearby clients need the 0x77 update.
  for (const other of nearbyClients(api, mob)) other.client.send(moving);
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  api.commands.register({
    name: 'mount',
    help: '[mount — toggle riding an adjacent tame mount.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (mob.mountedFrom) {
        // Currently mounted — dismount. BUGFIX #26: pet stays in
        // world.mobiles while ridden (just flagged `mounted=true` and
        // hidden from clients via removeEntity). Look it up; if it
        // somehow disappeared (admin nuke, save corruption) treat
        // dismount as a clean reset rather than crashing.
        const pet = mobileBySerial(api, mob.mountedFrom >>> 0);
        mob.body = mob.mountedOriginalBody ?? (mob.body === 0x00E2 ? 0x0190 : mob.body);
        delete mob.mountedFrom;
        delete mob.mountedOriginalBody;
        if (pet) {
          delete pet.mounted;
          moveMobile(api, pet, { x: mob.x, y: mob.y, z: mob.z, map: mob.map });
          if (api.protocol.mobileIncoming) {
            const incoming = api.protocol.mobileIncoming({
              serial: pet.serial, body: pet.body, x: pet.x, y: pet.y, z: pet.z,
              direction: pet.direction, hue: pet.hue, flags: pet.flags,
              notoriety: pet.notoriety, equipment: [],
            });
            // BUGFIX #65: visibility-gate.
            for (const other of nearbyClients(api, pet)) other.client.send(incoming);
          }
        }
        broadcastUpdate(api, mob);
        ctx.state.sendSystemMessage('You dismount.');
        return;
      }
      // Try to find an adjacent owned pet.
      const pet = adjacentMyPet(api, mob);
      if (!pet) {
        ctx.state.sendSystemMessage('No mountable pet stands beside you.');
        return;
      }
      const cfg = api.monsters?.get?.(pet.kind) ?? {};
      if (!cfg.tameable && !MOUNTED_BODY[pet.kind]) {
        ctx.state.sendSystemMessage('You cannot ride that.');
        return;
      }
      mob.mountedOriginalBody = mob.body;
      mob.body = mountedBodyFor(pet.kind);
      mob.mountedFrom = pet.serial >>> 0;
      // BUGFIX #26 (FAZA BJ): the previous version `world.mobiles.delete(pet)`
      // — pet was permanently dropped from the world map. After server
      // restart (mounted state persisted, pet didn't), `world.mobiles
      // .get(pet.serial)` returned undefined and dismount silently
      // skipped re-spawn. Pet vanished forever. Now we keep the pet
      // in world.mobiles and just flag `mounted=true` so AI ticks
      // skip it, broadcast removeEntity so clients hide its sprite,
      // and restore on dismount.
      pet.mounted = true;
      if (api.protocol.removeEntity) {
        const rm = api.protocol.removeEntity(pet.serial);
        // BUGFIX #65: visibility-gate. Pet vanish on mount only needs
        // the nearby crowd, not every connected player.
        for (const other of nearbyClients(api, pet)) other.client.send(rm);
      }
      broadcastUpdate(api, mob);
      ctx.state.sendSystemMessage(`You mount ${pet.name ?? 'the creature'}.`);
      void PLAYER_FEMALE;
    },
  });

  return () => api.commands.unregister('mount');
}
