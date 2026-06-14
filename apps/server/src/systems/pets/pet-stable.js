// Pet stable — 30-day rental for tamed creatures. Mirrors ServUO
// `Scripts/Mobiles/AI/AnimalTrainer.cs` stable mechanic.
//
// API:
//   stable.deposit(stableMob, master, pet)  // remove from world, store
//   stable.withdraw(stableMob, master, slot)// recall a stabled pet
//   stable.list(master)                     // who's stabled?
//
// On deposit we drop the pet from the world (removeEntity broadcast) and
// keep its data in `master._stable[]`. On withdraw we re-add the mob
// from saved data, re-broadcast mobileIncoming, and reset its position
// to the stable NPC's location. Storage isn't durable (no save-to-disk
// yet) — ServUO writes to `Saves/Mobiles`. Spawner-persistence pattern
// can extend to stables later.

const SLOTS_DEFAULT = 5;

export const stable = {
  /** @param {{slots?:number}} cfg */
  deposit(stableMob, master, pet, _cfg = {}) {
    if (!pet || pet.controlMaster !== master.serial) {
      return { ok: false, reason: 'not-yours' };
    }
    if (!master._stable) master._stable = [];
    if (master._stable.length >= (master.stableSlots ?? SLOTS_DEFAULT)) {
      return { ok: false, reason: 'no-slots' };
    }
    // BH #10 #8 — drop the stored `slot` field. Splice reindexes the
    // array but the persisted slot value would lie, causing UI / save
    // round-trip mismatches. Use the array index everywhere.
    const snapshot = {
      kind: pet.kind, name: pet.name, body: pet.body, hue: pet.hue,
      hp: pet.hp, hpMax: pet.hpMax, mana: pet.mana, manaMax: pet.manaMax,
      stam: pet.stam, stamMax: pet.stamMax,
      hunger: pet.hunger, loyalty: pet.loyalty,
      bonded: pet.bonded ?? false,
      stabledAt: Date.now(),
    };
    master._stable.push(snapshot);
    const slot = master._stable.length - 1;
    // Mark the mob as stabled — caller broadcasts removeEntity.
    pet._stabled = true;
    return { ok: true, slot };
  },

  withdraw(_stableMob, master, slot) {
    if (!master._stable || !master._stable[slot]) {
      return { ok: false, reason: 'empty-slot' };
    }
    const snap = master._stable.splice(slot, 1)[0];
    // 30-day expiry — past that, return value is "lost" (ServUO releases pets).
    const ageDays = (Date.now() - (snap.stabledAt ?? 0)) / 86_400_000;
    if (ageDays > 30) return { ok: false, reason: 'lost', snapshot: snap };
    return { ok: true, snapshot: snap };
  },

  list(master) {
    return master._stable ? [...master._stable] : [];
  },

  /** Sweep expired pets (caller decides what to do with `lost` returns). */
  sweepExpired(master) {
    if (!master._stable) return [];
    const now = Date.now();
    const lost = [];
    master._stable = master._stable.filter((s) => {
      const ageDays = (now - (s.stabledAt ?? 0)) / 86_400_000;
      if (ageDays > 30) { lost.push(s); return false; }
      return true;
    });
    return lost;
  },
};
