// `[tame` — Animal Taming skill check that, on success, binds a tameable
// creature to the sender as a pet. Mirrors ServUO `Skills/AnimalTaming.cs`
// — multi-attempt cadence (3.5s per try, ~3 attempts) with overhead
// progress text. Cancels if the player walks more than a tile away or
// the creature dies / wanders out of range.
//
// Difficulty model: each tameable creature has `tameMinSkill` (0% chance)
// and `tameMaxSkill` (100% chance) values declared in monsters.json. The
// roll is a linear interpolation: chance = (skill - min) / (max - min).
// Skill gain follows the standard bell curve via `api.skillGain.tryGain`.

// Animal Taming = 36 in skills.json. Earlier value 35 collided with
// Tailoring (the actual ServUO Animal Taming id).
import { normalizeSkillValue } from '../_rules.js';
import { nearbyClients } from '../_spatial.js';
import { mobileBySerial } from '../_entities.js';

const SKILL_ANIMAL_TAMING = 36;
const ATTEMPT_INTERVAL_MS = 3500;
const ATTEMPT_COUNT = 3;
const TAME_RANGE = 6;

export default function register(api) {
  if (!api.targeting || !api.protocol) {
    api.log('commands/tame: missing targeting/protocol; skipping');
    return () => {};
  }

  api.commands.register({
    name: 'tame',
    help: '[tame — click a tameable creature to attempt to bind it as a pet.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('Tame which creature?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('Taming cancelled.');
          return;
        }
        const creature = mobileBySerial(api, picked.serial >>> 0);
        if (!creature) {
          ctx.state.sendSystemMessage('That creature is not nearby.');
          return;
        }
        if (creature === ctx.sender) {
          ctx.state.sendSystemMessage('You cannot tame yourself.');
          return;
        }
        if (creature.client) {
          ctx.state.sendSystemMessage('You cannot tame another player.');
          return;
        }
        const cfg = api.monsters?.get?.(creature.kind)
                ?? api.npcs?.get?.(creature.kind);
        if (!cfg?.tameable) {
          ctx.state.sendSystemMessage('That creature cannot be tamed.');
          return;
        }
        if (creature.controlMaster) {
          if ((creature.controlMaster >>> 0) === (ctx.sender.serial >>> 0)) {
            ctx.state.sendSystemMessage('That creature is already your pet.');
          } else {
            ctx.state.sendSystemMessage('That creature already has a master.');
          }
          return;
        }

        // Range check — must be within 6 tiles.
        if (!withinRange(ctx.sender, creature, TAME_RANGE)) {
          ctx.state.sendSystemMessage('That is too far away.');
          return;
        }

        // PHASE CR: multi-attempt taming with overhead progress text.
        // Mirror ServUO's AnimalTaming — 3 attempts at 3.5 s each, with
        // a "you start to tame" / "you continue to tame" cadence. The
        // skill check rolls on the LAST attempt; earlier attempts are
        // narrative only (server still has to validate range each tick
        // — the player wandering away cancels the tame).
        // PHASE DA: visual feedback — a 0x376A magic-ring graphical
        // effect anchored on the creature, broadcast to nearby clients
        // so the player can see WHICH mob is being tamed when several
        // are clustered.
        ctx.state.sendSystemMessage('You start to tame the creature.');
        broadcastNearby(api, creature, 'You start to tame the creature.', 0x59);
        broadcastTamingEffect(api, creature);
        const startX = ctx.sender.x, startY = ctx.sender.y;
        let attempt = 0;
        const tick = () => {
          attempt += 1;
          const liveCreature = mobileBySerial(api, creature.serial);
          if (!liveCreature || liveCreature.ghost || (liveCreature.hp ?? 0) <= 0) {
            ctx.state.sendSystemMessage('The creature is gone.');
            return;
          }
          if (liveCreature.controlMaster) {
            ctx.state.sendSystemMessage('Someone else has tamed it first.');
            return;
          }
          if (!withinRange(ctx.sender, liveCreature, TAME_RANGE)) {
            ctx.state.sendSystemMessage('It is too far away — your concentration breaks.');
            return;
          }
          if (Math.abs(ctx.sender.x - startX) > 1 || Math.abs(ctx.sender.y - startY) > 1) {
            ctx.state.sendSystemMessage('You move away and the creature loses interest.');
            return;
          }
          if (attempt < ATTEMPT_COUNT) {
            ctx.state.sendSystemMessage('You continue to tame the creature.');
            broadcastNearby(api, liveCreature, '*tilts its head, listening*', 0x59);
            broadcastTamingEffect(api, liveCreature);
            setTimeout(tick, ATTEMPT_INTERVAL_MS);
            return;
          }

          // Final attempt — roll the skill check.
          const tamingValue = normalizeSkillValue(
            ctx.sender.skills?.[SKILL_ANIMAL_TAMING] ?? ctx.sender.skills?.[String(SKILL_ANIMAL_TAMING)] ?? 0,
          );
          const minSkill = liveCreature.tameMinSkill ?? cfg.tameMinSkill ?? 0;
          const maxSkill = liveCreature.tameMaxSkill ?? cfg.tameMaxSkill ?? 100;
          let chance = 0;
          if (tamingValue >= maxSkill) chance = 1.0;
          else if (tamingValue <= minSkill) chance = 0.0;
          else chance = (tamingValue - minSkill) / (maxSkill - minSkill);
          const success = Math.random() < chance;
          api.skillGain?.tryGain?.(ctx.sender, SKILL_ANIMAL_TAMING, minSkill, maxSkill);

          if (!success) {
            ctx.state.sendSystemMessage('You fail to tame the creature.');
            broadcastNearby(api, liveCreature, '*looks at you defiantly*', 0x35);
            return;
          }

          // Server parity #11 #3 — control-slot cap. ServUO
          // `BaseCreature.ControlSlots` (1 dog / 2 llama / 3 nightmare
          // / 4-5 dragons) limits total followers. Without this a 100
          // Taming player keeps an army.
          const slots = liveCreature.controlSlots ?? 1;
          const cap = ctx.sender.followersMax ?? 5;
          const cur = ctx.sender.followers ?? 0;
          if (cur + slots > cap) {
            ctx.state.sendSystemMessage(
              `That creature would push you past your follower limit (${cur}/${cap}).`,
            );
            return;
          }
          ctx.sender.followers = cur + slots;
          liveCreature._followerCost = slots;
          // Success — bind the pet.
          liveCreature.controlMaster = ctx.sender.serial >>> 0;
          liveCreature.notoriety = 1;
          liveCreature.team = ctx.sender.serial >>> 0;
          // ServUO BaseCreature.BondingBegin — stamp the start of the
          // bonding period. After BONDING_DELAY (7 days) the periodic
          // sweep in main.js promotes this pet to bonded=true (can be
          // resurrected via Vet skill, transfers to ghost, etc).
          liveCreature.tameSince = Date.now();
          liveCreature.bonded = false;
          liveCreature._listensToSpeech = true;
          liveCreature._speechKeywords = ['all'];
          liveCreature.petCommand = 'follow';
          // A tamed creature is no longer owned by its wilderness spawner.
          // Release the slot immediately instead of waiting for a later
          // periodic sweep of the group.
          api.spawner?.releaseMobile?.(liveCreature);
          api.ai.attach?.(liveCreature, 'pet', { command: 'follow', targetSerial: 0 });
          // Add to the world's pet index so the hunger ticker + bond
          // sweep find this creature without a full mob walk.
          if (api.world._pets) api.world._pets.add(liveCreature.serial);
          // Server parity #10 #3 — achievements progress on successful
          // tame. Lazy via systems.achievements so the engine stays
          // unit-testable without the catalog.
          try {
            const ach = api.ctx?.systems?.achievements;
            const acc = ctx.sender.client?.account;
            if (ach?.progress && acc) {
              const unlocks = ach.progress(acc, 'tames', 1);
              if (Array.isArray(unlocks)) {
                for (const u of unlocks) {
                  ctx.state.sendSystemMessage(
                    `★ Achievement unlocked: ${u.achievement?.name ?? u.id ?? ''}`,
                  );
                }
              }
            }
          } catch (e) { console.error('[tame] achievements:', e); }
          ctx.state.sendSystemMessage(`${liveCreature.name ?? 'The creature'} is now your pet.`);
          // BUGFIX #60 (PHASE CR): the original re-broadcast of mobileMoving
          // fanned to EVERY connected client globally. A taming in Britain
          // pinged players in Trinsic and on Felucca via redundant 0x77
          // packets. Filter by map + 18-tile visibility window.
          const moving = api.protocol.mobileMoving?.({
            serial: liveCreature.serial, body: liveCreature.body,
            x: liveCreature.x, y: liveCreature.y, z: liveCreature.z,
            direction: liveCreature.direction, hue: liveCreature.hue,
            flags: liveCreature.flags, notoriety: liveCreature.notoriety,
          });
          if (moving) {
            for (const other of nearbyClients(api, liveCreature)) other.client.send(moving);
          }
        };
        setTimeout(tick, ATTEMPT_INTERVAL_MS);
      }, { kind: 0 /* mobile */ });
    },
  });

  function withinRange(a, b, range) {
    if (a.map !== b.map) return false;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= range;
  }

  /**
   * Broadcast an overhead-flavour message anchored to `subject`. Honours
   * map + 18-tile visibility — the same scope the rest of the game uses.
   */
  function broadcastNearby(api, subject, text, hue = 0x35) {
    const sp = api.protocol.unicodeMessage?.({
      serial: subject.serial, graphic: subject.body, type: 0,
      hue, font: 3, language: 'ENU',
      name: subject.name ?? 'creature',
      text,
    });
    if (!sp) return;
    for (const other of nearbyClients(api, subject)) other.client.send(sp);
  }

  /**
   * PHASE DA: graphical effect on a creature mid-taming. Item id 0x376A
   * is ServUO's "magic ring" sprite — same one Bless / Heal use for
   * the warm-glow telegraph. We anchor it on the creature with
   * EffectKind.FromSource so it tracks them around if they wander.
   */
  function broadcastTamingEffect(api, creature) {
    if (!api.protocol?.graphicalEffect) return;
    const Kind = api.protocol.EffectKind ?? {};
    const bytes = api.protocol.graphicalEffect({
      kind: Kind.FromSource ?? 0,
      from: creature.serial, to: creature.serial,
      itemId: 0x376A, hue: 0x4FE,
      fromX: creature.x, fromY: creature.y, fromZ: creature.z,
      toX:   creature.x, toY:   creature.y, toZ:   creature.z,
      speed: 10, duration: 18,
    });
    if (!bytes) return;
    for (const other of nearbyClients(api, creature)) other.client.send(bytes);
  }

  return () => api.commands.unregister('tame');
}
