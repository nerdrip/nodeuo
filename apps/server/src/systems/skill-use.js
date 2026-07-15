// Central lifecycle for player-triggered skills. Individual script commands
// remain authoritative for their game rules; this layer supplies consistent
// availability, anti-spam, target ownership, interruption and telemetry.

export const SKILL_USE_COOLDOWN_MS = 500;
export const SKILL_TARGET_TIMEOUT_MS = 30_000;

const stats = new Map();
let nextUseId = 0;
const MOVE_INTERRUPTED = new Set([11, 22, 36, 48]);
const DAMAGE_INTERRUPTED = new Set([11, 18, 22, 36, 40, 48]);

function row(skillId) {
  const id = skillId | 0;
  const current = stats.get(id) ?? {
    skillId: id, attempts: 0, dispatched: 0, completed: 0,
    cancelled: 0, interrupted: 0, rejected: 0, lastUsedAt: 0,
    reasons: {},
  };
  stats.set(id, current);
  return current;
}

function reject(skillId, reason) {
  const metric = row(skillId);
  metric.rejected++;
  metric.reasons[reason] = (metric.reasons[reason] ?? 0) + 1;
  return { ok: false, reason };
}

export function beginSkillUse(state, skillId, command, now = Date.now()) {
  const mob = state?.mobile;
  const id = skillId | 0;
  const metric = row(id);
  metric.attempts++;
  metric.lastUsedAt = now;
  if (!mob || id < 1 || id > 58 || !command) return reject(id, 'invalid');
  if (mob.dead || (mob.hp ?? 1) <= 0) return reject(id, 'dead');
  if (mob.frozen || mob.paralyzed) return reject(id, 'immobilized');
  if (now < (state._nextSkillUseAt ?? 0)) return reject(id, 'cooldown');

  interruptSkillUse(state, 'superseded', false);
  state._nextSkillUseAt = now + SKILL_USE_COOLDOWN_MS;
  const use = {
    id: (++nextUseId) >>> 0,
    skillId: id,
    command,
    startedAt: now,
    targetId: null,
    status: 'dispatching',
    interruptOnMove: MOVE_INTERRUPTED.has(id),
    interruptOnDamage: DAMAGE_INTERRUPTED.has(id),
  };
  state._activeSkillUse = use;
  metric.dispatched++;
  return { ok: true, use };
}

export function attachSkillTarget(state, targetId) {
  const use = state?._activeSkillUse;
  if (!use) return null;
  use.targetId = targetId >>> 0;
  use.status = 'targeting';
  return use.id;
}

export function completeSkillUse(state, outcome = 'completed') {
  const use = state?._activeSkillUse;
  if (!use) return false;
  const metric = row(use.skillId);
  if (outcome === 'cancelled') metric.cancelled++;
  else metric.completed++;
  use.status = outcome;
  use.finishedAt = Date.now();
  state._lastSkillUse = { ...use };
  state._activeSkillUse = null;
  return true;
}

export function interruptSkillUse(state, reason = 'interrupted', notify = true) {
  const use = state?._activeSkillUse;
  if (!use) return false;
  if (use.targetId != null) {
    const target = state.targetCallbacks?.get?.(use.targetId);
    if (target?.timer) clearTimeout(target.timer);
    state.targetCallbacks?.delete?.(use.targetId);
  }
  const metric = row(use.skillId);
  metric.interrupted++;
  metric.reasons[reason] = (metric.reasons[reason] ?? 0) + 1;
  use.status = 'interrupted';
  use.reason = reason;
  use.finishedAt = Date.now();
  state._lastSkillUse = { ...use };
  state._activeSkillUse = null;
  if (notify) state.sendSystemMessage?.(`Skill use interrupted (${reason}).`);
  return true;
}

export function skillUseSnapshot(skillId = null) {
  const rows = skillId == null
    ? [...stats.values()]
    : (stats.has(skillId | 0) ? [stats.get(skillId | 0)] : []);
  return rows.map((entry) => ({ ...entry, reasons: { ...entry.reasons } }));
}
