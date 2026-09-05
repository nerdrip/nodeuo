// Server-authoritative mechanics used by activities that cannot be represented
// by a ClassicUO gump alone.  State is deliberately JSON-only so it can be
// persisted, inspected and migrated without executing client supplied code.

const MAX_TEXT = 160;
const MAX_CANVAS_SIDE = 32;
const MAX_ADVENTURE_NODES = 96;

function text(value, max = MAX_TEXT) { return String(value ?? '').trim().slice(0, max); }
function integer(value, min, max, fallback = min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}
function playerKey(mobile) { return String(Number(mobile?.serial) >>> 0); }

const CARDS = Object.freeze({
  strike: Object.freeze({ id: 'strike', name: 'Strike', cost: 1, damage: 2 }),
  guard: Object.freeze({ id: 'guard', name: 'Guard', cost: 1, armor: 2 }),
  bolt: Object.freeze({ id: 'bolt', name: 'Arcane Bolt', cost: 2, damage: 4 }),
  mend: Object.freeze({ id: 'mend', name: 'Mend', cost: 2, healing: 3 }),
  insight: Object.freeze({ id: 'insight', name: 'Insight', cost: 1, draw: 2 }),
  riposte: Object.freeze({ id: 'riposte', name: 'Riposte', cost: 2, armor: 2, damage: 2 }),
});
const STARTER_DECK = Object.freeze(['strike', 'strike', 'strike', 'guard', 'guard', 'bolt', 'mend', 'insight', 'riposte', 'strike']);

function shuffled(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cardPlayer(state, mobile) {
  const key = playerKey(mobile);
  state.players[key] ??= {
    name: text(mobile?.name, 64), health: 20, armor: 0, mana: 1,
    deckList: [...STARTER_DECK], deck: [], hand: [], discard: [], ready: false,
  };
  return state.players[key];
}

function drawCards(player, count, random) {
  for (let i = 0; i < count && player.hand.length < 8; i++) {
    if (!player.deck.length) {
      player.deck = shuffled(player.discard, random);
      player.discard = [];
    }
    const card = player.deck.shift();
    if (!card) break;
    player.hand.push(card);
  }
}

function cardGameCommand(ctx) {
  const { state, mobile, command, payload, random } = ctx;
  const actorKey = playerKey(mobile);
  const actor = cardPlayer(state, mobile);
  const keys = Object.keys(state.players);
  if (command === 'set-deck') {
    if (state.turn) return { ok: false, error: 'A running match cannot change decks.' };
    const cards = Array.isArray(payload?.cards) ? payload.cards.map((id) => text(id, 32).toLowerCase()) : [];
    if (cards.length < 10 || cards.length > 30) return { ok: false, error: 'A deck requires 10 to 30 cards.' };
    const copies = {};
    for (const id of cards) {
      if (!CARDS[id]) return { ok: false, error: `Unknown card: ${id}.` };
      copies[id] = (copies[id] ?? 0) + 1;
      if (copies[id] > 4) return { ok: false, error: `A deck may contain at most four copies of ${id}.` };
    }
    actor.deckList = cards; actor.ready = false;
    return { ok: true, contribution: 2, stageIndex: 0, message: `Deck validated with ${cards.length} cards.` };
  }
  if (command === 'ready') {
    if (!Array.isArray(actor.deckList) || actor.deckList.length < 10) return { ok: false, error: 'Build a valid deck first.' };
    actor.health = 20; actor.armor = 0; actor.mana = 1;
    actor.deck = shuffled(actor.deckList, random); actor.hand = []; actor.discard = [];
    actor.ready = true;
    if (!state.turn && keys.length >= 2 && keys.every((key) => state.players[key].ready)) {
      state.turn = keys[0]; state.round = 1;
      for (const player of Object.values(state.players)) drawCards(player, 5, random);
    }
    return { ok: true, advanceToStage: state.turn ? 1 : undefined,
      message: state.turn ? 'The match has begun.' : 'Ready; waiting for an opponent.' };
  }
  if (!state.turn) return { ok: false, error: 'Both players must be ready.' };
  if (state.turn !== actorKey) return { ok: false, error: 'It is not your turn.' };
  if (command === 'play-card') {
    const handIndex = integer(payload?.handIndex, 0, actor.hand.length - 1, -1);
    if (handIndex < 0 || !actor.hand[handIndex]) return { ok: false, error: 'Choose a card from your hand.' };
    const card = CARDS[actor.hand[handIndex]];
    if (!card || actor.mana < card.cost) return { ok: false, error: 'Not enough mana.' };
    const targetKey = text(payload?.targetSerial, 16) || keys.find((key) => key !== actorKey);
    const target = state.players[targetKey];
    if (!target) return { ok: false, error: 'Choose an opponent.' };
    actor.mana -= card.cost;
    actor.hand.splice(handIndex, 1); actor.discard.push(card.id);
    actor.armor += card.armor ?? 0;
    actor.health = Math.min(20, actor.health + (card.healing ?? 0));
    drawCards(actor, card.draw ?? 0, random);
    const damage = Math.max(0, (card.damage ?? 0) - target.armor);
    target.armor = Math.max(0, target.armor - (card.damage ?? 0));
    target.health = Math.max(0, target.health - damage);
    if (target.health === 0) {
      state.winner = actorKey; state.turn = '';
      return { ok: true, contribution: 100, completed: true, message: `${actor.name} won the card match.` };
    }
    return { ok: true, contribution: Math.max(1, damage), stageIndex: 1, message: `${card.name} resolved.` };
  }
  if (command === 'end-turn') {
    actor.armor = 0;
    const index = keys.indexOf(actorKey);
    state.turn = keys[(index + 1) % keys.length];
    if (state.turn === keys[0]) state.round++;
    const next = state.players[state.turn];
    next.mana = Math.min(10, Math.max(next.mana, Math.min(10, state.round)));
    drawCards(next, 1, random);
    return { ok: true, contribution: 1, stageIndex: 1, message: 'Turn ended.' };
  }
  return { ok: false, error: 'Unsupported card-game command.' };
}

function deckCommand({ state, mobile, command, payload, random }) {
  const key = playerKey(mobile);
  state.runs[key] ??= { health: 30, floor: 0, energy: 3, armor: 0, deck: [...STARTER_DECK], relics: [], encounter: null, cardRewards: [], restedLast: false };
  const run = state.runs[key];
  if (command === 'choose-card') {
    if (!run.cardRewards.length) return { ok: false, error: 'No card reward is waiting.' };
    const card = text(payload?.card, 32).toLowerCase();
    if (!run.cardRewards.includes(card)) return { ok: false, error: 'Choose one of the offered cards.' };
    if (run.deck.length >= 30) return { ok: false, error: 'The expedition deck is full.' };
    run.deck.push(card); run.cardRewards = [];
    return { ok: true, contribution: 2, advanceToStage: 1,
      message: `${CARDS[card].name} added to the expedition deck.` };
  }
  if (command === 'choose-route') {
    if (run.encounter) return { ok: false, error: 'Finish the current encounter first.' };
    if (run.cardRewards.length) return { ok: false, error: 'Choose the earned card before continuing.' };
    const route = ['battle', 'elite', 'rest'].includes(payload?.route) ? payload.route : 'battle';
    if (route === 'rest') {
      if (run.restedLast) return { ok: false, error: 'A combat route is required after resting.' };
      run.health = Math.min(30, run.health + 8);
      run.restedLast = true;
      return { ok: true, contribution: 3, stageIndex: 1, message: 'You recovered at a safe camp.' };
    }
    run.floor++; run.restedLast = false;
    run.encounter = { kind: route, health: route === 'elite' ? 20 + run.floor * 2 : 10 + run.floor, hand: shuffled(run.deck, random).slice(0, 5) };
    run.energy = 3; run.armor = 0;
    return { ok: true, contribution: 2, stageIndex: 1, message: `${route} encounter started.` };
  }
  if (command === 'play-card') {
    const encounter = run.encounter;
    if (!encounter) return { ok: false, error: 'Choose a route first.' };
    const index = integer(payload?.handIndex, 0, encounter.hand.length - 1, -1);
    const card = CARDS[encounter.hand[index]];
    if (!card || card.cost > run.energy) return { ok: false, error: 'Invalid card or insufficient energy.' };
    run.energy -= card.cost; encounter.hand.splice(index, 1);
    encounter.health = Math.max(0, encounter.health - (card.damage ?? 0));
    run.health = Math.min(30, run.health + (card.healing ?? 0));
    run.armor += card.armor ?? 0;
    if (encounter.health === 0) {
      const elite = encounter.kind === 'elite';
      run.encounter = null;
      if (elite && !run.relics.includes('vanguard-sigil')) run.relics.push('vanguard-sigil');
      if (run.floor >= 8) return { ok: true, contribution: 100, completed: true, message: 'The expedition was conquered.' };
      run.cardRewards = shuffled(Object.keys(CARDS), random).slice(0, 3);
      return { ok: true, contribution: elite ? 15 : 8, stageIndex: 1, message: 'Encounter cleared.' };
    }
    if (run.energy === 0 || encounter.hand.length === 0) {
      const incoming = Math.max(0, 4 + run.floor - run.armor);
      run.health = Math.max(0, run.health - incoming); run.energy = 3;
      run.armor = 0;
      encounter.hand = shuffled(run.deck, random).slice(0, 5);
      if (run.health === 0) { run.encounter = null; return { ok: true, failed: true, message: 'The expedition run ended.' }; }
    }
    return { ok: true, contribution: Math.max(1, card.damage ?? card.healing ?? 1), stageIndex: 1, message: `${card.name} played.` };
  }
  return { ok: false, error: 'Unsupported deckbuilding command.' };
}

function musicCommand({ state, mobile, command, payload }) {
  const key = playerKey(mobile);
  state.projects[key] ??= { tempo: 100, tracks: [{ instrument: 'lute', notes: [] }], performances: 0 };
  const project = state.projects[key];
  if (command === 'set-tempo') {
    project.tempo = integer(payload?.tempo, 40, 240, 100);
    return { ok: true, contribution: 1, stageIndex: 0, message: `Tempo set to ${project.tempo} BPM.` };
  }
  if (command === 'add-note') {
    const track = integer(payload?.track, 0, 7, 0);
    while (project.tracks.length <= track) project.tracks.push({ instrument: 'lute', notes: [] });
    const notes = project.tracks[track].notes;
    if (notes.length >= 256) return { ok: false, error: 'Track note limit reached.' };
    notes.push({ beat: integer(payload?.beat, 0, 255, 0), pitch: integer(payload?.pitch, 36, 96, 60), length: integer(payload?.length, 1, 16, 1) });
    notes.sort((a, b) => a.beat - b.beat || a.pitch - b.pitch);
    const noteCount = project.tracks.reduce((sum, row) => sum + row.notes.length, 0);
    return { ok: true, contribution: 1, stageIndex: 0,
      advanceToStage: noteCount >= 8 ? 1 : undefined, message: 'Note added.' };
  }
  if (command === 'set-instrument') {
    const track = integer(payload?.track, 0, 7, 0);
    while (project.tracks.length <= track) project.tracks.push({ instrument: 'lute', notes: [] });
    project.tracks[track].instrument = text(payload?.instrument || 'lute', 32).toLowerCase();
    return { ok: true, contribution: 1, stageIndex: 1, message: `Track ${track + 1} instrument updated.` };
  }
  if (command === 'clear-track') {
    const track = project.tracks[integer(payload?.track, 0, project.tracks.length - 1, -1)];
    if (!track) return { ok: false, error: 'Track not found.' };
    track.notes = [];
    return { ok: true, stageIndex: 0, message: 'Track cleared.' };
  }
  if (command === 'remove-note') {
    const track = project.tracks[integer(payload?.track, 0, project.tracks.length - 1, 0)];
    const index = integer(payload?.note, 0, (track?.notes.length ?? 0) - 1, -1);
    if (!track || index < 0) return { ok: false, error: 'Note not found.' };
    track.notes.splice(index, 1); return { ok: true, stageIndex: 0, message: 'Note removed.' };
  }
  if (command === 'perform') {
    const notes = project.tracks.reduce((sum, track) => sum + track.notes.length, 0);
    if (notes < 8) return { ok: false, error: 'Compose at least eight notes before performing.' };
    project.performances++;
    return { ok: true, contribution: Math.min(50, notes + project.tracks.length * 3), completed: true,
      message: `Performance completed with ${notes} notes.` };
  }
  return { ok: false, error: 'Unsupported music-studio command.' };
}

function paintingCommand({ state, mobile, command, payload }) {
  const key = playerKey(mobile);
  state.canvases[key] ??= { width: 16, height: 16, palette: [0, 1, 2, 3, 4, 5, 6, 7], pixels: {}, revision: 0, publishedRevision: -1 };
  const canvas = state.canvases[key];
  if (command === 'resize') {
    canvas.width = integer(payload?.width, 4, MAX_CANVAS_SIDE, 16);
    canvas.height = integer(payload?.height, 4, MAX_CANVAS_SIDE, 16);
    canvas.pixels = {}; canvas.revision++;
    return { ok: true, advanceToStage: 1, message: 'Canvas resized and cleared.' };
  }
  if (command === 'set-palette') {
    const colors = Array.isArray(payload?.colors) ? payload.colors.slice(0, 32)
      .map((color) => integer(color, 0, 0xffff, -1)).filter((color) => color >= 0) : [];
    if (colors.length < 2) return { ok: false, error: 'Choose at least two valid UO hues.' };
    canvas.palette = colors; canvas.revision++;
    for (const [pixel, color] of Object.entries(canvas.pixels)) if (color >= colors.length) delete canvas.pixels[pixel];
    return { ok: true, contribution: 1, advanceToStage: 1, message: `Palette updated with ${colors.length} colors.` };
  }
  if (command === 'paint') {
    const x = integer(payload?.x, 0, canvas.width - 1, -1);
    const y = integer(payload?.y, 0, canvas.height - 1, -1);
    const color = integer(payload?.color, 0, canvas.palette.length - 1, -1);
    if (x < 0 || y < 0 || color < 0) return { ok: false, error: 'Invalid pixel.' };
    const pixelKey = `${x},${y}`;
    if (color === 0) delete canvas.pixels[pixelKey]; else canvas.pixels[pixelKey] = color;
    canvas.revision++;
    return { ok: true, contribution: 1, stageIndex: 1, message: 'Canvas updated.' };
  }
  if (command === 'publish') {
    const used = Object.keys(canvas.pixels).length;
    if (used < 16) return { ok: false, error: 'Paint at least sixteen tiles before publishing.' };
    if (canvas.publishedRevision === canvas.revision) return { ok: false, error: 'Change the artwork before publishing another revision.' };
    canvas.publishedRevision = canvas.revision;
    return { ok: true, contribution: Math.min(100, used), completed: true,
      message: 'Artwork published to the shard gallery.' };
  }
  return { ok: false, error: 'Unsupported painting command.' };
}

function validateAdventure(project) {
  const errors = [];
  if (!project.start || !project.nodes[project.start]) errors.push('A valid start node is required.');
  const endings = Object.values(project.nodes).filter((node) => node.kind === 'ending');
  if (!endings.length) errors.push('At least one ending is required.');
  for (const node of Object.values(project.nodes)) {
    for (const next of node.next) if (!project.nodes[next]) errors.push(`${node.id} links to missing node ${next}.`);
  }
  if (project.start) {
    const visited = new Set(); const queue = [project.start];
    while (queue.length) {
      const id = queue.shift(); if (visited.has(id) || !project.nodes[id]) continue;
      visited.add(id); queue.push(...project.nodes[id].next);
    }
    for (const ending of endings) if (!visited.has(ending.id)) errors.push(`Ending ${ending.id} is unreachable.`);
  }
  return errors.slice(0, 32);
}

function adventureCommand({ state, mobile, command, payload }) {
  const key = playerKey(mobile);
  state.projects[key] ??= { title: 'Untitled Adventure', start: '', nodes: {}, revision: 0, publishedRevision: -1 };
  const project = state.projects[key];
  if (command === 'add-node') {
    if (Object.keys(project.nodes).length >= MAX_ADVENTURE_NODES) return { ok: false, error: 'Adventure node limit reached.' };
    const id = text(payload?.id, 32).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!id || project.nodes[id]) return { ok: false, error: 'Choose a unique node id.' };
    const kind = ['story', 'choice', 'combat', 'ending'].includes(payload?.kind) ? payload.kind : 'story';
    project.nodes[id] = { id, kind, title: text(payload?.title || id, 80), body: text(payload?.body, 1000), next: [] };
    if (!project.start) project.start = id;
    project.revision++;
    return { ok: true, contribution: 2, stageIndex: 0, message: 'Adventure node added.' };
  }
  if (command === 'edit-node') {
    const node = project.nodes[text(payload?.id, 32)];
    if (!node) return { ok: false, error: 'Adventure node not found.' };
    if (payload?.kind != null && ['story', 'choice', 'combat', 'ending'].includes(payload.kind)) node.kind = payload.kind;
    if (payload?.title != null) node.title = text(payload.title, 80);
    if (payload?.body != null) node.body = text(payload.body, 1000);
    project.revision++;
    return { ok: true, contribution: 1, stageIndex: 0, message: 'Adventure node updated.' };
  }
  if (command === 'delete-node') {
    const id = text(payload?.id, 32);
    if (!project.nodes[id]) return { ok: false, error: 'Adventure node not found.' };
    delete project.nodes[id];
    for (const node of Object.values(project.nodes)) node.next = node.next.filter((next) => next !== id);
    if (project.start === id) project.start = '';
    project.revision++;
    return { ok: true, stageIndex: 0, message: 'Adventure node deleted.' };
  }
  if (command === 'set-start') {
    const id = text(payload?.id, 32);
    if (!project.nodes[id]) return { ok: false, error: 'Adventure node not found.' };
    project.start = id; project.revision++;
    return { ok: true, contribution: 1, stageIndex: 0, message: 'Adventure start node updated.' };
  }
  if (command === 'connect') {
    const from = project.nodes[text(payload?.from, 32)];
    const to = project.nodes[text(payload?.to, 32)];
    if (!from || !to || from.id === to.id) return { ok: false, error: 'Choose two different existing nodes.' };
    if (!from.next.includes(to.id)) { from.next.push(to.id); project.revision++; }
    return { ok: true, contribution: 1, stageIndex: 0, message: 'Nodes connected.' };
  }
  if (command === 'validate') {
    const errors = validateAdventure(project);
    return errors.length ? { ok: false, error: errors.join(' ') }
      : { ok: true, advanceToStage: 2, message: 'Adventure graph is valid and ready to publish.' };
  }
  if (command === 'publish') {
    const errors = validateAdventure(project);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    if (project.publishedRevision === project.revision) return { ok: false, error: 'Change the adventure before publishing another revision.' };
    project.publishedRevision = project.revision;
    return { ok: true, contribution: Math.min(100, Object.keys(project.nodes).length * 4), completed: true,
      message: `Adventure revision ${project.publishedRevision} published.` };
  }
  return { ok: false, error: 'Unsupported adventure-authoring command.' };
}

function replayCommand({ state, mobile, command, payload, now }) {
  const key = playerKey(mobile);
  state.viewers[key] ??= { cursor: 0, speed: 1, viewpoint: 0, bookmarks: [] };
  const viewer = state.viewers[key];
  if (command === 'select-event') {
    if (!state.timeline.length) return { ok: false, error: 'No recorded event is available.' };
    viewer.cursor = integer(payload?.cursor, 0, state.timeline.length - 1, state.timeline.length - 1);
    viewer.selectedEvent = viewer.cursor;
    return { ok: true, advanceToStage: 1, message: 'Replay event selected.' };
  }
  if (command === 'publish') {
    if (!Number.isInteger(viewer.selectedEvent) || !viewer.bookmarks.length) {
      return { ok: false, error: 'Select an event and add at least one bookmark before publishing.' };
    }
    viewer.publishedAt = Number(now) || Date.now();
    return { ok: true, completed: true, message: 'Chronicle replay published.' };
  }
  const stageIndex = 1;
  if (command === 'seek') viewer.cursor = integer(payload?.cursor, 0, Math.max(0, state.timeline.length - 1), 0);
  else if (command === 'step') viewer.cursor = integer(viewer.cursor + integer(payload?.direction, -1, 1, 1), 0, Math.max(0, state.timeline.length - 1), 0);
  else if (command === 'speed') viewer.speed = [0.25, 0.5, 1, 2, 4].includes(Number(payload?.speed)) ? Number(payload.speed) : 1;
  else if (command === 'viewpoint') viewer.viewpoint = Number(payload?.serial) >>> 0;
  else if (command === 'bookmark') {
    if (viewer.bookmarks.length >= 32) viewer.bookmarks.shift();
    viewer.bookmarks.push({ cursor: viewer.cursor, label: text(payload?.label || `Moment ${viewer.cursor}`, 64) });
  } else return { ok: false, error: 'Unsupported replay command.' };
  return { ok: true, contribution: 1, stageIndex, message: 'Replay view updated.' };
}

const HANDLERS = Object.freeze({
  'collectible-card-game': cardGameCommand,
  'deckbuilding-expeditions': deckCommand,
  'music-studio': musicCommand,
  'painting-and-mosaics': paintingCommand,
  'player-authored-adventures': adventureCommand,
  'chronicle-replays': replayCommand,
});

export function createSpecializedState(systemId) {
  if (systemId === 'collectible-card-game') return { schema: 1, kind: 'card-game', players: {}, turn: '', round: 0, winner: '' };
  if (systemId === 'deckbuilding-expeditions') return { schema: 1, kind: 'deckbuilding', runs: {} };
  if (systemId === 'music-studio') return { schema: 1, kind: 'music-studio', projects: {} };
  if (systemId === 'painting-and-mosaics') return { schema: 1, kind: 'painting', canvases: {} };
  if (systemId === 'player-authored-adventures') return { schema: 1, kind: 'adventure-authoring', projects: {} };
  if (systemId === 'chronicle-replays') return { schema: 1, kind: 'replay', timeline: [], viewers: {} };
  return null;
}

export function specializedCommands(systemId) {
  const commands = {
    'collectible-card-game': ['set-deck', 'ready', 'play-card', 'end-turn'],
    'deckbuilding-expeditions': ['choose-route', 'play-card', 'choose-card'],
    'music-studio': ['set-tempo', 'set-instrument', 'add-note', 'remove-note', 'clear-track', 'perform'],
    'painting-and-mosaics': ['resize', 'set-palette', 'paint', 'publish'],
    'player-authored-adventures': ['add-node', 'edit-node', 'delete-node', 'set-start', 'connect', 'validate', 'publish'],
    'chronicle-replays': ['select-event', 'seek', 'step', 'speed', 'viewpoint', 'bookmark', 'publish'],
  };
  return commands[systemId] ?? [];
}

export function runSpecializedCommand(context) {
  const handler = HANDLERS[context?.systemId];
  if (!handler) return { ok: false, error: 'This activity has no specialized command engine.' };
  return handler(context);
}

/**
 * Drop participant-private state when a player explicitly leaves an activity.
 * Card matches need a stronger reset because a departed player may currently
 * own the turn; retaining that key would permanently deadlock a replacement.
 */
export function removeSpecializedParticipant(systemId, state, mobile) {
  if (!state) return false;
  const key = playerKey(mobile);
  if (systemId === 'collectible-card-game') {
    if (!state.players?.[key]) return false;
    delete state.players[key];
    state.turn = ''; state.round = 0; state.winner = '';
    for (const player of Object.values(state.players)) {
      player.health = 20; player.armor = 0; player.mana = 1;
      player.deck = []; player.hand = []; player.discard = []; player.ready = false;
    }
    return true;
  }
  const stores = {
    'deckbuilding-expeditions': state.runs,
    'music-studio': state.projects,
    'painting-and-mosaics': state.canvases,
    'player-authored-adventures': state.projects,
    'chronicle-replays': state.viewers,
  };
  const store = stores[systemId];
  if (!store?.[key]) return false;
  delete store[key];
  return true;
}

export function publicSpecializedState(systemId, state, mobile) {
  if (!state) return null;
  const key = playerKey(mobile);
  if (systemId === 'collectible-card-game') {
    return { kind: state.kind, turn: state.turn, round: state.round, winner: state.winner,
      player: state.players[key] ?? null,
      opponents: Object.entries(state.players).filter(([id]) => id !== key).map(([serial, player]) => ({ serial, name: player.name, health: player.health, armor: player.armor, handSize: player.hand.length })) };
  }
  if (systemId === 'deckbuilding-expeditions') return { kind: state.kind, run: state.runs[key] ?? null };
  if (systemId === 'music-studio') return { kind: state.kind, project: state.projects[key] ?? null };
  if (systemId === 'painting-and-mosaics') return { kind: state.kind, canvas: state.canvases[key] ?? null };
  if (systemId === 'player-authored-adventures') return { kind: state.kind, project: state.projects[key] ?? null };
  if (systemId === 'chronicle-replays') return { kind: state.kind, viewer: state.viewers[key] ?? null, timeline: state.timeline.slice(-256) };
  return null;
}

export function appendReplayEvent(state, event) {
  if (state?.kind !== 'replay') return;
  state.timeline.push(event);
  if (state.timeline.length > 2_048) state.timeline.splice(0, state.timeline.length - 2_048);
}

export const SPECIALIZED_SYSTEM_IDS = Object.freeze(new Set(Object.keys(HANDLERS)));
export const GAME_SYSTEM_CARDS = CARDS;
