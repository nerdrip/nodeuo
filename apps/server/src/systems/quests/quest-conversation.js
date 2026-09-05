// QuestConversation — branching NPC dialogue trees. ServUO scripts in
// `Engines/Quests/Conversation*.cs` represent each step as a class; we
// boil it down to a graph of nodes:
//
//   {
//     id,                    // unique within a quest
//     text,                  // body shown to the player
//     keywords?: ['help', 'job', 'orc']  // matches ascii speech
//     choices?: [{ key, text, next }]    // optional explicit choices
//     onEnter?: (ctx) => void            // side-effect (set state, give item)
//     terminal?: boolean                 // true = end of conversation
//   }
//
// The runtime picks `next` by:
//   1. an explicit choice the player typed/clicked,
//   2. the first keyword match in the player's speech,
//   3. the default `nextDefault` if no choice/keyword fits.
//
// State is per-(player, npc) on `state.questConvo[npcSerial]`.

const _conversations = new Map();

/** Register a conversation tree. `id` is the NPC kind (e.g. 'orc-quest-giver'). */
export function registerConversation(id, tree) {
  _conversations.set(id, tree);
}
export function getConversation(id) { return _conversations.get(id); }

function getNode(tree, nodeId) {
  return tree.nodes?.find((n) => n.id === nodeId);
}

function skillValue(player, skillId) {
  const raw = player?.skills?.[skillId] ?? player?.skills?.[String(skillId)] ?? 0;
  const value = Number(raw?.value ?? raw?.base ?? raw) || 0;
  return value > 120 ? value / 10 : value;
}

/**
 * Begin a conversation. Returns the entry node payload to render.
 * @param {{playerState:any, npc:any, kind:string}} ctx
 */
export function beginConversation(ctx) {
  const tree = _conversations.get(ctx.kind);
  if (!tree) return null;
  if (!ctx.playerState.questConvo) ctx.playerState.questConvo = {};
  ctx.playerState.questConvo[ctx.npc.serial] = { kind: ctx.kind, currentNode: tree.entry };
  const node = getNode(tree, tree.entry);
  if (node?.onEnter) { try { node.onEnter(ctx); } catch (e) { console.error('[convo]', e); } }
  return nodeToPayload(node);
}

/**
 * Advance the conversation in response to player input. `input` may be
 * a choice key or free-form speech (for keyword matching). Returns the
 * resulting node payload, or null if no match was found.
 */
export function advanceConversation({ playerState, npc, input }) {
  const session = playerState.questConvo?.[npc.serial];
  if (!session) return null;
  const tree = _conversations.get(session.kind);
  if (!tree) return null;
  const cur = getNode(tree, session.currentNode);
  if (!cur) return null;
  let nextId = null;

  // Explicit choice match.
  if (cur.choices?.length) {
    const choice = cur.choices.find((c) => c.key === input);
    if (choice) {
      const context = { playerState, npc, input, conversation: tree, node: cur };
      if (choice.skillCheck) {
        const check = choice.skillCheck;
        const skill = skillValue(playerState.mobile, check.skillId);
        const difficulty = Math.max(0, Math.min(120, Number(check.difficulty) || 0));
        const chance = Math.max(0.05, Math.min(0.95, (skill - difficulty + 50) / 100));
        const passed = Math.random() < chance;
        session.lastCheck = { skillId: check.skillId | 0, skill, difficulty, chance, passed };
        nextId = passed ? (choice.success ?? choice.next) : (choice.failure ?? choice.next);
      } else nextId = typeof choice.next === 'function' ? choice.next(context) : choice.next;
    }
  }
  // Keyword match (case-insensitive substring).
  if (!nextId && cur.keywords && typeof input === 'string') {
    const lower = input.toLowerCase();
    for (const k of cur.keywords) {
      if (lower.includes(k.toLowerCase())) {
        // Each keyword routes to a sibling-node named `${cur.id}:${k}`.
        nextId = `${cur.id}:${k}`;
        break;
      }
    }
  }
  if (!nextId) nextId = cur.nextDefault;
  if (!nextId) return null;
  const next = getNode(tree, nextId);
  if (!next) return null;
  session.currentNode = nextId;
  if (next.onEnter) {
    try { next.onEnter({ playerState, npc, input }); } catch (e) { console.error('[convo]', e); }
  }
  if (next.terminal) delete playerState.questConvo[npc.serial];
  return nodeToPayload(next);
}

function nodeToPayload(node) {
  if (!node) return null;
  return {
    id: node.id,
    text: node.text,
    speaker: node.speaker, expression: node.expression, voice: node.voice,
    portrait: node.portrait, rewards: node.rewards, tags: node.tags,
    choices: node.choices?.map(({ key, text, skillCheck, requiresSkill }) => ({
      key, text, skillCheck, requiresSkill,
    })) ?? [],
    terminal: !!node.terminal,
  };
}
