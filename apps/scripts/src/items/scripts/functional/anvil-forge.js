import { equipped } from '../../../_inventory.js';
import { destroyItemBySerial } from '../../../_items.js';
import { effectiveSkill } from '../../../_rules.js';
import { broadcastItemUpdate } from '../_shared/broadcast.js';

// Anvil + Forge + crafting station scripts. Mirrors ServUO's Anvil /
// Forge / TinkerTools / TailorTools / etc. — when a player double-clicks
// the station, route to the appropriate crafting menu (existing `craft`
// command handles the actual recipes).
//
// One builder per role; index.js imports each builder, builds it with
// `api`, and registers under that role name.

const SKILL_TACTICS = 28;
const SKILL_ARCHERY = 32;
const SKILL_WRESTLING = 44;
const TRAINING_DUMMY_SOUNDS = [0x3A4, 0x3A6, 0x3A9, 0x3AE, 0x3B4, 0x3B6];
const CRAFT_ADDON_MAX_USES = 5000;
const CRAFT_SKILL_ALIAS = {
  Blacksmithy: 'blacksmithing',
  Tailoring: 'tailoring',
  Cooking: 'cooking',
  Tinkering: 'tinkering',
  Carpentry: 'carpentry',
  Inscription: 'inscription',
  Alchemy: 'alchemy',
  'Bowcraft/Fletching': 'fletching',
};
const STATION_TOOL_ALIASES = {
  Blacksmithy: ['smith', 'smithing', 'blacksmith', 'blacksmithing', 'blacksmithy'],
  Tailoring: ['tailor', 'tailoring', 'sewing'],
  Cooking: ['cook', 'cooking'],
  Tinkering: ['tinker', 'tinkering'],
  Carpentry: ['carp', 'carpentry', 'carpenter'],
  Inscription: ['inscribe', 'inscription', 'scribe'],
  Alchemy: ['alch', 'alchemy', 'glass', 'glassblowing', 'glassblow'],
  'Bowcraft/Fletching': ['fletch', 'fletching', 'bowcraft', 'fletcher'],
};

function distance(a, b) {
  return Math.max(
    Math.abs((a?.x ?? 0) - (b?.x ?? 0)),
    Math.abs((a?.y ?? 0) - (b?.y ?? 0)),
  );
}

function trainingRange(item) {
  const minSkill = item.training?.minSkill ?? -25;
  const maxSkill = item.training?.maxSkill ?? 25;
  return { minSkill, maxSkill };
}

function currentWeapon(api, user) {
  if (user?._weapon) return user._weapon;
  for (const item of equipped(api, user)) {
    if ((item.layer === 1 || item.layer === 2) && item.weapon) return item.weapon;
  }
  return { skill: SKILL_WRESTLING, range: 1 };
}

function trainingSkillName(skillId) {
  switch (skillId | 0) {
    case 41: return 'Swordsmanship';
    case 42: return 'Mace Fighting';
    case 43: return 'Fencing';
    case SKILL_ARCHERY: return 'Archery';
    case 58: return 'Throwing';
    case SKILL_WRESTLING:
    default: return 'Wrestling';
  }
}

function setTrainingSwing(api, world, item, user) {
  const now = Date.now();
  item._trainingDummyBaseItemId ??= item.itemId | 0;
  item._trainingDummySwingUntil = now + 3000;
  item.itemId = (item._trainingDummyBaseItemId | 0) + 1;
  const soundId = TRAINING_DUMMY_SOUNDS[(Math.random() * TRAINING_DUMMY_SOUNDS.length) | 0];
  const pkt = api.protocol?.playSound?.({
    soundId, x: item.x ?? 0, y: item.y ?? 0, z: item.z ?? 0,
  });
  if (pkt) {
    try { user?.client?.send?.(pkt); } catch { /* best effort */ }
  }
  broadcastItemUpdate(api, world, item);
}

function beginSpin(api, world, item) {
  if ((item._spinningWheelSpinningUntil ?? 0) > Date.now()) return;
  item._spinningWheelBaseItemId ??= item.itemId | 0;
  item._spinningWheelSpinningUntil = Date.now() + 6000;
  if ([0x1015, 0x1019, 0x101C, 0x10A4].includes(item.itemId | 0)) item.itemId += 1;
  broadcastItemUpdate(api, world, item);
}

function endSpin(api, world, item) {
  item._spinningWheelSpinningUntil = 0;
  if ([0x1016, 0x101A, 0x101D, 0x10A5].includes(item.itemId | 0)) item.itemId -= 1;
  else if (item._spinningWheelBaseItemId) item.itemId = item._spinningWheelBaseItemId;
  broadcastItemUpdate(api, world, item);
}

function addServuoCraftClasses(item) {
  item.servuoClasses = [...new Set([...(item.servuoClasses ?? []),
    'CraftAddon',
    'AddonToolComponent',
    'ToolDropComponent',
    'SetSecureLevelEntry',
  ])];
}

function makeStation(api, role, skill, message) {
  return {
    name: role,
    onCreate(_world, item) {
      item.movable = false;
      item.forceShowProperties = true;
      item.craftingStation ??= role;
      item.addonCraftSystem ??= skill;
      item.addonToolTurnedOn ??= true;
      item.toolMaxUses ??= CRAFT_ADDON_MAX_USES;
      item.toolUsesRemaining ??= item.usesRemaining ?? 0;
      item.secureLevel ??= 'CoOwners';
      addServuoCraftClasses(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      if (distance(user, item) > 2) {
        user?.client?.sendSystemMessage?.('I am too far away to do that.');
        return true;
      }
      if (item.addonToolTurnedOn === false) {
        user?.client?.sendSystemMessage?.('The power tool is turned off.');
        return true;
      }
      const sysMsg = user?.client?.sendSystemMessage?.bind(user.client);
      sysMsg?.(message);
      const alias = CRAFT_SKILL_ALIAS[skill];
      if (alias && api.commands?.dispatch) {
        api.commands.dispatch(`craft gump ${alias}`, { sender: user, state: user.client, world });
      }
      // Surface a `craft:open` event so future craft UI can latch on.
      api.events?.emit?.('craft:open', {
        player: user, station: role, skill, itemSerial: item.serial,
      });
      return true;
    },
    onDrop(world, item, dropped, dropper) {
      return rechargeCraftAddonTool(api, world, item, dropped, dropper, skill);
    },
  };
}

function rechargeCraftAddonTool(api, world, station, dropped, dropper, stationSkill) {
  addServuoCraftClasses(station);
  if (!isRechargeTool(dropped)) {
    dropper?.client?.sendSystemMessage?.('The container cannot hold that type of object.');
    return { handled: true, consumeHeld: false };
  }
  if (isRunicTool(dropped)) {
    dropper?.client?.sendSystemMessage?.('The container cannot hold that type of object.');
    return { handled: true, consumeHeld: false };
  }
  if (!toolMatchesStation(dropped, stationSkill)) {
    dropper?.client?.sendSystemMessage?.('The container cannot hold that type of object.');
    return { handled: true, consumeHeld: false };
  }
  station.toolMaxUses ??= CRAFT_ADDON_MAX_USES;
  station.toolUsesRemaining ??= station.usesRemaining ?? 0;
  const capacity = Math.max(0, (station.toolMaxUses | 0) - (station.toolUsesRemaining | 0));
  if (capacity <= 0) {
    dropper?.client?.sendSystemMessage?.('Adding this to the power tool would put it over the max number of charges the tool can hold.');
    return { handled: true, consumeHeld: false };
  }
  const uses = toolUses(dropped);
  if (uses <= 0) {
    dropper?.client?.sendSystemMessage?.('The container cannot hold that type of object.');
    return { handled: true, consumeHeld: false };
  }
  const added = Math.min(uses, capacity);
  station.toolUsesRemaining += added;
  station.usesRemaining = station.toolUsesRemaining;
  setToolUses(dropped, uses - added);
  dropper?.client?.sendSystemMessage?.('Charges have been added to the power tool.');
  const pkt = api.protocol?.playSound?.({
    soundId: 0x42, x: station.x ?? 0, y: station.y ?? 0, z: station.z ?? 0,
  });
  if (pkt) {
    try { dropper?.client?.send?.(pkt); } catch { /* advisory */ }
  }
  broadcastItemUpdate(api, world, station);
  if (toolUses(dropped) <= 0) {
    try { destroyItemBySerial({ ...api, world }, dropped.serial); } catch { /* defensive */ }
    return true;
  }
  broadcastItemUpdate(api, world, dropped);
  return { handled: true, consumeHeld: false };
}

function isRechargeTool(item) {
  if (!item) return false;
  return item.kind === 'tool'
    || item.tool
    || item.usesRemaining != null
    || item.charges != null
    || item.toolKind != null
    || item.craftingStation != null
    || item.craftSystem != null;
}

function isRunicTool(item) {
  return !!(item?.runicMaterial || item?.runicBudget || item?._runicTool
    || String(item?.category ?? '').toLowerCase().includes('runic'));
}

function toolMatchesStation(tool, stationSkill) {
  const aliases = STATION_TOOL_ALIASES[stationSkill] ?? [];
  const values = [
    tool.toolKind,
    tool.craftSystem,
    tool.craftingStation,
    tool.skill,
    tool.category,
    tool.name,
  ].map((v) => String(v ?? '').toLowerCase());
  return values.some((v) => aliases.some((alias) => v.includes(alias)));
}

function toolUses(tool) {
  return tool?.usesRemaining ?? tool?.tool?.charges ?? tool?.charges ?? 0;
}

function setToolUses(tool, value) {
  const next = Math.max(0, value | 0);
  if (tool.usesRemaining != null) tool.usesRemaining = next;
  else if (tool.tool?.charges != null) tool.tool.charges = next;
  else tool.charges = next;
}

export function buildAnvil(api) {
  return makeStation(api, 'anvil', 'Blacksmithy',
    'You step up to the anvil. Type [craft Blacksmithy to begin.');
}
export function buildForge(api) {
  return makeStation(api, 'forge', 'Blacksmithy',
    'The forge crackles with heat. Type [craft Blacksmithy to begin.');
}
export function buildLoom(api) {
  return makeStation(api, 'loom', 'Tailoring',
    'You sit at the loom. Type [craft Tailoring to begin.');
}
export function buildSpinningWheel(api) {
  const station = makeStation(api, 'spinning-wheel', 'Tailoring',
    'The spinning wheel hums. Type [craft Tailoring to begin.');
  return {
    ...station,
    hasTick: true,
    onCreate(world, item) {
      station.onCreate?.(world, item);
      item.servuoClasses = [...new Set([...(item.servuoClasses ?? []),
        'ISpinningWheel',
        'SpinCallback',
        'SpinTimer',
        'SpinningwheelEastAddon',
        'SpinningwheelEastDeed',
        'SpinningwheelSouthAddon',
        'SpinningwheelSouthDeed',
      ])];
    },
    onUse(world, item, user) {
      const handled = station.onUse?.(world, item, user);
      beginSpin(api, world, item);
      return handled;
    },
    onTick(world, item) {
      if (!item._spinningWheelSpinningUntil || item._spinningWheelSpinningUntil > Date.now()) return false;
      endSpin(api, world, item);
      return true;
    },
  };
}
export function buildOven(api) {
  return makeStation(api, 'oven', 'Cooking',
    'The oven glows with embers. Type [craft Cooking to begin.');
}
export function buildTinkerTools(api) {
  return makeStation(api, 'tinker-tools', 'Tinkering',
    'You unroll the tinker\'s kit. Type [craft Tinkering to begin.');
}
export function buildCarpentryTools(api) {
  return makeStation(api, 'carpentry-tools', 'Carpentry',
    'You select a chisel and saw. Type [craft Carpentry to begin.');
}
export function buildInscriptionTools(api) {
  return makeStation(api, 'inscription-tools', 'Inscription',
    'You sharpen a quill. Type [craft Inscription to begin.');
}
export function buildAlchemyTable(api) {
  return makeStation(api, 'alchemy-table', 'Alchemy',
    'Glass beakers shimmer. Type [craft Alchemy to begin.');
}
export function buildFletchingStation(api) {
  return makeStation(api, 'fletching-station', 'Bowcraft/Fletching',
    'You set out shafts and feathers. Type [craft Bowcraft/Fletching to begin.');
}
export function buildSewingMachine(api) {
  return makeStation(api, 'sewing-machine', 'Tailoring',
    'The sewing machine is ready. Type [craft Tailoring to begin.');
}
export function buildSmithingPress(api) {
  return makeStation(api, 'smithing-press', 'Blacksmithy',
    'The smithing press locks into place. Type [craft Blacksmithy to begin.');
}
export function buildSpinningLathe(api) {
  return makeStation(api, 'spinning-lathe', 'Carpentry',
    'The spinning lathe is ready. Type [craft Carpentry to begin.');
}
export function buildWritingDesk(api) {
  return makeStation(api, 'writing-desk', 'Inscription',
    'The writing desk glows softly. Type [craft Inscription to begin.');
}

export function buildTrainingDummy(api) {
  return {
    name: 'training-dummy',
    hasTick: true,
    onUse(world, item, user) {
      if (!user) return false;
      const now = Date.now();
      const weapon = currentWeapon(api, user);
      const skillId = weapon.skill ?? SKILL_WRESTLING;
      const range = Math.max(1, weapon.range ?? 1);
      const { minSkill, maxSkill } = trainingRange(item);
      if (skillId === SKILL_ARCHERY || range > 1) {
        user.client?.sendSystemMessage?.("You can't practice ranged weapons on this.");
        return true;
      }
      if (distance(user, item) > range) {
        user.client?.sendSystemMessage?.('You are too far away to do that.');
        return true;
      }
      if ((item._trainingDummySwingUntil ?? 0) > now) {
        user.client?.sendSystemMessage?.('You have to wait until it stops swinging.');
        return true;
      }
      if (user.mounted) {
        user.client?.sendSystemMessage?.("You can't practice on this while on a mount.");
        return true;
      }
      if (effectiveSkill(user, skillId) >= maxSkill) {
        user.client?.sendSystemMessage?.(
          'Your skill cannot improve any further by simply practicing with a dummy.',
        );
        return true;
      }
      setTrainingSwing(api, world, item, user);
      user.client?.sendSystemMessage?.(
        `You strike the training dummy. ${trainingSkillName(skillId)} and Tactics sharpen.`,
      );
      api.skillGain?.tryGain?.(user, skillId, minSkill, maxSkill);
      api.skillGain?.tryGain?.(user, SKILL_TACTICS, minSkill, maxSkill);
      api.events?.emit?.('combat:practice', {
        player: user,
        dummy: item,
        skillId,
        minSkill,
        maxSkill,
      });
      return true;
    },
    onTick(world, item) {
      const until = item._trainingDummySwingUntil ?? 0;
      if (!until || until > Date.now()) return false;
      item._trainingDummySwingUntil = 0;
      if (item._trainingDummyBaseItemId) {
        item.itemId = item._trainingDummyBaseItemId;
        broadcastItemUpdate(api, world, item);
      }
      return true;
    },
  };
}

export function buildCampfire(api) {
  return {
    name: 'campfire',
    onUse(world, item, user) {
      if (!user) return false;
      user?.client?.sendSystemMessage?.('You warm yourself by the fire.');
      if (user.hp != null && user.hpMax != null) {
        user.hp = Math.min(user.hpMax, user.hp + 5);
        api.protocol?.broadcastMobileHits?.(user);
      }
      return true;
    },
  };
}

export function buildAnkh(api) {
  return {
    name: 'ankh',
    onUse(world, item, user) {
      if (!user) return false;
      if (user.ghost) {
        try {
          api.commands?.find?.('resurrect')?.run?.({
            sender: user, args: [], state: { sendSystemMessage: () => {} },
          });
        } catch { /* best-effort */ }
        return true;
      }
      user?.client?.sendSystemMessage?.('You feel a surge of divine energy.');
      if (user.mana != null && user.manaMax != null) {
        user.mana = Math.min(user.manaMax, user.mana + 20);
      }
      return true;
    },
  };
}

function isGhost(mob) {
  return mob?.ghost === true || mob?.dead === true || (mob?.hp | 0) <= 0;
}

function ankhDistance(a, b) {
  return Math.max(
    Math.abs((a?.x ?? 0) - (b?.x ?? 0)),
    Math.abs((a?.y ?? 0) - (b?.y ?? 0)),
  );
}

function resurrectFromAnkh(api, world, item, user) {
  if (!user?.client) return false;
  if (ankhDistance(item, user) > 2) {
    user.client.sendSystemMessage?.('That is too far away.');
    return true;
  }
  if (!isGhost(user)) {
    user.client.sendSystemMessage?.('You are not dead, and thus cannot be resurrected!');
    return true;
  }
  const now = Date.now();
  const next = user.ankhNextUseAt ?? user.ankhNextUse ?? 0;
  if (next > now) {
    const seconds = Math.ceil((next - now) / 1000);
    if (seconds >= 60) user.client.sendSystemMessage?.(`You must wait ${Math.ceil(seconds / 60)} minutes before you can use this item.`);
    else user.client.sendSystemMessage?.(`You must wait ${seconds} seconds before you can use this item.`);
    return true;
  }
  const finish = () => {
    user.ankhNextUseAt = Date.now() + 60 * 60 * 1000;
    user.ankhNextUse = user.ankhNextUseAt;
    const corpse = api.corpse ?? api.ctx?.corpse ?? api.systems?.corpse;
    if (corpse?.resurrectMobile) corpse.resurrectMobile(world, user, user);
    else if (api.commands?.find?.('resurrect')) {
      api.commands.find('resurrect')?.run?.({ sender: user, args: [], state: { sendSystemMessage: () => {} } });
    } else {
      user.ghost = false;
      user.dead = false;
      user.hp = Math.max(1, Math.floor((user.hpMax ?? 10) / 2));
      user.mana = 0;
      user.stam = user.stamMax ?? user.stam ?? 0;
    }
    user.client?.sendSystemMessage?.('You have been resurrected.');
  };
  if (!api.gumps?.send) {
    finish();
    return true;
  }
  const layout = [
    '{ resizepic 0 0 5054 330 150 }',
    '{ text 24 18 1152 0 }',
    '{ text 24 48 1153 1 }',
    '{ button 24 102 4023 4024 1 0 1 }',
    '{ text 62 104 1153 2 }',
    '{ button 174 102 4017 4018 1 0 0 }',
    '{ text 212 104 1153 3 }',
  ].join('');
  api.gumps.send(user.client, {
    gumpId: 0xA9000201,
    x: 140,
    y: 120,
    layout,
    texts: ['Ankh of Sacrifice', 'Do you wish to be resurrected?', 'Accept', 'Decline'],
  }, (resp) => {
    const b = resp?.buttonId | 0;
    if (b === 1 || b === 2) finish();
  });
  return true;
}

export function buildAnkhOfSacrifice(api) {
  return {
    name: 'ankh-of-sacrifice',
    onCreate(_world, item) {
      item.movable = false;
      item.labelNumber ??= 1027772;
      item.forceShowProperties = true;
      item.servuoClass ??= 'AnkhOfSacrificeComponent';
      item.servuoClasses = [...new Set([
        ...(item.servuoClasses ?? []),
        'AnkhOfSacrificeComponent',
        'AnkhOfSacrificeAddon',
        'AnkhOfSacrificeDeed',
        'LockKarmaEntry',
        'AnkhResurrectGump',
      ])];
    },
    onUse(world, item, user) {
      if (!user?.client) return false;
      if (isGhost(user)) return resurrectFromAnkh(api, world, item, user);
      if (ankhDistance(item, user) > 2) {
        user.client.sendSystemMessage?.('That is too far away.');
        return true;
      }
      user.karmaLocked = !user.karmaLocked;
      user.KarmaLocked = user.karmaLocked;
      user.client.sendSystemMessage?.(user.karmaLocked
        ? 'Your karma has been locked. Your karma can no longer be raised.'
        : 'Your karma has been unlocked. Your karma can be raised again.');
      return true;
    },
    onWalkOn(world, item, mob) {
      if (!isGhost(mob)) return false;
      if (ankhDistance(item, mob) > 1) return false;
      return resurrectFromAnkh(api, world, item, mob);
    },
  };
}

export function buildBookshelf(_api) {
  return {
    name: 'bookshelf',
    onUse(world, item, user) {
      user?.client?.sendSystemMessage?.('A row of weathered tomes — pick one to read.');
      return true;
    },
  };
}
