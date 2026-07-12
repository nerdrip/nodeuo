import { adjustKarma, adjustFame } from '../../notoriety.js';
import { normalizeSkillValue } from '../../combat-formulas.js';

// MLQuests (Mondain's Legacy quest framework). Port of ServUO
// `Scripts/Services/MondainsLegacyQuests/` core scaffolding —
// BaseQuest.cs, Objectives, Rewards, BaseEscort.cs, NPC quest giver.
//
// We expose 5 objective types matching the most common ML quests:
//   slay      — kill N of <kind>
//   collect   — bring N of <itemType> to NPC
//   escort    — walk a quest NPC from <fromRegion> to <toRegion>
//   deliver   — give <itemType> to <recipient> NPC
//   talk      — speak <keyword> near <npcSerial>
//
// A quest is a JS object:
//   {
//     id, title, description,
//     giverKind,                // NPC kind that hands it out
//     objectives: [{type, ...args}],
//     rewards: [{type, ...args}],   // gold, item, fame, karma, skill
//     unique: false,             // can be retaken
//   }
//
// Player progress: `mob.mlQuests = [{ id, progress: {...}, acceptedAt }]`.

const _registry = new Map();

function normalizeQuest(def) {
  return Object.freeze({
    id: def.id,
    title: def.title ?? def.id,
    description: def.description ?? '',
    giverKind: def.giverKind ?? null,
    objectives: (def.objectives ?? []).map((o) => ({ ...o })),
    rewards: (def.rewards ?? []).map((r) => ({ ...r })),
    servuoClass: def.servuoClass ?? def.className ?? null,
    servuoClasses: Array.isArray(def.servuoClasses) ? def.servuoClasses.slice() : undefined,
    sourcePath: def.sourcePath ?? null,
    cliloc: def.cliloc ? { ...def.cliloc } : undefined,
    refuseCliloc: def.refuseCliloc ?? null,
    uncompleteCliloc: def.uncompleteCliloc ?? null,
    completeCliloc: def.completeCliloc ?? null,
    rewardChoices: (def.rewardChoices ?? []).map((r) => ({ ...r })),
    extracted: !!def.extracted,
    unique: !!def.unique,
  });
}

/** Register a quest definition. Throws on duplicate ID. */
export function registerQuest(def) {
  if (!def?.id) throw new Error('Quest needs an id');
  if (_registry.has(def.id)) throw new Error(`Duplicate quest id: ${def.id}`);
  _registry.set(def.id, normalizeQuest(def));
  return _registry.get(def.id);
}

/** Explicit authored override for a lower-fidelity extracted definition.
 * Kept separate from registerQuest so accidental duplicate IDs still fail. */
export function replaceQuest(def) {
  if (!def?.id) throw new Error('Quest needs an id');
  _registry.set(def.id, normalizeQuest(def));
  return _registry.get(def.id);
}

/** Lookup. */
export function getQuest(id) { return _registry.get(id) ?? null; }
export function listQuests() { return [..._registry.values()]; }

/** Begin `questId` for `mob`. Returns { ok, reason }. */
export function offer(mob, questId) {
  const def = getQuest(questId);
  if (!def) return { ok: false, reason: 'no-such-quest' };
  if (!mob.mlQuests) mob.mlQuests = [];
  const existing = mob.mlQuests.find((q) => q.id === questId);
  if (existing) {
    if (def.unique) return { ok: false, reason: 'already-completed' };
    if (!existing.completed) return { ok: false, reason: 'already-active' };
    // Unique=false → reset for replay.
    Object.assign(existing, _initProgress(def));
    return { ok: true, def };
  }
  mob.mlQuests.push({
    id: def.id,
    ..._initProgress(def),
    acceptedAt: Date.now(),
  });
  return { ok: true, def };
}

function _initProgress(def) {
  const progress = {};
  for (const o of def.objectives) {
    if (o.type === 'slay' || o.type === 'collect') progress[o.type + ':' + (o.kind ?? o.itemType)] = 0;
    else if (o.type === 'escort') progress.escort = false;
    else if (o.type === 'deliver') progress['deliver:' + (o.itemType ?? '?')] = false;
    else if (o.type === 'talk') progress['talk:' + (o.keyword ?? '?')] = false;
  }
  return { progress, completed: false };
}

/** Bump a `slay`/`collect` counter and check completion. */
export function trackKill(mob, kind) {
  if (!mob.mlQuests) return [];
  const advanced = [];
  for (const q of mob.mlQuests) {
    if (q.completed) continue;
    const def = getQuest(q.id);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'slay' || obj.kind !== kind) continue;
      const key = 'slay:' + kind;
      q.progress[key] = (q.progress[key] ?? 0) + 1;
      if (q.progress[key] >= (obj.count ?? 1)) advanced.push({ q, def, objective: obj });
      _maybeComplete(q, def);
    }
  }
  return advanced;
}

export function trackCollect(mob, itemType, amount = 1) {
  if (!mob.mlQuests) return [];
  const out = [];
  for (const q of mob.mlQuests) {
    if (q.completed) continue;
    const def = getQuest(q.id);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'collect' || obj.itemType !== itemType) continue;
      const key = 'collect:' + itemType;
      q.progress[key] = Math.min(obj.count ?? 1, (q.progress[key] ?? 0) + amount);
      _maybeComplete(q, def);
      out.push({ q, def });
    }
  }
  return out;
}

export function trackTalk(mob, npcSerial, keyword) {
  if (!mob.mlQuests) return [];
  const out = [];
  for (const q of mob.mlQuests) {
    if (q.completed) continue;
    const def = getQuest(q.id);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'talk') continue;
      if (obj.npcSerial && obj.npcSerial !== npcSerial) continue;
      if (obj.keyword && obj.keyword !== keyword) continue;
      q.progress['talk:' + (obj.keyword ?? '?')] = true;
      _maybeComplete(q, def);
      out.push({ q, def });
    }
  }
  return out;
}

export function trackEscortArrive(mob, region) {
  if (!mob.mlQuests) return [];
  const out = [];
  for (const q of mob.mlQuests) {
    if (q.completed) continue;
    const def = getQuest(q.id);
    if (!def) continue;
    for (const obj of def.objectives) {
      if (obj.type !== 'escort' || obj.toRegion !== region) continue;
      q.progress.escort = true;
      _maybeComplete(q, def);
      out.push({ q, def });
    }
  }
  return out;
}

function _maybeComplete(q, def) {
  for (const obj of def.objectives) {
    if (obj.type === 'slay') {
      const key = 'slay:' + obj.kind;
      if ((q.progress[key] ?? 0) < (obj.count ?? 1)) return;
    } else if (obj.type === 'collect') {
      const key = 'collect:' + obj.itemType;
      if ((q.progress[key] ?? 0) < (obj.count ?? 1)) return;
    } else if (obj.type === 'escort') {
      if (!q.progress.escort) return;
    } else if (obj.type === 'deliver') {
      if (!q.progress['deliver:' + obj.itemType]) return;
    } else if (obj.type === 'talk') {
      if (!q.progress['talk:' + (obj.keyword ?? '?')]) return;
    }
  }
  q.completed = true;
  q.completedAt = Date.now();
}

/** Hand-in: applies rewards to mob. Returns rewards delivered, or [] if
 *  the quest isn't completed yet. */
export function turnIn(mob, questId) {
  if (!mob.mlQuests) return [];
  const q = mob.mlQuests.find((x) => x.id === questId);
  if (!q || !q.completed || q.turnedIn) return [];
  const def = getQuest(questId);
  if (!def) return [];
  for (const r of def.rewards) {
    switch (r.type) {
      case 'gold': mob.gold = (mob.gold ?? 0) + (r.amount ?? 0); break;
      case 'fame': adjustFame(mob, r.amount ?? 0); break;
      case 'karma': adjustKarma(mob, r.amount ?? 0); break;
      case 'skill': {
        const id = r.skillId | 0;
        const cap = r.cap ?? 100;
        const skills = mob.skills ?? {};
        const cur = normalizeSkillValue(skills[id] ?? skills[String(id)] ?? 0);
        if (cur < cap) {
          mob.skills ??= {};
          mob.skills[id] = Math.min(cap, cur + (r.amount ?? 0));
        }
        break;
      }
      case 'mastery': {
        // Unlock a Skill Mastery / Bard Mastery for the player. We
        // record it on the mob so the mastery cast path (cast.js) can
        // gate access. ServUO uses `Mobile.MasteryInfo`; we model a
        // flat Set keyed by `<school>:<spell>`.
        mob.masteryUnlocked ??= new Set();
        if (Array.isArray(mob.masteryUnlocked)) mob.masteryUnlocked = new Set(mob.masteryUnlocked);
        const tag = `${r.school ?? 'bard'}:${(r.spell ?? '').toLowerCase()}`;
        mob.masteryUnlocked.add(tag);
        break;
      }
      case 'virtue': {
        // Bump a virtue track. Virtues system reads `mob.virtues[name]`.
        mob.virtues ??= {};
        const v = (mob.virtues[r.virtue] ?? 0) + (r.amount ?? 0);
        mob.virtues[r.virtue] = Math.min(20000, v);
        break;
      }
      // 'item' reward is delivered through the item factory by the caller.
    }
  }
  q.turnedIn = true;
  q.turnedInAt = Date.now();
  return def.rewards.slice();
}

/** Drop a quest from the player's log. */
export function abandon(mob, questId) {
  if (!mob.mlQuests) return false;
  const idx = mob.mlQuests.findIndex((x) => x.id === questId);
  if (idx < 0) return false;
  mob.mlQuests.splice(idx, 1);
  return true;
}

/** Clear (tests). */
export function clearAll() { _registry.clear(); }

// ---- Default escort framework ---------------------------------------------
//
// `BaseEscort.cs` in ServUO ships a generic NPC that follows the player
// from one region to another and rewards on arrival. We expose a helper
// to register an escort quest in two lines.

// ---- Turn-in gump --------------------------------------------------------
//
// ServUO `MondainQuestGump` opens when a player double-clicks the quest
// NPC after completing objectives. It lists rewards (some are choice-only,
// e.g. "pick one weapon or one armor") and a Confirm/Decline button.
// Quest defs may declare `rewardChoices: [{ key, label, item: {...} }]`
// — gump rendering surfaces a radio list; selection drives `turnIn`.

/** Build a layout string for the turn-in gump. */
export function buildTurnInGump(def, _q) {
  const lines = [];
  lines.push('{ resizepic 0 0 5054 400 280 }');
  lines.push(`{ text 20 14 1153 0 }`);          // title
  lines.push(`{ text 20 36 1152 1 }`);          // description
  const rewardSummary = (def.rewards ?? [])
    .map((r) => r.type === 'gold' ? `${r.amount}gp`
              : r.type === 'fame' ? `+${r.amount} fame`
              : r.type === 'karma' ? `+${r.amount} karma`
              : r.type === 'skill' ? `+${r.amount} skill #${r.skillId}`
              : r.type ?? '?').join(', ');
  lines.push(`{ text 20 80 1149 2 }`);          // "Rewards:"
  lines.push(`{ text 20 102 1149 3 }`);
  // Reward choices (radio list)
  let y = 130;
  const choices = def.rewardChoices ?? [];
  for (let i = 0; i < choices.length; i++) {
    lines.push(`{ radio 20 ${y} 9720 9721 ${i === 0 ? 1 : 0} ${100 + i} }`);
    lines.push(`{ text 50 ${y + 2} 1149 ${4 + i} }`);
    y += 24;
  }
  // Buttons
  lines.push(`{ button 240 240 4023 4024 1 0 1 }`);  // Confirm
  lines.push(`{ button 320 240 4017 4018 1 0 2 }`);  // Decline
  const texts = [
    def.title,
    def.description ?? '',
    'Rewards:',
    rewardSummary,
    ...choices.map((c) => c.label || c.key),
  ];
  return { layout: lines.join(' '), texts };
}

/** Open the turn-in gump for a player. Caller passes the netcode
 *  `gumps.send(state, gump, cb)` reference so we don't import the
 *  net layer from here. */
export function openTurnInGump(gumps, state, mob, questId) {
  const q = mob.mlQuests?.find((x) => x.id === questId);
  if (!q || !q.completed || q.turnedIn) return false;
  const def = getQuest(questId);
  if (!def) return false;
  const gump = buildTurnInGump(def, q);
  gumps.send(state, gump, (resp) => {
    if (resp.buttonId !== 1) return; // declined
    let chosenKey = null;
    if (def.rewardChoices?.length) {
      // Find the first switch that was selected; gump radio switches
      // carry switchIDs 100..100+N.
      const sw = resp.switches.find((s) => s >= 100);
      if (sw != null) chosenKey = def.rewardChoices[sw - 100]?.key ?? null;
    }
    const rewards = turnIn(mob, questId);
    if (chosenKey) {
      mob.client?.sendSystemMessage?.(`You chose: ${chosenKey}.`);
      // Spawning of the chosen item is left to the caller — we record
      // the choice on the quest entry for downstream handlers.
      q.rewardChoice = chosenKey;
    }
    if (rewards.length) {
      mob.client?.sendSystemMessage?.(`Quest "${def.title}" complete!`);
    }
  });
  return true;
}

export function registerEscort({
  id,
  title,
  npcKind,
  fromRegion,
  toRegion,
  goldReward = 500,
  fameReward = 250,
  rewards = null,
  unique = false,
  replace = false,
}) {
  const defaultRewards = [];
  if ((goldReward ?? 0) > 0) defaultRewards.push({ type: 'gold', amount: goldReward });
  if ((fameReward ?? 0) > 0) defaultRewards.push({ type: 'fame', amount: fameReward });
  return (replace ? replaceQuest : registerQuest)({
    id,
    title: title ?? `Escort ${npcKind}`,
    description: `Escort ${npcKind} from ${fromRegion} to ${toRegion}.`,
    giverKind: npcKind,
    objectives: [{ type: 'escort', fromRegion, toRegion }],
    rewards: rewards ?? defaultRewards,
    unique,
  });
}
