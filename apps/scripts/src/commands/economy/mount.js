import { moveMobile } from '../../_movement.js';
import { allItems, allMobiles, nearbyClients, nearbyMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

// `[mount` — toggle mounting / dismounting an adjacent tame horse pet.
//
// ServUO model: each mount creature has a `Rider` field and emits a
// `MountItem` on layer 25 (Mount). The player's humanoid body stays intact;
// clients compose its mounted animation group with the mount animation.
//   1. Player runs [mount → finds an adjacent tameable pet they own.
//   2. We equip the canonical hidden mount-art item on Layer.Mount.
//   3. The pet mob is hidden from world views — restored on
//      dismount at the player's tile.
//
// Damage-induced dismount is handled in the central combat.damage hook
// when HP drops below 20%.

const PLAYER_FEMALE = 0x0191;

// ServUO BaseMount's second constructor id is the graphic of the hidden
// Layer.Mount item worn by the rider. The browser renderer resolves that
// graphic to the mount animation body and draws it below the unchanged
// human + clothing layers. The old implementation replaced `player.body`,
// which made every garment disappear and corrupted paperdoll state.
export const MOUNT_ITEM_BY_KIND = Object.freeze({
  reptalon: 0x3E90,
  'cu-sidhe': 0x3E91,
  'charger-of-the-fallen': 0x3E92,
  horse: 0x3E9F,
  llama: 0x3EA6,
  ostard: 0x3EA5,
  'forest-ostard': 0x3EA5,
  'frenzied-ostard': 0x3EA4,
  'desert-ostard': 0x3EA3,
  ridgeback: 0x3EBA,
  'giant-beetle': 0x3EBC,
  'fire-beetle': 0x3E95,
  'swamp-dragon': 0x3EBD,
  'scaled-swamp-dragon': 0x3EBE,
  'bane-dragon': 0x3EBD,
  'skeletal-mount': 0x3EBB,
  lasher: 0x3ECB,
  unicorn: 0x3EB4,
  hiryu: 0x3E94,
  'lesser-hiryu': 0x3E94,
  'dread-warhorse': 0x3EA7,
  hellsteed: 0x3EBB,
});

const MOUNT_MENU_KINDS = Object.keys(MOUNT_ITEM_BY_KIND);

// World saves made before the mount/body audit retain the body serialized at
// spawn time. Correct only the known bad kind/body pairs here: this preserves
// intentional hues and polymorphs while making old pets converge to the same
// ServUO body as newly spawned mounts after a script/server reload.
const LEGACY_MOUNT_BODY_FIXES = Object.freeze({
  'bane-dragon': Object.freeze({ from: Object.freeze([0x000C]), to: 0x031A }),
  'charger-of-the-fallen': Object.freeze({ from: Object.freeze([0x00FC]), to: 0x011C }),
  'desert-ostard': Object.freeze({ from: Object.freeze([0x00DB]), to: 0x00D2 }),
  'fire-beetle': Object.freeze({ from: Object.freeze([0x00A1]), to: 0x00A9 }),
  'frenzied-ostard': Object.freeze({ from: Object.freeze([0x00DB]), to: 0x00DA }),
  'giant-beetle': Object.freeze({ from: Object.freeze([0x00A1]), to: 0x0317 }),
  hellsteed: Object.freeze({ from: Object.freeze([0x0075]), to: 0x0319 }),
  lasher: Object.freeze({ from: Object.freeze([0x0509]), to: 0x057F }),
  reptalon: Object.freeze({ from: Object.freeze([0x02E0]), to: 0x0114 }),
  ridgeback: Object.freeze({ from: Object.freeze([0x00D5]), to: 0x00BB }),
  'scaled-swamp-dragon': Object.freeze({ from: Object.freeze([0x0033]), to: 0x031F }),
  'swamp-dragon': Object.freeze({ from: Object.freeze([0x0033]), to: 0x031A }),
});

function mountItemFor(kind) { return MOUNT_ITEM_BY_KIND[kind] ?? 0; }

function equippedMountItem(api, rider) {
  const explicit = itemBySerial(api, rider._mountItemSerial >>> 0);
  if (explicit) return explicit;
  for (const item of allItems(api)) {
    if ((item.parent >>> 0) === (rider.serial >>> 0) && (item.layer | 0) === 25) return item;
  }
  return null;
}

function adjacentMyPet(api, mob) {
  const preferred = mob._requestedMountSerial >>> 0;
  let fallback = null;
  for (const m of nearbyMobiles(api, mob, mob, 1)) {
    if (m === mob) continue;
    if ((m.controlMaster >>> 0) !== (mob.serial >>> 0)) continue;
    if (m.map !== mob.map) continue;
    if (Math.abs(m.x - mob.x) > 1 || Math.abs(m.y - mob.y) > 1) continue;
    if (preferred && (m.serial >>> 0) === preferred) return m;
    fallback ??= m;
  }
  return fallback;
}

function broadcastUpdate(api, mob) {
  if (!api.protocol?.mobileMoving) return;
  const moving = api.protocol.mobileMoving({
    serial: mob.serial, body: mob.body,
    x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue,
    flags: mob.flags, notoriety: mob.notoriety,
  });
  // BUGFIX #65 (PHASE CW): visibility-gate. Mounting / dismounting body
  // change is local — only nearby clients need the 0x77 update.
  for (const other of nearbyClients(api, mob)) other.client.send(moving);
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  let migratedBodies = 0;
  for (const mob of allMobiles(api)) {
    const fix = LEGACY_MOUNT_BODY_FIXES[mob?.kind];
    if (!fix || !fix.from.includes(mob.body | 0)) continue;
    mob.body = fix.to;
    migratedBodies++;
    broadcastUpdate(api, mob);
  }
  if (migratedBodies) api.log?.(`[mounts] corrected ${migratedBodies} legacy mount bod${migratedBodies === 1 ? 'y' : 'ies'}`);

  function currentMount(rider) {
    return rider.mountedFrom ? mobileBySerial(api, rider.mountedFrom >>> 0) : adjacentMyPet(api, rider);
  }

  function openCargo(ctx) {
    const pet = currentMount(ctx.sender);
    if (!pet || (pet.controlMaster >>> 0) !== (ctx.sender.serial >>> 0)) {
      ctx.state.sendSystemMessage('Mount or stand beside your controlled mount first.'); return;
    }
    let box = itemBySerial(api, pet._mountCargoSerial >>> 0);
    if (!box) {
      box = createItem(api, api.world, {
        itemId: 0x0E75, name: `${pet.name ?? 'mount'} cargo`, parent: pet.serial,
        layer: 0, gumpId: 0x003C, movable: false, weight: 0, map: pet.map,
      });
      pet._mountCargoSerial = box.serial >>> 0;
      pet.mountCargoCapacity = Math.max(40, Math.min(250, 40 + (pet.str | 0)));
    }
    const contents = [];
    for (const item of allItems(api)) {
      if ((item.parent >>> 0) !== (box.serial >>> 0)) continue;
      contents.push({ serial:item.serial,itemId:item.itemId,amount:item.amount??1,hue:item.hue??0,gridX:item.gridX??0,gridY:item.gridY??0,gridLocation:0 });
    }
    ctx.state.send(api.protocol.displayContainer(box.serial, box.gumpId, 125));
    ctx.state.send(api.protocol.containerContents(box.serial, contents));
    ctx.state.openContainers?.add?.(box.serial);
    ctx.state.sendSystemMessage(`Mount cargo capacity: ${pet.mountCargoCapacity} stones.`);
  }

  function useAbility(ctx, abilityId) {
    const MA = api.systems?.mountAbilities;
    const result = MA?.useMountAbility?.(api.world, ctx.sender, abilityId)
      ?? { ok:false,error:'Mount ability system unavailable.' };
    ctx.state.sendSystemMessage(result.ok ? `${result.pet.name ?? 'Your mount'} uses ${result.ability.label}.` : result.error);
    if (result.ok && api.protocol.staminaUpdate) {
      ctx.state.send(api.protocol.staminaUpdate({ serial:ctx.sender.serial,current:ctx.sender.stam|0,max:ctx.sender.stamMax??100 }));
    }
    return result;
  }

  function openAbilityMenu(ctx) {
    const MA = api.systems?.mountAbilities;
    const pet = MA?.mountedPet?.(api.world, ctx.sender);
    if (!pet) { ctx.state.sendSystemMessage('You must be mounted.'); return; }
    const abilities = MA.abilitiesForMount(pet);
    if (!api.gumps?.send) {
      abilities.forEach((entry) => ctx.state.sendSystemMessage(`${entry.id}: ${entry.remainingMs ? `${(entry.remainingMs/1000).toFixed(1)}s` : 'ready'} — ${entry.description}`));
      return;
    }
    const texts = ['Mount Abilities', ...abilities.map((entry) => `${entry.label} — ${entry.remainingMs ? `${(entry.remainingMs/1000).toFixed(1)}s` : 'READY'} — ${entry.description}`)];
    const layout = [`{ resizepic 0 0 5054 480 ${70+abilities.length*34} }`,`{ text 20 15 1153 0 }`];
    abilities.forEach((entry,index)=>{layout.push(`{ button 20 ${50+index*34} 4005 4007 1 0 ${100+index} }`,`{ text 52 ${50+index*34} ${entry.remainingMs?946:1153} ${index+1} }`);});
    api.gumps.send(ctx.state,{x:120,y:90,gumpId:0x4D414249,layout:layout.join(''),texts},(resp)=>{const index=(resp?.buttonId|0)-100;if(index>=0&&abilities[index])useAbility(ctx,abilities[index].id);});
  }

  api.commands.register({
    name: 'mount',
    help: '[mount [abilities|ability <id>|cargo] — ride and manage a mount.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const sub = String(ctx.args?.[0] ?? '').toLowerCase();
      if (sub === 'cargo' || sub === 'pack') { openCargo(ctx); return; }
      if (sub === 'abilities' || sub === 'skills') { openAbilityMenu(ctx); return; }
      if (sub === 'ability') { useAbility(ctx, String(ctx.args?.[1] ?? '').toLowerCase()); return; }
      if (mob.mountedFrom) {
        // Currently mounted — dismount. BUGFIX #26: pet stays in
        // world.mobiles while ridden (just flagged `mounted=true` and
        // hidden from clients via removeEntity). Look it up; if it
        // somehow disappeared (admin nuke, save corruption) treat
        // dismount as a clean reset rather than crashing.
        const pet = mobileBySerial(api, mob.mountedFrom >>> 0);
        // Remove the actual Layer.Mount item; RemoveEntity makes every
        // client evict the equipment slot in O(1).
        const mountItem = equippedMountItem(api, mob);
        if (mountItem) {
          const rm = api.protocol.removeEntity?.(mountItem.serial);
          if (rm) for (const other of nearbyClients(api, mob)) other.client.send(rm);
          destroyItemBySerial(api, mountItem.serial);
        }
        delete mob._mountItemSerial;
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
      const remountAt = Number(mob._dismountedUntil) || 0;
      if (remountAt > Date.now()) {
        const seconds = Math.max(1, Math.ceil((remountAt - Date.now()) / 1000));
        ctx.state.sendSystemMessage(`You must wait ${seconds}s before mounting again.`);
        return;
      }
      // Try to find an adjacent owned pet.
      const pet = adjacentMyPet(api, mob);
      if (!pet) {
        ctx.state.sendSystemMessage('No mountable pet stands beside you.');
        return;
      }
      const cfg = api.monsters?.get?.(pet.kind) ?? {};
      const mountGraphic = mountItemFor(pet.kind);
      if (!mountGraphic || (!cfg.tameable && !cfg.tamable && !pet.controlMaster)) {
        ctx.state.sendSystemMessage('You cannot ride that.');
        return;
      }
      mob.mountedFrom = pet.serial >>> 0;
      const mountItem = createItem(api, api.world, {
        itemId: mountGraphic,
        hue: pet.hue ?? 0,
        amount: 1,
        x: 0, y: 0, z: 0, map: mob.map,
        parent: mob.serial,
        layer: 25,
        movable: false,
        weight: 0,
        name: `${pet.name ?? pet.kind} (mounted)`,
      });
      mob._mountItemSerial = mountItem?.serial >>> 0;
      // BUGFIX #26 (PHASE BJ): the previous version `world.mobiles.delete(pet)`
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
      if (mountItem && api.protocol.equipUpdate) {
        const equip = api.protocol.equipUpdate({
          serial: mountItem.serial,
          itemId: mountItem.itemId,
          layer: 25,
          parent: mob.serial,
          hue: mountItem.hue ?? 0,
        });
        for (const other of nearbyClients(api, mob)) other.client.send(equip);
      }
      broadcastUpdate(api, mob);
      ctx.state.sendSystemMessage(`You mount ${pet.name ?? 'the creature'}.`);
      void PLAYER_FEMALE;
    },
  });

  function spawnTamedMount(ctx, kind) {
    const cfg = api.monsters?.get?.(kind);
    const mountItemId = mountItemFor(kind);
    if (!cfg || !mountItemId) {
      ctx.state.sendSystemMessage(`Mount '${kind}' is unavailable in this content set.`);
      return null;
    }
    const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
    let pet = null;
    try {
      pet = factory?.(api.world, kind, {
        x: (ctx.sender.x | 0) + 1,
        y: ctx.sender.y | 0,
        z: ctx.sender.z | 0,
        map: ctx.sender.map ?? 1,
      });
    } catch (e) {
      api.log?.(`[mounts] ${kind} spawn failed: ${e?.message ?? e}`);
    }
    if (!pet) {
      ctx.state.sendSystemMessage(`Could not spawn '${kind}'.`);
      return null;
    }
    pet.controlMaster = ctx.sender.serial >>> 0;
    pet.controlled = true;
    pet.tameable = true;
    pet.tamable = true;
    pet.controlOrder = 'follow';
    pet.controlTarget = ctx.sender.serial >>> 0;
    pet.team = ctx.sender.serial >>> 0;
    pet.notoriety = 1;
    const slots = Math.max(1, cfg.controlSlots ?? pet.controlSlots ?? 1);
    pet.controlSlots = slots;
    pet._followerCost = slots;
    ctx.sender.followers = (ctx.sender.followers | 0) + slots;
    pet.tameSince = Date.now();
    pet.bonded = false;
    pet._tamedAt = Date.now();
    if (api.protocol.mobileIncoming) {
      const incoming = api.protocol.mobileIncoming({
        serial: pet.serial, body: pet.body,
        x: pet.x, y: pet.y, z: pet.z,
        direction: pet.direction ?? 0, hue: pet.hue ?? 0,
        flags: pet.flags ?? 0, notoriety: pet.notoriety,
        equipment: [],
      });
      for (const viewer of nearbyClients(api, pet)) viewer.client.send(incoming);
    }
    ctx.state.sendSystemMessage(`${pet.name ?? kind} appears beside you, already tamed.`);
    return pet;
  }

  function openMountMenu(ctx, page = 0) {
    const available = MOUNT_MENU_KINDS.filter((kind) => api.monsters?.get?.(kind));
    const perPage = 10;
    const pages = Math.max(1, Math.ceil(available.length / perPage));
    page = Math.max(0, Math.min(page, pages - 1));
    const rows = available.slice(page * perPage, (page + 1) * perPage);
    const W = 430, H = 82 + perPage * 45 + 40;
    const layout = [`{ page 0 }`, `{ resizepic 0 0 5054 ${W} ${H} }`];
    const texts = ['Tamed Mounts', `${available.length} choices · page ${page + 1}/${pages}`];
    layout.push('{ text 20 14 1153 0 }', '{ text 145 14 70 1 }');
    layout.push(`{ button ${W - 32} 10 4017 4018 1 0 0 }`);
    rows.forEach((kind, i) => {
      const cfg = api.monsters.get(kind);
      const y = 52 + i * 45;
      // A mobile body is animation art, not item art. Rendering the hidden
      // Layer.Mount item via tilepic used ship/tiller sprites on several UO
      // data generations and produced the long stretched bars seen in the
      // picker. `mobilepic` is our optional web-client gump extension;
      // standard clients safely ignore the unknown command.
      layout.push(`{ mobilepic 16 ${y - 5} ${cfg.body | 0} ${cfg.hue ?? 0} 0 54 54 }`);
      layout.push(`{ button 76 ${y} 4005 4007 1 0 ${100 + i} }`);
      texts.push(cfg.name ?? kind);
      layout.push(`{ text 102 ${y} 1153 ${texts.length - 1} }`);
      texts.push(`${kind} · body 0x${(cfg.body | 0).toString(16)} · mount art 0x${mountItemFor(kind).toString(16)}`);
      layout.push(`{ text 102 ${y + 18} 70 ${texts.length - 1} }`);
    });
    const fy = H - 30;
    if (page > 0) layout.push(`{ button 20 ${fy} 4014 4015 1 0 2000 }`);
    if (page < pages - 1) layout.push(`{ button ${W - 70} ${fy} 4005 4006 1 0 2001 }`);
    api.gumps.send(ctx.state, {
      x: 80, y: 60, gumpId: 0x4D4F554E, layout: layout.join(''), texts,
    }, (resp) => {
      const button = resp?.buttonId | 0;
      if (button === 2000) return openMountMenu(ctx, page - 1);
      if (button === 2001) return openMountMenu(ctx, page + 1);
      if (button >= 100 && button < 100 + rows.length) {
        spawnTamedMount(ctx, rows[button - 100]);
        return openMountMenu(ctx, page);
      }
    });
  }

  const mountMenuCommand = {
    name: 'mounts',
    help: '[mounts [kind] — visual GM mount picker; spawned mount is already tamed.',
    access: 'Admin',
    run(ctx, args) {
      const kind = String(args?.[0] ?? '').toLowerCase();
      if (kind) spawnTamedMount(ctx, kind);
      else if (api.gumps) openMountMenu(ctx);
      else ctx.state.sendSystemMessage(`Available mounts: ${MOUNT_MENU_KINDS.join(', ')}`);
    },
  };
  api.commands.register(mountMenuCommand);

  return () => {
    api.commands.unregister('mount');
    api.commands.unregister('mounts');
  };
}
