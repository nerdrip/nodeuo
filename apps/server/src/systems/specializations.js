import {
  extNodeUOSpecialization,
  NodeUOCapability,
  NodeUOSpecializationMessage,
} from '@uo/protocol';
import { normalizeSkillValue } from '../combat-formulas.js';

const node = (id, tree, label, description, effects, requires = []) => Object.freeze({
  id, tree, label, description, cost: 1, maxRank: 1, requires, effects,
});

export const SPECIALIZATION_TREES = Object.freeze([
  Object.freeze({ id: 'vanguard', label: 'Vanguard', color: 0xd45f4c, nodes: Object.freeze([
    node('iron-constitution', 'vanguard', 'Iron Constitution', 'Reduces incoming damage by 4%.', { incomingDamage: -0.04 }),
    node('battle-precision', 'vanguard', 'Battle Precision', 'Increases outgoing weapon damage by 3%.', { weaponDamage: 0.03 }, ['iron-constitution']),
    node('executioner', 'vanguard', 'Executioner', 'Deals 8% more damage to targets below 30% life.', { executeDamage: 0.08 }, ['battle-precision']),
  ]) }),
  Object.freeze({ id: 'arcanist', label: 'Arcanist', color: 0x6d78d8, nodes: Object.freeze([
    node('mana-flow', 'arcanist', 'Mana Flow', 'Reduces spell mana cost by 5%.', { manaCost: -0.05 }),
    node('focused-casting', 'arcanist', 'Focused Casting', 'Reduces cast time by 8%.', { castTime: -0.08 }, ['mana-flow']),
    node('arcane-surge', 'arcanist', 'Arcane Surge', 'Increases non-physical damage by 6%.', { spellDamage: 0.06 }, ['focused-casting']),
  ]) }),
  Object.freeze({ id: 'ranger', label: 'Ranger', color: 0x4eaa72, nodes: Object.freeze([
    node('pathfinder', 'ranger', 'Pathfinder', 'Reduces running stamina cost by 20%.', { staminaCost: -0.20 }),
    node('eagle-eye', 'ranger', 'Eagle Eye', 'Increases ranged weapon damage by 5%.', { rangedDamage: 0.05 }, ['pathfinder']),
    node('rapid-volley', 'ranger', 'Rapid Volley', 'Reduces ranged recovery by 8%.', { rangedRecovery: -0.08 }, ['eagle-eye']),
  ]) }),
  Object.freeze({ id: 'artisan', label: 'Artisan', color: 0xc28b42, nodes: Object.freeze([
    node('efficient-hands', 'artisan', 'Efficient Hands', 'Reduces crafting resource use by 5%.', { resourceUse: -0.05 }),
    node('quality-focus', 'artisan', 'Quality Focus', 'Adds 4% exceptional-item chance.', { exceptionalChance: 0.04 }, ['efficient-hands']),
    node('resourceful', 'artisan', 'Resourceful', 'Adds 5% crafting success chance.', { craftSuccess: 0.05 }, ['quality-focus']),
  ]) }),
]);

const NODE_BY_ID = new Map(SPECIALIZATION_TREES.flatMap((tree) => tree.nodes.map((entry) => [entry.id, entry])));

function ensureState(mob) {
  const raw = mob?.specializations;
  const allocations = raw?.allocations && typeof raw.allocations === 'object' && !Array.isArray(raw.allocations)
    ? raw.allocations : {};
  const clean = {};
  for (const [id, rank] of Object.entries(allocations)) {
    if (NODE_BY_ID.has(id) && Number.isFinite(Number(rank)) && Number(rank) > 0) clean[id] = 1;
  }
  // Preserve object identity: reset()/allocate() may retain this reference
  // while another helper computes spent points. Replacing it on every read
  // made a reset mutate an orphan object and left the mobile unchanged.
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  state.earned = Math.max(0, Math.min(12, raw?.earned | 0));
  state.allocations = clean;
  if (mob) mob.specializations = state;
  return state;
}

/** Points are unlocked by durable skill milestones and never revoked. */
export function milestonePoints(mob) {
  const values = Object.values(mob?.skills ?? {}).map(normalizeSkillValue);
  let result = 0;
  for (const value of values) {
    if (value >= 70) result += 1;
    if (value >= 90) result += 1;
    if (value >= 110) result += 1;
  }
  return Math.min(12, result);
}

export function refreshEarnedPoints(mob) {
  const state = ensureState(mob);
  state.earned = Math.max(state.earned, milestonePoints(mob));
  return state.earned;
}

export function spentPoints(mob) {
  return Object.values(ensureState(mob).allocations).reduce((sum, rank) => sum + (rank | 0), 0);
}

export function availablePoints(mob) {
  return Math.max(0, refreshEarnedPoints(mob) - spentPoints(mob));
}

export function hasNode(mob, id) {
  return (ensureState(mob).allocations[id] | 0) > 0;
}

export function allocate(mob, id) {
  const entry = NODE_BY_ID.get(String(id ?? '').toLowerCase());
  if (!entry) return { ok: false, error: 'Unknown specialization node.' };
  if (hasNode(mob, entry.id)) return { ok: false, error: 'That specialization is already learned.' };
  if (entry.requires.some((required) => !hasNode(mob, required))) {
    return { ok: false, error: `Requires: ${entry.requires.join(', ')}.` };
  }
  if (availablePoints(mob) < entry.cost) return { ok: false, error: 'No specialization points available.' };
  ensureState(mob).allocations[entry.id] = 1;
  return { ok: true, node: entry };
}

export function reset(mob) {
  const state = ensureState(mob);
  const refunded = spentPoints(mob);
  state.allocations = {};
  return refunded;
}

export function modifiersFor(mob) {
  const result = {};
  const allocations = ensureState(mob).allocations;
  for (const [id, rank] of Object.entries(allocations)) {
    const entry = NODE_BY_ID.get(id);
    if (!entry) continue;
    for (const [effect, amount] of Object.entries(entry.effects)) {
      result[effect] = (result[effect] ?? 0) + amount * (rank | 0);
    }
  }
  return result;
}

export function modifyDamage(amount, attacker, defender, { damageType = 'physical', ranged = false } = {}) {
  let multiplier = 1;
  const outgoing = modifiersFor(attacker);
  const incoming = modifiersFor(defender);
  multiplier += incoming.incomingDamage ?? 0;
  multiplier += damageType === 'physical' ? (outgoing.weaponDamage ?? 0) : (outgoing.spellDamage ?? 0);
  if (ranged) multiplier += outgoing.rangedDamage ?? 0;
  if (defender && (defender.hp | 0) > 0 && (defender.hpMax | 0) > 0
    && (defender.hp | 0) / (defender.hpMax | 0) <= 0.30) multiplier += outgoing.executeDamage ?? 0;
  return Math.max(0, Math.round(Math.max(0, Number(amount) || 0) * multiplier));
}

export function manaCost(mob, base) {
  return Math.max(0, Math.ceil((Number(base) || 0) * (1 + (modifiersFor(mob).manaCost ?? 0))));
}

export function castTimeMs(mob, base) {
  return Math.max(0, Math.round((Number(base) || 0) * (1 + (modifiersFor(mob).castTime ?? 0))));
}

export function staminaCost(mob, base) {
  return Math.max(0, Math.round((Number(base) || 0) * (1 + (modifiersFor(mob).staminaCost ?? 0))));
}

export function snapshot(mob) {
  const state = ensureState(mob);
  refreshEarnedPoints(mob);
  return {
    version: 1,
    trees: SPECIALIZATION_TREES,
    state: { earned: state.earned, spent: spentPoints(mob), available: availablePoints(mob), allocations: { ...state.allocations } },
  };
}

export function open(state, requestId = 0) {
  if (!state?.mobile || !state.supportsNodeUO?.(NodeUOCapability.Specializations)) return false;
  state.send(extNodeUOSpecialization({
    kind: NodeUOSpecializationMessage.Open,
    requestId,
    payload: snapshot(state.mobile),
  }));
  return true;
}

export function sendResult(state, requestId, result) {
  if (!state?.mobile || !state.supportsNodeUO?.(NodeUOCapability.Specializations)) return false;
  state.send(extNodeUOSpecialization({
    kind: NodeUOSpecializationMessage.Result,
    requestId,
    payload: { ...result, ...snapshot(state.mobile) },
  }));
  return true;
}
