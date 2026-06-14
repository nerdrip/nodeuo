// FAZA CX — virtue accrual.
//
// FAZA DC: client mirrors `mob.virtues` from a 0xBF 0xCD VirtueState
// push (see packages/protocol extVirtueState). `pushVirtues(state, mob)`
// emits the packet to the player's client. We auto-push on rank-cross
// (already done via sendSystemMessage) AND on every awardVirtue call so
// the in-game gump refreshes live.
//
// ServUO's eight UO virtues each accumulate from specific player
// actions and unlock perks at thresholds (Follower 4000 / Seeker
// 10000 / Knight 20000). The full ServUO system tracks per-virtue
// last-tick + decay; we ship the irreducible core: a `awardVirtue`
// helper that mutates `mob.virtues[key]`, capped at 20 000, and
// fires a small overhead system message at threshold crossings so
// the player gets feedback.
//
// Hooks (called from elsewhere):
//   corpse.killMobile  → Valor (per-monster body)
//   shrines.resurrect  → Compassion (the resurrector if not self)
//   corpse.resurrectMobile → Compassion
//
// Persistence: `mob.virtues` is in MOBILE_EXT_KEYS so the field round-
// trips through the JSON snapshot.

import { extVirtueState } from '@uo/protocol';

export const VIRTUES = Object.freeze([
  'humility', 'sacrifice', 'compassion', 'spirituality',
  'valor', 'honor', 'justice', 'honesty',
]);

const RANK_THRESHOLDS = [
  { name: 'Follower', value: 4000  },
  { name: 'Seeker',   value: 10000 },
  { name: 'Knight',   value: 20000 },
];

/**
 * Add `amount` to `mob.virtues[key]`. Caps at 20 000. Returns the new
 * value. Fires a system message when crossing into a higher rank.
 *
 * @param {*} mob
 * @param {string} key
 * @param {number} amount
 */
export function awardVirtue(mob, key, amount) {
  if (!mob || amount <= 0) return 0;
  if (!VIRTUES.includes(key)) return 0;          // unknown key — no state change
  if (!mob.virtues) mob.virtues = {};
  const before = mob.virtues[key] | 0;
  const after = Math.min(20000, before + (amount | 0));
  mob.virtues[key] = after;
  if (after === before) return after;
  // Rank crossing announcement.
  const beforeRank = rankAt(before);
  const afterRank  = rankAt(after);
  if (afterRank && afterRank.name !== beforeRank?.name && mob.client?.sendSystemMessage) {
    const niceKey = key.charAt(0).toUpperCase() + key.slice(1);
    mob.client.sendSystemMessage(
      `You have gained the rank of ${afterRank.name} in ${niceKey}.`,
    );
  }
  // Push live update to the gump.
  pushVirtues(mob);
  return after;
}

/**
 * Push a 0xBF 0xCD VirtueState packet to `mob.client` so the browser
 * gump can render up-to-date numbers. No-op for NPCs (no client) or
 * when the wire builder/protocol is missing in tests.
 */
export function pushVirtues(mob) {
  if (!mob?.client?.send) return;
  if (typeof extVirtueState !== 'function') return;
  const v = mob.virtues ?? {};
  mob.client.send(extVirtueState({
    humility:     v.humility     | 0,
    sacrifice:    v.sacrifice    | 0,
    compassion:   v.compassion   | 0,
    spirituality: v.spirituality | 0,
    valor:        v.valor        | 0,
    honor:        v.honor        | 0,
    justice:      v.justice      | 0,
    honesty:      v.honesty      | 0,
  }));
}

/**
 * Subtract `amount` from `mob.virtues[key]`. Floors at 0. Used for
 * decay or virtue-burning rituals.
 *
 * BUGFIX #76 (FAZA DH): the awardVirtue path auto-pushed the new
 * VirtueState packet to the client, but spendVirtue silently mutated
 * mob.virtues without notifying — players invoking [honor saw the
 * Ctrl+V gump still showing the pre-spend honor value until the next
 * awardVirtue call. Symmetry restored.
 */
export function spendVirtue(mob, key, amount) {
  if (!mob || amount <= 0) return 0;
  if (!mob.virtues) mob.virtues = {};
  const before = mob.virtues[key] | 0;
  const after = Math.max(0, before - (amount | 0));
  mob.virtues[key] = after;
  pushVirtues(mob);
  return after;
}

/**
 * Map a numeric virtue value to its current rank (or null below
 * Follower threshold).
 */
export function rankAt(value) {
  let best = null;
  for (const r of RANK_THRESHOLDS) {
    if ((value | 0) >= r.value) best = r;
  }
  return best;
}

/**
 * Convenience: virtue value awarded for killing a creature based on
 * its templated body. Mirrors ServUO's "monster fame" → Valor table:
 * tier-1 trash mobs (rats, fish) award nothing; tier-3 mobs award
 * 50; champion bosses award 1500. Keep simple constants here; tune
 * per-monster via monsters.json `valor` override later.
 */
export function valorForKill(monsterCfg) {
  if (!monsterCfg) return 0;
  if (typeof monsterCfg.valor === 'number') return monsterCfg.valor;
  // Default heuristic: scale from the creature's HP.
  const hp = monsterCfg.hp | 0;
  if (hp >= 1500) return 1500;     // dragon / lord boss
  if (hp >= 500)  return 200;
  if (hp >= 200)  return 50;
  if (hp >= 50)   return 10;
  return 0;
}

export const _RANK_THRESHOLDS_FOR_TEST = RANK_THRESHOLDS;

// =====================================================================
//  Virtue invocations — server parity #10. The 8 active virtue powers
//  cost a portion of the player's virtue value + share a per-virtue
//  cooldown. ServUO `Engines/MyRunUO/Virtues/*Virtue.cs` documents the
//  costs / cooldowns / effects. We implement the player-facing core
//  ones; deferred: Honor's "embrace-honor combat marker" full duel ruleset.
// =====================================================================

const INVOCATION_COSTS = {
  Compassion:   { cost: 100, cooldownMs: 60 * 60_000, rank: 'Seeker' },
  Honor:        { cost: 100, cooldownMs: 5  * 60_000, rank: 'Seeker' },
  Justice:      { cost: 100, cooldownMs: 60 * 60_000, rank: 'Seeker' },
  Sacrifice:    { cost: 100, cooldownMs: 5  * 60_000, rank: 'Seeker' },
  Valor:        { cost: 100, cooldownMs: 60 * 60_000, rank: 'Seeker' },
  Spirituality: { cost: 100, cooldownMs: 10 * 60_000, rank: 'Seeker' },
  Humility:     { cost: 100, cooldownMs: 60 * 60_000, rank: 'Seeker' },
  // Honesty was duplicated as "Justice2" — corrected. ServUO
  // `HonestyVirtue.cs` flags a lost item on use; returning it to the
  // owner awards Honesty value back. Activating costs 100 to flag a
  // dropped item as honest-loot (sets `_honestyOwner` so any other
  // player picking it up sees a system reminder and gets Honesty
  // points for returning).
  Honesty:      { cost: 100, cooldownMs: 60 * 60_000, rank: 'Seeker' },
};

/**
 * Invoke `key` virtue power on `mob` with optional `target`. Returns
 * `{ ok, reason, effect }`. Caller (a virtue cmd / context-menu)
 * applies the actual world effect from `effect` (a tag).
 *
 * Pattern: timer stamp `mob._virtueCooldown[key]` + virtue-value debit.
 * Effect tags map to: 'res' (Compassion / Sacrifice — target res),
 * 'protect' (Justice — share dmg with protégé for 10 min),
 * 'embrace' (Honor — next swing crits + reveal),
 * 'valor-altar' (Valor — spawn champ altar nearby — out-of-scope here).
 */
export function invokeVirtue(mob, key, target = null, now = Date.now()) {
  const cfg = INVOCATION_COSTS[key];
  if (!cfg) return { ok: false, reason: 'unknown-virtue' };
  const v = mob.virtues?.[key] | 0;
  if (v < cfg.cost) return { ok: false, reason: 'low-virtue', need: cfg.cost };
  if (!mob._virtueCooldown) mob._virtueCooldown = {};
  const until = mob._virtueCooldown[key] | 0;
  if (now < until) return { ok: false, reason: 'cooldown', untilMs: until };

  let effect = null;
  switch (key) {
    case 'Compassion':
      if (!target || !target.ghost) return { ok: false, reason: 'need-ghost-target' };
      effect = 'res';
      break;
    case 'Honor':
      mob._honorEmbraceUntil = now + 30_000;     // 30 s window for next swing
      effect = 'embrace';
      break;
    case 'Justice':
      if (!target || target === mob) return { ok: false, reason: 'need-protege' };
      mob._protegeOf = target.serial >>> 0;
      target._protegeOwner = mob.serial >>> 0;
      mob._protegeUntil = now + 10 * 60_000;
      target._protegeUntil = mob._protegeUntil;
      effect = 'protect';
      break;
    case 'Sacrifice':
      if (!target || !target.ghost) return { ok: false, reason: 'need-ghost-target' };
      // Cost: caller's hp goes to 1; target res with full hp.
      mob.hp = 1;
      effect = 'res';
      break;
    case 'Valor':
      effect = 'valor-altar';            // caller spawns champ altar
      break;
    case 'Spirituality':
      mob._spiritualityUntil = now + 60_000;
      effect = 'mana-regen';
      break;
    case 'Humility':
      mob._humilityUntil = now + 60_000;
      effect = 'gargoyle-form';
      break;
    case 'Honesty':
      // Flag a dropped item as "honest" — the next finder gets a
      // system message and earns Honesty back on return. We expect
      // the caller to pass `target` as the item being marked.
      if (!target) return { ok: false, reason: 'need-item-target' };
      target._honestyOwner = mob.serial >>> 0;
      target._honestyUntil = now + 24 * 60 * 60_000;        // 24h window
      effect = 'honesty-mark';
      break;
    default:
      return { ok: false, reason: 'unimplemented' };
  }

  spendVirtue(mob, key, cfg.cost);
  mob._virtueCooldown[key] = now + cfg.cooldownMs;
  return { ok: true, effect, target };
}

export const VIRTUE_INVOCATION_TABLE = Object.freeze(INVOCATION_COSTS);
