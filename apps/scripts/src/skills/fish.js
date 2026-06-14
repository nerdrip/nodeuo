// `[fish` — Fishing skill activity. Player targets a water tile and
// rolls Fishing. Success drops a fish in their pack; skilled rare rolls
// can drop big fish or Message-In-A-Bottle (MIB) treasure hooks. 4s
// cooldown — slower than Mining/Lumberjack because fish don't get mad.
//
// Water detection: check both land tileId (UO water sequences 0xA8..0xAB,
// 0x136..0x137) and any static FLAG_WET (we approximate by item-id range
// 0x1796..0x17B2 = water statics from the static atlas).

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { attachCaddellite } from '../items/scripts/functional/servuo-p1-items.js';

const SKILL_FISHING = 19;
const COOLDOWN_MS = 4000;
const FISH_ITEM = 0x09CC;
const BIG_FISH_ITEM = 0x09CC;       // same art, hued + sized differently
const MIB_ITEM = 0x099F;             // jug/bottle graphic — message in a bottle
const MAX_RANGE = 4;
// FAZA DN: rare drop chances. 5% big-fish, 1% MIB, but only at ≥80
// fishing skill (the ServUO `Fishing.cs` "rare" tier gate).
const BIG_FISH_CHANCE = 0.05;
const MIB_CHANCE = 0.01;
const RARE_MIN_SKILL = 80;

const cooldown = new WeakMap();
function hasCaddellitePole(api, mob) {
  return !!findInPack(api, mob, (it) => it.caddelliteTool && (it.script === 'fishing-pole' || it.tagId === 'caddellite-fishing-pole'));
}

function isWaterTile(tileId) {
  if (tileId >= 0x00A8 && tileId <= 0x00AB) return true;
  if (tileId >= 0x0136 && tileId <= 0x0137) return true;
  return false;
}
function isWaterStatic(tileId) {
  return tileId >= 0x1796 && tileId <= 0x17B2;
}

export default function register(api) {
  if (!api.targeting || !api.game?.mobile?.giveItem || !api.landProvider) return () => {};

  api.commands.register({
    name: 'fish',
    help: '[fish — target a water tile to cast your line.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Be patient — wait for the next cast.');
        return;
      }
      ctx.state.sendSystemMessage('Where do you want to fish?');
      api.targeting.request(ctx.state, (picked) => {
        // BUGFIX #82 (FAZA DN): defensive nulls — `picked` can be a
        // mobile (no .x/.y) when the player misclicks, or land/statics
        // queries can return null when the chunk isn't loaded. The
        // previous code assumed both — landAt(undef, undef) crashed
        // the targeting callback and the player got no error message
        // (just a silent no-op + spent cooldown).
        if (!picked || typeof picked.x !== 'number' || typeof picked.y !== 'number') {
          ctx.state.sendSystemMessage('You must target a water tile.');
          return;
        }
        const dist = Math.max(Math.abs(picked.x - mob.x), Math.abs(picked.y - mob.y));
        if (dist > MAX_RANGE) {
          ctx.state.sendSystemMessage('That is too far away.');
          return;
        }
        const land = api.landProvider.landAt(mob.map ?? 1, picked.x, picked.y);
        const statics = api.landProvider.staticsAt(mob.map ?? 1, picked.x, picked.y) ?? [];
        const isWater = (land && isWaterTile(land.tileId))
          || statics.some((s) => isWaterStatic(s.tileId));
        if (!isWater) {
          ctx.state.sendSystemMessage('You can only fish in water.');
          return;
        }
        cooldown.set(mob, now);
        const rawSkill = mob.skills?.[SKILL_FISHING] ?? mob.skills?.[String(SKILL_FISHING)] ?? 0;
        const skill = normalizeSkillValue(rawSkill);
        const chance = Math.min(0.95, Math.max(0.10, skill / 90));
        if (Math.random() >= chance) {
          ctx.state.sendSystemMessage('The fish slip away.');
          api.skillGain?.tryGain?.(mob, SKILL_FISHING, 50);
          return;
        }
        // FAZA DN: rare-drop roll for skilled anglers. Random check
        // BEFORE the regular fish so the rare doesn't double-drop.
        let dropName = 'a fish';
        let dropItemId = FISH_ITEM;
        let dropHue = 0;
        let mibPayload = null;
        if (skill >= RARE_MIN_SKILL) {
          if (Math.random() < MIB_CHANCE) {
            dropName = 'a message in a bottle';
            dropItemId = MIB_ITEM;
            dropHue = 0x481;
            // Treasure-map style payload: random spot on the same map.
            mibPayload = {
              x: ((Math.random() * 5000) | 0),
              y: ((Math.random() * 5000) | 0),
              map: mob.map ?? 1,
              level: 1 + ((Math.random() * 4) | 0),
            };
          } else if (Math.random() < BIG_FISH_CHANCE) {
            dropName = 'a big fish';
            dropItemId = BIG_FISH_ITEM;
            dropHue = 0x021;
          }
        }
        const fish = api.game?.mobile?.giveItem?.(mob, {
          itemId: dropItemId,
          amount: 1,
          hue: dropHue,
          name: dropName,
          ...(mibPayload ? { script: 'message-in-bottle' } : {}),
        }, { randomGrid: true });
        if (!fish) {
          ctx.state.sendSystemMessage('You have no backpack for the catch.');
          return;
        }
        if (mibPayload) {
          fish.mib = mibPayload;
        }
        // Big fish carries a trophy weight (UO `BigFish.cs`). Range 30..200
        // — a tinker / carpenter can mount it on a wall plaque via [trophy
        // (apps/scripts/src/commands/trophy.js). Without this stamp the
        // mounted-plaque label has nothing to show off.
        if (dropHue === 0x021 && !mibPayload) {
          fish._trophyWeight = 30 + Math.floor(Math.random() * 171);
          fish.name = `a big fish (${fish._trophyWeight} stone)`;
        }
        if (hasCaddellitePole(api, mob)) {
          attachCaddellite(fish);
          fish.name = `Caddellite infused ${fish.name ?? dropName}`;
          ctx.state.sendSystemMessage('The Caddellite fishing pole infuses the catch.');
        }
        ctx.state.sendSystemMessage(
          mibPayload ? 'You haul in a sealed bottle!'
            : (dropHue ? 'You catch a remarkable fish!' : 'You catch a fish.'),
        );
        api.skillGain?.tryGain?.(mob, SKILL_FISHING, 50);
      }, { kind: 1 });
    },
  });

  return () => api.commands.unregister('fish');
}
