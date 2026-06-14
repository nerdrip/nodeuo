// `[lockpick` — Lockpicking skill activity. Targets a container and, if
// it has a `locked` flag with a `lockDifficulty` (0..100), runs a skill
// check. Success clears the lock and prints a success message; failure
// breaks the lockpick (would consume one if we modelled lockpick stacks).
//
// Lockable containers: any item whose runtime field `locked === true`.
// Difficulty: `lockDifficulty` (default 50). For MVP we let `[gm lock`
// or treasure-map spawn handlers tag chests with these fields.

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { destroyItemBySerial } from '../_items.js';
import { itemBySerial } from '../_entities.js';

const SKILL_LOCKPICKING = 25;
const COOLDOWN_MS = 3_000;
const cooldown = new WeakMap();

export default function register(api) {
  if (!api.targeting || !api.protocol) return () => {};

  api.commands.register({
    name: 'lockpick',
    help: '[lockpick — target a locked container to pick its lock.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Catch your breath before trying again.');
        return;
      }
      ctx.state.sendSystemMessage('Pick which lock?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) {
          ctx.state.sendSystemMessage('That isn\'t a container.');
          return;
        }
        if (!item.locked) {
          ctx.state.sendSystemMessage('That is not locked.');
          return;
        }
        cooldown.set(mob, now);
        // Locate a lockpick (item id 0x14FC) in the player's pack. If
        // they don't carry one, refuse the attempt rather than letting
        // the skill gain off thin air. ServUO `Lockpicking.cs` also
        // requires a pick stack.
        const pick = findInPack(api, mob, (it) => it.itemId === 0x14FC || it.kind === 'lockpick');
        if (!pick) {
          ctx.state.sendSystemMessage('You need a lockpick.');
          return;
        }
        const skill = normalizeSkillValue(
          mob.skills?.[SKILL_LOCKPICKING] ?? mob.skills?.[String(SKILL_LOCKPICKING)] ?? 0,
        );
        // Treasure-chest tier → difficulty table. ServUO TreasureMap
        // chests scale 36 → 95 across levels 1..7. Other locked items
        // use their `lockDifficulty` or default 50.
        const tier = item.treasureLevel | 0;
        const diff = tier > 0
          ? Math.max(36, Math.min(95, 30 + tier * 10))
          : (item.lockDifficulty ?? 50);
        const margin = skill - diff;
        const chance = Math.max(0.05, Math.min(0.95, 0.5 + margin / 100));
        if (Math.random() < chance) {
          item.locked = false;
          ctx.state.sendSystemMessage('The lock springs open.');
          api.skillGain?.tryGain?.(mob, SKILL_LOCKPICKING, diff);
          // ServUO: ~5% chance the pick breaks even on success.
          if (Math.random() < 0.05) {
            _consumePick(api, pick);
            ctx.state.sendSystemMessage('Your pick splinters as the lock opens.');
          }
        } else {
          // Critical fail (chest difficulty exceeds skill+50) — pick breaks
          // outright. Marginal fail (within 25) → 60% break. Otherwise 90% break.
          const breakChance = margin < -50 ? 1.0 : margin < -25 ? 0.6 : 0.9;
          if (Math.random() < breakChance) {
            _consumePick(api, pick);
            ctx.state.sendSystemMessage('Your pick slips and breaks.');
          } else {
            ctx.state.sendSystemMessage('You fail to pick the lock.');
          }
          if (Math.random() < 0.4) api.skillGain?.tryGain?.(mob, SKILL_LOCKPICKING, diff);
        }
      }, { kind: 0 });
    },
  });

  function _consumePick(api, pick) {
    if (!pick) return;
    if ((pick.amount | 0) > 1) {
      pick.amount = pick.amount - 1;
      try { api.items?.invalidateProps?.(pick.serial); } catch { /* */ }
    } else {
      try { destroyItemBySerial(api, pick.serial); } catch { /* */ }
    }
  }

  return () => api.commands.unregister('lockpick');
}
