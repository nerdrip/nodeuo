// Quest chain loader — reads scripts/data/world/quest-chains.json (major
// multi-stage quest chains) and exposes them via `api.systems.mlQuests`
// or `api.questChains` for player commands.
//
// Each chain is a multi-stage definition with an intro line, ordered
// stages (each with kill/collect/visit/talk/use/craft/special objectives),
// and a reward block (gold, fame, skill, items, mastery, virtue).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/quest-chains.json');

const _state = new Map();   // chainId → loaded chain definition

export function loadChains() {
  try {
    const json = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    for (const [id, def] of Object.entries(json)) {
      _state.set(id, { id, ...def });
    }
  } catch (e) {
    console.warn('quest-chains: load failed', e.message);
  }
  return _state.size;
}

export function listChains() { return [..._state.values()]; }
export function getChain(id) { return _state.get(id) ?? null; }

/** Initialize per-player chain progress. */
function _progressFor(mob, chainId) {
  if (!mob._chainQuests) mob._chainQuests = {};
  return mob._chainQuests[chainId];
}

export function startChain(mob, chainId) {
  const def = _state.get(chainId);
  if (!def) return { ok: false, reason: 'no-such-chain' };
  mob._chainQuests ??= {};
  if (mob._chainQuests[chainId]) return { ok: false, reason: 'already-active' };
  mob._chainQuests[chainId] = {
    stage: 0, objIdx: 0,
    counters: {},
    startedAt: Date.now(),
    completed: false,
  };
  return { ok: true, def };
}

export function statusOf(mob, chainId) {
  return _progressFor(mob, chainId) ?? null;
}

/** Advance a kill-objective; returns whether the current stage completed. */
export function recordKill(mob, kind) {
  if (!mob?._chainQuests) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._chainQuests)) {
    if (prog.completed) continue;
    const def = _state.get(id);
    const stage = def?.stages?.[prog.stage];
    if (!stage) continue;
    for (const obj of stage.objectives ?? []) {
      if (obj.kind !== 'slay' || obj.target !== kind) continue;
      const key = `slay:${obj.target}`;
      prog.counters[key] = (prog.counters[key] ?? 0) + 1;
      if (prog.counters[key] >= (obj.count ?? 1)) {
        advanced.push({ chainId: id, stage: prog.stage });
      }
    }
  }
  return advanced;
}

export function recordCollect(mob, resource, amount = 1) {
  if (!mob?._chainQuests) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._chainQuests)) {
    if (prog.completed) continue;
    const def = _state.get(id);
    const stage = def?.stages?.[prog.stage];
    if (!stage) continue;
    for (const obj of stage.objectives ?? []) {
      if (obj.kind !== 'collect' || obj.resource !== resource) continue;
      const key = `collect:${obj.resource}`;
      prog.counters[key] = (prog.counters[key] ?? 0) + amount;
      if (prog.counters[key] >= (obj.count ?? 1)) {
        advanced.push({ chainId: id, stage: prog.stage });
      }
    }
  }
  return advanced;
}

export function recordTalk(mob, npcName) {
  if (!mob?._chainQuests) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._chainQuests)) {
    if (prog.completed) continue;
    const def = _state.get(id);
    const stage = def?.stages?.[prog.stage];
    if (!stage) continue;
    for (const obj of stage.objectives ?? []) {
      if (obj.kind !== 'talk' || obj.npc !== npcName) continue;
      prog.counters[`talk:${obj.npc}`] = 1;
      advanced.push({ chainId: id, stage: prog.stage });
    }
  }
  return advanced;
}

export function recordVisit(mob, region) {
  if (!mob?._chainQuests) return [];
  const advanced = [];
  for (const [id, prog] of Object.entries(mob._chainQuests)) {
    if (prog.completed) continue;
    const def = _state.get(id);
    const stage = def?.stages?.[prog.stage];
    if (!stage) continue;
    for (const obj of stage.objectives ?? []) {
      if (obj.kind !== 'visit' || obj.region !== region) continue;
      prog.counters[`visit:${obj.region}`] = 1;
      advanced.push({ chainId: id, stage: prog.stage });
    }
  }
  return advanced;
}

/** Check if all objectives of current stage are done. */
function _isStageComplete(prog, stage) {
  for (const obj of stage.objectives ?? []) {
    if (obj.kind === 'slay') {
      const c = prog.counters[`slay:${obj.target}`] ?? 0;
      if (c < (obj.count ?? 1)) return false;
    } else if (obj.kind === 'collect') {
      const c = prog.counters[`collect:${obj.resource}`] ?? 0;
      if (c < (obj.count ?? 1)) return false;
    } else if (obj.kind === 'talk') {
      if (!prog.counters[`talk:${obj.npc}`]) return false;
    } else if (obj.kind === 'visit') {
      if (!prog.counters[`visit:${obj.region}`]) return false;
    } else if (obj.kind === 'special') {
      const c = prog.counters[`special:${obj.target}`] ?? 0;
      if (c < (obj.count ?? 1)) return false;
    } else if (obj.kind === 'use') {
      const c = prog.counters[`use:${obj.target}`] ?? 0;
      if (c < (obj.count ?? 1)) return false;
    } else if (obj.kind === 'craft') {
      const c = prog.counters[`craft:${obj.target}`] ?? 0;
      if (c < (obj.count ?? 1)) return false;
    }
  }
  return true;
}

/** Try to advance — returns `{ ok, stage, reward, completedChain }`. */
export function advanceStage(mob, chainId) {
  const prog = _progressFor(mob, chainId);
  if (!prog) return { ok: false, reason: 'not-active' };
  if (prog.completed) return { ok: false, reason: 'completed' };
  const def = _state.get(chainId);
  const stage = def?.stages?.[prog.stage];
  if (!stage) return { ok: false, reason: 'no-stage' };
  if (!_isStageComplete(prog, stage)) return { ok: false, reason: 'objectives' };
  // Award stage reward.
  const reward = stage.reward ?? {};
  prog.stage++;
  // Reset counters for new stage.
  prog.counters = {};
  const completedChain = prog.stage >= def.stages.length;
  if (completedChain) {
    prog.completed = true;
    prog.completedAt = Date.now();
  }
  return { ok: true, stage: stage.id, reward, completedChain };
}

/** Default register — wires loader to `api.systems.questChains`. */
export default function register(api) {
  const count = loadChains();
  if (api.systems) {
    api.systems.questChains = {
      list: listChains, get: getChain,
      start: startChain, status: statusOf,
      recordKill, recordCollect, recordTalk, recordVisit,
      advance: advanceStage,
    };
  }
  api.log?.(`quest-chains: loaded ${count} chains`);
  return () => {
    if (api.systems?.questChains) delete api.systems.questChains;
  };
}
