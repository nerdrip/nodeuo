// `[cook` — Cooking skill activity. Targets a raw food item in the
// caster's pack and, on a successful Cooking roll, transforms it into
// the corresponding cooked variant. ServUO requires a heat source
// nearby (campfire / oven / forge); we accept both runtime items and
// map statics within two tiles.

import { normalizeSkillValue } from '../_rules.js';
import { itemBySerial } from '../_entities.js';
import { destroyItemBySerial } from '../_items.js';
import { isInPack } from '../_inventory.js';
import { nearbyItems } from '../_spatial.js';

const SKILL_COOKING = 14;
const COOLDOWN_MS = 1500;
const HEAT_RANGE = 2;
const cooldown = new WeakMap();

// Map: raw item id → cooked item id.
const COOKED = {
  0x097B: 0x097D, // raw fish steak → cooked
  0x09CC: 0x097B, // raw fish (alt) → cooked
  0x09B9: 0x09B7, // raw bird → roasted bird
  0x09F1: 0x09F2, // raw ham → cooked
  0x1607: 0x1608, // raw lamb → cooked
};

const HEAT_SOURCE_IDS = new Set([
  // Campfires / fire pits.
  0x0DE3, 0x0DE4, 0x0DE5, 0x0DE6, 0x0DE7, 0x0DE8, 0x0DE9,
  // Ovens / stone ovens.
  0x092B, 0x092C, 0x092D, 0x092E, 0x092F, 0x0930, 0x0931,
  // Forges and forge pieces.
  0x197A, 0x197B, 0x197C, 0x197D, 0x197E, 0x197F,
  0x1980, 0x1981, 0x1982, 0x1983, 0x1984, 0x1985,
  0x1986, 0x1987, 0x1988, 0x1995, 0x1996, 0x1997,
  0x1998, 0x1999, 0x199A,
]);

function isHeatSourceId(itemId) {
  return HEAT_SOURCE_IDS.has(itemId | 0);
}

function hasHeatSource(api, mob) {
  for (const it of nearbyItems(api, mob, HEAT_RANGE)) {
    if (!it.parent && it.map === mob.map && isHeatSourceId(it.itemId)) return true;
  }
  const staticsAt = api.landProvider?.staticsAt;
  if (typeof staticsAt !== 'function') return false;
  const map = mob.map ?? 1;
  for (let dx = -HEAT_RANGE; dx <= HEAT_RANGE; dx++) {
    for (let dy = -HEAT_RANGE; dy <= HEAT_RANGE; dy++) {
      const statics = staticsAt(map, (mob.x | 0) + dx, (mob.y | 0) + dy) ?? [];
      if (statics.some((s) => isHeatSourceId(s.tileId ?? s.itemId))) return true;
    }
  }
  return false;
}

export default function register(api) {
  if (!api.targeting || !api.protocol) return () => {};

  api.commands.register({
    name: 'cook',
    help: '[cook — target raw food in your pack to cook it.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) return;
      ctx.state.sendSystemMessage('Cook which food?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item || !isInPack(api, item, mob)) {
          ctx.state.sendSystemMessage('That must be in your pack.');
          return;
        }
        if (!hasHeatSource(api, mob)) {
          ctx.state.sendSystemMessage('You need to be near a heat source to cook.');
          return;
        }
        const cookedId = COOKED[item.itemId];
        if (!cookedId) {
          ctx.state.sendSystemMessage('You can\'t cook that.');
          return;
        }
        cooldown.set(mob, now);
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_COOKING] ?? mob.skills?.[String(SKILL_COOKING)] ?? 0,
        );
        const chance = Math.min(0.95, Math.max(0.10, skill / 100));
        if (Math.random() < chance) {
          item.itemId = cookedId;
          item.name = 'cooked food';
          ctx.state.sendSystemMessage('You cook the food expertly.');
          if (mob.client) mob.client.send(api.protocol.containerContentUpdate({
            serial: item.serial, itemId: item.itemId, amount: item.amount ?? 1,
            hue: item.hue ?? 0, gridX: item.gridX ?? 0, gridY: item.gridY ?? 0, gridLocation: 0,
          }, mob.serial));
        } else {
          ctx.state.sendSystemMessage('You burn the food.');
          // Audit #33 P1 #5 — route through `destroyItem` so reverse
          // parent + sector + _tickingItems indices stay coherent and
          // observers receive the removeEntity broadcast. Raw delete
          // (the pre-#22 pattern) leaks stale entries.
          destroyItemBySerial(api, item.serial);
          if (mob.client) mob.client.send(api.protocol.removeEntity(item.serial));
        }
        api.skillGain?.tryGain?.(mob, SKILL_COOKING, 50);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('cook');
}
