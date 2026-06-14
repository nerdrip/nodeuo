// FAZA DF — pet training milestones.
//
// Tamed pets gain experience for kills (and only for kills they
// actually landed — the killer slot in `killMobile`). Each level
// milestone (default 5 tiers) bumps `hpMax`, `str`, and refunds full
// HP. ServUO has a parallel system in `Skills/AnimalTraining.cs` with
// a much richer "training plan" UI; we ship the irreducible core that
// makes the bond feel like a progression and not a static stat sheet.
//
// Persisted fields (added to MOBILE_EXT_KEYS):
//   mob.petXp     — accumulated xp toward the next level
//   mob.petLevel  — current level (0..MAX_LEVEL)
//
// Tuning knobs are constants here; if a future round wants per-creature
// curves, move them to monsters.json `training` blocks.

const MAX_LEVEL = 5;
const XP_PER_LEVEL = 1000;
const HP_BONUS_PER_LEVEL = 0.10;   // +10% hpMax per tier
const STR_BONUS_PER_LEVEL = 5;     // +5 str per tier

/**
 * Award `amount` xp to a pet. If the running total crosses a level
 * threshold the pet's stats bump and a system message is sent to the
 * master. Returns the new (cumulative) xp value, or 0 for no-op.
 *
 * Caps at the MAX_LEVEL × XP_PER_LEVEL plateau — past that pets are
 * "fully trained" and further xp is ignored.
 */
export function awardPetXp(pet, amount) {
  if (!pet || amount <= 0) return 0;
  if (!pet.controlMaster) return 0;       // not actually a pet
  const lvl = pet.petLevel | 0;
  if (lvl >= MAX_LEVEL) return pet.petXp | 0;
  const before = pet.petXp | 0;
  const cap = MAX_LEVEL * XP_PER_LEVEL;
  const after = Math.min(cap, before + (amount | 0));
  pet.petXp = after;
  // Compute new level from total xp (each level = XP_PER_LEVEL points).
  const newLevel = Math.min(MAX_LEVEL, Math.floor(after / XP_PER_LEVEL));
  if (newLevel > lvl) {
    levelUp(pet, lvl, newLevel);
  }
  return after;
}

/** Evolution / morph table. When a pet of `kind` reaches `atLevel`, it
 *  TRANSFORMS into the listed `next` kind — its body graphic + name +
 *  optional fame change so visually + mechanically it ascends. Mirrors
 *  ServUO ML's "Dragon morph" mini-system where a Drake at training
 *  milestone 3 becomes a Dragon, etc. */
const EVOLUTION_TABLE = {
  // Reptile line — hatchling → drake → dragon → ancient
  'lava-lizard':   [{ atLevel: 2, next: 'drake',           body: 0x003B, name: 'a drake' }],
  'drake':         [{ atLevel: 3, next: 'dragon',          body: 0x000C, name: 'a dragon' }],
  'dragon':        [{ atLevel: 5, next: 'ancient-dragon',  body: 0x000C, name: 'an ancient dragon', hue: 0x47E, fame: 25000 }],
  // Wolf line — wolf → dire wolf → grey wolf
  'timber-wolf':   [{ atLevel: 2, next: 'grey-wolf',       body: 0x00E1, name: 'a grey wolf' }],
  'grey-wolf':    [{ atLevel: 4, next: 'dire-wolf',       body: 0x0019, name: 'a dire wolf', fame: 5000 }],
  // Bird line — eagle → giant eagle → roc
  'eagle':         [{ atLevel: 3, next: 'giant-eagle',     body: 0x0005, name: 'a giant eagle' }],
  // Ostard line — ridable
  'forest-ostard': [{ atLevel: 3, next: 'frenzied-ostard', body: 0x00DA, name: 'a frenzied ostard' }],
  // Serpent line
  'snake':         [{ atLevel: 2, next: 'giant-serpent',   body: 0x0095, name: 'a giant serpent' }],
  'giant-serpent': [{ atLevel: 4, next: 'silver-serpent',  body: 0x0096, name: 'a silver serpent', hue: 0x47E }],
  // Cu sidhe line — heartwood pet
  'cu-sidhe-juvenile': [{ atLevel: 3, next: 'cu-sidhe',    body: 0x0115, name: 'a cu sidhe', fame: 12000 }],
};

function maybeEvolve(pet, newLevel) {
  const evolutions = EVOLUTION_TABLE[pet.kind];
  if (!evolutions) return;
  const match = evolutions.find((e) => e.atLevel === newLevel);
  if (!match) return;
  pet.kind = match.next;
  pet.body = match.body;
  pet.name = match.name;
  if (match.hue != null) pet.hue = match.hue;
  if (match.fame != null) pet.fame = match.fame;
  pet._evolvedAt = Date.now();
  if (pet._world) {
    const master = pet._world.mobiles?.get?.(pet.controlMaster);
    if (master?.client?.sendSystemMessage) {
      master.client.sendSystemMessage(
        `★ ${pet.name} has evolved to a new form! ★`,
      );
    }
    // Re-broadcast so nearby clients see the new body.
    try {
      const incoming = pet._world._handlers?.mobileIncoming?.({
        serial: pet.serial, body: pet.body, x: pet.x, y: pet.y, z: pet.z,
        direction: pet.direction ?? 0, hue: pet.hue ?? 0,
        flags: pet.flags ?? 0, notoriety: pet.notoriety ?? 1, equipment: [],
      });
      if (incoming) {
        for (const m of pet._world.mobiles?.values?.() ?? []) {
          if (!m.client || m.map !== pet.map) continue;
          if (Math.abs(m.x - pet.x) > 18 || Math.abs(m.y - pet.y) > 18) continue;
          m.client.sendRemove?.(pet.serial);
          m.client.send(incoming);
        }
      }
    } catch { /* protocol optional */ }
  }
}

function levelUp(pet, oldLevel, newLevel) {
  const tiers = newLevel - oldLevel;
  // Snapshot baseline ONCE on first level (so repeated levelUps don't
  // compound off of an already-bumped value).
  if (pet._origPetHpMax == null) pet._origPetHpMax = pet.hpMax | 0;
  if (pet._origPetStr   == null) pet._origPetStr   = pet.str   | 0;
  const newHpMax = Math.round(
    pet._origPetHpMax * (1 + HP_BONUS_PER_LEVEL * newLevel),
  );
  const newStr = (pet._origPetStr | 0) + STR_BONUS_PER_LEVEL * newLevel;
  pet.hpMax = newHpMax;
  pet.hp = newHpMax;                   // free heal on level-up
  pet.str = newStr;
  pet.petLevel = newLevel;
  // Check evolution AFTER stats bump so the new form inherits the
  // boosted hpMax baseline.
  maybeEvolve(pet, newLevel);
  // Notify the master if they're online.
  notifyMaster(pet, tiers, newLevel);
}

function notifyMaster(pet, tiers, newLevel) {
  // Look up the master via world reference if `_world` is captured;
  // otherwise the caller is responsible for messaging. The killMobile
  // path passes `world` and we resolve there. Keep this as a fallback
  // for direct test use.
  if (pet._world) {
    const master = pet._world.mobiles?.get?.(pet.controlMaster);
    if (master?.client?.sendSystemMessage) {
      master.client.sendSystemMessage(
        `${pet.name ?? 'Your pet'} grows stronger! `
        + `(level ${newLevel}, +${tiers} tier${tiers === 1 ? '' : 's'})`,
      );
    }
  }
}

/**
 * Standalone "level the master gets credit for, even if the pet itself
 * already maxed". Caller picks what to do with the return value (e.g.
 * give a small Compassion virtue tick).
 */
export function petLevel(pet) { return pet?.petLevel | 0; }

/**
 * Reset training (admin tool / pet release). Clears xp + level and
 * restores the original stats.
 */
export function resetPetTraining(pet) {
  if (!pet) return;
  if (pet._origPetHpMax != null) {
    pet.hpMax = pet._origPetHpMax;
    pet.hp = Math.min(pet.hp ?? pet.hpMax, pet.hpMax);
    delete pet._origPetHpMax;
  }
  if (pet._origPetStr != null) {
    pet.str = pet._origPetStr;
    delete pet._origPetStr;
  }
  delete pet.petXp;
  delete pet.petLevel;
}

/**
 * Default xp award for a kill, scaled to the victim's HP. Mirrors the
 * heuristic in `valorForKill`: tier-1 mobs award nothing (don't farm
 * rats forever), tier-3 award 10, lord-tier 100. Tunable via
 * `monsterCfg.petXp`.
 */
export function petXpForKill(monsterCfg) {
  if (!monsterCfg) return 0;
  if (typeof monsterCfg.petXp === 'number') return monsterCfg.petXp;
  const hp = monsterCfg.hp | 0;
  if (hp >= 1500) return 100;
  if (hp >= 500)  return 30;
  if (hp >= 200)  return 10;
  if (hp >= 50)   return 5;
  return 0;
}

/** Snapshot of pet xp for UI / `[pet xp` command. Returns null when
 *  the mob isn't a pet (no controlMaster). */
export function xpProgressOf(pet) {
  if (!pet?.controlMaster) return null;
  const xp = pet.petXp | 0;
  const lvl = pet.petLevel | 0;
  const cap = MAX_LEVEL * XP_PER_LEVEL;
  const intoLevel = xp - lvl * XP_PER_LEVEL;
  const next = (lvl + 1) * XP_PER_LEVEL;
  return {
    xp,
    level: lvl,
    cap,
    nextLevelAt: lvl >= MAX_LEVEL ? null : next,
    intoLevel,
    pct: lvl >= MAX_LEVEL ? 100 : Math.round((intoLevel / XP_PER_LEVEL) * 100),
    isMax: lvl >= MAX_LEVEL,
  };
}

export const _PET_TRAINING_CONST = Object.freeze({
  MAX_LEVEL, XP_PER_LEVEL, HP_BONUS_PER_LEVEL, STR_BONUS_PER_LEVEL,
});
