// FAZA FG — Treasure chest lifecycle.
//
// ServUO `Items/Special/TreasureChestLevel*.cs`: locked + trapped
// chests guarding a level-tiered loot table. We bind the script to
// items the dig command spawns — onUse triggers a "first opener"
// loot roll if the chest is unlocked, then transitions to a normal
// container.
//
// Item shape:
//   item.script = 'treasure-chest'
//   item.locked = true | false
//   item.trapped = { damage, level } | null
//   item.treasureLevel = 1..7
//   item.treasureLooted = boolean (set after first roll)

import { childrenOf } from '../../../_inventory.js';
import { nearbyClients } from '../../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../../_items.js';

function randomMs(minMinutes, maxMinutes) {
  const min = Math.max(1, minMinutes | 0);
  const max = Math.max(min, maxMinutes | 0);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 60_000;
}

function clearContents(api, world, chest) {
  for (const child of [...childrenOf({ world }, chest)]) {
    try { destroyItemBySerial(api, child.serial); } catch { /* ignore */ }
  }
}

function treasureGoldRange(level) {
  switch (level | 0) {
    case 1: return [100, 300];
    case 2: return [300, 600];
    case 3: return [600, 900];
    case 4: return [900, 1200];
    case 5: return [1200, 5000];
    case 6: return [5000, 9000];
    default: return [200 * level, 600 * level];
  }
}

function fillTreasure(api, world, item, all = true) {
  const level = Math.max(1, item.treasureLevel ?? item.treasureChestLevel ?? item.trapped?.level ?? 1);
  const [minGold, maxGold] = treasureGoldRange(level);
  const goldAmt = minGold + Math.floor(Math.random() * (maxGold - minGold + 1));
  createItem(api, world, {
    itemId: 0x0EED, amount: goldAmt,
    x: 0, y: 0, z: 0, map: item.map,
    parent: item.serial, name: 'gold', movable: true,
  });
  if (all && level >= 3) {
    createItem(api, world, {
      itemId: 0x0F0A, amount: level,
      x: 0, y: 0, z: 0, map: item.map,
      parent: item.serial, hue: 0x481, name: 'a magic gem', movable: true,
    });
  }
}

function resetTreasureChest(api, world, item) {
  clearContents(api, world, item);
  item.locked = true;
  item.treasureLooted = false;
  item.treasureResetAt = 0;
  item.name = 'a locked treasure chest';
  fillTreasure(api, world, item, true);
}

export default function buildTreasureChestScript(api) {
  return {
    name: 'treasure-chest',
    hasTick: true,
    onCreate(world, item) {
      item.container = true;
      item.gumpId ||= 0x0048;
      item.movable = false;
      item.servuoClasses ??= [
        item.servuoClass,
        'BaseTreasureChest',
        item.treasureChestMod ? 'BaseTreasureChestMod' : null,
        'TreasureResetTimer',
        'ChestTimer',
      ].filter(Boolean);
      item.treasureMinSpawnMinutes ??= 10;
      item.treasureMaxSpawnMinutes ??= 60;
      if (!item.treasureLooted && ![...childrenOf({ world }, item)].length) {
        fillTreasure(api, world, item, true);
      }
    },
    onUse(world, item, user) {
      if (item.locked) {
        user?.client?.sendSystemMessage?.('It is locked.');
        return true;
      }
      if (!item.treasureResetAt && !item.treasureDeleteAt) {
        if (item.treasureChestMod) {
          item.treasureDeleteAt = Date.now() + randomMs(2, 5);
        } else {
          item.treasureResetAt = Date.now() + randomMs(
            item.treasureMinSpawnMinutes ?? 10,
            item.treasureMaxSpawnMinutes ?? 60,
          );
        }
      }
      if (item.trapped) {
        const dmg = (item.trapped.damage | 0) * (item.trapped.level | 0);
        user?.client?.sendSystemMessage?.(`A trap detonates! (-${dmg} hp)`);
        if (user.hp != null) {
          user.hp = Math.max(0, user.hp - dmg);
          if (user.client && api.protocol?.healthUpdate) {
            user.client.send(api.protocol.healthUpdate({
              serial: user.serial, current: user.hp, max: user.hpMax ?? 50,
            }));
          }
        }
        delete item.trapped;
        return true;
      }
      if (item.treasureLooted) return false;     // fall through to normal open
      if (![...childrenOf({ world }, item)].length) fillTreasure(api, world, item, true);
      item.treasureLooted = true;
      item.name = 'a treasure chest';
      // Visibility-gated message.
      const m = api.protocol?.unicodeMessage?.({
        serial: item.serial, graphic: item.itemId, type: 0,
        hue: 0x44, font: 3, name: 'chest', text: 'You unlock the treasures within.',
      });
      if (m) for (const obs of nearbyClients(world, item)) obs.client.send(m);
      return false; // let normal container open follow
    },
    onTick(world, item) {
      const now = Date.now();
      if (item.treasureDeleteAt && now >= item.treasureDeleteAt) {
        destroyItemBySerial(api, item.serial);
        return;
      }
      if (item.treasureResetAt && now >= item.treasureResetAt) {
        resetTreasureChest(api, world, item);
      }
    },
  };
}
