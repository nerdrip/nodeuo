// `[chop` — Lumberjacking skill activity. Player targets a tree static,
// rolls Lumberjacking, and on success a stack of logs (or boards if
// post-processed) appears in their pack. Cooldown 3s.
//
// Tree static id ranges from UO's tiledata:
//   0x0CCA..0x0CD3, 0x0CD8, 0x0CE0, 0x0CE3..0x0CE7,
//   0x0D2F..0x0D75 (variants), 0x0CCE..0x0CD0 (oak),
//   0x0D6E..0x0D75 (yew), 0x0CC8..0x0CC9 (pine).
// We approximate with a wide range 0x0CCA..0x0D75 plus a handful of
// special-cases.

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { attachCaddellite } from '../items/scripts/functional/servuo-p1-items.js';

const SKILL_LUMBERJACKING = 45;
const COOLDOWN_MS = 3000;
const LOG_ITEM = 0x1BDD;
const MAX_RANGE = 2;

const cooldown = new WeakMap();
function hasCaddelliteHatchet(api, mob) {
  return !!findInPack(api, mob, (it) => it.caddelliteTool && (it.script === 'hatchet' || it.tagId === 'caddellite-hatchet'));
}

function isTreeStatic(tileId) {
  if (tileId >= 0x0CCA && tileId <= 0x0D75) return true;
  return false;
}

export default function register(api) {
  if (!api.targeting || !api.game?.mobile?.giveItem || !api.landProvider) return () => {};

  api.commands.register({
    name: 'chop',
    help: '[chop — target a tree to cut logs.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Catch your breath before swinging again.');
        return;
      }
      ctx.state.sendSystemMessage('Which tree?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked) return;
        const dist = Math.max(Math.abs(picked.x - mob.x), Math.abs(picked.y - mob.y));
        if (dist > MAX_RANGE) {
          ctx.state.sendSystemMessage('That is too far away.');
          return;
        }
        // BUGFIX #110 (PHASE FY): same defensive null fix as fish/mine —
        // staticsAt can return null for unloaded chunks; the previous
        // code would throw "cannot read 'some' of null" silently, the
        // targeting callback aborted, and the player got no message.
        const statics = api.landProvider.staticsAt(mob.map ?? 1, picked.x, picked.y) ?? [];
        if (!statics.some((s) => isTreeStatic(s.tileId))) {
          ctx.state.sendSystemMessage('There is no tree there.');
          return;
        }
        cooldown.set(mob, now);
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_LUMBERJACKING] ?? mob.skills?.[String(SKILL_LUMBERJACKING)] ?? 0,
        );
        const chance = Math.min(0.95, Math.max(0.10, skill / 100));
        if (Math.random() >= chance) {
          ctx.state.sendSystemMessage('Your axe glances off the bark.');
          api.skillGain?.tryGain?.(mob, SKILL_LUMBERJACKING, 50);
          return;
        }
        // PHASE FY: enchanted-axe bonus (+2 logs) — `lumberjackBonus`
        // flag on any item in the pack triggers it.
        const bonus = findInPack(api, mob, (it) => it.lumberjackBonus) ? 2 : 0;
        const yieldAmt = 2 + Math.floor(skill / 20) + bonus;
        const logs = api.game?.mobile?.giveItem?.(mob, {
          itemId: LOG_ITEM,
          amount: yieldAmt,
          name: 'log',
        }, { randomGrid: true });
        if (!logs) {
          ctx.state.sendSystemMessage('You have no backpack for the logs.');
          return;
        }
        if (hasCaddelliteHatchet(api, mob)) {
          attachCaddellite(logs);
          logs.name = 'Caddellite infused logs';
          ctx.state.sendSystemMessage('The Caddellite hatchet infuses the logs.');
        }
        ctx.state.sendSystemMessage(`You chop ${yieldAmt} logs.`);
        api.skillGain?.tryGain?.(mob, SKILL_LUMBERJACKING, 50);
        // Harvest quota bookkeeping.
        try {
          const awarded = api.systems?.harvestQuotas?.recordHarvest?.(
            ctx.state?.account,
            'lumber',
            yieldAmt,
          ) ?? [];
          for (const tier of awarded) {
            ctx.state.sendSystemMessage(
              `★ Lumberjack quota reached — ${tier} ticket awarded! Use [quota claim ${tier}.`,
            );
          }
        } catch { /* quota optional */ }
      }, { kind: 1 });
    },
  });

  return () => api.commands.unregister('chop');
}
