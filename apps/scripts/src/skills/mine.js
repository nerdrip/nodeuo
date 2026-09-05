// `[mine` — Mining skill activity. Targets a tile, checks for mountain
// terrain or rock statics, runs a Mining skill check, drops ore/resources
// in the player's pack on success. Cooldown 4s per attempt.
//
// Tile detection heuristic (server has no tiledata flags loader yet):
//   - Land tileId in 0xDC..0xE3 / 0x10C..0x10F / 0x1F8..0x1FA = mountains
//   - Static tileId in 0x1363..0x13A8 = ore vein / stone outcrop
//
// The server harvest system owns the ServUO-style colored ore/gem table;
// this command performs targeting/range checks and turns drops into items.

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { attachCaddellite } from '../items/scripts/functional/servuo-p1-items.js';

const SKILL_MINING = 46;
const COOLDOWN_MS = 4000;
const IRON_ORE = 0x19B7;
const MAX_RANGE = 2;
const ORE_RESOURCE_ITEMS = {
  'iron-ore':        { itemId: IRON_ORE, name: 'iron ore', tagId: 'ore-iron', servuoClass: 'IronOre' },
  'dull-copper-ore': { itemId: IRON_ORE, name: 'dull copper ore', tagId: 'ore-dullcopper', hue: 0x0973, servuoClass: 'DullCopperOre' },
  'shadow-iron-ore': { itemId: IRON_ORE, name: 'shadow iron ore', tagId: 'ore-shadow', hue: 0x0966, servuoClass: 'ShadowIronOre' },
  'copper-ore':      { itemId: IRON_ORE, name: 'copper ore', tagId: 'ore-copper', hue: 0x096D, servuoClass: 'CopperOre' },
  'bronze-ore':      { itemId: IRON_ORE, name: 'bronze ore', tagId: 'ore-bronze', hue: 0x0972, servuoClass: 'BronzeOre' },
  'gold-ore':        { itemId: IRON_ORE, name: 'gold ore', tagId: 'ore-gold', hue: 0x08A5, servuoClass: 'GoldOre' },
  'agapite-ore':     { itemId: IRON_ORE, name: 'agapite ore', tagId: 'ore-agapite', hue: 0x0979, servuoClass: 'AgapiteOre' },
  'verite-ore':      { itemId: IRON_ORE, name: 'verite ore', tagId: 'ore-verite', hue: 0x089F, servuoClass: 'VeriteOre' },
  'valorite-ore':    { itemId: IRON_ORE, name: 'valorite ore', tagId: 'ore-valorite', hue: 0x08AB, servuoClass: 'ValoriteOre' },
};
const GEM_RESOURCE_ITEMS = {
  amethyst: 'gem-amethyst',
  citrine: 'gem-citrine',
  diamond: 'gem-diamond',
  emerald: 'gem-emerald',
  ruby: 'gem-ruby',
  sapphire: 'gem-sapphire',
  'star-sapphire': 'gem-star-sapphire',
  tourmaline: 'gem-tourmaline',
};
// PHASE DO: vein depletion. Each tile-keyed vein supports a fixed pull
// budget (drop ~10 ores total) before it depletes. Depleted veins
// regenerate after a 5-minute respawn timer. Tracked in-process; lost
// on restart (fine — it's a soft economy guardrail, not a save target).
const VEIN_BUDGET = 10;
const VEIN_RESPAWN_MS = 5 * 60 * 1000;
const cooldown = new WeakMap();
/** @type {Map<string, {remaining: number, depletedAt: number|null}>} */
const veinState = new Map();
function veinKey(map, x, y) { return `${map}|${x}|${y}`; }
function veinAt(map, x, y, now) {
  const key = veinKey(map, x, y);
  let v = veinState.get(key);
  if (!v) {
    v = { remaining: VEIN_BUDGET, depletedAt: null };
    veinState.set(key, v);
    return v;
  }
  // Respawn check.
  if (v.depletedAt && now - v.depletedAt >= VEIN_RESPAWN_MS) {
    v.remaining = VEIN_BUDGET;
    v.depletedAt = null;
  }
  return v;
}
export function _resetVeinsForTest() { veinState.clear(); }
function hasPickaxeBonus(api, mob) {
  return !!findInPack(api, mob, (it) => it.pickaxeBonus);
}
function hasCaddellitePickaxe(api, mob) {
  return !!findInPack(api, mob, (it) => it.caddelliteTool && (it.script === 'pickaxe' || it.tagId === 'caddellite-pickaxe'));
}

function isMountainTile(tileId) {
  if (tileId >= 0x000DC && tileId <= 0x000E3) return true;
  if (tileId >= 0x0010C && tileId <= 0x0010F) return true;
  if (tileId >= 0x001F8 && tileId <= 0x001FA) return true;
  return false;
}
function isOreStatic(tileId) {
  if (tileId >= 0x1363 && tileId <= 0x13A8) return true;
  if (tileId >= 0x1772 && tileId <= 0x1784) return true; // boulders
  return false;
}

function resourceItem(resource, amount) {
  const ore = ORE_RESOURCE_ITEMS[resource];
  if (ore) {
    return {
      ...ore,
      amount,
      stackable: true,
      servuoClasses: [ore.servuoClass],
    };
  }
  const gemTag = GEM_RESOURCE_ITEMS[resource];
  if (gemTag) {
    return {
      tagId: gemTag,
      amount,
      stackable: true,
      name: resource.replace(/-/g, ' '),
    };
  }
  return {
    itemId: IRON_ORE,
    amount,
    stackable: true,
    name: resource.replace(/-/g, ' '),
  };
}

export default function register(api) {
  if (!api.targeting || !api.game?.mobile?.giveItem || !api.landProvider) return () => {};

  api.commands.register({
    name: 'mine',
    help: '[mine — target a mountain or rock to mine ore.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You must wait a moment before mining again.');
        return;
      }
      ctx.state.sendSystemMessage('Where do you wish to mine?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) return;
        const dist = Math.max(Math.abs(picked.x - mob.x), Math.abs(picked.y - mob.y));
        if (dist > MAX_RANGE) {
          ctx.state.sendSystemMessage('That is too far away.');
          return;
        }
        const land = api.landProvider.landAt(mob.map ?? 1, picked.x, picked.y);
        const statics = api.landProvider.staticsAt(mob.map ?? 1, picked.x, picked.y) ?? [];
        const isMineable = (land && isMountainTile(land.tileId))
          || statics.some((s) => isOreStatic(s.tileId));
        if (!isMineable) {
          ctx.state.sendSystemMessage('You see no metal there.');
          return;
        }
        cooldown.set(mob, now);
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_MINING] ?? mob.skills?.[String(SKILL_MINING)] ?? 0,
        );

        const harvest = api.systems?.harvest;
        const map = mob.map ?? 1;
        let result = null;
        if (harvest?.tryMining) {
          if (harvest.isVeinDepleted?.('mining', map, picked.x, picked.y, now)) {
            ctx.state.sendSystemMessage('This vein is depleted. Try again later.');
            return;
          }
          result = harvest.tryMining(mob, picked.x, picked.y, map, {
            effectiveSkill: () => skill,
            rng: Math.random,
          });
          if (result?.ok && harvest.consumeVein && !harvest.consumeVein('mining', map, picked.x, picked.y, now)) {
            ctx.state.sendSystemMessage('This vein is depleted. Try again later.');
            return;
          }
        } else {
          const vein = veinAt(map, picked.x, picked.y, now);
          if (vein.remaining <= 0) {
            ctx.state.sendSystemMessage('This vein is depleted. Try again later.');
            return;
          }
          const chance = Math.min(0.95, Math.max(0.05, skill / 100));
          if (Math.random() < chance) {
            const amount = 1 + Math.floor(skill / 25) + (hasPickaxeBonus(api, mob) ? 1 : 0);
            vein.remaining = Math.max(0, vein.remaining - amount);
            if (vein.remaining === 0) vein.depletedAt = now;
            result = {
              ok: true,
              resource: 'iron-ore',
              amount,
              drops: [{ resource: 'iron-ore', amount }],
              message: `You mine ${amount} iron ore.`,
            };
          } else {
            result = { ok: false, reason: 'failed', message: 'You loosen some rocks but find no ore.' };
          }
        }

        if (!result?.ok) {
          ctx.state.sendSystemMessage(result?.message ?? 'You loosen some rocks but find no ore.');
          api.skillGain?.tryGain?.(mob, SKILL_MINING, 50);
          return;
        }

        const yieldBonus = harvest?.tryMining && hasPickaxeBonus(api, mob) ? 1 : 0;
        const drops = result.drops?.length ? result.drops : [{ resource: result.resource, amount: result.amount ?? 1 }];
        let ore = null;
        let yieldAmt = 0;
        for (const drop of drops) {
          const isOre = /-ore$/.test(drop.resource ?? '');
          const amount = Math.max(1, (drop.amount | 0) + (isOre ? yieldBonus : 0));
          if (isOre) yieldAmt += amount;
          const item = api.game?.mobile?.giveItem?.(mob, resourceItem(drop.resource, amount), { randomGrid: true });
          if (isOre && !ore) ore = item;
        }
        if (!ore && yieldAmt > 0) {
          ctx.state.sendSystemMessage('You have no backpack for the ore.');
          return;
        }
        ctx.state.sendSystemMessage(result.message ?? `You mine ${yieldAmt} ore.`);
        if (hasCaddellitePickaxe(api, mob)) {
          if (ore) {
            attachCaddellite(ore);
            ore.name = `Caddellite infused ${ore.name ?? 'ore'}`;
          }
          ctx.state.sendSystemMessage('The Caddellite pickaxe infuses the ore.');
          if (Math.random() < 0.005) {
            api.game?.mobile?.giveItem?.(mob, {
              itemId: 0x1364,
              name: 'Rough Meteorite',
              script: 'caddellite-infuser',
              servuoClass: 'Meteorite',
              servuoClasses: ['Meteorite', 'Caddellite'],
            }, { randomGrid: true });
            ctx.state.sendSystemMessage('You uncover a rough meteorite.');
          }
        }
        api.skillGain?.tryGain?.(mob, SKILL_MINING, 50);
        // Harvest quota bookkeeping — bump today's count + announce any
        // ticket awards.
        try {
          const awarded = api.systems?.harvestQuotas?.recordHarvest?.(
            ctx.state?.account,
            'mining',
            yieldAmt,
          ) ?? [];
          for (const tier of awarded) {
            ctx.state.sendSystemMessage(
              `★ Mining quota reached — ${tier} ticket awarded! Use [quota claim ${tier}.`,
            );
          }
        } catch { /* quota optional */ }
      }, { kind: 1 /* location */ });
    },
  });

  return () => api.commands.unregister('mine');
}
