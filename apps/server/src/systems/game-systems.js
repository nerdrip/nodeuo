import fs from 'node:fs';
import { createGameSystemAdapterRegistry } from './game-system-adapters.js';
import {
  appendReplayEvent, createSpecializedState, publicSpecializedState,
  removeSpecializedParticipant, runSpecializedCommand, specializedCommands,
} from './game-system-specialized.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const CLIENT_MODES = new Set(['classic', 'hybrid', 'enhanced']);
const CATEGORIES = new Set(['world', 'pve', 'narrative', 'economy', 'pvp', 'culture', 'progression']);
const ARCHETYPES = new Set(['campaign', 'raid', 'hunt', 'defense', 'competition', 'pvp',
  'crafting', 'economy', 'trade', 'exploration', 'expedition', 'narrative', 'social',
  'puzzle', 'collection', 'simulation', 'creative']);
const MAX_INSTANCES = 256;
const MAX_PARTICIPANTS = 256;
const MAX_HISTORY = 256;
const MAX_PLAYER_COMPLETIONS = 256;
const MAX_TELEMETRY_SYSTEMS = 512;
const MAX_ACCOUNT_LIMITS = 100_000;
const MAX_PENDING_REWARDS = 32;
const DAY_MS = 86_400_000;

const EVENT_BY_ARCHETYPE = Object.freeze({
  campaign: 'mobile:killed', raid: 'mobile:killed', hunt: 'mobile:killed',
  defense: 'combat:damage', competition: 'activity:action', pvp: 'combat:damage',
  crafting: 'craft:completed', economy: 'bod:turnedIn', trade: 'bod:turnedIn',
  exploration: 'region:enter', expedition: 'region:enter',
  narrative: 'speech', social: 'speech', puzzle: 'activity:action',
  collection: 'activity:action', simulation: 'activity:action', creative: 'activity:action',
});

function boundedInt(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function validateBoundedInteger(errors, label, value, min, max) {
  if (value == null) return;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}.`);
  }
}

function validateIntegerArray(errors, label, value, min, max, maxEntries) {
  if (value == null) return;
  if (!Array.isArray(value)) { errors.push(`${label} must be an array.`); return; }
  if (value.length > maxEntries) errors.push(`${label} may contain at most ${maxEntries} entries.`);
  if (value.some((entry) => !Number.isInteger(Number(entry)) || Number(entry) < min || Number(entry) > max)) {
    errors.push(`${label} entries must be integers between ${min} and ${max}.`);
  }
}

function validateTextArray(errors, label, value, maxEntries) {
  if (value == null) return;
  if (!Array.isArray(value)) { errors.push(`${label} must be an array.`); return; }
  if (value.length > maxEntries) errors.push(`${label} may contain at most ${maxEntries} entries.`);
  if (value.some((entry) => typeof entry !== 'string' || !entry.trim())) errors.push(`${label} entries must be non-empty strings.`);
}

function cleanText(value, max = 512) {
  return String(value ?? '').trim().slice(0, max);
}

function publicStage(stage) {
  return {
    id: stage.id, name: stage.name, description: stage.description,
    goal: stage.goal, event: stage.event, skill: stage.skill,
    actions: stage.actions, targetKinds: stage.targetKinds,
    sourceKinds: stage.sourceKinds, regions: stage.regions, maps: stage.maps,
    uniqueTargets: stage.uniqueTargets, allowManual: stage.allowManual,
    contributionCap: stage.contributionCap, nextStageByAction: stage.nextStageByAction,
  };
}

function cleanList(value, maxEntries = 32, maxText = 64) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map((entry) => cleanText(entry, maxText).toLowerCase())
    .filter((entry, index, all) => entry && all.indexOf(entry) === index)
    .slice(0, maxEntries));
}

function cleanNumberList(value, min, max, maxEntries = 32) {
  return Object.freeze((Array.isArray(value) ? value : [])
    .map(Number).filter((entry, index, all) => Number.isInteger(entry) && entry >= min && entry <= max && all.indexOf(entry) === index)
    .slice(0, maxEntries));
}

function defaultActions(archetype) {
  if (['campaign', 'raid', 'hunt', 'defense'].includes(archetype)) return ['engage', 'support', 'scout'];
  if (['crafting', 'economy', 'trade'].includes(archetype)) return ['contribute', 'research', 'deliver'];
  if (['narrative', 'social'].includes(archetype)) return ['investigate', 'persuade', 'report'];
  if (['exploration', 'expedition'].includes(archetype)) return ['explore', 'survey', 'decode'];
  if (['competition', 'pvp'].includes(archetype)) return ['compete', 'defend', 'assist'];
  return ['attempt', 'assist', 'study'];
}

function normalizeStage(raw, index, definition) {
  const source = typeof raw === 'string' ? { name: raw } : raw ?? {};
  const name = cleanText(source.name || source.title || `Stage ${index + 1}`, 96);
  const goal = boundedInt(source.goal, 1, 1_000_000,
    Math.max(10, definition.difficulty * 10 + index * 5));
  const actions = (Array.isArray(source.actions) ? source.actions : defaultActions(definition.archetype))
    .map((entry) => cleanText(typeof entry === 'string' ? entry : entry?.id, 32).toLowerCase())
    .filter((entry, actionIndex, all) => ID_PATTERN.test(entry) && all.indexOf(entry) === actionIndex)
    .slice(0, 8);
  const event = cleanText(source.event || EVENT_BY_ARCHETYPE[definition.archetype] || 'activity:action', 64);
  return Object.freeze({
    id: cleanText(source.id || `stage-${index + 1}`, 64).toLowerCase(),
    name,
    description: cleanText(source.description || name),
    goal,
    event,
    skill: cleanText(source.skill || definition.skill || 'Tactics', 64),
    actions: Object.freeze(actions.length ? actions : ['attempt']),
    targetKinds: cleanList(source.targetKinds),
    sourceKinds: cleanList(source.sourceKinds),
    regions: cleanList(source.regions),
    maps: cleanNumberList(source.maps, 0, 255, 8),
    uniqueTargets: boundedInt(source.uniqueTargets, 0, 10_000, 0),
    allowManual: source.allowManual !== false,
    contributionCap: boundedInt(source.contributionCap, 1, 100_000, 1000),
    nextStageByAction: Object.freeze(Object.fromEntries(Object.entries(source.nextStageByAction ?? {})
      .map(([action, stageId]) => [cleanText(action, 32).toLowerCase(), cleanText(stageId, 64).toLowerCase()])
      .filter(([action, stageId]) => ID_PATTERN.test(action) && ID_PATTERN.test(stageId)))),
  });
}

function normalizeAvailability(raw = {}) {
  return Object.freeze({
    maps: cleanNumberList(raw.maps, 0, 255, 8),
    regions: cleanList(raw.regions, 32, 64),
    daysOfWeek: cleanNumberList(raw.daysOfWeek, 0, 6, 7),
    startHourUtc: boundedInt(raw.startHourUtc, 0, 23, 0),
    endHourUtc: boundedInt(raw.endHourUtc, 0, 24, 24),
    minAccountAgeDays: boundedInt(raw.minAccountAgeDays, 0, 3650, 0),
    requiredCompletions: Object.freeze(Object.fromEntries(Object.entries(raw.requiredCompletions ?? {})
      .map(([id, amount]) => [cleanText(id, 64).toLowerCase(), boundedInt(amount, 1, MAX_PLAYER_COMPLETIONS, 1)])
      .filter(([id]) => ID_PATTERN.test(id)))),
  });
}

function normalizeAntiExploit(raw = {}) {
  return Object.freeze({
    completionCooldownMinutes: boundedInt(raw.completionCooldownMinutes, 0, 30 * 24 * 60, 0),
    dailyCompletionLimit: boundedInt(raw.dailyCompletionLimit, 0, 100, 0),
    maxActionsPerMinute: boundedInt(raw.maxActionsPerMinute, 1, 600, 60),
    maxEventContribution: boundedInt(raw.maxEventContribution, 1, 100_000, 1000),
    minParticipationPercent: boundedInt(raw.minParticipationPercent, 0, 100, 10),
    requireUniqueEventTarget: raw.requireUniqueEventTarget === true,
    accountWide: raw.accountWide !== false,
  });
}

function normalizeEntry(raw = {}) {
  return Object.freeze({
    gold: boundedInt(raw.gold, 0, 1_000_000, 0),
    tokens: boundedInt(raw.tokens, 0, 100_000, 0),
  });
}

function normalizeReward(raw, difficulty, id) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 16).map((item, index) => Object.freeze({
    id: cleanText(item?.id || `${id}-reward-${index + 1}`, 64).toLowerCase(),
    name: cleanText(item?.name || `${id} reward`, 96),
    artId: boundedInt(item?.artId, 0, 0xffff, 0x14f0),
    hue: boundedInt(item?.hue, 0, 0xffff, 0),
    amount: boundedInt(item?.amount, 1, 60_000, 1),
    chancePermille: boundedInt(item?.chancePermille, 1, 1000, 1000),
    accountBound: item?.accountBound !== false,
  }));
  return Object.freeze({
    gold: boundedInt(raw?.gold, 0, 1_000_000, difficulty * 100),
    tokens: boundedInt(raw?.tokens, 0, 100_000, difficulty * 5),
    title: cleanText(raw?.title, 96),
    reputation: boundedInt(raw?.reputation, 0, 100_000, difficulty * 2),
    unlocks: cleanList(raw?.unlocks, 16, 64),
    items: Object.freeze(items),
  });
}

export function validateGameSystemCatalog(rawCatalog, { expectedCount = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(rawCatalog)) return { ok: false, errors: ['Catalog root must be a JSON array.'], warnings, definitions: [] };
  if (expectedCount != null && rawCatalog.length !== expectedCount) {
    errors.push(`Catalog must contain exactly ${expectedCount} systems; found ${rawCatalog.length}.`);
  }
  const seen = new Set();
  const definitions = [];
  rawCatalog.forEach((raw, index) => {
    const id = cleanText(raw?.id, 64).toLowerCase();
    if (!ID_PATTERN.test(id)) errors.push(`Record ${index + 1}: invalid id "${id}".`);
    if (seen.has(id)) errors.push(`Record ${index + 1}: duplicate id "${id}".`);
    seen.add(id);
    const name = cleanText(raw?.name, 96);
    const summary = cleanText(raw?.summary, 512);
    if (!name) errors.push(`${id || `Record ${index + 1}`}: name is required.`);
    if (!summary) errors.push(`${id || `Record ${index + 1}`}: summary is required.`);
    const category = cleanText(raw?.category, 32).toLowerCase();
    const archetype = cleanText(raw?.archetype || 'campaign', 32).toLowerCase();
    const clientMode = cleanText(raw?.clientMode || 'hybrid', 16).toLowerCase();
    if (!CLIENT_MODES.has(clientMode)) errors.push(`${id}: clientMode must be classic, hybrid, or enhanced.`);
    if (!CATEGORIES.has(category)) errors.push(`${id}: category is not recognized.`);
    if (!ARCHETYPES.has(archetype)) errors.push(`${id}: archetype is not recognized.`);
    validateBoundedInteger(errors, `${id}: difficulty`, raw?.difficulty, 1, 10);
    validateBoundedInteger(errors, `${id}: durationMinutes`, raw?.durationMinutes, 1, 30 * 24 * 60);
    validateBoundedInteger(errors, `${id}: cooldownSeconds`, raw?.cooldownSeconds, 0, 86_400);
    validateBoundedInteger(errors, `${id}: staminaCost`, raw?.staminaCost, 0, 100);
    validateBoundedInteger(errors, `${id}: party.min`, raw?.party?.min, 1, MAX_PARTICIPANTS);
    validateBoundedInteger(errors, `${id}: party.max`, raw?.party?.max, 1, MAX_PARTICIPANTS);
    validateBoundedInteger(errors, `${id}: party.teams`, raw?.party?.teams, 1, 8);
    validateBoundedInteger(errors, `${id}: reward.gold`, raw?.reward?.gold, 0, 1_000_000);
    validateBoundedInteger(errors, `${id}: reward.tokens`, raw?.reward?.tokens, 0, 100_000);
    validateBoundedInteger(errors, `${id}: version`, raw?.version, 1, 1_000_000);
    validateBoundedInteger(errors, `${id}: entry.gold`, raw?.entry?.gold, 0, 1_000_000);
    validateBoundedInteger(errors, `${id}: entry.tokens`, raw?.entry?.tokens, 0, 100_000);
    validateBoundedInteger(errors, `${id}: antiExploit.dailyCompletionLimit`, raw?.antiExploit?.dailyCompletionLimit, 0, 100);
    validateBoundedInteger(errors, `${id}: antiExploit.maxActionsPerMinute`, raw?.antiExploit?.maxActionsPerMinute, 1, 600);
    validateBoundedInteger(errors, `${id}: antiExploit.completionCooldownMinutes`, raw?.antiExploit?.completionCooldownMinutes, 0, 30 * 24 * 60);
    validateBoundedInteger(errors, `${id}: antiExploit.maxEventContribution`, raw?.antiExploit?.maxEventContribution, 1, 100_000);
    validateBoundedInteger(errors, `${id}: antiExploit.minParticipationPercent`, raw?.antiExploit?.minParticipationPercent, 0, 100);
    validateBoundedInteger(errors, `${id}: availability.startHourUtc`, raw?.availability?.startHourUtc, 0, 23);
    validateBoundedInteger(errors, `${id}: availability.endHourUtc`, raw?.availability?.endHourUtc, 0, 24);
    validateBoundedInteger(errors, `${id}: availability.minAccountAgeDays`, raw?.availability?.minAccountAgeDays, 0, 3650);
    validateIntegerArray(errors, `${id}: availability.maps`, raw?.availability?.maps, 0, 255, 8);
    validateIntegerArray(errors, `${id}: availability.daysOfWeek`, raw?.availability?.daysOfWeek, 0, 6, 7);
    validateTextArray(errors, `${id}: availability.regions`, raw?.availability?.regions, 32);
    validateTextArray(errors, `${id}: reward.unlocks`, raw?.reward?.unlocks, 16);
    if (raw?.reward?.items != null && !Array.isArray(raw.reward.items)) errors.push(`${id}: reward.items must be an array.`);
    if ((raw?.reward?.items?.length ?? 0) > 16) errors.push(`${id}: reward.items may contain at most 16 entries.`);
    for (const [requiredId, amount] of Object.entries(raw?.availability?.requiredCompletions ?? {})) {
      if (!ID_PATTERN.test(requiredId)) errors.push(`${id}: invalid prerequisite system id "${requiredId}".`);
      validateBoundedInteger(errors, `${id}: prerequisite ${requiredId}`, amount, 1, MAX_PLAYER_COMPLETIONS);
    }
    const rewardIds = new Set();
    const rawRewardItems = Array.isArray(raw?.reward?.items) ? raw.reward.items : [];
    for (const [rewardIndex, item] of rawRewardItems.entries()) {
      const label = `${id} reward item ${rewardIndex + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${label} must be an object.`); continue; }
      const rewardId = cleanText(item.id || `${id}-reward-${rewardIndex + 1}`, 64).toLowerCase();
      if (!ID_PATTERN.test(rewardId)) errors.push(`${label}: invalid id "${rewardId}".`);
      if (rewardIds.has(rewardId)) errors.push(`${id}: duplicate reward item id "${rewardId}".`);
      rewardIds.add(rewardId);
      validateBoundedInteger(errors, `${label}: artId`, item.artId, 0, 0xffff);
      validateBoundedInteger(errors, `${label}: hue`, item.hue, 0, 0xffff);
      validateBoundedInteger(errors, `${label}: amount`, item.amount, 1, 60_000);
      validateBoundedInteger(errors, `${label}: chancePermille`, item.chancePermille, 1, 1000);
    }
    const difficulty = boundedInt(raw?.difficulty, 1, 10, 3);
    const party = Object.freeze({
      min: boundedInt(raw?.party?.min, 1, MAX_PARTICIPANTS, 1),
      max: boundedInt(raw?.party?.max, 1, MAX_PARTICIPANTS, 8),
      teams: boundedInt(raw?.party?.teams, 1, 8, ['competition', 'pvp'].includes(archetype) ? 2 : 1),
    });
    if (party.min > party.max) errors.push(`${id}: party.min cannot exceed party.max.`);
    if (party.teams > party.max) errors.push(`${id}: party.teams cannot exceed party.max.`);
    const shell = { id, difficulty, archetype, skill: cleanText(raw?.skill || 'Tactics', 64) };
    const stages = (Array.isArray(raw?.stages) ? raw.stages : []).map((stage, stageIndex) => normalizeStage(stage, stageIndex, shell));
    if (stages.length < 3) errors.push(`${id}: at least three playable stages are required.`);
    if (stages.length > 12) errors.push(`${id}: no more than twelve stages are allowed.`);
    const stageIds = new Set();
    for (const [stageIndex, stage] of stages.entries()) {
      const rawStage = raw.stages[stageIndex];
      if (rawStage && typeof rawStage === 'object') {
        validateBoundedInteger(errors, `${id} stage ${stageIndex + 1}: goal`, rawStage.goal, 1, 1_000_000);
        validateBoundedInteger(errors, `${id} stage ${stageIndex + 1}: uniqueTargets`, rawStage.uniqueTargets, 0, 10_000);
        validateBoundedInteger(errors, `${id} stage ${stageIndex + 1}: contributionCap`, rawStage.contributionCap, 1, 100_000);
        validateIntegerArray(errors, `${id} stage ${stageIndex + 1}: maps`, rawStage.maps, 0, 255, 8);
        validateTextArray(errors, `${id} stage ${stageIndex + 1}: regions`, rawStage.regions, 32);
        validateTextArray(errors, `${id} stage ${stageIndex + 1}: targetKinds`, rawStage.targetKinds, 32);
        validateTextArray(errors, `${id} stage ${stageIndex + 1}: sourceKinds`, rawStage.sourceKinds, 32);
        validateTextArray(errors, `${id} stage ${stageIndex + 1}: actions`, rawStage.actions, 8);
        if (rawStage.nextStageByAction != null
            && (!rawStage.nextStageByAction || typeof rawStage.nextStageByAction !== 'object' || Array.isArray(rawStage.nextStageByAction))) {
          errors.push(`${id} stage ${stageIndex + 1}: nextStageByAction must be an object.`);
        }
      }
      if (!ID_PATTERN.test(stage.id)) errors.push(`${id} stage ${stageIndex + 1}: invalid id "${stage.id}".`);
      if (stageIds.has(stage.id)) errors.push(`${id}: duplicate stage id "${stage.id}".`);
      stageIds.add(stage.id);
      if (stage.actions.length === 0) errors.push(`${id} stage ${stageIndex + 1}: at least one valid action is required.`);
      if (!stage.allowManual && stage.event === 'activity:action' && specializedCommands(id).length === 0) {
        errors.push(`${id} stage ${stageIndex + 1}: a manual-only event cannot disable manual actions without a specialized engine.`);
      }
    }
    for (const stage of stages) {
      for (const nextId of Object.values(stage.nextStageByAction)) {
        if (!stageIds.has(nextId)) errors.push(`${id}: stage ${stage.id} branches to missing stage "${nextId}".`);
      }
    }
    const reward = normalizeReward(raw?.reward, difficulty, id);
    if (reward.gold === 0 && reward.tokens === 0 && !reward.title && reward.items.length === 0) warnings.push(`${id}: completion has no configured reward.`);
    const availability = normalizeAvailability(raw?.availability);
    const antiExploit = normalizeAntiExploit(raw?.antiExploit);
    const entry = normalizeEntry(raw?.entry);
    definitions.push(Object.freeze({
      id, name, summary, category, archetype,
      version: boundedInt(raw?.version, 1, 1_000_000, 1),
      difficulty, skill: shell.skill,
      enabled: raw?.enabled !== false,
      durationMinutes: boundedInt(raw?.durationMinutes, 1, 30 * 24 * 60, 60),
      cooldownSeconds: boundedInt(raw?.cooldownSeconds, 0, 86_400, 2),
      staminaCost: boundedInt(raw?.staminaCost, 0, 100, 1),
      clientMode: CLIENT_MODES.has(clientMode) ? clientMode : 'hybrid',
      enhancedView: cleanText(raw?.enhancedView || archetype, 64),
      adapter: cleanText(raw?.adapter, 128),
      party, reward, entry, availability, antiExploit,
      stages: Object.freeze(stages),
      specializedCommands: Object.freeze(specializedCommands(id)),
      tags: Object.freeze((Array.isArray(raw?.tags) ? raw.tags : [])
        .map((entry) => cleanText(entry, 32).toLowerCase()).filter(Boolean).slice(0, 16)),
    }));
  });
  return { ok: errors.length === 0, errors, warnings, definitions };
}

export function loadGameSystemCatalog(sourceFile, options = {}) {
  const parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const result = validateGameSystemCatalog(parsed, options);
  if (!result.ok) throw new Error(`Invalid game-system catalog:\n${result.errors.join('\n')}`);
  return result;
}

function playerProfile(mobile) {
  mobile.gameSystems ??= { tokens: 0, completions: {}, titles: [], unlocks: [], reputation: {}, daily: {}, lastCompletedAt: {}, pendingRewards: [], lastPlayedAt: 0 };
  mobile.gameSystems.tokens = Math.max(0, Number(mobile.gameSystems.tokens) | 0);
  mobile.gameSystems.completions ??= {};
  mobile.gameSystems.unlocks = Array.isArray(mobile.gameSystems.unlocks) ? mobile.gameSystems.unlocks.slice(-256) : [];
  mobile.gameSystems.reputation ??= {};
  mobile.gameSystems.daily ??= {};
  mobile.gameSystems.lastCompletedAt ??= {};
  mobile.gameSystems.pendingRewards = Array.isArray(mobile.gameSystems.pendingRewards) ? mobile.gameSystems.pendingRewards.slice(-32) : [];
  mobile.gameSystems.titles = Array.isArray(mobile.gameSystems.titles)
    ? mobile.gameSystems.titles.slice(-64) : [];
  return mobile.gameSystems;
}

function accountIdentity(mobile) {
  return cleanText(mobile?.account?.username ?? mobile?.accountName ?? mobile?.account ?? mobile?.serial, 96).toLowerCase();
}

function dayKey(now) { return new Date(now).toISOString().slice(0, 10); }

function mobileRegion(mobile) {
  return cleanText(mobile?.region?.id ?? mobile?.region?.name ?? mobile?._region?.id ?? mobile?._region?.name, 64).toLowerCase();
}

function availabilityError(definition, mobile, now, { skipProgress = false } = {}) {
  const rules = definition.availability;
  const date = new Date(now);
  if (rules.daysOfWeek.length && !rules.daysOfWeek.includes(date.getUTCDay())) return 'This activity is not scheduled today.';
  const hour = date.getUTCHours();
  if (rules.startHourUtc !== rules.endHourUtc) {
    const inHours = rules.startHourUtc < rules.endHourUtc
      ? hour >= rules.startHourUtc && hour < rules.endHourUtc
      : hour >= rules.startHourUtc || hour < rules.endHourUtc;
    if (!inHours) return `This activity is available from ${rules.startHourUtc}:00 to ${rules.endHourUtc}:00 UTC.`;
  }
  if (rules.maps.length && !rules.maps.includes(Number(mobile?.map) | 0)) return 'This activity is unavailable on this facet.';
  const region = mobileRegion(mobile);
  if (rules.regions.length && !rules.regions.includes(region)) return 'Travel to an eligible region before joining.';
  const createdRaw = mobile?.account?.createdAt ?? mobile?.account?.created
    ?? mobile?.client?.account?.createdAt ?? mobile?.client?.account?.created
    ?? mobile?.accountCreatedAt ?? 0;
  const createdAt = typeof createdRaw === 'string' ? Date.parse(createdRaw) : Number(createdRaw);
  if (rules.minAccountAgeDays && (!createdAt || now - createdAt < rules.minAccountAgeDays * DAY_MS)) return `This activity requires an account age of ${rules.minAccountAgeDays} days.`;
  if (!skipProgress) {
    const profile = playerProfile(mobile);
    for (const [systemId, amount] of Object.entries(rules.requiredCompletions)) {
      if ((Number(profile.completions[systemId]) | 0) < amount) return `Complete ${systemId} ${amount} time(s) first.`;
    }
    const last = Number(profile.lastCompletedAt[definition.id]) || 0;
    if (definition.antiExploit.completionCooldownMinutes && now - last < definition.antiExploit.completionCooldownMinutes * 60_000) {
      return 'This activity is still on its completion cooldown.';
    }
    const daily = profile.daily?.[definition.id];
    if (definition.antiExploit.dailyCompletionLimit && daily?.day === dayKey(now)
        && (Number(daily.count) | 0) >= definition.antiExploit.dailyCompletionLimit) return 'Your daily completion limit has been reached.';
  }
  return '';
}

function eventTargetKey(payload) {
  const target = payload?.target ?? payload?.victim ?? payload?.item ?? payload?.region ?? payload?.destination;
  if (target == null) return '';
  return cleanText(target.serial ?? target.id ?? target.name ?? `${target.x ?? ''},${target.y ?? ''},${target.map ?? ''}`, 96).toLowerCase();
}

function eventKind(value) {
  return cleanText(value?.kind ?? value?.type ?? value?.template ?? value?.definitionId ?? value?.name, 64).toLowerCase();
}

function stageAcceptsEvent(stage, actor, payload) {
  if (stage.maps.length && !stage.maps.includes(Number(actor?.map) | 0)) return false;
  const region = cleanText(payload?.region?.id ?? payload?.region?.name ?? mobileRegion(actor), 64).toLowerCase();
  if (stage.regions.length && !stage.regions.includes(region)) return false;
  if (stage.targetKinds.length && !stage.targetKinds.includes(eventKind(payload?.target ?? payload?.victim ?? payload?.item))) return false;
  if (stage.sourceKinds.length && !stage.sourceKinds.includes(eventKind(payload?.source ?? actor))) return false;
  return true;
}

function skillValue(mobile, skill, registry = null) {
  const skills = mobile?.skills ?? {};
  const wanted = String(skill ?? '').toLowerCase();
  const registeredId = registry?.find?.(skill)?.id;
  let value = skills[skill] ?? skills[wanted]
    ?? (registeredId == null ? undefined : skills[registeredId])
    ?? (registeredId == null ? undefined : skills[String(registeredId)]);
  if (value == null) {
    const key = Object.keys(skills).find((entry) => entry.toLowerCase() === wanted);
    value = key == null ? null : skills[key];
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 120 ? numeric / 10 : numeric;
  return ((Number(mobile?.str) || 50) + (Number(mobile?.dex) || 50) + (Number(mobile?.int) || 50)) / 3;
}

function actorFromEvent(payload) {
  const actor = payload?.player ?? payload?.killer ?? payload?.attacker ?? payload?.mobile
    ?? payload?.crafter ?? payload?.speaker ?? payload?.source ?? null;
  return actor?.controlMaster ?? actor?.summonMaster ?? actor?.owner ?? actor;
}

function publicParticipant(row) {
  return {
    serial: row.serial, name: row.name, score: row.score,
    contributions: row.contributions, team: row.team, joinedAt: row.joinedAt,
    focus: row.focus ?? 0, streak: row.streak ?? 0,
  };
}

function publicInstance(instance, definition, { includeParticipants = true } = {}) {
  const stage = definition?.stages?.[instance.stageIndex] ?? null;
  return {
    id: instance.id, systemId: instance.systemId, status: instance.status,
    createdAt: instance.createdAt, startedAt: instance.startedAt,
    endsAt: instance.endsAt, completedAt: instance.completedAt,
    stageIndex: instance.stageIndex, stage: stage ? publicStage(stage) : null,
    progress: instance.progress, revision: instance.revision,
    teamScores: [...(instance.teamScores ?? [])], winnerTeam: instance.winnerTeam ?? 0,
    momentum: instance.momentum ?? 0, stageAttempts: instance.stageAttempts ?? 0,
    definitionVersion: instance.definitionVersion ?? definition?.version ?? 1,
    rulesRevision: instance.rulesRevision ?? 0,
    participants: includeParticipants ? [...instance.participants.values()]
      .map(publicParticipant).sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt) : undefined,
  };
}

function publicPlayerInstance(instance, definition, mobile, options) {
  return { ...publicInstance(instance, definition, options),
    specialState: publicSpecializedState(instance.systemId, instance.modeState, mobile) };
}

export class GameSystemRuntime {
  constructor({ world, scheduler = null, skills = null, systems = {}, sourceFile, publish = null, now = () => Date.now(), random = Math.random } = {}) {
    if (!world) throw new TypeError('GameSystemRuntime requires a world.');
    if (!sourceFile) throw new TypeError('GameSystemRuntime requires a catalog sourceFile.');
    this.world = world;
    this.scheduler = scheduler;
    this.skills = skills;
    this.sourceFile = sourceFile;
    this.publish = typeof publish === 'function' ? publish : () => false;
    this.now = now;
    this.random = random;
    this.adapters = createGameSystemAdapterRegistry(systems);
    this.definitions = new Map();
    this.instances = new Map();
    this.participantIndex = new Map();
    this.eventIndex = new Map();
    this.replayInstances = new Set();
    this.history = [];
    this.nextInstanceId = 1;
    this.catalogRevision = 0;
    this.telemetry = new Map();
    // Account-wide anti-exploit state is world metadata rather than character
    // state. It survives restarts while still allowing character profiles to
    // be moved independently by the account/character migration tools.
    this.accountLimits = new Map();
    this._unsubscribers = [];
    this.reloadCatalog();
    this.restore(world._persistedGameSystems);
    this._installEventBridges();
    this._timer = scheduler?.every?.('game-systems', 1000, () => this.tick());
    this._timer?.unref?.();
    world._gameSystemRuntime = this;
  }

  reloadCatalog() {
    // The shipped catalog contains 100 systems, but the format is deliberately
    // extensible: an administrator may add or archive definitions later.
    const result = loadGameSystemCatalog(this.sourceFile);
    const adapterValidation = this.adapters.validate(result.definitions);
    if (!adapterValidation.ok) throw new Error(`Invalid game-system adapters:\n${adapterValidation.errors.join('\n')}`);
    this.definitions = new Map(result.definitions.map((definition) => [definition.id, definition]));
    this.catalogRevision++;
    for (const instance of this.instances.values()) {
      // Live instances keep their immutable definition snapshot. Removing or
      // editing a catalog row therefore cannot corrupt a run in progress.
      if (!this.definitions.has(instance.systemId) && !instance.definitionSnapshot && !TERMINAL.has(instance.status)) instance.status = 'failed';
    }
    this._rebuildIndexes();
    return { ok: true, count: this.definitions.size, revision: this.catalogRevision,
      warnings: [...result.warnings, ...adapterValidation.warnings], adapters: this.adapters.diagnostics(result.definitions) };
  }

  catalogSnapshot({ category = '', query = '', includeDisabled = false } = {}) {
    const needle = cleanText(query, 96).toLowerCase();
    const categoryKey = cleanText(category, 32).toLowerCase();
    const systems = [...this.definitions.values()].filter((definition) =>
      (includeDisabled || definition.enabled)
      && (!categoryKey || definition.category === categoryKey)
      && (!needle || `${definition.id} ${definition.name} ${definition.summary} ${definition.tags.join(' ')}`.toLowerCase().includes(needle)))
      .map((definition) => ({ ...definition, stages: definition.stages.map(publicStage) }));
    return { operation: 'catalog', revision: this.catalogRevision, systems };
  }

  definition(id) { return this.definitions.get(String(id ?? '').toLowerCase()) ?? null; }

  definitionForInstance(instance) { return instance?.definitionSnapshot ?? this.definition(instance?.systemId); }

  activeForSystem(systemId) {
    return [...this.instances.values()].find((entry) => entry.systemId === systemId && !TERMINAL.has(entry.status)) ?? null;
  }

  joinableForSystem(systemId) {
    const definition = this.definition(systemId);
    if (!definition) return null;
    return [...this.instances.values()].find((entry) => entry.systemId === definition.id
      && ['active', 'recruiting'].includes(entry.status)
      && entry.participants.size < this.definitionForInstance(entry).party.max) ?? null;
  }

  instanceForPlayer(mobile, instanceOrSystemId) {
    return this._resolvePlayerInstance(mobile, instanceOrSystemId);
  }

  start(systemId, { startedBy = 0, status = 'active', allowParallel = false } = {}) {
    const definition = this.definition(systemId);
    if (!definition?.enabled) return { ok: false, error: 'System is missing or disabled.' };
    if (this.instances.size >= MAX_INSTANCES) this._pruneInstances();
    if (this.instances.size >= MAX_INSTANCES) return { ok: false, error: 'The live activity limit has been reached.' };
    const existing = allowParallel ? null : this.activeForSystem(definition.id);
    if (existing) return { ok: true, existing: true, instance: publicInstance(existing, definition) };
    const now = this.now();
    const id = `${definition.id}:${now.toString(36)}:${(this.nextInstanceId++).toString(36)}`;
    const definitionSnapshot = structuredClone(definition);
    const instance = {
      id, systemId: definition.id, status: status === 'recruiting' ? 'recruiting' : 'active',
      createdAt: now, startedAt: status === 'recruiting' ? 0 : now,
      endsAt: now + definition.durationMinutes * 60_000,
      pausedAt: 0, completedAt: 0, stageIndex: 0, progress: 0, revision: 1,
      teamScores: Array.from({ length: definition.party.teams }, () => 0),
      winnerTeam: 0, momentum: 0, stageAttempts: 0,
      definitionVersion: definition.version, rulesRevision: this.catalogRevision, definitionSnapshot,
      startedBy: Number(startedBy) >>> 0, participants: new Map(), rewarded: false,
      modeState: createSpecializedState(definition.id),
    };
    this.instances.set(id, instance);
    if (definition.id === 'chronicle-replays') this.replayInstances.add(id);
    this._indexInstanceEvent(instance);
    this._history('started', instance);
    this._metric(definition.id, 'started');
    this.adapters.lifecycle('start', definition, { instance, runtime: this, world: this.world });
    this._dirtyMeta();
    return { ok: true, instance: publicInstance(instance, definition) };
  }

  transition(instanceId, status) {
    const instance = this.instances.get(String(instanceId));
    if (!instance) return { ok: false, error: 'Activity instance not found.' };
    const next = cleanText(status, 16).toLowerCase();
    if (!['active', 'paused', 'completed', 'failed', 'cancelled'].includes(next)) {
      return { ok: false, error: 'Invalid activity transition.' };
    }
    if (TERMINAL.has(instance.status)) return { ok: false, error: 'Activity is already finished.' };
    if (next === instance.status) {
      return { ok: true, existing: true, instance: publicInstance(instance, this.definitionForInstance(instance)) };
    }
    const now = this.now();
    const previous = instance.status;
    instance.status = next;
    if (next === 'paused') instance.pausedAt = now;
    if (next === 'active') {
      if (!instance.startedAt) {
        instance.startedAt = now;
        instance.endsAt = now + this.definitionForInstance(instance).durationMinutes * 60_000;
      } else if (previous === 'paused' && instance.pausedAt) {
        instance.endsAt += Math.max(0, now - instance.pausedAt);
      }
      instance.pausedAt = 0;
    }
    if (TERMINAL.has(next)) instance.completedAt = now;
    if (next === 'completed') {
      this._settleWinner(instance, this.definitionForInstance(instance));
      this._reward(instance, this.definitionForInstance(instance));
    }
    instance.revision++;
    this._rebuildIndexes();
    this._history(next, instance); this._metric(instance.systemId, next);
    this.adapters.lifecycle(next, this.definitionForInstance(instance), { instance, runtime: this, world: this.world });
    this._publishInstance(instance, next);
    this._dirtyMeta();
    return { ok: true, instance: publicInstance(instance, this.definitionForInstance(instance)) };
  }

  join(mobile, systemId, { allowEnhanced = false } = {}) {
    if (!mobile?.serial) return { ok: false, error: 'A player character is required.' };
    const definition = this.definition(systemId);
    if (!definition?.enabled) return { ok: false, error: 'System is missing or disabled.' };
    const current = this._resolvePlayerInstance(mobile, definition.id);
    if (current) return { ok: true, existing: true,
      instance: publicPlayerInstance(current, this.definitionForInstance(current), mobile) };
    let instance = this.joinableForSystem(definition.id);
    let liveDefinition = instance ? this.definitionForInstance(instance) : definition;
    if (liveDefinition.clientMode === 'enhanced' && !allowEnhanced) {
      return { ok: false, requiresNodeUO: true, error: 'This activity requires the NodeUO client. You can continue playing without it.' };
    }
    const unavailable = this._availabilityError(liveDefinition, mobile, this.now());
    if (unavailable) return { ok: false, error: unavailable };
    const identity = accountIdentity(mobile);
    if (liveDefinition.antiExploit.accountWide && [...this.instances.values()].some((candidate) =>
      candidate.systemId === liveDefinition.id && !TERMINAL.has(candidate.status)
      && [...candidate.participants.values()].some((row) => row.accountKey === identity))) {
      return { ok: false, error: 'Only one character per account may join active runs of this activity.' };
    }
    const profile = playerProfile(mobile);
    if ((Number(mobile.gold) || 0) < liveDefinition.entry.gold || profile.tokens < liveDefinition.entry.tokens) {
      return { ok: false, error: `Entry requires ${liveDefinition.entry.gold} gold and ${liveDefinition.entry.tokens} activity tokens.` };
    }
    if (!instance) {
      const started = this.start(definition.id, {
        startedBy: mobile.serial,
        status: definition.party.min > 1 ? 'recruiting' : 'active',
        allowParallel: true,
      });
      if (!started.ok) return started;
      instance = this.instances.get(started.instance.id);
      liveDefinition = this.definitionForInstance(instance);
    }
    if (!['active', 'recruiting'].includes(instance.status)) return { ok: false, error: 'Activity is not accepting participants.' };
    if (instance.participants.has(mobile.serial)) return { ok: true, existing: true,
      instance: publicPlayerInstance(instance, liveDefinition, mobile) };
    if (instance.participants.size >= liveDefinition.party.max) return { ok: false, error: 'Activity is full.' };
    mobile.gold = Math.max(0, (Number(mobile.gold) | 0) - liveDefinition.entry.gold);
    profile.tokens -= liveDefinition.entry.tokens;
    const teamCounts = Array.from({ length: liveDefinition.party.teams }, (_, team) =>
      [...instance.participants.values()].filter((participant) => participant.team === team + 1).length);
    const team = teamCounts.indexOf(Math.min(...teamCounts)) + 1;
    instance.participants.set(mobile.serial, {
      serial: mobile.serial, name: cleanText(mobile.name || `Player ${mobile.serial}`, 64),
      accountKey: identity, joinedAt: this.now(), score: 0, contributions: 0, team, cooldownUntil: 0,
      focus: 0, streak: 0,
      actionWindowStartedAt: 0, actionsInWindow: 0, targetKeys: {},
      entryPaid: { ...liveDefinition.entry },
    });
    if (instance.status === 'recruiting' && instance.participants.size >= liveDefinition.party.min) {
      const now = this.now();
      instance.status = 'active';
      instance.startedAt = now;
      instance.endsAt = now + liveDefinition.durationMinutes * 60_000;
      this._indexInstanceEvent(instance);
      this._history('active', instance, mobile.serial);
    }
    let ids = this.participantIndex.get(mobile.serial);
    if (!ids) { ids = new Set(); this.participantIndex.set(mobile.serial, ids); }
    ids.add(instance.id);
    instance.revision++;
    playerProfile(mobile).lastPlayedAt = this.now();
    const claimed = this.claimPendingRewards(mobile, { notify: false });
    this._dirtyMobile(mobile);
    this._dirtyMeta();
    mobile.client?.sendSystemMessage?.(`You joined ${liveDefinition.name}.${claimed.claimed ? ` ${claimed.claimed} pending reward item(s) were delivered.` : ''}`);
    this._history('joined', instance, mobile.serial);
    this._metric(instance.systemId, 'joined');
    this.adapters.lifecycle('join', liveDefinition, { instance, mobile, runtime: this, world: this.world });
    this._publishInstance(instance, 'joined');
    return { ok: true, instance: publicPlayerInstance(instance, liveDefinition, mobile) };
  }

  leave(mobile, instanceOrSystemId) {
    const instance = this._resolvePlayerInstance(mobile, instanceOrSystemId);
    if (!instance) return { ok: false, error: 'You are not participating in that activity.' };
    removeSpecializedParticipant(instance.systemId, instance.modeState, mobile);
    instance.participants.delete(mobile.serial);
    this.participantIndex.get(mobile.serial)?.delete(instance.id);
    if (!this.participantIndex.get(mobile.serial)?.size) this.participantIndex.delete(mobile.serial);
    const definition = this.definitionForInstance(instance);
    if (instance.status === 'active' && instance.participants.size < definition.party.min) {
      instance.status = 'recruiting';
      instance.startedAt = 0;
      instance.endsAt = this.now() + definition.durationMinutes * 60_000;
      this._history('recruiting', instance, mobile.serial);
      this._rebuildIndexes();
    }
    instance.revision++;
    this._history('left', instance, mobile.serial);
    this._metric(instance.systemId, 'left');
    this.adapters.lifecycle('leave', definition, { instance, mobile, runtime: this, world: this.world });
    this._dirtyMobile(mobile);
    this._dirtyMeta();
    mobile.client?.sendSystemMessage?.(`You left ${definition?.name ?? instance.systemId}.`);
    this._publishInstance(instance, 'left');
    return { ok: true, instance: publicInstance(instance, definition) };
  }

  act(mobile, instanceOrSystemId, actionId = 'attempt', { amount = 1, source = 'command' } = {}) {
    const instance = this._resolvePlayerInstance(mobile, instanceOrSystemId);
    if (!instance) return { ok: false, error: 'Join the activity before contributing.' };
    if (instance.status !== 'active') return { ok: false, error: 'Activity is not active.' };
    const definition = this.definitionForInstance(instance);
    const stage = definition?.stages?.[instance.stageIndex];
    if (!definition || !stage) return { ok: false, error: 'Activity definition is unavailable.' };
    const action = cleanText(actionId || stage.actions[0], 32).toLowerCase();
    if (!stage.actions.includes(action)) return { ok: false, error: `Choose: ${stage.actions.join(', ')}.` };
    if (!stage.allowManual) return { ok: false, error: `Complete this objective through the ${stage.event} world event.` };
    const participant = instance.participants.get(mobile.serial);
    const now = this.now();
    if (now - participant.actionWindowStartedAt >= 60_000) {
      participant.actionWindowStartedAt = now; participant.actionsInWindow = 0;
    }
    if (participant.actionsInWindow >= definition.antiExploit.maxActionsPerMinute) {
      this._metric(definition.id, 'rateLimited');
      return { ok: false, retryAfterMs: Math.max(1, 60_000 - (now - participant.actionWindowStartedAt)), error: 'Activity action rate limit reached.' };
    }
    participant.actionsInWindow++;
    if (participant.cooldownUntil > now) {
      return { ok: false, retryAfterMs: participant.cooldownUntil - now, error: 'That activity action is cooling down.' };
    }
    const actionIndex = Math.max(0, stage.actions.indexOf(action));
    const tactic = actionIndex === 0 ? 'execute' : actionIndex === 1 ? 'support' : 'prepare';
    const staminaCost = tactic === 'prepare' ? Math.ceil(definition.staminaCost / 2) : definition.staminaCost;
    if ((Number(mobile.stam) || 0) < staminaCost) return { ok: false, error: 'You are too tired.' };
    mobile.stam = Math.max(0, (Number(mobile.stam) || 0) - staminaCost);
    this.world.markMobileVitals?.(mobile);
    participant.cooldownUntil = now + definition.cooldownSeconds * 1000;
    const effectiveSkill = skillValue(mobile, stage.skill, this.skills);
    const focusBonus = Math.min(0.20, (participant.focus ?? 0) * 0.025);
    const momentumBonus = Math.min(0.10, (instance.momentum ?? 0) * 0.005);
    const tacticBonus = tactic === 'prepare' ? 0.14 : tactic === 'support' ? 0.07 : 0;
    const chance = Math.max(0.10, Math.min(0.98,
      0.45 + (effectiveSkill - definition.difficulty * 10) / 150 + focusBonus + momentumBonus + tacticBonus));
    const success = this.random() <= chance;
    const base = boundedInt(amount, 1, Math.min(1000, stage.contributionCap), 1);
    const tacticMultiplier = tactic === 'execute' ? 1.2 : tactic === 'support' ? 0.8 : 0.5;
    const streakMultiplier = 1 + Math.min(0.25, (participant.streak ?? 0) * 0.025);
    const contribution = success ? Math.max(1,
      Math.round(base * (1 + effectiveSkill / 100) * tacticMultiplier * streakMultiplier)) : 0;
    instance.stageAttempts = (instance.stageAttempts ?? 0) + 1;
    if (success) {
      participant.streak = Math.min(10, (participant.streak ?? 0) + 1);
      if (tactic === 'execute') participant.focus = Math.max(0, (participant.focus ?? 0) - 2);
      else if (tactic === 'support') instance.momentum = Math.min(20, (instance.momentum ?? 0) + 2);
      else participant.focus = Math.min(8, (participant.focus ?? 0) + 2);
      this._advance(instance, mobile, contribution, { action, source, tactic });
    } else {
      participant.streak = 0;
      participant.focus = Math.min(8, (participant.focus ?? 0) + 1);
      instance.momentum = Math.max(0, (instance.momentum ?? 0) - 1);
      this._history('attempt-failed', instance, mobile.serial, { action, source, tactic });
    }
    const result = {
      ok: true, success, contribution, chance: Number(chance.toFixed(3)), action,
      tactic, staminaCost,
      message: success ? `${tactic} contributed ${contribution} progress.` : 'The attempt failed; no resources beyond stamina were consumed.',
      instance: publicInstance(instance, definition),
    };
    mobile.client?.sendSystemMessage?.(result.message);
    this._publishInstance(instance, success ? 'progress' : 'attempt-failed');
    this._metric(definition.id, success ? 'actionsSucceeded' : 'actionsFailed');
    this._dirtyMobile(mobile);
    this._dirtyMeta();
    return result;
  }

  special(mobile, instanceOrSystemId, command, payload = {}) {
    const instance = this._resolvePlayerInstance(mobile, instanceOrSystemId);
    if (!instance) return { ok: false, error: 'Join the activity before using its enhanced controls.' };
    if (instance.status !== 'active') return { ok: false, error: 'Activity is not active.' };
    const definition = this.definitionForInstance(instance);
    if (!instance.modeState || !definition.specializedCommands.includes(cleanText(command, 32).toLowerCase())) {
      return { ok: false, error: 'Unsupported specialized command.' };
    }
    const participant = instance.participants.get(mobile.serial);
    const now = this.now();
    if (now - participant.actionWindowStartedAt >= 60_000) {
      participant.actionWindowStartedAt = now; participant.actionsInWindow = 0;
    }
    if (participant.actionsInWindow++ >= definition.antiExploit.maxActionsPerMinute) {
      this._metric(definition.id, 'rateLimited');
      return { ok: false, error: 'Enhanced command rate limit reached.' };
    }
    const result = runSpecializedCommand({ systemId: definition.id, state: instance.modeState,
      mobile, command: cleanText(command, 32).toLowerCase(), payload, random: this.random, now, world: this.world });
    if (!result.ok) { this._metric(definition.id, 'specialRejected'); return result; }
    if (result.failed) this.transition(instance.id, 'failed');
    else if (result.completed) {
      // A malformed author-authored branch may point backwards. Specialized
      // engines must never be able to turn that into an unbounded server loop.
      let transitionsLeft = definition.stages.length * 2 + 1;
      while (instance.status === 'active' && transitionsLeft-- > 0) {
        const stage = definition.stages[instance.stageIndex];
        if (!stage) break;
        this._advance(instance, mobile, stage.goal, { action: command, source: 'specialized-engine' });
      }
      if (instance.status === 'active') {
        this._metric(definition.id, 'invalidTransitions');
        this._history('invalid-transition', instance, mobile.serial, { command, target: 'terminal' });
        this.transition(instance.id, 'failed');
        return { ...result, ok: false, error: 'The activity stage graph did not reach a terminal state.',
          instance: publicPlayerInstance(instance, definition, mobile),
          specialState: publicSpecializedState(definition.id, instance.modeState, mobile) };
      }
    } else if (Number.isInteger(result.advanceToStage)) {
      const target = Math.min(definition.stages.length - 1, Math.max(0, result.advanceToStage));
      let transitionsLeft = definition.stages.length + 1;
      while (instance.status === 'active' && instance.stageIndex < target && transitionsLeft-- > 0) {
        const stage = definition.stages[instance.stageIndex];
        this._advance(instance, mobile, Math.max(1, stage.goal - instance.progress),
          { action: command, source: 'specialized-engine' });
      }
      if (instance.status === 'active' && instance.stageIndex < target) {
        this._metric(definition.id, 'invalidTransitions');
        this._history('invalid-transition', instance, mobile.serial, { command, target });
        this.transition(instance.id, 'failed');
        return { ...result, ok: false, error: 'The activity stage graph could not reach the requested stage.',
          instance: publicPlayerInstance(instance, definition, mobile),
          specialState: publicSpecializedState(definition.id, instance.modeState, mobile) };
      }
    } else if (result.contribution
        && (result.stageIndex == null || result.stageIndex === instance.stageIndex)) {
      this._advance(instance, mobile, Math.min(result.contribution, definition.antiExploit.maxEventContribution),
        { action: command, source: 'specialized-engine' });
    }
    instance.revision++;
    this._metric(definition.id, 'specialCommands');
    this._publishInstance(instance, 'specialized');
    this._dirtyMeta();
    return { ...result, instance: publicPlayerInstance(instance, definition, mobile),
      specialState: publicSpecializedState(definition.id, instance.modeState, mobile) };
  }

  recordEvent(name, payload = {}) {
    const eventName = cleanText(name, 64);
    const actor = actorFromEvent(payload);
    if (!actor?.serial) return 0;
    const scopedSystemId = cleanText(payload?.gameSystemId ?? payload?.activityId ?? payload?.systemId, 64).toLowerCase();
    const scopedInstanceId = cleanText(payload?.gameSystemInstanceId ?? payload?.activityInstanceId, 160);
    const candidateIds = this.eventIndex.get(eventName);
    const playerIds = this.participantIndex.get(actor.serial);
    if (!candidateIds?.size || !playerIds?.size) return 0;
    let advanced = 0;
    for (const instanceId of playerIds) {
      if (!candidateIds.has(instanceId)) continue;
      const instance = this.instances.get(instanceId);
      if (!instance || instance.status !== 'active') continue;
      if (scopedInstanceId && instance.id !== scopedInstanceId) continue;
      if (scopedSystemId && instance.systemId !== scopedSystemId) continue;
      const definition = this.definitionForInstance(instance);
      const stage = definition?.stages?.[instance.stageIndex];
      const participant = instance.participants.get(actor.serial);
      if (!stage || !participant || !stageAcceptsEvent(stage, actor, payload)) continue;
      const targetKey = eventTargetKey(payload);
      if (stage.uniqueTargets > 0 || definition.antiExploit.requireUniqueEventTarget) {
        if (!targetKey) {
          this._metric(definition.id, 'invalidEvents');
          continue;
        }
        participant.targetKeys[stage.id] ??= [];
        if (participant.targetKeys[stage.id].includes(targetKey)) {
          this._metric(definition.id, 'duplicateEvents');
          continue;
        }
        participant.targetKeys[stage.id].push(targetKey);
        const limit = Math.max(stage.uniqueTargets, 128);
        if (participant.targetKeys[stage.id].length > limit) participant.targetKeys[stage.id].splice(0, participant.targetKeys[stage.id].length - limit);
      }
      const rawAmount = boundedInt(payload.amount ?? payload.damage, 1, definition.antiExploit.maxEventContribution, 1);
      const amount = eventName === 'combat:damage'
        ? Math.max(1, Math.ceil(rawAmount / 10)) : rawAmount;
      this._advance(instance, actor, amount, { action: eventName, source: 'world-event' });
      this._publishInstance(instance, 'progress');
      advanced++;
    }
    for (const instanceId of this.replayInstances) {
      const instance = this.instances.get(instanceId);
      if (instance?.status === 'active' && instance.modeState) {
        appendReplayEvent(instance.modeState, { at: this.now(), event: eventName, actorSerial: Number(actor.serial) >>> 0,
          targetSerial: Number(payload?.target?.serial ?? payload?.victim?.serial) >>> 0,
          amount: boundedInt(payload.amount ?? payload.damage, 0, 100_000, 0) });
      }
    }
    return advanced;
  }

  notifyRegion(mobile, region) {
    return this.recordEvent('region:enter', { mobile, region });
  }

  leaderboard(systemId, limit = 50) {
    const rows = new Map();
    for (const instance of this.instances.values()) {
      if (systemId && instance.systemId !== systemId) continue;
      for (const participant of instance.participants.values()) {
        const row = rows.get(participant.serial) ?? { serial: participant.serial, name: participant.name, score: 0, contributions: 0 };
        row.score += participant.score;
        row.contributions += participant.contributions;
        rows.set(participant.serial, row);
      }
    }
    return [...rows.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, boundedInt(limit, 1, 100, 50));
  }

  playerSnapshot(mobile) {
    if (!mobile?.serial) return { profile: null, instances: [] };
    this.claimPendingRewards(mobile);
    const instances = [...(this.participantIndex.get(mobile.serial) ?? [])]
      .map((id) => this.instances.get(id)).filter(Boolean)
      .map((instance) => publicPlayerInstance(instance, this.definitionForInstance(instance), mobile));
    return { profile: { ...playerProfile(mobile) }, instances };
  }

  openSnapshot(mobile, options = {}) {
    return {
      ...this.catalogSnapshot(options), operation: 'open',
      ...this.playerSnapshot(mobile),
      live: [...this.instances.values()].filter((entry) => !TERMINAL.has(entry.status))
        .map((instance) => publicInstance(instance, this.definitionForInstance(instance), { includeParticipants: false })),
    };
  }

  handleRequest(state, payload = {}) {
    const mobile = state?.mobile;
    if (!mobile) return { ok: false, error: 'A player character is required.' };
    const operation = cleanText(payload.operation || 'open', 32).toLowerCase();
    if (operation === 'open' || operation === 'list') return { ok: true, ...this.openSnapshot(mobile, payload) };
    if (operation === 'get') {
      const definition = this.definition(payload.systemId);
      return definition ? { ok: true, system: { ...definition, stages: definition.stages.map(publicStage) }, ...this.playerSnapshot(mobile) }
        : { ok: false, error: 'Game system not found.' };
    }
    if (operation === 'instances') return { ok: true, ...this.playerSnapshot(mobile) };
    if (operation === 'profile') return { ok: true, ...this.playerSnapshot(mobile) };
    if (operation === 'join') return this.join(mobile, payload.systemId, { allowEnhanced: true });
    if (operation === 'leave') return this.leave(mobile, payload.instanceId || payload.systemId);
    // Contribution size is authoritative. A modified client may choose an
    // action, but cannot multiply its value by sending a forged amount.
    if (operation === 'action') return this.act(mobile, payload.instanceId || payload.systemId, payload.actionId, { amount: 1 });
    if (operation === 'special') return this.special(mobile, payload.instanceId || payload.systemId, payload.command, payload.data ?? {});
    if (operation === 'leaderboard') return { ok: true, systemId: payload.systemId, leaderboard: this.leaderboard(payload.systemId, payload.limit) };
    return { ok: false, error: 'Unsupported game-system operation.' };
  }

  tick() {
    const now = this.now();
    for (const instance of this.instances.values()) {
      if (['active', 'recruiting'].includes(instance.status) && instance.endsAt > 0 && instance.endsAt <= now) {
        this.transition(instance.id, 'failed');
      }
    }
    this._pruneInstances();
  }

  serialize() {
    return {
      version: 4, nextInstanceId: this.nextInstanceId,
      history: this.history.slice(-MAX_HISTORY),
      telemetry: Object.fromEntries(this.telemetry),
      accountLimits: Object.fromEntries(this.accountLimits),
      instances: [...this.instances.values()].map((instance) => ({
        ...instance, participants: [...instance.participants.values()],
      })),
    };
  }

  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return { restored: 0 };
    this.nextInstanceId = Math.max(1, Number(snapshot.nextInstanceId) | 0);
    this.history = Array.isArray(snapshot.history) ? snapshot.history.slice(-MAX_HISTORY) : [];
    for (const [id, row] of Object.entries(snapshot.telemetry ?? {}).slice(0, MAX_TELEMETRY_SYSTEMS)) {
      if (ID_PATTERN.test(id) && row && typeof row === 'object') this.telemetry.set(id, { ...row });
    }
    for (const [identity, raw] of Object.entries(snapshot.accountLimits ?? {}).slice(0, MAX_ACCOUNT_LIMITS)) {
      const key = cleanText(identity, 96).toLowerCase();
      if (!key || !raw || typeof raw !== 'object') continue;
      const completions = {};
      const lastCompletedAt = {};
      const daily = {};
      for (const [systemId, amount] of Object.entries(raw.completions ?? {}).slice(0, MAX_PLAYER_COMPLETIONS)) {
        if (ID_PATTERN.test(systemId)) completions[systemId] = boundedInt(amount, 0, MAX_PLAYER_COMPLETIONS, 0);
      }
      for (const [systemId, at] of Object.entries(raw.lastCompletedAt ?? {}).slice(0, MAX_PLAYER_COMPLETIONS)) {
        if (ID_PATTERN.test(systemId)) lastCompletedAt[systemId] = Math.max(0, Number(at) || 0);
      }
      for (const [systemId, value] of Object.entries(raw.daily ?? {}).slice(0, MAX_PLAYER_COMPLETIONS)) {
        if (ID_PATTERN.test(systemId) && /^\d{4}-\d{2}-\d{2}$/.test(value?.day ?? '')) {
          daily[systemId] = { day: value.day, count: boundedInt(value.count, 0, 100, 0) };
        }
      }
      this.accountLimits.set(key, { completions, lastCompletedAt, daily, lastTouchedAt: Math.max(0, Number(raw.lastTouchedAt) || 0) });
    }
    let restored = 0;
    for (const raw of Array.isArray(snapshot.instances) ? snapshot.instances.slice(-MAX_INSTANCES) : []) {
      if (!raw?.id || (!this.definitions.has(raw.systemId) && !raw.definitionSnapshot) || this.instances.has(raw.id)) continue;
      const snapshotValidation = raw.definitionSnapshot
        ? validateGameSystemCatalog([raw.definitionSnapshot]) : null;
      const definitionSnapshot = snapshotValidation?.ok ? snapshotValidation.definitions[0] : null;
      const definition = definitionSnapshot ?? this.definition(raw.systemId);
      const restoredStageIndex = boundedInt(raw.stageIndex, 0, definition.stages.length, 0);
      let restoredStatus = ['recruiting', 'active', 'paused', 'completed', 'failed', 'cancelled'].includes(raw.status)
        ? raw.status : 'failed';
      if (!TERMINAL.has(restoredStatus) && restoredStageIndex >= definition.stages.length) restoredStatus = 'failed';
      const instance = {
        id: cleanText(raw.id, 160), systemId: raw.systemId,
        status: restoredStatus,
        createdAt: Number(raw.createdAt) || this.now(), startedAt: Number(raw.startedAt) || 0,
        endsAt: Number(raw.endsAt) || 0, pausedAt: Number(raw.pausedAt) || 0,
        completedAt: Number(raw.completedAt) || 0,
        definitionVersion: boundedInt(raw.definitionVersion, 1, 1_000_000, definition.version),
        rulesRevision: Math.max(0, Number(raw.rulesRevision) | 0),
        definitionSnapshot: structuredClone(definition),
        stageIndex: restoredStageIndex,
        progress: boundedInt(raw.progress, 0, 1_000_000, 0), revision: Math.max(1, Number(raw.revision) | 0),
        teamScores: Array.from({ length: definition.party.teams }, (_, index) =>
          Math.max(0, Number(raw.teamScores?.[index]) | 0)),
        winnerTeam: boundedInt(raw.winnerTeam, 0, definition.party.teams, 0),
        momentum: boundedInt(raw.momentum, 0, 20, 0), stageAttempts: Math.max(0, Number(raw.stageAttempts) | 0),
        startedBy: Number(raw.startedBy) >>> 0, participants: new Map(), rewarded: raw.rewarded === true,
        modeState: raw.modeState && typeof raw.modeState === 'object' ? structuredClone(raw.modeState) : createSpecializedState(definition.id),
      };
      for (const participant of Array.isArray(raw.participants) ? raw.participants.slice(0, definition.party.max) : []) {
        const serial = Number(participant?.serial) >>> 0;
        if (!serial || instance.participants.has(serial)) continue;
        instance.participants.set(serial, {
          serial, name: cleanText(participant.name, 64), joinedAt: Number(participant.joinedAt) || 0,
          accountKey: cleanText(participant.accountKey || serial, 96).toLowerCase(),
          score: Math.max(0, Number(participant.score) | 0),
          contributions: Math.max(0, Number(participant.contributions) | 0),
          team: boundedInt(participant.team, 1, definition.party.teams, 1), cooldownUntil: 0,
          focus: boundedInt(participant.focus, 0, 8, 0), streak: boundedInt(participant.streak, 0, 10, 0),
          actionWindowStartedAt: 0, actionsInWindow: 0,
          targetKeys: participant.targetKeys && typeof participant.targetKeys === 'object' ? structuredClone(participant.targetKeys) : {},
          entryPaid: participant.entryPaid && typeof participant.entryPaid === 'object' ? { ...participant.entryPaid } : { gold: 0, tokens: 0 },
        });
      }
      this.instances.set(instance.id, instance);
      restored++;
    }
    this._rebuildIndexes();
    return { restored };
  }

  reset({ preserveProfiles = true } = {}) {
    this.instances.clear(); this.participantIndex.clear(); this.eventIndex.clear(); this.replayInstances.clear(); this.history.length = 0; this.telemetry.clear(); this.nextInstanceId = 1;
    if (!preserveProfiles) this.accountLimits.clear();
    if (!preserveProfiles) for (const mobile of this.world.mobiles.values()) delete mobile.gameSystems;
    this._dirtyMeta();
    if (!preserveProfiles) for (const mobile of this.world.mobiles.values()) this._dirtyMobile(mobile);
    return { ok: true };
  }

  dispose() {
    this._timer?.cancel?.();
    for (const unsubscribe of this._unsubscribers.splice(0)) unsubscribe?.();
    if (this.world._gameSystemRuntime === this) delete this.world._gameSystemRuntime;
  }

  _resolvePlayerInstance(mobile, instanceOrSystemId) {
    if (!mobile?.serial) return null;
    const key = String(instanceOrSystemId ?? '');
    const direct = this.instances.get(key);
    if (direct?.participants.has(mobile.serial) && !TERMINAL.has(direct.status)) return direct;
    for (const id of this.participantIndex.get(mobile.serial) ?? []) {
      const instance = this.instances.get(id);
      if (instance?.systemId === key && !TERMINAL.has(instance.status)) return instance;
    }
    return null;
  }

  _accountLimit(mobile, { create = false } = {}) {
    const identity = accountIdentity(mobile);
    if (!identity) return null;
    let row = this.accountLimits.get(identity);
    if (!row && create) {
      if (this.accountLimits.size >= MAX_ACCOUNT_LIMITS) {
        const oldest = [...this.accountLimits].sort((a, b) => (a[1].lastTouchedAt || 0) - (b[1].lastTouchedAt || 0))[0];
        if (oldest) this.accountLimits.delete(oldest[0]);
      }
      row = { completions: {}, lastCompletedAt: {}, daily: {}, lastTouchedAt: this.now() };
      this.accountLimits.set(identity, row);
    }
    if (row) row.lastTouchedAt = this.now();
    return row;
  }

  _availabilityError(definition, mobile, now) {
    const characterError = availabilityError(definition, mobile, now,
      { skipProgress: definition.antiExploit.accountWide });
    if (characterError) return characterError;
    if (!definition.antiExploit.accountWide) return '';
    const limits = this._accountLimit(mobile);
    if (!limits) return '';
    for (const [systemId, amount] of Object.entries(definition.availability.requiredCompletions)) {
      if ((Number(limits.completions[systemId]) | 0) < amount) return `Complete ${systemId} ${amount} time(s) first.`;
    }
    const last = Number(limits.lastCompletedAt[definition.id]) || 0;
    if (definition.antiExploit.completionCooldownMinutes
        && now - last < definition.antiExploit.completionCooldownMinutes * 60_000) {
      return 'This activity is still on its account-wide completion cooldown.';
    }
    const daily = limits.daily[definition.id];
    if (definition.antiExploit.dailyCompletionLimit && daily?.day === dayKey(now)
        && (Number(daily.count) | 0) >= definition.antiExploit.dailyCompletionLimit) {
      return 'Your account-wide daily completion limit has been reached.';
    }
    return '';
  }

  _createRewardItem(mobile, item, systemId) {
    const pack = mobile?.backpack ?? mobile?.equipment?.get?.(21);
    if (!pack?.serial) return null;
    return this.world.createItem({ artId: item.artId, hue: item.hue, amount: item.amount,
      x: 0, y: 0, z: 0, map: mobile.map ?? 1, parent: pack.serial, name: item.name,
      activityReward: systemId, accountBound: item.accountBound, movable: true });
  }

  claimPendingRewards(mobile, { notify = true } = {}) {
    const profile = playerProfile(mobile);
    const queued = profile.pendingRewards.slice(0, MAX_PENDING_REWARDS);
    if (!queued.length) return { ok: true, claimed: 0, remaining: 0 };
    let claimed = 0;
    const remaining = [];
    for (const item of queued) {
      try {
        const created = this._createRewardItem(mobile, item, cleanText(item.systemId, 64));
        if (!created) { remaining.push(item); continue; }
        claimed++;
      } catch {
        remaining.push(item);
      }
    }
    if (claimed) {
      profile.pendingRewards = remaining;
      this._dirtyMobile(mobile);
      if (notify) mobile.client?.sendSystemMessage?.(`${claimed} pending activity reward item(s) were delivered to your backpack.`);
    }
    return { ok: true, claimed, remaining: remaining.length };
  }

  _advance(instance, mobile, amount, metadata) {
    const definition = this.definitionForInstance(instance);
    const stage = definition?.stages?.[instance.stageIndex];
    const participant = instance.participants.get(mobile.serial);
    if (!stage || !participant) return false;
    const contribution = boundedInt(amount, 1,
      Math.min(100_000, stage.contributionCap, definition.antiExploit.maxEventContribution), 1);
    instance.progress += contribution;
    participant.score += contribution;
    participant.contributions++;
    const teamIndex = Math.max(0, (participant.team | 0) - 1);
    instance.teamScores ??= Array.from({ length: definition.party.teams }, () => 0);
    instance.teamScores[teamIndex] = Math.max(0, Number(instance.teamScores[teamIndex]) | 0) + contribution;
    instance.revision++;
    this._metric(definition.id, 'progress', contribution);
    this._history('progress', instance, mobile.serial, { amount: contribution, ...metadata });
    this.adapters.lifecycle('progress', definition, { instance, mobile, amount: contribution, metadata, runtime: this, world: this.world });
    const previousEvent = stage.event;
    if (instance.progress >= stage.goal) {
      instance.progress = 0;
      instance.momentum = 0; instance.stageAttempts = 0;
      for (const row of instance.participants.values()) { row.focus = 0; row.streak = 0; }
      const branchId = stage.nextStageByAction?.[cleanText(metadata?.action, 32).toLowerCase()];
      const branchIndex = branchId ? definition.stages.findIndex((entry) => entry.id === branchId) : -1;
      instance.stageIndex = branchIndex >= 0 ? branchIndex : instance.stageIndex + 1;
      this._history('stage-completed', instance, mobile.serial, { stageId: stage.id });
      this._metric(definition.id, 'stagesCompleted');
      this.adapters.lifecycle('stage-completed', definition, { instance, mobile, stage, runtime: this, world: this.world });
      if (instance.stageIndex >= definition.stages.length) {
        instance.status = 'completed';
        instance.completedAt = this.now();
        this._settleWinner(instance, definition);
        this._reward(instance, definition);
        this._history('completed', instance, mobile.serial);
        this._metric(definition.id, 'completed');
        this.adapters.lifecycle('completed', definition, { instance, mobile, runtime: this, world: this.world });
      }
    }
    const nextEvent = definition.stages[instance.stageIndex]?.event ?? null;
    if (previousEvent !== nextEvent || TERMINAL.has(instance.status)) {
      this.eventIndex.get(previousEvent)?.delete(instance.id);
      if (this.eventIndex.get(previousEvent)?.size === 0) this.eventIndex.delete(previousEvent);
      this._indexInstanceEvent(instance);
    }
    if (TERMINAL.has(instance.status)) this._rebuildIndexes();
    this._dirtyMobile(mobile);
    this._dirtyMeta();
    return true;
  }

  _reward(instance, definition) {
    if (instance.rewarded) return;
    instance.rewarded = true;
    const totalGoal = Math.max(1, definition.stages.reduce((sum, stage) => sum + stage.goal, 0));
    for (const participant of instance.participants.values()) {
      const mobile = this.world.mobiles.get(participant.serial);
      if (!mobile) continue;
      const participationPercent = participant.score * 100 / totalGoal;
      if (participationPercent < definition.antiExploit.minParticipationPercent) {
        mobile.client?.sendSystemMessage?.(`${definition.name} completed, but your contribution was below the ${definition.antiExploit.minParticipationPercent}% reward threshold.`);
        this._metric(definition.id, 'rewardsWithheld');
        continue;
      }
      const competitive = ['competition', 'pvp'].includes(definition.archetype) && definition.party.teams > 1;
      const teamFactor = competitive && instance.winnerTeam
        ? (participant.team === instance.winnerTeam ? 1 : 0.65) : 1;
      const share = Math.max(1, Math.min(2, participant.score / totalGoal)) * teamFactor;
      const gold = Math.round(definition.reward.gold * share);
      const tokens = Math.round(definition.reward.tokens * share);
      mobile.gold = Math.max(0, Number(mobile.gold) | 0) + gold;
      const profile = playerProfile(mobile);
      profile.tokens += tokens;
      profile.completions[definition.id] = Math.min(MAX_PLAYER_COMPLETIONS,
        (Number(profile.completions[definition.id]) | 0) + 1);
      profile.reputation[definition.category] = Math.min(1_000_000,
        (Number(profile.reputation[definition.category]) | 0) + definition.reward.reputation);
      profile.lastCompletedAt[definition.id] = this.now();
      const today = dayKey(this.now());
      const daily = profile.daily[definition.id];
      profile.daily[definition.id] = { day: today, count: daily?.day === today ? (Number(daily.count) | 0) + 1 : 1 };
      if (definition.antiExploit.accountWide) {
        const limits = this._accountLimit(mobile, { create: true });
        limits.completions[definition.id] = Math.min(MAX_PLAYER_COMPLETIONS,
          (Number(limits.completions[definition.id]) | 0) + 1);
        limits.lastCompletedAt[definition.id] = this.now();
        const accountDaily = limits.daily[definition.id];
        limits.daily[definition.id] = { day: today,
          count: accountDaily?.day === today ? (Number(accountDaily.count) | 0) + 1 : 1 };
      }
      if (definition.reward.title && !profile.titles.includes(definition.reward.title)) {
        profile.titles.push(definition.reward.title); profile.titles.splice(0, Math.max(0, profile.titles.length - 64));
      }
      for (const unlock of definition.reward.unlocks) if (!profile.unlocks.includes(unlock)) profile.unlocks.push(unlock);
      profile.unlocks.splice(0, Math.max(0, profile.unlocks.length - 256));
      const grantedItems = [];
      for (const item of definition.reward.items) {
        if (Math.floor(this.random() * 1000) >= item.chancePermille) continue;
        if (!(mobile.backpack ?? mobile.equipment?.get?.(21))?.serial) {
          profile.pendingRewards.push({ ...item, systemId: definition.id, earnedAt: this.now() });
          profile.pendingRewards.splice(0, Math.max(0, profile.pendingRewards.length - MAX_PENDING_REWARDS));
          continue;
        }
        try {
          const created = this._createRewardItem(mobile, item, definition.id);
          if (created) grantedItems.push(created.name ?? item.name);
          else {
            profile.pendingRewards.push({ ...item, systemId: definition.id, earnedAt: this.now() });
            profile.pendingRewards.splice(0, Math.max(0, profile.pendingRewards.length - MAX_PENDING_REWARDS));
          }
        } catch (error) {
          profile.pendingRewards.push({ ...item, systemId: definition.id, earnedAt: this.now() });
          profile.pendingRewards.splice(0, Math.max(0, profile.pendingRewards.length - MAX_PENDING_REWARDS));
          this._history('reward-item-deferred', instance, mobile.serial, { id: item.id, error: String(error?.message ?? error) });
        }
      }
      mobile.client?.sendSystemMessage?.(`${definition.name} completed: ${gold} gold, ${tokens} activity tokens${grantedItems.length ? ` and ${grantedItems.join(', ')}` : ''} awarded.`);
      this._metric(definition.id, 'rewardsGranted');
      this._dirtyMobile(mobile);
    }
  }

  _history(kind, instance, actorSerial = 0, data = null) {
    this.history.push({ at: this.now(), kind, instanceId: instance.id, systemId: instance.systemId, actorSerial: Number(actorSerial) >>> 0, data });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
  }

  _settleWinner(instance, definition) {
    if (!['competition', 'pvp'].includes(definition.archetype) || definition.party.teams < 2) {
      instance.winnerTeam = 0;
      return 0;
    }
    const scores = instance.teamScores ?? [];
    const best = Math.max(0, ...scores);
    const winners = scores.map((score, index) => score === best ? index + 1 : 0).filter(Boolean);
    instance.winnerTeam = best > 0 && winners.length === 1 ? winners[0] : 0;
    return instance.winnerTeam;
  }

  _publishInstance(instance, reason) {
    for (const participant of instance.participants.values()) {
      const mobile = this.world.mobiles.get(participant.serial);
      const state = mobile?.client;
      if (state) this.publish(state, { operation: 'update', reason,
        instance: publicPlayerInstance(instance, this.definitionForInstance(instance), mobile) });
    }
  }

  _indexInstanceEvent(instance) {
    if (instance.status !== 'active') return;
    const stage = this.definitionForInstance(instance)?.stages?.[instance.stageIndex];
    if (!stage) return;
    let set = this.eventIndex.get(stage.event);
    if (!set) { set = new Set(); this.eventIndex.set(stage.event, set); }
    set.add(instance.id);
  }

  _dirtyMobile(mobile) {
    this.world.markEntityProperties?.(mobile, 'mobile');
  }

  _dirtyMeta() {
    this.world.mutationJournal?.markMetaDirty?.();
  }

  _metric(systemId, key, amount = 1) {
    if (!this.telemetry.has(systemId) && this.telemetry.size >= MAX_TELEMETRY_SYSTEMS) return;
    const row = this.telemetry.get(systemId) ?? { started: 0, joined: 0, left: 0, completed: 0, failed: 0,
      cancelled: 0, progress: 0, stagesCompleted: 0, actionsSucceeded: 0, actionsFailed: 0,
      specialCommands: 0, specialRejected: 0, duplicateEvents: 0, rateLimited: 0,
      invalidTransitions: 0,
      invalidEvents: 0, rewardsGranted: 0, rewardsWithheld: 0, lastUpdatedAt: 0 };
    row[key] = Math.max(0, (Number(row[key]) || 0) + amount);
    row.lastUpdatedAt = this.now();
    this.telemetry.set(systemId, row);
  }

  telemetrySnapshot(systemId = '') {
    const definitions = [...this.definitions.values()];
    const rows = definitions.filter((definition) => !systemId || definition.id === systemId).map((definition) => {
      const metrics = this.telemetry.get(definition.id) ?? {};
      const started = Number(metrics.started) || 0;
      const completed = Number(metrics.completed) || 0;
      return { systemId: definition.id, name: definition.name, version: definition.version, ...metrics,
        active: [...this.instances.values()].filter((entry) => entry.systemId === definition.id && !TERMINAL.has(entry.status)).length,
        completionRate: started ? Number((completed / started).toFixed(4)) : 0 };
    });
    return { ok: true, catalogRevision: this.catalogRevision, rows,
      adapters: this.adapters.diagnostics(definitions) };
  }

  _rebuildIndexes() {
    this.participantIndex.clear(); this.eventIndex.clear(); this.replayInstances.clear();
    for (const instance of this.instances.values()) {
      if (instance.systemId === 'chronicle-replays' && !TERMINAL.has(instance.status)) this.replayInstances.add(instance.id);
      this._indexInstanceEvent(instance);
      if (TERMINAL.has(instance.status)) continue;
      for (const serial of instance.participants.keys()) {
        let set = this.participantIndex.get(serial);
        if (!set) { set = new Set(); this.participantIndex.set(serial, set); }
        set.add(instance.id);
      }
    }
  }

  _installEventBridges() {
    for (const event of ['mobile:killed', 'combat:damage', 'speech', 'craft:completed', 'bod:turnedIn']) {
      this._unsubscribers.push(this.world.events?.on?.(event, (payload) => this.recordEvent(event, payload)) ?? (() => {}));
    }
  }

  _pruneInstances() {
    if (this.instances.size < MAX_INSTANCES) return;
    const removable = [...this.instances.values()].filter((entry) => TERMINAL.has(entry.status))
      .sort((a, b) => a.completedAt - b.completedAt);
    while (this.instances.size >= MAX_INSTANCES && removable.length) this.instances.delete(removable.shift().id);
    this._rebuildIndexes();
  }
}

export function createGameSystemRuntime(options) {
  return new GameSystemRuntime(options);
}
