import { destroyItemBySerial } from '../../../_items.js';
import { createMobile, destroyMobileBySerial } from '../../../_mobiles.js';
import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import {
  equipped, findInPack, isInPack, isPackedOrWorn,
} from '../../../_inventory.js';
import { nearbyClients } from '../../../_spatial.js';
import { broadcastItemUpdate } from '../_shared/broadcast.js';

const CADD_SOCKET = 'Caddellite';
const PET_WHISTLE_COMMAND_APIS = new WeakSet();
const P1_COMMAND_APIS = new WeakSet();
const SECRET_CHEST_COMMAND_APIS = new WeakSet();
const ETHEREAL_RIDER_BODY = Object.freeze({
  horse: 0x00E2,
  llama: 0x00DC,
  ostard: 0x00DD,
  zostrich: 0x00DA,
  kirin: 0x00DA,
  unicorn: 0x00E2,
  ridgeback: 0x03EA,
  dragon: 0x00E2,
  'cu-sidhe': 0x0115,
  hiryu: 0x00E2,
  reptalon: 0x0114,
  'gm-ethereal': 0x00E2,
});
const ETHEREAL_MOUNT_BODY = Object.freeze({
  horse: 0x00E2,
  llama: 0x00DC,
  ostard: 0x00DD,
  zostrich: 0x00DA,
  kirin: 0x84,
  unicorn: 0x7A,
  ridgeback: 0x18A,
  dragon: 0x3D,
  'cu-sidhe': 0x115,
  hiryu: 0x6A,
  reptalon: 0x114,
  'gm-ethereal': 0x00E2,
});
const OBSIDIAN_NAMES = [
  null,
  'an aggressive cavalier',
  'a beguiling rogue',
  'a benevolent physician',
  'a brilliant artisan',
  'a capricious adventurer',
  'a clever beggar',
  'a convincing charlatan',
  'a creative inventor',
  'a creative tinker',
  'a cunning knave',
  'a dauntless explorer',
  'a despicable ruffian',
  'an earnest malcontent',
  'an exultant animal tamer',
  'a famed adventurer',
  'a fanatical crusader',
  'a fastidious clerk',
  'a fearless hunter',
  'a festive harlequin',
  'a fidgety assassin',
  'a fierce soldier',
  'a fierce warrior',
  'a frugal magnate',
  'a glib pundit',
  'a gnomic shaman',
  'a graceful noblewoman',
  'an idiotic madman',
  'an imaginative designer',
  'an inept conjurer',
  'an innovative architect',
  'an inventive blacksmith',
  'a judicious mayor',
  'a masterful chef',
  'a masterful woodworker',
  'a melancholy clown',
  'a melodic bard',
  'a merciful guard',
  'a mirthful jester',
  'a nervous surgeon',
  'a peaceful scholar',
  'a prolific gardener',
  'a quixotic knight',
  'a regal aristocrat',
  'a resourceful smith',
  'a reticent alchemist',
  'a sanctified priest',
  'a scheming patrician',
  'a shrewd mage',
  'a singing minstrel',
  'a skilled tailor',
  'a squeamish assassin',
  'a stoic swordsman',
  'a studious scribe',
  'a thought provoking writer',
  'a treacherous scoundrel',
  'a troubled poet',
  'an unflappable wizard',
  'a valiant warrior',
  'a wayward fool',
];
const SHIMMERING_IDS = [
  0x2206, 0x2207, 0x2208, 0x2209, 0x220A, 0x220B, 0x220C, 0x220D, 0x220E,
  0x2210, 0x2211, 0x2212, 0x2213, 0x2214, 0x2215, 0x2216, 0x2217, 0x2218,
  0x221A, 0x221B, 0x221C, 0x221D, 0x221E, 0x221F, 0x2220, 0x2221, 0x2222,
  0x2224, 0x2225, 0x2226, 0x2227, 0x2228, 0x2229, 0x222A, 0x222B, 0x222C,
];

export const ServUOItemParityClasses = Object.freeze([
  'BleedTimer',
  'Caddellite',
  'CallingTimer',
  'ChylothStaff',
  'DefenseTimer',
  'DisassembleEntry',
  'DisguiseTimers',
  'DawnsMusicBox',
  'EpiphanyHelper',
  'FreeTimer',
  'GiftBoxNeon',
  'GMEthereal',
  'GMEthVirtual',
  'IcyPatch',
  'IDurability',
  'IWearableDurability',
  'LinkBondedPetEntry',
  'MaabusCoffin',
  'MaabusCoffinComponent',
  'MudPuppy',
  'PetWhistle',
  'PetWhistleGump',
  'PlayingTimer',
  'RedHerring',
  'ResetEquipTimer',
  'SecretSwitch',
  'SecretWall',
  'SecretChest',
  'SecretChestArray',
  'ShimmeringCrystals',
  'StealableArtifactsSpawner',
  'StealableEntry',
  'StealableInstance',
  'StopMusic',
  'TormentedChains',
  'MoveDelayTimer',
]);

export const ServUODurabilityInterfaces = Object.freeze(['IDurability', 'IWearableDurability']);

function say(mob, msg) {
  try { mob?.client?.sendSystemMessage?.(msg); } catch { /* advisory */ }
}

function ensureClasses(entity, classes) {
  if (!entity) return;
  const cur = Array.isArray(entity.servuoClasses) ? entity.servuoClasses : [];
  entity.servuoClasses = [...new Set([...cur, ...classes])];
  entity.servuoClass ??= classes[0];
}

function pickSerial(picked) {
  return picked?.serial ?? picked?.targetSerial ?? picked?.itemSerial ?? picked?.mobileSerial ?? 0;
}

function targetItem(api, world, picked) {
  return itemBySerial({ ...api, world }, pickSerial(picked)) ?? (picked?.itemId != null ? picked : null);
}

function targetMobile(api, world, picked) {
  return mobileBySerial({ ...api, world }, pickSerial(picked)) ?? (picked?.body != null ? picked : null);
}

function dealDamage(api, world, mob, amount, source, damageType = { physical: 100 }) {
  if (!mob) return;
  try {
    api.combat?.damage?.(world, mob, amount, source, damageType);
    return;
  } catch { /* try compact signature */ }
  try {
    api.combat?.damage?.(mob, amount, { source, damageType });
    return;
  } catch { /* fallback below */ }
  mob.hp = Math.max(0, (mob.hp ?? 0) - (amount | 0));
}

function playSound(api, center, soundId) {
  const pkt = api.protocol?.playSound?.({
    soundId, x: center?.x ?? 0, y: center?.y ?? 0, z: center?.z ?? 0,
  });
  if (!pkt) return;
  for (const mob of nearbyClients(api, center, null, 18)) {
    try { mob.client?.send?.(pkt); } catch { /* socket transient */ }
  }
}

export function attachCaddellite(item) {
  if (!item) return false;
  const sockets = Array.isArray(item.itemSockets) ? item.itemSockets : [];
  if (!sockets.some((s) => s?.type === CADD_SOCKET || s === CADD_SOCKET)) {
    sockets.push({ type: CADD_SOCKET, servuoClass: 'Caddellite' });
  }
  item.itemSockets = sockets;
  item.caddellite = true;
  item.caddelliteInfused = true;
  ensureClasses(item, ['Caddellite']);
  return true;
}

export function hasCaddellite(item) {
  if (!item) return false;
  if (item.caddellite || item.caddelliteInfused) return true;
  return Array.isArray(item.itemSockets)
    && item.itemSockets.some((s) => s?.type === CADD_SOCKET || s === CADD_SOCKET);
}

export function caddelliteEquippedBy(api, mob) {
  for (const it of equipped(api, mob)) {
    if (hasCaddellite(it)) return it;
  }
  return null;
}

export function checkCaddelliteDamage(api, damager) {
  if (!damager) return false;
  if (damager.caddelliteInfusedUntil && damager.caddelliteInfusedUntil > Date.now()) return true;
  return !!caddelliteEquippedBy(api, damager);
}

export function updateCaddelliteBuff(api, mob) {
  if (!mob) return false;
  const active = checkCaddelliteDamage(api, mob);
  if (active) {
    api.statusEffects?.apply?.(mob, {
      name: 'caddellite-infused',
      durationMs: 30_000,
      data: { servuoClass: 'Caddellite' },
    });
  } else {
    api.statusEffects?.remove?.(mob, 'caddellite-infused', api.world);
  }
  return active;
}

function makeFreeTimer(api, world, entity, ms, onFree = null) {
  const handle = setTimeout(() => {
    try { onFree?.(entity); } catch { /* advisory */ }
    if (entity?.serial) {
      if (entity.itemId != null) destroyItemBySerial({ ...api, world }, entity.serial);
      else destroyMobileBySerial({ ...api, world }, entity.serial);
    }
  }, Math.max(0, ms | 0));
  if (handle?.unref) handle.unref();
  return handle;
}

export function buildSpikedEggNog(api) {
  return {
    name: 'spiked-eggnog',
    onCreate(_world, item) {
      item.nextUseTime ??= 0;
      ensureClasses(item, ['SpikedEggNog', 'BleedTimer']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['SpikedEggNog', 'BleedTimer']);
      const isSecure = !!(item.lockedDown || item.secure || item.isSecure || item.secureLevel);
      if (!isSecure && user?.accessLevel !== 'GM' && user?.accessLevel !== 'Admin') {
        say(user, 'The egg nog must be secured in a house before it can be used.');
        return true;
      }
      const now = Date.now();
      if ((item.nextUseTime ?? 0) > now) {
        const left = Math.ceil((item.nextUseTime - now) / 1000);
        say(user, `You must wait ${left} seconds before drinking again.`);
        return true;
      }
      item.nextUseTime = now + 60_000;
      say(user, 'The spiked egg nog burns all the way down.');
      let ticks = 0;
      api.statusEffects?.apply?.(user, {
        name: 'spiked-eggnog-bleed',
        durationMs: 12_500,
        tickIntervalMs: 2000,
        data: { servuoClass: 'BleedTimer' },
        tick(mob, w) {
          if (++ticks > 6) return;
          const dmg = 1 + ((Math.random() * 10) | 0);
          dealDamage(api, w ?? world, mob, dmg, item, { energy: 100 });
          say(mob, 'The spiked egg nog courses painfully through you.');
        },
      });
      playSound(api, user ?? item, 0x02D6);
      return true;
    },
  };
}

export function buildIcyPatch(api) {
  return {
    name: 'icy-patch',
    onCreate(_world, item) {
      item.movable = false;
      item.weight ??= 5;
      if (!item._icyPatchVariant && Math.random() < 0.10) {
        item.itemId = 0x122A;
        item._icyPatchVariant = true;
      }
      ensureClasses(item, ['IcyPatch']);
    },
    onWalkOn(world, item, mob) {
      if (!mob?.client) return;
      ensureClasses(item, ['IcyPatch']);
      if ((mob._icyPatchUntil ?? 0) > Date.now()) return;
      mob._icyPatchUntil = Date.now() + 1500;
      const roll = Math.random();
      if (roll < 0.35) {
        say(mob, 'You skillfully maintain your balance on the icy patch.');
        return;
      }
      const duration = roll < 0.78 ? 1250 : 2000;
      mob._paralyzedUntil = Math.max(mob._paralyzedUntil ?? 0, Date.now() + duration);
      api.statusEffects?.apply?.(mob, {
        name: 'paralyze',
        durationMs: duration,
        data: { source: 'IcyPatch', servuoClass: 'IcyPatch' },
      });
      if (mob.mounted || mob.mountedFrom) {
        mob.mounted = false;
        say(mob, 'You slip from your mount!');
      } else {
        say(mob, roll < 0.78 ? 'You slip on the icy patch!' : 'You fall hard on the icy patch!');
      }
      try { api.combat?.animate?.(world, mob, 0x15, { frameCount: 5 }); } catch { /* advisory */ }
      playSound(api, mob, 0x0208);
    },
  };
}

export function buildKronusScroll(api) {
  return {
    name: 'kronus-scroll',
    onCreate(_world, item) {
      ensureClasses(item, ['KronusScroll', 'CallingTimer', 'SummonedPaladin']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['KronusScroll', 'CallingTimer', 'SummonedPaladin']);
      const inWell = (user?.map ?? 1) === 3
        && (user.x | 0) >= 2080 && (user.x | 0) <= 2089
        && (user.y | 0) >= 1346 && (user.y | 0) <= 1355;
      if (!inWell) {
        say(user, 'The Calling of Kronus answers only at the Well of Tears in Malas.');
        return true;
      }
      if ((user._kronusCallingUntil ?? 0) > Date.now()) {
        say(user, 'You are already calling Kronus.');
        return true;
      }
      user._kronusCallingUntil = Date.now() + 6500;
      api.statusEffects?.apply?.(user, {
        name: 'kronus-calling',
        durationMs: 6500,
        tickIntervalMs: 1000,
        data: { servuoClass: 'CallingTimer' },
        tick(mob, w) {
          mob._paralyzedUntil = Math.max(mob._paralyzedUntil ?? 0, Date.now() + 1250);
          try { api.combat?.animate?.(w ?? world, mob, 0x10, { frameCount: 7 }); } catch { /* advisory */ }
        },
        onRemove(mob, w) {
          delete mob._kronusCallingUntil;
          const paladin = createMobile(api, w ?? world, {
            kind: 'summoned-paladin',
            name: 'a summoned paladin',
            body: 0x190,
            hue: 0,
            x: (mob.x | 0) + 1,
            y: mob.y | 0,
            z: mob.z | 0,
            map: mob.map ?? 3,
            hp: 150,
            hpMax: 150,
            str: 110,
            dex: 90,
            int: 80,
            aiBehavior: 'aggressive',
            summoned: true,
            summonedUntil: Date.now() + 5 * 60_000,
            controlMaster: mob.serial,
            servuoClass: 'SummonedPaladin',
            servuoClasses: ['SummonedPaladin', 'CallingTimer'],
          });
          if (paladin) {
            say(mob, 'A summoned paladin answers the Calling of Kronus.');
            try { api.combat?.animate?.(w ?? world, paladin, 0x10, { frameCount: 7 }); } catch { /* advisory */ }
          }
        },
      });
      playSound(api, user, 0x01F3);
      return true;
    },
  };
}

export function buildCaddelliteInfuser(api) {
  function finish(world, item, user, picked) {
    const target = targetItem(api, world, picked);
    if (!target || !isPackedOrWorn({ ...api, world }, target, user)) {
      say(user, 'Target an item in your backpack or equipped on your character.');
      return;
    }
    if (!['weapon', 'armor', 'clothing', 'spellbook', 'tool', 'resource'].includes(target.kind ?? '')
        && !target.weapon && !target.armorAttributes && !target.spellbook && !target.craftingStation) {
      say(user, 'That item cannot hold a Caddellite infusion.');
      return;
    }
    attachCaddellite(target);
    broadcastItemUpdate(api, world, target);
    say(user, `${target.name ?? 'The item'} is now Caddellite infused.`);
    if ((item.amount ?? 1) > 1) item.amount -= 1;
    else destroyItemBySerial({ ...api, world }, item.serial);
  }
  return {
    name: 'caddellite-infuser',
    onCreate(_world, item) {
      ensureClasses(item, ['Caddellite']);
      item.stackable = item.stackable ?? true;
    },
    onUse(world, item, user) {
      ensureClasses(item, ['Caddellite']);
      if (!isInPack({ ...api, world }, item, user)) {
        say(user, 'That must be in your pack for you to use it.');
        return true;
      }
      if (!api.targeting?.request || !user?.client) {
        say(user, 'Targeting unavailable.');
        return true;
      }
      say(user, 'Target an item to infuse with Caddellite.');
      api.targeting.request(user.client, (picked) => finish(world, item, user, picked), { range: 2 });
      return true;
    },
  };
}

export function buildKhaldunTastyTreat(api) {
  return {
    name: 'khaldun-tasty-treat',
    onCreate(_world, item) {
      item.stackable = true;
      ensureClasses(item, ['KhaldunTastyTreat', 'Caddellite']);
    },
    onUse(world, item, user) {
      if (!api.targeting?.request || !user?.client) {
        say(user, 'Targeting unavailable.');
        return true;
      }
      say(user, 'Target one of your bonded pets to infuse it with Caddellite.');
      api.targeting.request(user.client, (picked) => {
        const pet = targetMobile(api, world, picked);
        if (!pet || (pet.controlMaster >>> 0) !== (user.serial >>> 0)) {
          say(user, 'That is not your pet.');
          return;
        }
        if (!pet.bonded) {
          say(user, 'This treat can only be used on a bonded pet.');
          return;
        }
        pet.caddelliteInfusedUntil = Date.now() + 30 * 60_000;
        ensureClasses(pet, ['Caddellite', 'KhaldunTastyTreat']);
        say(user, 'Your pet is now Caddellite infused by this treat.');
        if ((item.amount ?? 1) > 1) item.amount -= 1;
        else destroyItemBySerial({ ...api, world }, item.serial);
      }, { range: 12 });
      return true;
    },
  };
}

export function buildObsidianStatue(api) {
  function updateVisual(item) {
    const qty = Math.max(1, Math.min(10, item.obsidianQuantity ?? item.quantity ?? 1));
    item.obsidianQuantity = qty;
    item.quantity = qty;
    item.itemId = qty < 2 ? 0x1EA7 : (qty < 10 ? 0x1F13 : 0x12CB);
    if (qty >= 10) {
      item.name = `an obsidian statue of ${item.obsidianStatueName ?? 'an adventurer'}`;
    } else if (qty >= 2) {
      item.name = 'a partially reconstructed obsidian statue';
    } else {
      item.name = 'a section of an obsidian statue';
    }
  }
  function combine(world, item, user, picked) {
    const other = targetItem(api, world, picked);
    if (!other || other === item || other.script !== 'obsidian-statue') {
      say(user, 'Target another section of an obsidian statue.');
      return;
    }
    if (!isInPack({ ...api, world }, item, user) || !isInPack({ ...api, world }, other, user)) {
      say(user, 'Both statue sections must be in your backpack.');
      return;
    }
    updateVisual(item);
    updateVisual(other);
    const space = 10 - other.obsidianQuantity;
    const move = Math.min(space, item.obsidianQuantity);
    if (move <= 0) {
      say(user, 'The statue cannot be improved any further.');
      return;
    }
    other.obsidianQuantity += move;
    if (other.obsidianQuantity >= 10 && !other.obsidianStatueName) {
      other.obsidianStatueName = OBSIDIAN_NAMES[(Math.random() * OBSIDIAN_NAMES.length) | 0]
        || user?.name
        || 'an adventurer';
    }
    item.obsidianQuantity -= move;
    updateVisual(other);
    broadcastItemUpdate(api, world, other);
    if (item.obsidianQuantity <= 0) destroyItemBySerial({ ...api, world }, item.serial);
    else {
      updateVisual(item);
      broadcastItemUpdate(api, world, item);
    }
    say(user, 'You fit the obsidian pieces together.');
  }
  return {
    name: 'obsidian-statue',
    onCreate(_world, item) {
      ensureClasses(item, ['Obsidian', 'DisassembleEntry']);
      updateVisual(item);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['Obsidian', 'DisassembleEntry']);
      updateVisual(item);
      if (item.obsidianQuantity >= 10) {
        say(user, 'Nothing happens.');
        return true;
      }
      if (!isInPack({ ...api, world }, item, user)) {
        say(user, 'Nothing happens.');
        return true;
      }
      if (!api.targeting?.request || !user?.client) {
        say(user, 'Targeting unavailable.');
        return true;
      }
      say(user, 'Target another obsidian statue section to reconstruct it.');
      api.targeting.request(user.client, (picked) => combine(world, item, user, picked));
      return true;
    },
  };
}

export function buildSecretWall(api) {
  return {
    name: 'secret-wall',
    onCreate(_world, item) {
      item.movable = false;
      item.secretWallLocked ??= true;
      item.secretWallActive ??= true;
      ensureClasses(item, ['SecretWall']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['SecretWall']);
      const dist = Math.max(Math.abs((item.x | 0) - (user?.x | 0)), Math.abs((item.y | 0) - (user?.y | 0)));
      if (dist > 2) {
        say(user, 'That is too far away.');
        return true;
      }
      if (item.secretWallLocked || item.secretWallActive === false) {
        say(user, 'This door appears to be locked.');
        return true;
      }
      const dest = item.secretWallDest ?? item.teleportTo;
      if (!dest) {
        say(user, 'The secret wall has no destination.');
        return true;
      }
      api.game?.mobile?.teleport?.(user, {
        x: dest.x | 0, y: dest.y | 0, z: dest.z | 0, map: dest.map ?? user.map ?? 1,
      }, { refresh: user?.client, state: user?.client });
      say(user, 'The wall becomes transparent, and you push your way through it.');
      return true;
    },
  };
}

export function buildSecretSwitch(api) {
  function lockAgain(world, item) {
    const wall = itemBySerial({ ...api, world }, item.secretWallSerial);
    if (item.secretSwitchOn && item.secretSwitchReturnId != null) item.itemId = item.secretSwitchReturnId;
    item.secretSwitchOn = false;
    if (wall) {
      wall.secretWallLocked = true;
      broadcastItemUpdate(api, world, wall);
    }
    broadcastItemUpdate(api, world, item);
  }
  return {
    name: 'secret-switch',
    onCreate(_world, item) {
      item.movable = false;
      item.secretSwitchOn ??= false;
      item.secretSwitchBaseId ??= item.itemId;
      item.secretSwitchReturnId ??= item.itemId;
      ensureClasses(item, ['SecretSwitch']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['SecretSwitch']);
      const wall = itemBySerial({ ...api, world }, item.secretWallSerial);
      if (!wall) {
        say(user, 'You hear a faint click, but nothing happens.');
        return true;
      }
      item.secretSwitchOn = !item.secretSwitchOn;
      item.itemId += item.secretSwitchOn ? 1 : -1;
      wall.secretWallLocked = !item.secretSwitchOn;
      broadcastItemUpdate(api, world, item);
      broadcastItemUpdate(api, world, wall);
      if (Math.random() < 0.5) {
        dealDamage(api, world, user, 4 + ((Math.random() * 5) | 0), item, { energy: 100 });
        playSound(api, user, 0x0229);
      }
      say(user, 'You hear a click behind the wall.');
      const handle = setTimeout(() => lockAgain(world, item), 10_000);
      if (handle?.unref) handle.unref();
      return true;
    },
  };
}

export function buildShimmeringCrystals(_api) {
  return {
    name: 'shimmering-crystals',
    onCreate(_world, item) {
      if (!SHIMMERING_IDS.includes(item.itemId | 0)) {
        item.itemId = SHIMMERING_IDS[(Math.random() * SHIMMERING_IDS.length) | 0];
      }
      item.name ??= 'Shimmering Crystals';
      item.forceShowProperties = true;
      ensureClasses(item, ['ShimmeringCrystals']);
    },
  };
}

export function buildMaabusCoffin(api) {
  return {
    name: 'maabus-coffin',
    onCreate(_world, item) {
      item.movable = false;
      item.maabusFullItemId ??= item.itemId;
      item.maabusEmptyItemId ??= item.emptyItemId ?? item.itemId;
      ensureClasses(item, ['MaabusCoffin', 'MaabusCoffinComponent']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['MaabusCoffin', 'MaabusCoffinComponent', 'Maabus']);
      if (item.maabusMobileSerial && mobileBySerial({ ...api, world }, item.maabusMobileSerial)) {
        say(user, 'The coffin is already stirring.');
        return true;
      }
      const loc = item.maabusSpawnLocation ?? { x: (item.x | 0) + 1, y: item.y | 0, z: item.z | 0, map: item.map ?? 1 };
      item.itemId = item.maabusEmptyItemId ?? item.itemId;
      broadcastItemUpdate(api, world, item);
      const maabus = createMobile(api, world, {
        kind: 'maabus',
        name: 'Maabus',
        body: 0x190,
        x: loc.x | 0,
        y: loc.y | 0,
        z: loc.z | 0,
        map: loc.map ?? item.map ?? 1,
        hp: 120,
        hpMax: 120,
        str: 90,
        dex: 80,
        int: 90,
        aiBehavior: 'wander',
        servuoClass: 'Maabus',
        servuoClasses: ['Maabus', 'MaabusCoffin'],
      });
      item.maabusMobileSerial = maabus?.serial ?? 0;
      say(user, 'The coffin opens and Maabus rises.');
      makeFreeTimer(api, world, maabus, 10_000, () => {
        item.maabusMobileSerial = 0;
        item.itemId = item.maabusFullItemId ?? item.itemId;
        broadcastItemUpdate(api, world, item);
      });
      return true;
    },
  };
}

export function buildPowderOfFortifying(api) {
  function canFortify(target) {
    if (!target) return false;
    if (target.canFortify === false) return false;
    if (target.brittle || target.attributes?.brittle || target.negativeAttributes?.brittle) return false;
    return target.durabilityMax != null
      || target.durability != null
      || target.kind === 'weapon'
      || target.kind === 'armor'
      || target.weapon
      || target.armorAttributes;
  }
  function fortify(world, powder, user, picked) {
    const target = targetItem(api, world, picked);
    if (!target || !isPackedOrWorn({ ...api, world }, target, user) || !canFortify(target)) {
      say(user, 'You cannot use the powder on that item.');
      return;
    }
    const cap = target.antique ? (target.antique === 1 ? 250 : target.antique === 2 ? 200 : 150) : 255;
    target.durabilityMax ??= target.durability ?? 100;
    target.durability ??= target.durabilityMax;
    if (target.durabilityMax >= cap) {
      say(user, 'The item cannot be improved any further.');
      return;
    }
    const bonus = target.antique ? (cap - target.durabilityMax) : Math.min(10, cap - target.durabilityMax);
    target.durabilityMax = Math.min(cap, target.durabilityMax + bonus);
    target.durability = Math.min(target.durabilityMax, target.durability + bonus);
    target.canFortify = true;
    ensureClasses(target, ['IDurability', 'IWearableDurability']);
    powder.charges = Math.max(0, (powder.charges ?? 10) - 1);
    say(user, 'You successfully use the powder on the item.');
    playSound(api, user, 0x0247);
    broadcastItemUpdate(api, world, target);
    if (powder.charges <= 0) {
      say(user, 'You have used up your powder of fortifying.');
      destroyItemBySerial({ ...api, world }, powder.serial);
    }
  }
  return {
    name: 'powder-of-fortifying',
    onCreate(_world, item) {
      item.charges ??= 10;
      ensureClasses(item, ['PowderOfTemperament', 'IDurability', 'IWearableDurability']);
    },
    onUse(world, item, user) {
      if (!isInPack({ ...api, world }, item, user)) {
        say(user, 'That must be in your pack for you to use it.');
        return true;
      }
      if (!api.targeting?.request || !user?.client) {
        say(user, 'Targeting unavailable.');
        return true;
      }
      say(user, 'Target the durable item to fortify.');
      api.targeting.request(user.client, (picked) => fortify(world, item, user, picked), { range: 2 });
      return true;
    },
  };
}

function registerPetWhistleCommandOnce(api) {
  if (!api.commands || PET_WHISTLE_COMMAND_APIS.has(api)) return;
  PET_WHISTLE_COMMAND_APIS.add(api);
  api.commands.register({
    name: 'petwhistle',
    help: '[petwhistle <serial?> attack|block|playdead|settle|wait|eat|alert|link',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const args = ctx.args ?? [];
      let action = args[0]?.toLowerCase();
      let whistle = null;
      if (/^\d+$/.test(action ?? '')) {
        whistle = itemBySerial(api, Number(action));
        action = args[1]?.toLowerCase();
      }
      whistle ??= findInPack(api, mob, (it) => it.script === 'pet-whistle' && it.petWhistlePetSerial);
      if (!whistle) {
        ctx.state.sendSystemMessage('No linked pet whistle found in your backpack.');
        return;
      }
      const pet = mobileBySerial(api, whistle.petWhistlePetSerial);
      if (!pet || (pet.controlMaster >>> 0) !== (mob.serial >>> 0)) {
        ctx.state.sendSystemMessage('The linked pet is not available.');
        return;
      }
      if (pet.controlOrder !== 'stay' && pet.petCommand !== 'stay') {
        ctx.state.sendSystemMessage('You must command your pet to stay before using this item.');
      }
      const anim = {
        attack: 0x09,
        block: 0x1B,
        playdead: 0x16,
        settle: 0x14,
        wait: 0x05,
        eat: 0x22,
        alert: 0x04,
      }[action ?? 'alert'];
      try { api.combat?.animate?.(api.world, pet, anim, { frameCount: 5 }); } catch { /* advisory */ }
      playSound(api, mob, 1665);
      ctx.state.sendSystemMessage(`Pet whistle: ${action ?? 'alert'}.`);
    },
  });
}

export function buildPetWhistle(api) {
  registerPetWhistleCommandOnce(api);
  function link(world, item, user, picked) {
    const pet = targetMobile(api, world, picked);
    if (!pet || (pet.controlMaster >>> 0) !== (user.serial >>> 0)) {
      say(user, 'Invalid target.');
      return;
    }
    if (!pet.bonded) {
      say(user, 'This item can only be linked to a bonded pet.');
      return;
    }
    const now = Date.now();
    if ((item.petWhistleNextLinkAt ?? 0) > now) {
      const left = Math.ceil((item.petWhistleNextLinkAt - now) / 1000);
      say(user, left > 60
        ? `You must wait ${Math.ceil(left / 60)} minutes before you can link another pet to this whistle.`
        : `You must wait ${left} seconds before you can link another pet to this whistle.`);
      return;
    }
    item.petWhistlePetSerial = pet.serial;
    item.petWhistlePetName = pet.name ?? 'pet';
    item.petWhistleAccount = user.accountName ?? user.client?.account?.username ?? item.petWhistleAccount ?? '';
    item.petWhistleNextLinkAt = now + 7 * 24 * 60 * 60_000;
    ensureClasses(item, ['PetWhistle', 'PetWhistleGump', 'LinkBondedPetEntry']);
    say(user, `Pet whistle linked to ${item.petWhistlePetName}.`);
  }
  return {
    name: 'pet-whistle',
    onCreate(_world, item) {
      item.blessed = true;
      ensureClasses(item, ['PetWhistle', 'PetWhistleGump', 'LinkBondedPetEntry']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['PetWhistle', 'PetWhistleGump', 'LinkBondedPetEntry']);
      const account = user?.accountName ?? user?.client?.account?.username ?? '';
      if (item.petWhistleAccount && account && item.petWhistleAccount !== account) {
        say(user, 'This item is Account Bound, you are not permitted to take this action.');
        return true;
      }
      if (!isInPack({ ...api, world }, item, user)) {
        say(user, 'This item must be in your backpack to be used.');
        return true;
      }
      if (!item.petWhistlePetSerial) {
        if (!api.targeting?.request || !user?.client) {
          say(user, 'Targeting unavailable.');
          return true;
        }
        say(user, 'Target a bonded pet to link this whistle.');
        api.targeting.request(user.client, (picked) => link(world, item, user, picked), { range: 12 });
        return true;
      }
      const pet = mobileBySerial({ ...api, world }, item.petWhistlePetSerial);
      if (!pet) {
        say(user, 'The linked pet is not available.');
        return true;
      }
      playSound(api, user, 1665);
      say(user, `Pet Whistle for ${pet.name ?? item.petWhistlePetName ?? 'pet'}.`);
      say(user, `Use [petwhistle ${item.serial} attack|block|playdead|settle|wait|eat|alert.`);
      return true;
    },
  };
}

export function buildGiftBoxNeon(_api) {
  const hues = [0x438, 0x424, 0x433, 0x445, 0x42B, 0x448];
  return {
    name: 'gift-box-neon',
    onCreate(_world, item) {
      item.container = true;
      item.gumpId ??= 0x003E;
      item.capacity ??= 125;
      item.maxWeight ??= 400;
      item.hue = item.hue || hues[(Math.random() * hues.length) | 0];
      item.flipIds ??= [0x232A, 0x232B];
      ensureClasses(item, ['GiftBoxNeon', 'GiftBoxHues', 'FlipableAttribute']);
    },
  };
}

export function buildTormentedChains(_api) {
  return {
    name: 'tormented-chains',
    onCreate(_world, item) {
      if (item.itemId !== 6663 && item.itemId !== 6664) item.itemId = 6663 + ((Math.random() * 2) | 0);
      item.name ??= 'chains of the tormented';
      item.weight ??= 1;
      ensureClasses(item, ['TormentedChains']);
    },
  };
}

function digitsFromArgs(args) {
  const joined = args.join('').replace(/\D/g, '');
  if (joined.length !== 5) return null;
  return [...joined].map((ch) => Number(ch));
}

function sameKey(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 5 || b.length !== 5) return false;
  return a.every((n, i) => (n | 0) === (b[i] | 0));
}

function ensureSecretChest(item, owner = null) {
  if (!item) return;
  item.container = true;
  item.gumpId ??= 0x058E;
  item.capacity ??= 125;
  item.maxWeight ??= 400;
  item.secretKey ??= [0, 0, 0, 0, 0];
  item.secretChestAccess ??= [];
  item.secretChestTrials ??= {};
  item.secretChestExpiresAt ??= Date.now() + 24 * 60 * 60_000;
  item.ownerSerial ??= owner?.serial;
  ensureClasses(item, ['SecretChest', 'SecretChestArray', 'SecretChestGump', 'SetEditKeyNumber', 'ResetKeyNumber']);
}

function registerSecretChestCommandOnce(api) {
  if (!api.commands || SECRET_CHEST_COMMAND_APIS.has(api)) return;
  SECRET_CHEST_COMMAND_APIS.add(api);
  api.commands.register({
    name: 'secretchest',
    help: '[secretchest <serial> set|reset|try <5 digits> — configure or unlock a Secret Chest.',
    access: 'Player',
    run(ctx) {
      const [serialArg, subRaw, ...rest] = ctx.args ?? [];
      const chest = itemBySerial(api, Number(serialArg));
      const sub = String(subRaw ?? '').toLowerCase();
      if (!chest || chest.script !== 'secret-chest') {
        ctx.state.sendSystemMessage('Usage: [secretchest <serial> set|reset|try <5 digits>');
        return;
      }
      ensureSecretChest(chest, ctx.sender);
      const isOwner = !chest.ownerSerial || (chest.ownerSerial >>> 0) === (ctx.sender.serial >>> 0)
        || ctx.sender.accessLevel === 'GM' || ctx.sender.accessLevel === 'Admin';
      if (sub === 'reset') {
        if (!isOwner) { ctx.state.sendSystemMessage('Only the owner can reset that key.'); return; }
        chest.secretKey = [0, 0, 0, 0, 0];
        chest.secretChestAccess = [];
        chest.locked = true;
        ctx.state.sendSystemMessage('Secret chest key reset.');
        return;
      }
      const digits = digitsFromArgs(rest);
      if (!digits) {
        ctx.state.sendSystemMessage('Enter exactly five digits.');
        return;
      }
      if (sub === 'set') {
        if (!isOwner) { ctx.state.sendSystemMessage('Only the owner can set that key.'); return; }
        chest.secretKey = digits;
        chest.locked = true;
        chest.secretChestAccess = [];
        ctx.state.sendSystemMessage('Secret chest key updated.');
        return;
      }
      if (sub === 'try' || sub === 'open') {
        const player = ctx.sender.serial >>> 0;
        const trials = chest.secretChestTrials ?? {};
        const used = trials[player] | 0;
        if (used >= 3) { ctx.state.sendSystemMessage('You have no attempts left for this chest.'); return; }
        if (!sameKey(chest.secretKey, digits)) {
          trials[player] = used + 1;
          chest.secretChestTrials = trials;
          ctx.state.sendSystemMessage(`Incorrect key. Attempts left: ${Math.max(0, 3 - trials[player])}.`);
          return;
        }
        chest.locked = false;
        chest.secretChestAccess = [...new Set([...(chest.secretChestAccess ?? []), player])];
        ctx.state.sendSystemMessage('The secret chest unlocks for you.');
        return;
      }
      ctx.state.sendSystemMessage('Usage: [secretchest <serial> set|reset|try <5 digits>');
    },
  });
}

export function buildSecretChest(api) {
  registerSecretChestCommandOnce(api);
  return {
    name: 'secret-chest',
    onCreate(_world, item) {
      ensureSecretChest(item);
      item.locked ??= true;
      item.flipIds ??= [0x9707, 0x9706];
    },
    onUse(_world, item, user) {
      ensureSecretChest(item, user);
      if (!item.locked) {
        say(user, 'The secret chest is unlocked.');
        return false;
      }
      if ((item.ownerSerial >>> 0) === (user?.serial >>> 0)) {
        say(user, `Use [secretchest ${item.serial} set 12345 to set its key.`);
      } else {
        say(user, `Use [secretchest ${item.serial} try 12345 to attempt the key.`);
      }
      return true;
    },
  };
}

function broadcastMobileBody(api, world, mob) {
  const pkt = api.protocol?.mobileMoving?.({
    serial: mob.serial,
    body: mob.body,
    x: mob.x,
    y: mob.y,
    z: mob.z,
    direction: mob.direction,
    hue: mob.hue,
    flags: mob.flags,
    notoriety: mob.notoriety,
  });
  if (!pkt) return;
  for (const other of nearbyClients({ ...api, world }, mob)) {
    try { other.client?.send?.(pkt); } catch { /* socket transient */ }
  }
}

export function buildServUOEthereal(api) {
  return {
    name: 'servuo-ethereal',
    onCreate(_world, item) {
      item.ethereal ??= { kind: item.mountKind ?? item.mount ?? 'horse', hue: item.hue ?? 0, summoned: false };
      item.mountKind ??= item.ethereal.kind;
      item.blessed = item.blessed ?? true;
      item.weight ??= 5;
      ensureClasses(item, ['GMEthereal', 'GMEthVirtual', 'EtherealMount']);
    },
    onUse(world, item, user) {
      ensureClasses(item, ['GMEthereal', 'GMEthVirtual', 'EtherealMount']);
      if (!isInPack({ ...api, world }, item, user)) {
        say(user, 'That must be in your backpack to use it.');
        return true;
      }
      if (item.staffOnly && user?.accessLevel !== 'GM' && user?.accessLevel !== 'Admin' && user?.accessLevel !== 'Counselor') {
        say(user, 'This item is to only be used by staff members.');
        destroyItemBySerial({ ...api, world }, item.serial);
        return true;
      }
      const kind = item.mountKind ?? item.mount ?? item.ethereal?.kind ?? 'horse';
      if (item.ethereal?.summoned && item.etherealMountSerial) {
        const mount = mobileBySerial({ ...api, world }, item.etherealMountSerial);
        if (mount) destroyMobileBySerial({ ...api, world }, mount.serial);
        item.ethereal.summoned = false;
        item.etherealMountSerial = 0;
        user.body = user.mountedOriginalBody ?? user.body;
        delete user.mountedOriginalBody;
        delete user.mountedFrom;
        user.mounted = false;
        broadcastMobileBody(api, world, user);
        say(user, 'You dismount from the ethereal mount.');
        return true;
      }
      if (user.mountedFrom || user.mounted) {
        say(user, 'You are already mounted.');
        return true;
      }
      const mount = createMobile(api, world, {
        kind: `ethereal-${kind}`,
        name: `ethereal ${String(kind).replace(/-/g, ' ')}`,
        body: ETHEREAL_MOUNT_BODY[kind] ?? 0x00E2,
        hue: item.hue || 0x4001,
        x: user.x,
        y: user.y,
        z: user.z,
        map: user.map ?? 1,
        controlMaster: user.serial,
        ethereal: true,
        mounted: true,
        hidden: true,
        servuoClass: item.servuoClass ?? 'GMEthereal',
        servuoClasses: ['GMEthereal', 'GMEthVirtual', 'EtherealMount'],
      });
      user.mountedOriginalBody = user.body;
      user.body = ETHEREAL_RIDER_BODY[kind] ?? 0x00E2;
      user.mountedFrom = mount?.serial ?? item.serial;
      user.mounted = true;
      item.ethereal = { kind, hue: item.hue ?? 0, summoned: true };
      item.etherealMountSerial = mount?.serial ?? 0;
      broadcastMobileBody(api, world, user);
      say(user, `You mount ${item.name ?? 'the ethereal mount'}.`);
      return true;
    },
  };
}

export function buildServUOFreeTimer(api) {
  return {
    name: 'servuo-free-timer',
    onCreate(world, item) {
      ensureClasses(item, ['EffectItem', 'EffectMobile', 'FreeTimer']);
      const ttl = item.freeAfterMs ?? item.durationMs ?? 0;
      if (ttl > 0) makeFreeTimer(api, world, item, ttl);
    },
  };
}

export function buildServUOP1Marker(_api) {
  return {
    name: 'servuo-p1-marker',
    onCreate(_world, item) {
      ensureClasses(item, ServUOItemParityClasses);
    },
  };
}

export function registerServUOP1Commands(api) {
  if (!api.commands || P1_COMMAND_APIS.has(api)) return;
  P1_COMMAND_APIS.add(api);

  api.commands.register({
    name: 'obsidian',
    help: '[obsidian disassemble <serial> — split a partial Obsidian statue.',
    access: 'Player',
    run(ctx) {
      const [sub, serialArg] = ctx.args ?? [];
      if (String(sub ?? '').toLowerCase() !== 'disassemble') {
        ctx.state.sendSystemMessage('Usage: [obsidian disassemble <serial>');
        return;
      }
      const item = itemBySerial(api, Number(serialArg));
      if (!item || item.script !== 'obsidian-statue' || !isInPack(api, item, ctx.sender)) {
        ctx.state.sendSystemMessage('Target a partial obsidian statue in your backpack.');
        return;
      }
      const qty = item.obsidianQuantity ?? item.quantity ?? 1;
      if (qty < 2 || qty >= 10) {
        ctx.state.sendSystemMessage('That statue cannot be disassembled.');
        return;
      }
      item.obsidianQuantity = 1;
      item.quantity = 1;
      item.itemId = 0x1EA7;
      item.name = 'a section of an obsidian statue';
      for (let i = 0; i < qty - 1; i++) {
        api.game?.mobile?.giveItem?.(ctx.sender, {
          itemId: 0x1EA7,
          name: 'a section of an obsidian statue',
          script: 'obsidian-statue',
          obsidianQuantity: 1,
          servuoClass: 'Obsidian',
          servuoClasses: ['Obsidian', 'DisassembleEntry'],
        }, { randomGrid: true });
      }
      ctx.state.sendSystemMessage('You disassemble the obsidian statue sections.');
    },
  });

  api.commands.register({
    name: 'caddellite',
    help: '[caddellite status — show whether your equipped gear is Caddellite infused.',
    access: 'Player',
    run(ctx) {
      const item = caddelliteEquippedBy(api, ctx.sender);
      ctx.state.sendSystemMessage(item
        ? `Caddellite infused: ${item.name ?? item.serial}.`
        : 'No Caddellite infused item equipped.');
      updateCaddelliteBuff(api, ctx.sender);
    },
  });
}
