// Quest system — registry of named quests + per-player progress map.
//
// MVP: each quest has a unique id, a list of objectives (each tracking
// a `kind` and `target` count), and a reward block. Players carry an
// `activeQuests` array of `{ id, progress: { [objIdx]: count } }`.
// When the world reports an event (kill, gather, deliver) the quest
// runtime calls `notifyEvent(player, event)` to advance every active
// quest that listens for that event kind.

/**
 * @typedef {Object} QuestObjective
 * @property {string} kind          'kill' | 'gather' | 'visit' | 'deliver'
 * @property {string} target        creature kind / item template name / region tag
 * @property {number} count
 * @property {string} description
 */

/**
 * @typedef {Object} QuestDefinition
 * @property {string} id
 * @property {string} name
 * @property {string} giver         NPC name or behavior tag that offers it
 * @property {string} description
 * @property {QuestObjective[]} objectives
 * @property {{ gold:number, items?:{ template:string, amount?:number }[] }} reward
 */

/** @type {Map<string, QuestDefinition>} */
const QUESTS = new Map();

export function registerQuest(def) {
  if (!def?.id) throw new Error('quest needs id');
  QUESTS.set(def.id, def);
}
export function getQuest(id) { return QUESTS.get(id); }
export function allQuests() { return [...QUESTS.values()]; }

/**
 * Begin a quest for a player. Returns true when accepted, false if they
 * already had it or the id is unknown.
 */
export function acceptQuest(player, id) {
  if (!QUESTS.has(id)) return false;
  player.activeQuests ??= [];
  if (player.activeQuests.some((q) => q.id === id)) return false;
  player.activeQuests.push({ id, progress: {} });
  return true;
}

export function abandonQuest(player, id) {
  if (!player.activeQuests) return false;
  const i = player.activeQuests.findIndex((q) => q.id === id);
  if (i < 0) return false;
  player.activeQuests.splice(i, 1);
  return true;
}

/**
 * Apply an event to every active quest of `player` and resolve rewards
 * for any quest whose objectives are now complete. Returns an array of
 * `{ id, completed, message }` describing what changed.
 */
export function notifyEvent(player, event) {
  if (!player?.activeQuests || player.activeQuests.length === 0) return [];
  const reports = [];
  for (const q of [...player.activeQuests]) {
    const def = QUESTS.get(q.id);
    if (!def) continue;
    let changed = false;
    for (let i = 0; i < def.objectives.length; i++) {
      const obj = def.objectives[i];
      if (obj.kind !== event.kind) continue;
      // Match the event payload against whichever objective field
      // applies to this kind. Authors write `target` for slay,
      // `resource` for collect, `region` for visit, `npc` for talk.
      // notifyEvent callers pass `target` for all of them; we accept
      // any of the four objective field names so the chains JSON
      // can stay schema-pleasant.
      const wanted = obj.target ?? obj.resource ?? obj.region ?? obj.npc;
      if (wanted !== event.target) continue;
      const had = q.progress[i] ?? 0;
      const cap = obj.count ?? 1;
      if (had >= cap) continue;
      q.progress[i] = had + (event.amount ?? 1);
      changed = true;
    }
    if (!changed) continue;
    const completed = def.objectives.every((obj, i) => (q.progress[i] ?? 0) >= (obj.count ?? 1));
    reports.push({ id: q.id, completed, name: def.name });
  }
  return reports;
}

/** Drop the quest from the active list and surface its reward. Caller
 *  should hand the gold/items to the player's pack. */
export function completeQuest(player, id) {
  const def = QUESTS.get(id);
  if (!def) return null;
  abandonQuest(player, id);
  return def.reward;
}

// ============================================================================
// Conversation trees — multi-stage dialog for richer quest hand-offs.
//
// Each quest definition can carry a `dialog` field shaped like:
//
//   dialog: {
//     intro: { text: '...', options: [
//       { reply: 'tell me more', goto: 'tell_more' },
//       { reply: 'sure, I\'ll help', accept: true },
//       { reply: 'goodbye', exit: true },
//     ]},
//     tell_more: { text: '...', options: [...] },
//     stages: { 'in-progress': '...', 'completed': '...' },
//   }
//
// `runDialog(player, questId, nodeId)` resolves the current node:
//   - If the quest is unaccepted → start at `dialog.intro`.
//   - If accepted but not yet complete → return `dialog.stages['in-progress']`
//     when the player asks again.
//   - If all objectives done → return `dialog.stages.completed` plus a
//     reward dispenser.
//
// Selecting an option mutates state:
//   - `accept: true`  → acceptQuest + jump to `accepted` node (or exit).
//   - `complete: true` → completeQuest + jump to `done` node.
//   - `goto: 'nodeId'` → return next node text+options.
//   - `exit: true`     → close the dialog window.

export function getDialogNode(player, questId, nodeId = 'intro') {
  const def = QUESTS.get(questId);
  if (!def?.dialog) return null;
  const dialog = def.dialog;
  // Auto-routing — if the caller asked for `intro` but the player already
  // has the quest active, route to the in-progress / completed branch.
  if (nodeId === 'intro' && player?.activeQuests?.some((q) => q.id === questId)) {
    const completed = isComplete(player, questId);
    if (completed) return { ...(dialog.completed ?? { text: 'You\'ve done it. My thanks.' }), _route: 'completed' };
    return { ...(dialog.in_progress ?? dialog.inProgress ?? { text: 'Have you finished yet?' }), _route: 'in_progress' };
  }
  return dialog[nodeId] ?? null;
}

function isComplete(player, questId) {
  const def = QUESTS.get(questId);
  if (!def) return false;
  const q = player.activeQuests?.find((x) => x.id === questId);
  if (!q) return false;
  return def.objectives.every((obj, i) => (q.progress[i] ?? 0) >= obj.count);
}

/**
 * Apply a dialog choice. Returns:
 *   { next: nodeId, action?: 'accept'|'complete'|'exit', reward? }
 */
export function chooseDialogOption(player, questId, nodeId, optionIndex) {
  const def = QUESTS.get(questId);
  if (!def?.dialog) return null;
  const node = def.dialog[nodeId];
  if (!node?.options) return null;
  const opt = node.options[optionIndex | 0];
  if (!opt) return null;
  if (opt.exit) return { action: 'exit' };
  if (opt.accept) {
    const ok = acceptQuest(player, questId);
    return { action: ok ? 'accept' : 'duplicate', next: opt.goto ?? 'accepted' };
  }
  if (opt.complete) {
    if (!isComplete(player, questId)) return { action: 'incomplete', next: 'in_progress' };
    const reward = completeQuest(player, questId);
    return { action: 'complete', next: opt.goto ?? 'done', reward };
  }
  return { next: opt.goto ?? nodeId };
}
