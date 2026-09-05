// PHASE EC — `[trapkit` Tinkering activity. Players craft a deployable
// trap from ingots that, when placed, explodes on the next mobile to
// step on it. Mirrors ServUO `Engines/Tinkering/Trapkit.cs`. We reuse
// the existing pressure-plate lifecycle script as the trap's runtime.

import { allItems, nearbyClients } from '../../_spatial.js';
import { normalizeSkillValue } from '../../_rules.js';
import { itemBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const SKILL_TINKERING = 38;
const COOLDOWN_MS = 2000;
const cooldown = new WeakMap();

function isInPack(world, item, mob) {
  let parent = item?.parent;
  for (let depth = 0; depth < 8 && parent != null; depth++) {
    if (parent === mob.serial) return true;
    parent = itemBySerial({ world }, parent)?.parent;
  }
  return false;
}

function destroyWorldItem(api, world, item) {
  if (!item) return;
  destroyItemBySerial({ world }, item.serial);
}

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  // Internal trap-kit script — separate from pressure-plate so admins
  // can spawn unarmed plates as decor without an explosion attached.
  api.itemScripts?.register?.({
    name: 'tinker-trap',
    onWalkOn(world, item, mob) {
      if (!mob || item._sprung) return;
      item._sprung = true;
      const dmg = item.trapDamage | 0;
      // Apply the damage through the standard combat path so observer
      // health bars + young-player gates stay consistent.
      if (mob.hp != null) {
        mob.hp = Math.max(0, mob.hp - dmg);
        if (api.protocol?.healthUpdate) {
          const hp = api.protocol.healthUpdate({
            serial: mob.serial, current: mob.hp, max: mob.hpMax ?? 50,
          });
          for (const m of nearbyClients(world, mob)) m.client.send(hp);
          if (mob.client) mob.client.send(hp);
        }
        mob.client?.sendSystemMessage?.(`A trap explodes! (-${dmg} hp)`);
      }
      // Self-destruct after firing.
      if (api.protocol?.removeEntity) {
        const rm = api.protocol.removeEntity(item.serial);
        for (const m of nearbyClients(world, item)) m.client.send(rm);
      }
      destroyWorldItem(api, world, item);
    },
  });

  api.commands.register({
    name: 'trapkit',
    help: '[trapkit — craft a tinker trap (consumes 5 ingots).',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const last = cooldown.get(sender) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Your tools are still warm.');
        return;
      }
      // Need 5 iron ingots.
      let ingot = null;
      for (const it of allItems(api)) {
        if (!isInPack(api.world, it, sender)) continue;
        if (it.itemId !== 0x1BF2) continue;
        if ((it.amount | 0) < 5) continue;
        ingot = it; break;
      }
      if (!ingot) {
        ctx.state.sendSystemMessage('You need 5 iron ingots to craft a trap.');
        return;
      }
      const rawSkill = sender.skills?.[SKILL_TINKERING] ?? sender.skills?.[String(SKILL_TINKERING)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      if (skill < 30) {
        ctx.state.sendSystemMessage('Tinkering 30+ required.');
        return;
      }
      const successChance = Math.min(0.95, Math.max(0.30, skill / 100));
      cooldown.set(sender, now);
      ingot.amount -= 5;
      if (ingot.amount <= 0) {
        destroyWorldItem(api, api.world, ingot);
        if (sender.client && api.protocol?.removeEntity) {
          sender.client.send(api.protocol.removeEntity(ingot.serial));
        }
      } else if (sender.client && api.protocol?.containerContentUpdate) {
        sender.client.send(api.protocol.containerContentUpdate({
          serial: ingot.serial, itemId: ingot.itemId, amount: ingot.amount,
          hue: 0, gridX: 0, gridY: 0, gridLocation: 0,
        }, ingot.parent ?? sender.serial));
      }
      if (Math.random() >= successChance) {
        ctx.state.sendSystemMessage('You botch the trap — the parts crumble.');
        api.skillGain?.tryGain?.(sender, SKILL_TINKERING, 60);
        return;
      }
      // Spawn the trap at the player's feet.
      const damage = 10 + Math.floor(skill / 5);
      const trap = createItem(api, api.world, {
        itemId: 0x1BC4, x: sender.x, y: sender.y, z: sender.z, map: sender.map,
        name: 'a small trap', movable: false, hue: 0x44C,
      });
      trap.script = 'tinker-trap';
      trap.trapDamage = damage;
      const wi = api.protocol?.worldItemSA?.({
        serial: trap.serial, itemId: trap.itemId, hue: trap.hue,
        amount: 1, x: trap.x, y: trap.y, z: trap.z,
      });
      if (wi) {
        for (const m of nearbyClients(api.world, trap)) m.client.send(wi);
      }
      ctx.state.sendSystemMessage(`You arm a trap (${damage} damage).`);
      api.skillGain?.tryGain?.(sender, SKILL_TINKERING, 70);
    },
  });

  return () => api.commands.unregister('trapkit');
}
