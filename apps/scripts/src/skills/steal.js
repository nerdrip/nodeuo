// `[steal` — Stealing skill check against a target mobile. On success,
// transfers a random item from the victim's backpack to the caster.
// Failure flags the caster as Criminal for 2 minutes; getting caught
// (failure roll near max) reveals the attempt to the victim with a
// system message.

import { adjustKarma, flagCriminal } from '../_notoriety.js';
import { normalizeSkillValue } from '../_rules.js';
import {
  childrenOf,
  equipped,
  findBackpack,
  packItems,
} from '../_inventory.js';
import { nearbyMobiles } from '../_spatial.js';
import { itemBySerial, mobileBySerial } from '../_entities.js';
import { moveItem } from '../_movement.js';

const SKILL_STEALING = 34;
const COOLDOWN_MS = 6_000;
const cooldown = new WeakMap();

export default function register(api) {
  if (!api.targeting || !api.protocol || !api.items) return () => {};

  api.commands.register({
    name: 'steal',
    help: '[steal — pick a target to filch an item from their pack.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      // Bug-hunt #11 #7 — ServUO `Stealing.OnUse` blocks while warring
      // or carrying recent-aggressor flags. Without this a player can
      // steal mid-fight which acts as a free dupe.
      if (mob.warMode) {
        ctx.state.sendSystemMessage('You cannot steal while in war mode.');
        return;
      }
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Wait before another attempt.');
        return;
      }
      ctx.state.sendSystemMessage('Steal from whom or what?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        // Audit #36 P2 #12 — ServUO `Stealing.OnTarget:396` calls
        // `from.RevealingAction()` BEFORE any roll. Was: thief stayed
        // hidden, breaking the stealth-mechanics balance (free
        // unlimited theft from stealth). Reveal regardless of
        // success/fail; broadcast a fresh 0x77 so observers see.
        if (mob.hidden) {
          mob.hidden = false;
          mob.stealthSteps = 0;
        }
        // ServUO Stealing supports both mobiles AND containers. Pick
        // the mobile first; if the serial is an item with a gumpId
        // (i.e. openable container) fall through to the chest path.
        const victim = mobileBySerial(api, picked.serial >>> 0);
        const targetItem = victim ? null : itemBySerial(api, picked.serial >>> 0);
        if (!victim && (!targetItem || !targetItem.gumpId)) {
          ctx.state.sendSystemMessage('Bad target.');
          return;
        }
        if (victim === mob) {
          ctx.state.sendSystemMessage('Bad target.');
          return;
        }
        // ServUO Stealing.cs:71-74 — pickpocketing a PLAYER requires
        // thieves-guild membership. Without this anyone can lift gear
        // off other players which is a pure griefing exploit.
        if (victim && victim.client && mob.npcGuild !== 'thieves') {
          ctx.state.sendSystemMessage('You must be in the thieves guild to steal from other players.');
          return;
        }
        // Shopkeepers + invulnerable NPCs are off-limits (Stealing.cs).
        if (victim && (victim.invulnerable || victim.kind === 'vendor' || victim.role === 'vendor')) {
          ctx.state.sendSystemMessage('You cannot steal from that.');
          return;
        }
        // Both hands must be empty — UO requires sleight-of-hand and a
        // weapon/shield occupies the same gesture slot.
        const hasInHand = (layer) => {
          for (const it of equipped(api, mob)) if (it.layer === layer) return true;
          return false;
        };
        if (hasInHand(1) || hasInHand(2)) {
          ctx.state.sendSystemMessage('You need both hands free to steal.');
          return;
        }
        const tx = victim?.x ?? targetItem?.x ?? 0;
        const ty = victim?.y ?? targetItem?.y ?? 0;
        const dist = Math.max(Math.abs(tx - mob.x), Math.abs(ty - mob.y));
        if (dist > 2) {
          ctx.state.sendSystemMessage('Get closer first.');
          return;
        }
        // Audit #39 P1 #5 — ServUO `Stealing.cs:111` refuses corpses
        // outright (loot the body normally instead). Was: corpse just
        // fell through to container path so thieves could pick from
        // it without taking the criminal loot flag.
        if (!victim && targetItem && targetItem.itemId === 0x2006) {
          ctx.state.sendSystemMessage('You cannot steal from a corpse.');
          return;
        }
        // Container path — pickpocket a chest / sack on the ground.
        // Higher difficulty than picking a mob's pack because containers
        // are stationary and obvious; ServUO scales by container.weight
        // bucket. We approximate: -10 % chance if the container is
        // movable=false (vendor-stall chest), 0 otherwise.
        if (!victim && targetItem) {
          cooldown.set(mob, now);
          const stealing = normalizeSkillValue(
            mob.skills?.[SKILL_STEALING] ?? mob.skills?.[String(SKILL_STEALING)] ?? 0,
          );
          const containerPenalty = targetItem.movable === false ? 10 : 0;
          const roll = Math.random() * 100;
          if (roll < stealing - containerPenalty) {
            // Audit #39 P1 #5 — ServUO `Stealing.cs:142-160` formula:
            //   pileWeight = item.Weight * Math.Max(amount, 1)
            //   if pileWeight > 10 → "That is too heavy to steal."
            //   else success window = stealing - pileWeight * 10
            // Was: any weight stolen with flat-skill window → 50 stone
            // ore stacks vanishing into a thief's pack.
            const candidates = [...childrenOf(api, targetItem)]
              .filter((c) => c.movable !== false && !c.newbied && !c.blessed
                && ((c.weight ?? 1) * (c.amount ?? 1)) <= 10);
            if (candidates.length === 0) {
              ctx.state.sendSystemMessage('The container is empty.');
            } else {
              const stolen = candidates[(Math.random() * candidates.length) | 0];
              // A5 — use setItemParent so the reverse index follows.
              const thiefPack = findBackpack(api, mob);
              const thiefParent = thiefPack?.serial ?? mob.serial;
              moveItem(api, stolen, { parent: thiefParent });
              stolen.gridX = 0; stolen.gridY = 0; stolen.gridLocation = 0;
              if (mob.client && api.protocol?.containerContentUpdate) {
                mob.client.send(api.protocol.containerContentUpdate({
                  serial: stolen.serial, itemId: stolen.itemId,
                  amount: stolen.amount ?? 1, hue: stolen.hue ?? 0,
                  gridX: 0, gridY: 0, gridLocation: 0,
                }, thiefParent));
              }
              ctx.state.sendSystemMessage(`You quietly slip ${stolen.name ?? 'an item'} from the container.`);
              // Karma loss for theft — ServUO `Stealing.OnSuccessfulSteal`
              // -200 karma per success. Bug-hunt #5 B4.
              adjustKarma(api, mob, -200);
              api.skillGain?.tryGain?.(mob, SKILL_STEALING, 60);
            }
          } else {
            ctx.state.sendSystemMessage('Your hand slips.');
            flagCriminal(api, mob);
            // Nearby guarded-region NPCs may yell on a failed pick.
            const observers = nearbyMobiles(api, mob, mob, 4);
            for (const m of observers) {
              if (!m.client && m._guarded) continue;
              if (!m.client || m === mob || m.map !== mob.map) continue;
              if (Math.abs(m.x - mob.x) > 4 || Math.abs(m.y - mob.y) > 4) continue;
              m.client.sendSystemMessage?.(
                `${mob.name ?? 'Someone'} tries to pick a lock or steal from a container!`);
            }
          }
          return;
        }
        cooldown.set(mob, now);
        const stealing = normalizeSkillValue(
          mob.skills?.[SKILL_STEALING] ?? mob.skills?.[String(SKILL_STEALING)] ?? 0,
        );
        // Opposed roll vs victim's Hiding for the "no one notices" branch.
        const detection = normalizeSkillValue(
          victim.skills?.[22] ?? victim.skills?.['22'] ?? 0,
        ) + 30;
        const roll = Math.random() * 100;
        const succeeded = roll < stealing;

        if (succeeded) {
          // Pull a random item from victim's backpack.
          const pack = findBackpack(api, victim);
          // Audit #39 P1 #5 — weight cap (pileWeight ≤ 10) also applies
          // to mob-pack theft. Without this you could pickpocket a
          // 50-stone halberd from a sleeping merchant.
          const candidates = pack
            ? [...packItems(api, victim)].filter((c) =>
                c.movable !== false && !c.newbied && !c.blessed
                && ((c.weight ?? 1) * (c.amount ?? 1)) <= 10)
            : [];
          if (candidates.length === 0) {
            ctx.state.sendSystemMessage('Their pack is empty.');
          } else {
            const stolen = candidates[(Math.random() * candidates.length) | 0];
            // BUGFIX #113 (PHASE GD): the previous parent-only mutation
            // moved the item server-side but never told the victim's
            // client OR the thief's client. Victim's pack still showed
            // the item until they re-opened it; the thief saw nothing.
            // Push the dual remove + add so both pack views match.
            const oldParent = stolen.parent;
            // Bug-hunt #6 P1 #6 — reverse-index aware reparent.
            const thiefPack = findBackpack(api, mob);
            const thiefParent = thiefPack?.serial ?? mob.serial;
            moveItem(api, stolen, { parent: thiefParent });
            stolen.gridX = 0; stolen.gridY = 0; stolen.gridLocation = 0;
            if (victim.client && api.protocol?.removeEntity) {
              victim.client.send(api.protocol.removeEntity(stolen.serial));
            }
            if (mob.client && api.protocol?.containerContentUpdate) {
              mob.client.send(api.protocol.containerContentUpdate({
                serial: stolen.serial, itemId: stolen.itemId,
                amount: stolen.amount ?? 1, hue: stolen.hue ?? 0,
                gridX: 0, gridY: 0, gridLocation: 0,
              }, thiefParent));
            }
            void oldParent;
            ctx.state.sendSystemMessage(`You quietly take ${stolen.name ?? 'an item'}.`);
            // Karma loss — see container path above.
            adjustKarma(api, mob, -200);
            // The victim notices if their detection beats the steal roll.
            if (Math.random() * 100 < detection - stealing) {
              victim.client?.sendSystemMessage?.(`You see ${mob.name ?? 'someone'} steal from you!`);
            }
          }
        } else {
          ctx.state.sendSystemMessage('Your hand slips.');
          flagCriminal(api, mob);
          // Nearby clients always notice an outright failure.
          victim.client?.sendSystemMessage?.(`${mob.name ?? 'Someone'} tries to steal from you!`);
        }
        api.skillGain?.tryGain?.(mob, SKILL_STEALING, 60);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('steal');
}
