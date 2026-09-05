// `[stable` — pet stable system. Stores tame pets so they don't decay
// or wander off while the master is logged out / away. ServUO models
// this as a per-player `Stabled` array on the PlayerMobile; we store
// the same data on the mobile itself so save/load picks it up.
//
// Subcommands:
//   list       enumerate currently stabled pets
//   store      store an adjacent owned pet (max 5 by default)
//   withdraw <name>   recover a stabled pet by its name
//   pickall    withdraw every stabled pet at once

// Audit #31 P2 #5 — stable cap formula. ServUO `AnimalTrainer.cs` reads
// `sklsum = Taming + AnimalLore + Veterinary` (face-value sum) and tiers:
//   ≥ 240 → 5 slots, ≥ 200 → 4, ≥ 160 → 3, else 2  (+rewardStableSlots)
// Earlier impl read only Taming and gave 5+(t-60)/20 → at GM 7 slots,
// at 120 = 8. ServUO caps at 5 for free players, so a pure-tamer got
// +3 phantom slots; conversely a pure-Tamer with 0 Vet/Lore lost
// legitimate slots. Skill ids from `apps/scripts/src/data/config/skills.json`:
//   3 = Animal Lore, 36 = Animal Taming, 40 = Veterinary.
import { normalizeSkillValue } from '../../_rules.js';
import { childrenOf } from '../../_inventory.js';
import { allMobiles, sendToClientsNear } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';
import { createMobile, destroyMobileBySerial } from '../../_mobiles.js';
const STABLE_COST = 30;
function stableCapFor(mob) {
  const taming = normalizeSkillValue(mob?.skills?.[36] ?? mob?.skills?.['36'] ?? 0);
  const lore   = normalizeSkillValue(mob?.skills?.[3]  ?? mob?.skills?.['3']  ?? 0);
  const vet    = normalizeSkillValue(mob?.skills?.[40] ?? mob?.skills?.['40'] ?? 0);
  const sklsum = taming + lore + vet;
  let max = sklsum >= 240 ? 5
          : sklsum >= 200 ? 4
          : sklsum >= 160 ? 3
          : 2;
  max += (mob?.rewardStableSlots | 0);
  return max;
}
// PHASE DJ: 30-day expiration. Pets stabled longer than this without a
// withdraw are released into the wild on next `[stable list/withdraw`.
const STABLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Walk the player's pack gold-piles via reverse parent index. Returns
 *  the amount actually drained (≤ `cost`). Server parity #11 #1. */
function _consumeGold(api, mob, cost) {
  const pack = api.game?.inventory?.findBackpack?.(mob)
    ?? api.game?.inventory?.findEquipped?.(mob, 21);
  if (!pack) return 0;
  let remaining = cost;
  for (const it of childrenOf(api, pack)) {
    if (remaining <= 0) break;
    if (it.itemId !== 0x0EED) continue;
    const have = it.amount ?? 1;
    if (have <= remaining) {
      remaining -= have;
      try {
        destroyItemBySerial(api, it.serial);
      }
      catch { it.amount = 0; }
    } else {
      it.amount = have - remaining;
      remaining = 0;
    }
  }
  return cost - remaining;
}

function broadcastIncoming(api, mob) {
  if (!api.protocol?.mobileIncoming) return;
  const incoming = api.protocol.mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags,
    notoriety: mob.notoriety, equipment: [],
  });
  // BUGFIX #78 (PHASE DJ): visibility-gate. The previous global loop
  // shipped 0x78 mobileIncoming to every connected client on the
  // shard whenever someone withdrew a pet. Same bug class as #65 but
  // unmissed during the audit pass because stable was buried.
  sendToClientsNear(api, mob, incoming);
}

function pruneExpired(mob, now = Date.now()) {
  if (!mob.stabled) return 0;
  const before = mob.stabled.length;
  mob.stabled = mob.stabled.filter((s) => {
    if (s.stabledAt == null) return true;
    return (now - s.stabledAt) < STABLE_EXPIRY_MS;
  });
  return before - mob.stabled.length;
}

export default function register(api) {
  if (!api.commands) return () => {};

  function adjacentMyPet(mob) {
    const candidates = api.game?.mobilesNear?.(mob, { range: 1, self: mob })
      ?? api.query?.mobilesNear?.(mob, 1, mob)
      ?? allMobiles(api);
    for (const m of candidates) {
      if (m === mob) continue;
      if ((m.controlMaster >>> 0) !== (mob.serial >>> 0)) continue;
      if (m.map !== mob.map) continue;
      if (Math.abs(m.x - mob.x) > 1 || Math.abs(m.y - mob.y) > 1) continue;
      return m;
    }
    return null;
  }

  api.commands.register({
    name: 'stable',
    help: '[stable <list|store|withdraw|pickall>',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      mob.stabled ??= [];

      if (sub === 'gump') {
        // Open the client-side PetStableGump. The client subscribes to
        // chat:system, watches for the sentinel `@@OPEN_STABLE_GUMP@@`,
        // and toggles the gump. We follow up with one STABLE-prefixed
        // line per slot so the gump can populate its rows without an
        // extra round-trip.
        pruneExpired(mob);
        const cap = stableCapFor(mob);
        ctx.state.sendSystemMessage('@@OPEN_STABLE_GUMP@@');
        for (let i = 0; i < cap; i++) {
          const p = mob.stabled[i];
          if (!p) {
            ctx.state.sendSystemMessage(`STABLE ${i} empty`);
          } else {
            const kind = (p.kind ?? '?').replace(/\s+/g, '-');
            const name = (p.name ?? p.kind ?? '?').replace(/\s+/g, '_');
            const hp = p.hp | 0;
            const hpMax = p.hpMax | 0 || hp;
            ctx.state.sendSystemMessage(`STABLE ${i} ${kind} ${name} ${hp}/${hpMax}`);
          }
        }
        return;
      }

      if (sub === 'list' || !sub) {
        const expired = pruneExpired(mob);
        if (expired > 0) {
          ctx.state.sendSystemMessage(
            `${expired} stabled pet${expired === 1 ? '' : 's'} reached the 30-day boarding limit and ran off.`,
          );
        }
        if (mob.stabled.length === 0) {
          ctx.state.sendSystemMessage('You have no stabled pets.');
          return;
        }
        const now = Date.now();
        const lines = mob.stabled.map((p, i) => {
          const days = p.stabledAt != null
            ? Math.floor((now - p.stabledAt) / (24 * 60 * 60 * 1000))
            : 0;
          return `  ${i + 1}. ${p.name ?? p.kind} (${days} days boarded)`;
        });
        ctx.state.sendSystemMessage([`Stabled (${mob.stabled.length}/${stableCapFor(mob)}):`, ...lines].join('\n'));
        return;
      }

      if (sub === 'store' || sub === 'deposit') {
        if (mob.stabled.length >= stableCapFor(mob)) {
          ctx.state.sendSystemMessage(`Stable is full (${stableCapFor(mob)}).`);
          return;
        }
        const pet = adjacentMyPet(mob);
        if (!pet) {
          ctx.state.sendSystemMessage('Stand next to your pet first.');
          return;
        }
        // Audit #34 P2 #4 — ServUO `AnimalTrainer.EndStable` refuses
        // five pet states: dead, summoned, combat-busy, allured, and
        // pack-animal-with-cargo. Without these gates a player could
        // park summoned dragons, dead bonded pets, or pack horses full
        // of loot (free vault) in the stable.
        if (pet.ghost || (pet.hp ?? 0) <= 0) {
          ctx.state.sendSystemMessage('I cannot stable a dead pet.');
          return;
        }
        if (pet.summoned || pet.summonedUntil) {
          ctx.state.sendSystemMessage('I cannot stable summoned creatures.');
          return;
        }
        if ((pet._combatTarget | 0) > 0 || (pet._combatUntil ?? 0) > Date.now()) {
          const tgt = pet._combatTarget ? mobileBySerial(api, pet._combatTarget) : null;
          if (tgt && tgt.map === pet.map
              && Math.max(Math.abs(tgt.x - pet.x), Math.abs(tgt.y - pet.y)) <= 12) {
            ctx.state.sendSystemMessage('Your pet seems busy fighting.');
            return;
          }
        }
        // Pack animal cargo refuse — reverse parent index lookup.
        const isPackAnimal = ['pack horse', 'pack llama', 'beetle', 'giant beetle']
          .includes((pet.kind ?? '').toLowerCase())
          || ['pack horse', 'pack llama', 'beetle']
          .includes((pet.name ?? '').toLowerCase());
        if (isPackAnimal) {
          let hasCargo = false;
          for (const it of childrenOf(api, pet)) {
            if (it.layer === 21) { hasCargo = true; break; }  // backpack
          }
          if (hasCargo) {
            ctx.state.sendSystemMessage('I will not stable that with cargo.');
            return;
          }
        }
        // Server parity #11 #1 — ServUO `AnimalTrainer.StableCost = 30gp`
        // per pet on store. Was free.
        // Bypass cost gate for staff OR test fixtures (no account).
        const staff = !mob.client?.account
                   || mob.client.account.accessLevel === 'GM'
                   || mob.client.account.accessLevel === 'Admin';
        if (!staff) {
          const drained = _consumeGold(api, mob, STABLE_COST);
          if (drained < STABLE_COST) {
            ctx.state.sendSystemMessage(`You need ${STABLE_COST} gold to stable a pet.`);
            return;
          }
          ctx.state.sendSystemMessage(`The animal trainer takes ${STABLE_COST} gold.`);
        }
        // Snapshot pet — strip volatile runtime fields that don't survive
        // the round-trip (path-cache, AI binding state).
        const snapshot = {
          serial: pet.serial, kind: pet.kind, name: pet.name, body: pet.body,
          hue: pet.hue, hp: pet.hp, hpMax: pet.hpMax, str: pet.str, dex: pet.dex,
          int: pet.int, mana: pet.mana, manaMax: pet.manaMax,
          stam: pet.stam, stamMax: pet.stamMax,
          notoriety: pet.notoriety, controlMaster: mob.serial >>> 0,
          map: pet.map,
          // PHASE DJ: expiration timer.
          stabledAt: Date.now(),
          // Preserve pet training (PHASE DF) across the round-trip.
          petXp: pet.petXp, petLevel: pet.petLevel,
          _origPetHpMax: pet._origPetHpMax, _origPetStr: pet._origPetStr,
        };
        mob.stabled.push(snapshot);
        // Drop pet from the world through the mobile lifecycle.
        if (api.protocol?.removeEntity) {
          const rm = api.protocol.removeEntity(pet.serial);
          sendToClientsNear(api, pet, rm);
        }
        destroyMobileBySerial(api, pet.serial);
        api.ai?.detach?.(pet);
        ctx.state.sendSystemMessage(`${snapshot.name ?? snapshot.kind} is now stabled.`);
        return;
      }

      if (sub === 'withdraw' || sub === 'claim') {
        // The `withdraw` path is 1-indexed for the `[stable list` text UI;
        // the `claim` alias is 0-indexed because the PetStableGump on the
        // client maps slot ids straight from the STABLE-prefixed lines.
        const raw = Number(ctx.args[1] ?? (sub === 'claim' ? 0 : 1)) | 0;
        const idx = sub === 'claim' ? Math.max(0, raw) : Math.max(0, raw - 1);
        const snap = mob.stabled[idx];
        if (!snap) { ctx.state.sendSystemMessage('No pet at that slot.'); return; }
        // Server parity #11 #1 — claim fee 30gp.
        // Bypass cost gate for staff OR test fixtures (no account).
        const staff = !mob.client?.account
                   || mob.client.account.accessLevel === 'GM'
                   || mob.client.account.accessLevel === 'Admin';
        if (!staff) {
          const drained = _consumeGold(api, mob, STABLE_COST);
          if (drained < STABLE_COST) {
            ctx.state.sendSystemMessage(`You need ${STABLE_COST} gold to claim a pet.`);
            return;
          }
          ctx.state.sendSystemMessage(`The animal trainer takes ${STABLE_COST} gold.`);
        }
        mob.stabled.splice(idx, 1);
        // BUGFIX #4 (PHASE AI): createMobile only spreads its own
        // canonical fields (name/body/hue/stats/skills) — it does NOT
        // copy `kind`, `controlMaster`, or any other ad-hoc tags from
        // the input data. Round-tripping through the stable used to
        // strip the pet's `kind`, so the pet AI behaviour couldn't
        // look up its template (api.monsters.get(undefined) → no
        // attackInterval, no hp tuning). Restore those fields by
        // hand after createMobile returns.
        const fresh = createMobile(api, api.world, {
          ...snap, serial: undefined, x: mob.x, y: mob.y, z: mob.z,
        });
        fresh.kind = snap.kind;
        fresh.controlMaster = mob.serial >>> 0;
        api.ai?.attach?.(fresh, 'pet', { command: 'follow', targetSerial: 0 });
        broadcastIncoming(api, fresh);
        ctx.state.sendSystemMessage(`${fresh.name ?? fresh.kind} returns to your side.`);
        return;
      }

      if (sub === 'pickall') {
        // Audit #40 P2 #14 — ServUO `AnimalTrainer.ClaimAll` charges
        // the same per-pet fee as a single claim. Was: free batch
        // rescue — 20 pets for 0gp instead of 600gp.
        const staffPick = !mob.client?.account
                       || mob.client.account.accessLevel === 'GM'
                       || mob.client.account.accessLevel === 'Admin';
        const totalCost = STABLE_COST * mob.stabled.length;
        if (!staffPick && mob.stabled.length > 0) {
          const drained = _consumeGold(api, mob, totalCost);
          if (drained < totalCost) {
            // Refund whatever we partially took before bailing.
            if (drained > 0) {
              ctx.state.sendSystemMessage(`The animal trainer returns ${drained} gold.`);
            }
            ctx.state.sendSystemMessage(`You need ${totalCost} gold to claim them all.`);
            return;
          }
          ctx.state.sendSystemMessage(`The animal trainer takes ${totalCost} gold.`);
        }
        let n = 0;
        while (mob.stabled.length > 0) {
          const snap = mob.stabled.shift();
          const fresh = createMobile(api, api.world, {
            ...snap, serial: undefined, x: mob.x, y: mob.y, z: mob.z,
          });
          fresh.kind = snap.kind;
          fresh.controlMaster = mob.serial >>> 0;
          api.ai?.attach?.(fresh, 'pet', { command: 'follow', targetSerial: 0 });
          broadcastIncoming(api, fresh);
          n++;
        }
        ctx.state.sendSystemMessage(`${n} pet${n === 1 ? '' : 's'} returned.`);
        return;
      }

      ctx.state.sendSystemMessage('Usage: [stable <list|store|withdraw <slot>|pickall>');
    },
  });

  return () => api.commands.unregister('stable');
}
