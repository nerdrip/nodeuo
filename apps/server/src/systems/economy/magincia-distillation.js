// New Magincia Distillation + Voting — ENGINE ONLY.
//
// Distillation recipes live in apps/scripts/src/data/config/magincia-recipes.json
// and are loaded at startup by apps/scripts/src/systems/economy/magincia-distillation.js.
//
// Engine responsibilities:
//   - hold the recipe table (set by script via setRecipes)
//   - distill 3-input → 1-output via pack scan
//   - apply 10-min stat buffs, sweep expired buffs on tick
//   - run 7-day voting cycles for bazaar stalls

/** @type {Record<number, {input:string,output:number,name:string,buffStat:string,buffAmount:number}>} */
let _recipes = {};

export function setRecipes(table) {
  _recipes = { ...(table || {}) };
}
export function recipes() { return Object.values(_recipes); }

/** Attempt to distill 3 of `inputItemId` from `mob`'s pack into 1 output. */
export function distill(world, mob, inputItemId) {
  const recipe = _recipes[inputItemId];
  if (!recipe) return { ok: false, reason: 'unknown-recipe' };
  const candidates = [];
  for (const it of world.items.values()) {
    if (it.parent !== mob.serial) continue;
    if (it.itemId !== inputItemId) continue;
    candidates.push(it);
    if (candidates.length >= 3) break;
  }
  if (candidates.length < 3) return { ok: false, reason: 'need-3' };
  for (const it of candidates) {
    try { world.destroyItem?.(it.serial); }
    catch { /* defensive */ }
  }
  const out = world.createItem?.({
    itemId: recipe.output,
    name: recipe.name,
    parent: mob.serial,
    _distillation: { stat: recipe.buffStat, amount: recipe.buffAmount },
  });
  return { ok: true, item: out, recipe };
}

export function drinkDistilled(mob, item, durationMs = 10 * 60 * 1000) {
  if (!mob || !item?._distillation) return false;
  const { stat, amount } = item._distillation;
  mob._distilledBuff ??= {};
  if (mob._distilledBuff[stat]) {
    const prev = mob._distilledBuff[stat];
    if (stat === 'str') mob.str = Math.max(0, (mob.str ?? 100) - prev.amount);
    if (stat === 'dex') mob.dex = Math.max(0, (mob.dex ?? 100) - prev.amount);
    if (stat === 'int') mob.int = Math.max(0, (mob.int ?? 100) - prev.amount);
  }
  mob._distilledBuff[stat] = { amount, until: Date.now() + durationMs };
  if (stat === 'str') mob.str = (mob.str ?? 100) + amount;
  if (stat === 'dex') mob.dex = (mob.dex ?? 100) + amount;
  if (stat === 'int') mob.int = (mob.int ?? 100) + amount;
  return true;
}

export function tickDistilledBuffs(world, now = Date.now()) {
  for (const m of world?.mobiles?.values?.() ?? []) {
    if (!m._distilledBuff) continue;
    for (const [stat, b] of Object.entries(m._distilledBuff)) {
      if (now > b.until) {
        if (stat === 'str') m.str = Math.max(0, (m.str ?? 100) - b.amount);
        if (stat === 'dex') m.dex = Math.max(0, (m.dex ?? 100) - b.amount);
        if (stat === 'int') m.int = Math.max(0, (m.int ?? 100) - b.amount);
        delete m._distilledBuff[stat];
      }
    }
  }
}

// ---- Voting --------------------------------------------------------------
const VOTING_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
let _currentCycleStartedAt = Date.now();
let _votes = { cycleId: 0, ballots: {} };

export function currentCycle(now = Date.now()) {
  if (now - _currentCycleStartedAt >= VOTING_CYCLE_MS) {
    _currentCycleStartedAt = now;
    _votes = { cycleId: _votes.cycleId + 1, ballots: {} };
  }
  return _votes.cycleId;
}

export function castVote(account, stallId, vendorSerial) {
  if (!account?.id || !stallId) return false;
  currentCycle();
  _votes.ballots[stallId] ??= { byAccount: {}, tally: {} };
  if (_votes.ballots[stallId].byAccount[account.id]) return false;
  _votes.ballots[stallId].byAccount[account.id] = vendorSerial;
  _votes.ballots[stallId].tally[vendorSerial] =
    (_votes.ballots[stallId].tally[vendorSerial] ?? 0) + 1;
  return true;
}

export function winner(stallId) {
  const b = _votes.ballots?.[stallId];
  if (!b) return null;
  let bestSerial = null; let bestCount = 0;
  for (const [serial, count] of Object.entries(b.tally)) {
    if (count > bestCount) { bestSerial = +serial; bestCount = count; }
  }
  return bestSerial ? { serial: bestSerial, votes: bestCount } : null;
}

export function snapshot() {
  return { cycleStartedAt: _currentCycleStartedAt, ..._votes };
}

export function restore(snap) {
  if (!snap || typeof snap !== 'object') return;
  _currentCycleStartedAt = snap.cycleStartedAt ?? Date.now();
  _votes = { cycleId: snap.cycleId ?? 0, ballots: snap.ballots ?? {} };
}
