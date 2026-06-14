// `[camp` — Camping skill activity. Drops a campfire item under the
// caster and applies a "rested" status that boosts HP/Mana regen for
// a short window. ServUO requires kindling in pack; we accept it as a
// reagent-like consumable.

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { sendToClientsNear } from '../_spatial.js';
import { createItem, destroyItemBySerial } from '../_items.js';

const SKILL_CAMPING = 11;
const COOLDOWN_MS = 60_000;
const cooldown = new WeakMap();

function destroyWorldItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  api.commands.register({
    name: 'camp',
    help: '[camp — make camp; uses kindling and grants the Rested buff.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Your last camp is still fresh.');
        return;
      }
      // Find kindling (0x0DE1) in pack.
      const kindling = findInPack(api, mob, (it) => it.itemId === 0x0DE1 && (it.amount | 0) > 0);
      if (!kindling) {
        ctx.state.sendSystemMessage('You need kindling to make a fire.');
        return;
      }
      cooldown.set(mob, now);

      kindling.amount = (kindling.amount | 0) - 1;
      if (kindling.amount <= 0) {
        destroyWorldItem(api, kindling);
        if (mob.client) mob.client.send(api.protocol.removeEntity(kindling.serial));
      } else if (mob.client) {
        mob.client.send(api.protocol.containerContentUpdate({
          serial: kindling.serial, itemId: kindling.itemId, amount: kindling.amount,
          hue: kindling.hue ?? 0, gridX: 0, gridY: 0, gridLocation: 0,
        }, kindling.parent ?? mob.serial));
      }

      const skill = normalizeSkillValue(
        mob.skills?.[SKILL_CAMPING] ?? mob.skills?.[String(SKILL_CAMPING)] ?? 0,
      );
      const chance = Math.min(0.95, Math.max(0.20, skill / 80));
      if (Math.random() >= chance) {
        ctx.state.sendSystemMessage('The kindling sputters out.');
        return;
      }
      // Spawn a campfire item next to the player (item id 0x0DE3).
      const fire = createItem(api, api.world, {
        itemId: 0x0DE3, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: 'a campfire', movable: false,
      });
      fire.campOwner = mob.serial >>> 0;
      // Broadcast spawn.
      // BUGFIX #84 (FAZA DP): the previous global loops shipped 0xF3
      // and 0x1D to every connected client whenever someone made camp
      // OR the campfire decayed. Same bug class as #65/#78/#80. Filter
      // by map + 18 tiles around the campfire's own coordinates (which
      // we capture before the timer in case the world shifts).
      if (api.protocol?.worldItemSA) {
        const wi = api.protocol.worldItemSA({
          serial: fire.serial, itemId: fire.itemId, hue: fire.hue,
          amount: 1, x: fire.x, y: fire.y, z: fire.z,
        });
        sendToClientsNear(api, fire, wi);
      }
      // Decay after 5 minutes.
      setTimeout(() => {
        if (api.protocol?.removeEntity) {
          const rm = api.protocol.removeEntity(fire.serial);
          sendToClientsNear(api, fire, rm);
        }
        destroyWorldItem(api, fire);
      }, 5 * 60 * 1000).unref?.();

      // Rested buff — server regen.js and the script-side regen formula
      // both read the 'rested' status and boost recovery while it lasts.
      api.statusEffects?.apply?.(mob, { name: 'rested', durationMs: 30_000 });
      ctx.state.sendSystemMessage('Your camp crackles to life.');
      api.skillGain?.tryGain?.(mob, SKILL_CAMPING, 50);
    },
  });

  return () => api.commands.unregister('camp');
}
