import { allMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
// `[pet <command>` — issue an order to all pets controlled by the sender.
//
// Subcommands:
//   follow   pets resume following the master (default)
//   stay     pets stand still wherever they are
//   guard    pets attack any aggressor of the master
//   attack   request a target — pets will close and attack
//   release  pets become wild (controlMaster cleared, AI swapped to wander)
//
// In a real UO client these are issued via speech ("all follow", "all stay")
// — mapping that is FAZA J part-2 (requires hooking the player speech
// handler). The text command shipped here is the GM-/dev-friendly path
// that exercises the same underlying state machine.

export default function register(api) {
  if (!api.protocol) return () => {};

  function ownedPets(masterSerial) {
    const out = [];
    for (const m of allMobiles(api)) {
      if ((m.controlMaster >>> 0) !== (masterSerial >>> 0)) continue;
      out.push(m);
    }
    return out;
  }

  function setBindingState(mob, mutator) {
    const binding = api.ai?.bindings?.get?.(mob.serial);
    if (!binding) return;
    mutator(binding.state);
  }

  api.commands.register({
    name: 'pet',
    help: '[pet <follow|stay|guard|attack|release>',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const pets = ownedPets(ctx.sender.serial);
      if (pets.length === 0) {
        ctx.state.sendSystemMessage('You have no pets to command.');
        return;
      }
      // FAZA CG helper: write the command both to the runtime binding
      // (so the AI tick sees it this frame) AND to mob.petCommand
      // (persisted so a server restart preserves the order).
      const setCommand = (p, cmd, target = 0) => {
        p.petCommand = cmd;
        setBindingState(p, (s) => { s.command = cmd; s.targetSerial = target; });
      };
      switch (sub) {
        case 'follow':
          for (const p of pets) setCommand(p, 'follow');
          ctx.state.sendSystemMessage(`${pets.length} pet${pets.length === 1 ? '' : 's'} follow you.`);
          break;
        case 'stay':
          for (const p of pets) setCommand(p, 'stay');
          ctx.state.sendSystemMessage(`${pets.length} pet${pets.length === 1 ? '' : 's'} stay.`);
          break;
        case 'guard':
          for (const p of pets) setCommand(p, 'guard');
          ctx.state.sendSystemMessage(`${pets.length} pet${pets.length === 1 ? '' : 's'} guard you.`);
          break;
        case 'attack':
          if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
          ctx.state.sendSystemMessage('Attack which target?');
          api.targeting.request(ctx.state, (picked) => {
            if (!picked?.serial) {
              ctx.state.sendSystemMessage('Order cancelled.');
              return;
            }
            for (const p of pets) setCommand(p, 'attack', picked.serial >>> 0);
            ctx.state.sendSystemMessage(`Pets attack target.`);
          }, { kind: 0 });
          break;
        case 'release':
          for (const p of pets) {
            p.controlMaster = 0;
            p.notoriety = 3; // back to neutral wilderness
            delete p.petCommand;
            delete p._listensToSpeech;
            delete p._speechKeywords;
            // Clear pet training so a re-tame doesn't inherit prior xp.
            delete p.petXp; delete p.petLevel; delete p.bonded;
            api.ai?.attach?.(p, 'wander');
          }
          ctx.state.sendSystemMessage(`Released ${pets.length} pet${pets.length === 1 ? '' : 's'}.`);
          break;
        case 'rename': {
          // FAZA DK: rename a single adjacent pet. ServUO uses speech
          // ("name <text>") with the pet selected; we expose a clean
          // textual path that the speech parser can also dispatch into.
          const newName = ctx.args.slice(1).join(' ').trim();
          if (!newName) {
            ctx.state.sendSystemMessage('Usage: [pet rename <new name>');
            return;
          }
          if (newName.length > 30) {
            ctx.state.sendSystemMessage('Pet names are limited to 30 characters.');
            return;
          }
          // Pick the closest adjacent pet (1 tile).
          let chosen = null, bestD = Infinity;
          for (const p of pets) {
            if (p.map !== ctx.sender.map) continue;
            const d = Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y));
            if (d > 2) continue;
            if (d < bestD) { bestD = d; chosen = p; }
          }
          if (!chosen) {
            ctx.state.sendSystemMessage('Stand next to your pet first.');
            return;
          }
          chosen.name = newName;
          if (api.protocol?.mobileIncoming) {
            const incoming = api.protocol.mobileIncoming({
              serial: chosen.serial, body: chosen.body,
              x: chosen.x, y: chosen.y, z: chosen.z,
              direction: chosen.direction, hue: chosen.hue,
              flags: chosen.flags, notoriety: chosen.notoriety,
              equipment: [],
            });
            for (const m of allMobiles(api)) {
              if (!m.client) continue;
              if (m.map !== chosen.map) continue;
              if (Math.abs(m.x - chosen.x) > 18 || Math.abs(m.y - chosen.y) > 18) continue;
              m.client.send(incoming);
            }
          }
          ctx.state.sendSystemMessage(`Renamed to ${newName}.`);
          break;
        }
        case 'bond': {
          // ServUO bonds a pet after 7 days of ownership (BondingDelay).
          // We now gate on `tameSince` — the periodic sweep in
          // systems/pets/pet-hunger.js promotes automatically once the
          // delay elapses. Manual `[pet bond` reports the time-left
          // for each adjacent pet so the player knows when to check.
          const now = Date.now();
          const BONDING_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
          const lines = [];
          // GM/Admin/Counselor short-circuit — admin pets bond instantly.
          const access = ctx.state?.account?.accessLevel ?? ctx.sender?.accessLevel ?? 'Player';
          const adminBypass = access === 'Admin' || access === 'GM' || access === 'Counselor';
          for (const p of pets) {
            if (p.map !== ctx.sender.map) continue;
            const d = Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y));
            if (d > 2) continue;
            if (p.bonded) {
              lines.push(`${p.name ?? 'pet'} is already bonded.`);
              continue;
            }
            const since = p.tameSince || (p.tameSince = now);
            const elapsed = now - since;
            if (adminBypass || elapsed >= BONDING_DELAY_MS) {
              p.bonded = true;
              lines.push(`${p.name ?? 'pet'} is now bonded.`);
            } else {
              const hoursLeft = Math.ceil((BONDING_DELAY_MS - elapsed) / (60 * 60 * 1000));
              lines.push(`${p.name ?? 'pet'} bonds in ~${hoursLeft} h.`);
            }
          }
          if (lines.length === 0) {
            ctx.state.sendSystemMessage('No adjacent pets to bond.');
          } else {
            for (const l of lines) ctx.state.sendSystemMessage(l);
          }
          break;
        }
        case 'transfer': {
          // [pet transfer <playerName> — hand ownership to another
          // player. ServUO requires adjacent + target accept-prompt
          // AND the FollowersMax check. Audit #32 P1 #1: previously
          // we skipped both — a player could dump unlimited pets onto
          // a victim, overflowing their follower slots and breaking
          // their pet accounting permanently.
          const targetName = (ctx.args[1] ?? '').toLowerCase();
          if (!targetName) { ctx.state.sendSystemMessage('Usage: [pet transfer <name>'); return; }
          let target = null;
          for (const m of allMobiles(api)) {
            if (!m.client) continue;
            if (m.name?.toLowerCase() === targetName) { target = m; break; }
          }
          if (!target) { ctx.state.sendSystemMessage('That player is not online.'); return; }
          const adj = Math.max(Math.abs(target.x - ctx.sender.x), Math.abs(target.y - ctx.sender.y));
          if (adj > 2 || target.map !== ctx.sender.map) {
            ctx.state.sendSystemMessage('Stand next to the recipient first.');
            return;
          }
          // Pre-filter pets that are actually in range; the cap check
          // and accept-prompt only consider these.
          const within = pets.filter((p) =>
            Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y)) <= 5);
          if (within.length === 0) {
            ctx.state.sendSystemMessage('No adjacent pets to transfer.');
            return;
          }
          // FollowersMax cap on recipient. ServUO `BaseCreature.OnDragDrop`
          // rejects when `Followers + ControlSlots > FollowersMax`.
          const slots = within.reduce((s, p) => s + (p._followerCost ?? 1), 0);
          const max = target.followersMax ?? 5;
          if (((target.followers | 0) + slots) > max) {
            ctx.state.sendSystemMessage(`${target.name} cannot accept that many followers.`);
            target.client?.sendSystemMessage?.(`${ctx.sender.name} tried to transfer pets but you have no room.`);
            return;
          }
          // Accept-prompt. The recipient must confirm via a yes/no
          // target. We mark the request `_petTransferOffer` on the
          // target with a 30s window; `[pet accept` consumes it.
          target._petTransferOffer = {
            from: ctx.sender.serial >>> 0,
            pets: within.map((p) => p.serial >>> 0),
            slots,
            expiresAt: Date.now() + 30_000,
          };
          target.client?.sendSystemMessage?.(
            `${ctx.sender.name} offers to transfer ${within.length} pet(s) to you. Type [pet accept within 30s.`);
          ctx.state.sendSystemMessage(`Offer sent to ${target.name}.`);
          return;
        }
        case 'accept': {
          // Audit #32 P1 #1 — consume pending transfer offer.
          const offer = ctx.sender._petTransferOffer;
          if (!offer || offer.expiresAt < Date.now()) {
            ctx.state.sendSystemMessage('No pending pet-transfer offer.');
            ctx.sender._petTransferOffer = null;
            return;
          }
          // Re-validate cap at accept time (recipient may have tamed
          // a pet between offer and accept).
          const max = ctx.sender.followersMax ?? 5;
          if (((ctx.sender.followers | 0) + offer.slots) > max) {
            ctx.state.sendSystemMessage('You have too many followers to accept those pets.');
            ctx.sender._petTransferOffer = null;
            return;
          }
          let n = 0;
          for (const s of offer.pets) {
            const p = mobileBySerial(api, s >>> 0);
            if (!p) continue;
            p.controlMaster = ctx.sender.serial >>> 0;
            n += 1;
          }
          ctx.sender.followers = (ctx.sender.followers | 0) + offer.slots;
          // Decrement old master's follower count too if they're online.
          const oldMaster = mobileBySerial(api, offer.from);
          if (oldMaster) {
            oldMaster.followers = Math.max(0, (oldMaster.followers | 0) - offer.slots);
            oldMaster.client?.sendSystemMessage?.(`${ctx.sender.name} accepted ${n} pet(s).`);
          }
          ctx.sender._petTransferOffer = null;
          ctx.state.sendSystemMessage(`You take ownership of ${n} pet(s).`);
          return;
        }
        case 'abandon': {
          // [pet abandon — release without bonding penalty. ServUO
          // distinguishes between "release" (lose stat-loss) and
          // "abandon" (also resets bonding). Same code path as release
          // for our model + extra cleanup.
          let n = 0;
          for (const p of pets) {
            const d = Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y));
            if (d > 5) continue;
            p.controlMaster = 0; p.notoriety = 3;
            delete p.petCommand; delete p.bonded; delete p.petLevel; delete p.petXp;
            api.ai?.attach?.(p, 'wander');
            n += 1;
          }
          ctx.state.sendSystemMessage(`Abandoned ${n} pet(s).`);
          return;
        }
        case 'feed': {
          // [pet feed — top up hunger from any matching food in your
          // pack. Pet-hunger system reads `pet.hunger` 0..20.
          let fed = 0;
          for (const p of pets) {
            if (Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y)) > 2) continue;
            const wasHungry = (p.hunger ?? 0) < 18;
            if (wasHungry) {
              p.hunger = 20;
              p.lastFedAt = Date.now();
              fed += 1;
            }
          }
          ctx.state.sendSystemMessage(fed > 0 ? `Fed ${fed} pet(s).` : 'No hungry pets adjacent.');
          return;
        }
        case 'coat':
        case 'saddle':
        case 'decoration':
        case 'trinket':
        case 'plate': {
          // Cosmetic family — `[pet coat <hueHex>` etc. Targets the
          // adjacent pet (closest within 2 tiles).
          const PC = api.systems?.petCustomization;
          if (!PC) { ctx.state.sendSystemMessage('Pet customization unavailable.'); return; }
          let chosen = null, bestD = Infinity;
          for (const p of pets) {
            if (p.map !== ctx.sender.map) continue;
            const d = Math.max(Math.abs(p.x - ctx.sender.x), Math.abs(p.y - ctx.sender.y));
            if (d > 2) continue;
            if (d < bestD) { bestD = d; chosen = p; }
          }
          if (!chosen) { ctx.state.sendSystemMessage('Stand next to a pet first.'); return; }
          const arg = ctx.args[1] ?? '';
          let ok = false;
          switch (sub) {
            case 'coat':       ok = PC.setCoat(chosen, parseInt(arg, 16) || 0); break;
            case 'saddle':     ok = PC.setSaddle(chosen, parseInt(arg, 16) || 0); break;
            case 'decoration': ok = PC.setDecoration(chosen, arg.toLowerCase() || null); break;
            case 'trinket':    ok = PC.setTrinket(chosen, parseInt(arg, 16) || 0); break;
            case 'plate':      ok = PC.setNamePlate(chosen, arg.toLowerCase() || null); break;
          }
          if (ok && api.protocol?.mobileIncoming) {
            // Re-broadcast pet so the new hue is picked up by observers.
            const incoming = api.protocol.mobileIncoming({
              serial: chosen.serial, body: chosen.body,
              x: chosen.x, y: chosen.y, z: chosen.z,
              direction: chosen.direction, hue: chosen.hue,
              flags: chosen.flags, notoriety: chosen.notoriety,
              equipment: [],
            });
            for (const m of allMobiles(api)) {
              if (!m.client) continue;
              if (m.map !== chosen.map) continue;
              if (Math.abs(m.x - chosen.x) > 18 || Math.abs(m.y - chosen.y) > 18) continue;
              m.client.send(incoming);
            }
          }
          ctx.state.sendSystemMessage(ok
            ? `${chosen.name ?? 'pet'} updated.`
            : `Bad ${sub} value.`);
          return;
        }
        case 'xp': {
          // [pet xp — list each owned pet's training progress.
          const PT = api.systems?.petTraining;
          if (!PT?.xpProgressOf) {
            ctx.state.sendSystemMessage('Pet training engine missing.');
            return;
          }
          if (pets.length === 0) {
            ctx.state.sendSystemMessage('You have no pets.');
            return;
          }
          ctx.state.sendSystemMessage('Pet training:');
          for (const p of pets) {
            const sn = PT.xpProgressOf(p);
            if (!sn) continue;
            const filled = Math.floor(sn.pct / 10);
            const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
            const tag = sn.isMax ? 'MAX' : `${sn.intoLevel}/1000 (${sn.pct}%)`;
            ctx.state.sendSystemMessage(`  ${p.name ?? 'pet'}  L${sn.level}  ${bar}  ${tag}`);
          }
          return;
        }
        case 'train': {
          const PT = api.systems?.petTraining;
          const ability = String(ctx.args[1] ?? '').toLowerCase();
          const serial = parseInt(String(ctx.args[2] ?? ''), 16) >>> 0;
          const pet = serial ? pets.find((entry) => (entry.serial >>> 0) === serial) : pets[0];
          if (!pet) { ctx.state.sendSystemMessage('Pet not found.'); return; }
          const result = PT?.trainPet?.(pet, ability) ?? { ok: false, error: 'Pet training engine missing.' };
          ctx.state.sendSystemMessage(result.ok
            ? `${pet.name ?? 'Your pet'} learned ${result.ability.label}. ${result.available} point(s) remain.`
            : result.error);
          return;
        }
        case 'trainui':
        case 'traingump':
        case 'tricks': {
          // Faza H.2 — open the pet-training overlay for the first owned pet
          // (or the one whose serial was passed as arg #2).
          const targetSerial = parseInt(String(ctx.args[1] ?? ''), 16) >>> 0;
          const pet = targetSerial
            ? pets.find((p) => (p.serial >>> 0) === targetSerial)
            : pets[0];
          if (!pet) {
            ctx.state.sendSystemMessage('No pet found.');
            return;
          }
          const PT = api.systems?.petTraining;
          const sn = PT?.xpProgressOf?.(pet) ?? { level: 0, pct: 0, intoLevel: 0 };
          const payload = [
            (pet.serial >>> 0).toString(16),
            (pet.name ?? '?').replace(/[|;]/g, '_'),
            sn.level | 0,
            sn.pct | 0,
            sn.intoLevel | 0,
            PT?.trainingPointsAvailable?.(pet) ?? 0,
            (pet.petTrainingAbilities ?? []).join(','),
          ].join('|');
          ctx.state.sendSystemMessage?.(`@@OPEN_PETTRAINING_GUMP@@${payload}`);
          return;
        }
        case 'loyalty':
        case 'status': {
          // [pet status — overview of each pet's bonding state, hunger,
          // current order, and adjacency.
          ctx.state.sendSystemMessage(`You own ${pets.length} pet(s):`);
          for (const p of pets) {
            const bonded = p.bonded ? 'bonded' : 'not bonded';
            const cmd = p.petCommand ?? 'idle';
            const hunger = p.hunger ?? '?';
            ctx.state.sendSystemMessage(`  ${p.name ?? 'pet'} — ${bonded}, hunger ${hunger}/20, order: ${cmd}`);
          }
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [pet <follow|stay|guard|attack|release|rename|bond|transfer|abandon|feed|loyalty>');
      }
    },
  });

  return () => api.commands.unregister('pet');
}
