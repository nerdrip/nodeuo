// `[removetrap` — Remove Trap skill (id 49).
//
// ServUO `Skills/RemoveTrap.cs`: target a trapped item (chest / floor
// plate / wall trap) within range 1, run a skill check vs the trap's
// declared difficulty. On success the trap script is removed from the
// item and the item is rendered safe; on failure the trap may misfire
// (deal its on-walk effect to the disarmer).
//
// Our trap items all carry one of these `kind` slugs (see
// items/scripts/traps/*.js):
//   spike-trap, pressure-plate, gas-trap, fire-column-trap,
//   saw-trap, dart-trap, world-trap, despise-ankh (Bug-only — not a trap)
//
// `puzzle-chest` and treasure-chest variants store their lock-pick
// trap difficulty in `item.trapPower`. Both code paths are handled —
// kind-tagged trap items use a static difficulty of 60, while chests
// scale by `trapPower` (15..120 from ServUO TreasureMap tier table).

import { normalizeSkillValue } from '../_rules.js';
import { destroyItemBySerial } from '../_items.js';
import { itemBySerial } from '../_entities.js';

const SKILL_REMOVE_TRAP = 49;
const SKILL_HIDING      = 22;
const COOLDOWN_MS       = 4_000;

const TRAP_KINDS = new Set([
  'spike-trap', 'pressure-plate', 'gas-trap',
  'fire-column-trap', 'saw-trap', 'dart-trap', 'world-trap',
]);

const cooldown = new WeakMap();

function skillOf(mob, id) {
  if (!mob?.skills) return 0;
  return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
}

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'removetrap',
    help: '[removetrap — disarm a trap on a targeted item.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      if (!sender) return;
      const now = Date.now();
      const last = cooldown.get(sender) ?? 0;
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You must wait before attempting another disarm.');
        return;
      }
      if (!api.targeting?.request) {
        ctx.state.sendSystemMessage('Targeting unavailable.');
        return;
      }
      ctx.state.sendSystemMessage('Target the trap to disarm.');
      api.targeting.request(ctx.state, (picked) => {
        // Stamp the cooldown on any acknowledged target — the player
        // has committed an action even if the result is "not a trap".
        cooldown.set(sender, Date.now());
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('That is not a valid target.'); return; }
        // Range 1 — must be adjacent. ServUO `RemoveTrap.cs:54` uses
        // `Range != 1` to reject; we match that exactly so a sneaky
        // ranged disarm-then-flee can't dodge the misfire risk.
        const dx = Math.abs((item.x | 0) - (sender.x | 0));
        const dy = Math.abs((item.y | 0) - (sender.y | 0));
        if (Math.max(dx, dy) > 1) {
          ctx.state.sendSystemMessage('You must be next to the trap to disarm it.');
          return;
        }
        // Is it actually trapped?
        const isKindTrap = TRAP_KINDS.has(item.kind);
        const isMagicTrap = (item._magicTrapDmg | 0) > 0 || item.trapped?.kind === 'magic';
        const isChestTrap = isMagicTrap || item.trapped || (item.trapPower | 0) > 0 || item.kind === 'puzzle-chest';
        if (!isKindTrap && !isChestTrap) {
          ctx.state.sendSystemMessage('That is not trapped.');
          return;
        }
        const skill = skillOf(sender, SKILL_REMOVE_TRAP);
        // Difficulty: kind-tagged traps = fixed 60, chest traps scale.
        const difficulty = isChestTrap
          ? Math.max(15, Math.min(120, item.trapped?.difficulty ?? item.trapPower ?? 0))
          : 60;
        // Hiding boosts the check slightly — ServUO Stealth/Hiding skill
        // contributes to "concentration" on a disarm attempt. Cap +20.
        const hideBoost = Math.min(20, skillOf(sender, SKILL_HIDING) / 5);
        const roll = Math.random() * 100;
        if (roll < skill - difficulty + 50 + hideBoost) {
          // Success — strip the trap.
          if (isKindTrap) {
            // Destroy the trap item entirely (ServUO destroys floor traps).
            try { destroyItemBySerial(api, item.serial); }
            catch { /* advisory */ }
          } else {
            item.trapPower = 0;
            item._magicTrapDmg = 0;
            item._magicTrapBy = 0;
            item.trapped = false;
          }
          ctx.state.sendSystemMessage('You disarm the trap.');
          api.skillGain?.tryGain?.(sender, SKILL_REMOVE_TRAP, difficulty);
        } else {
          // Failure — chance the trap misfires on the disarmer.
          ctx.state.sendSystemMessage('You fail to disarm the trap.');
          if (Math.random() < 0.35) {
            ctx.state.sendSystemMessage('The trap fires as you fumble!');
            // Walk-on hook is the closest analogue to "the trap fires
            // on the disarmer". Look up the engine's item-script for
            // this kind and call its onWalkOn closure with the sender
            // as the victim. If the item is a chest trap (no walk hook)
            // we just deal a flat 10..20 damage.
            const onWalkOn = item._scriptOnWalkOn;
            if (typeof onWalkOn === 'function') {
              try { onWalkOn(api.world, item, sender); }
              catch { /* advisory */ }
            } else if (isChestTrap) {
              const dmg = 10 + Math.floor(Math.random() * 11);
              api.combat?.damage?.(api.world, sender, dmg);
            }
          }
          // Skill gain on failure too — half-chance, scaled to
          // difficulty. ServUO behaves the same.
          if (Math.random() < 0.5) {
            api.skillGain?.tryGain?.(sender, SKILL_REMOVE_TRAP, difficulty);
          }
        }
      }, { kind: 0 });
    },
  });
  return () => api.commands.unregister('removetrap');
}
