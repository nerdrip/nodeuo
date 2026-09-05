// Player-facing entry point for the data-driven game-system catalog.
// Classic clients receive ordinary UO gumps and text. NodeUO peers receive
// the richer JSON workbench; gameplay remains server-authoritative in both.

const GUMP_ID = 0x4E554F47;
const PAGE_SIZE = 8;

function supportsEnhanced(api, state) {
  return !!state?.supportsNodeUO?.(api.nodeUO?.features?.GameSystems ?? 'game.systems');
}

function sendEnhanced(api, state, payload) {
  return api.nodeUO?.send?.(state, {
    feature: api.nodeUO?.features?.GameSystems ?? 'game.systems',
    namespace: 'nodeuo.game-systems',
    payload,
  }) ?? false;
}

function addText(lines, texts, x, y, hue, value) {
  texts.push(String(value ?? ''));
  lines.push(`{ text ${x} ${y} ${hue} ${texts.length - 1} }`);
}

function openList(api, state, page = 0, category = '') {
  const runtime = api.systems?.gameSystems;
  if (!runtime) { state.sendSystemMessage('Game systems are unavailable on this shard.'); return; }
  const systems = runtime.catalogSnapshot({ category }).systems;
  const maxPage = Math.max(0, Math.ceil(systems.length / PAGE_SIZE) - 1);
  const selectedPage = Math.max(0, Math.min(maxPage, page | 0));
  const rows = systems.slice(selectedPage * PAGE_SIZE, (selectedPage + 1) * PAGE_SIZE);
  const texts = [];
  const lines = ['{ page 0 }', '{ resizepic 0 0 5054 590 410 }', '{ checkertrans 12 12 566 386 }'];
  addText(lines, texts, 24, 16, 1153, 'NodeUO Activities');
  addText(lines, texts, 24, 38, 70,
    `Page ${selectedPage + 1}/${maxPage + 1} · ${systems.length} systems · [activity <id> for direct access`);
  rows.forEach((system, index) => {
    const y = 70 + index * 36;
    lines.push(`{ button 24 ${y} 4005 4007 1 0 ${100 + index} }`);
    addText(lines, texts, 58, y, system.clientMode === 'enhanced' ? 33 : 1152,
      `${system.name}  [${system.category}]`);
    addText(lines, texts, 58, y + 17, 70,
      system.clientMode === 'enhanced' ? 'NodeUO client required for this visual system.' : system.summary.slice(0, 75));
  });
  if (selectedPage > 0) {
    lines.push('{ button 24 365 4014 4016 1 0 10 }');
    addText(lines, texts, 58, 367, 1152, 'Previous');
  }
  if (selectedPage < maxPage) {
    lines.push('{ button 450 365 4005 4007 1 0 11 }');
    addText(lines, texts, 485, 367, 1152, 'Next');
  }
  lines.push('{ button 265 365 4017 4019 1 0 0 }');
  api.gumps.send(state, { gumpId: GUMP_ID, layout: lines.join(' '), texts }, (response) => {
    if (response.buttonId === 10) return openList(api, state, selectedPage - 1, category);
    if (response.buttonId === 11) return openList(api, state, selectedPage + 1, category);
    const system = rows[response.buttonId - 100];
    if (system) openDetail(api, state, system.id, selectedPage, category);
  });
}

function openLeaderboard(api, state, systemId, returnPage = 0, category = '') {
  const runtime = api.systems.gameSystems;
  const system = runtime.definition(systemId);
  if (!system) return openList(api, state, returnPage, category);
  const rows = runtime.leaderboard(systemId, 12);
  const texts = [];
  const lines = ['{ page 0 }', '{ resizepic 0 0 5054 480 350 }', '{ checkertrans 12 12 456 326 }'];
  addText(lines, texts, 24, 18, 1153, `${system.name} — leaderboard`);
  if (!rows.length) addText(lines, texts, 24, 55, 70, 'No recorded contributions yet.');
  rows.forEach((row, index) => addText(lines, texts, 30, 52 + index * 20, 1152,
    `${index + 1}. ${row.name} — ${row.score} points (${row.contributions} actions)`));
  lines.push('{ button 24 310 4014 4016 1 0 9 }');
  addText(lines, texts, 58, 312, 1152, 'Back');
  api.gumps.send(state, { gumpId: GUMP_ID, layout: lines.join(' '), texts }, () =>
    openDetail(api, state, systemId, returnPage, category));
}

function openDetail(api, state, systemId, returnPage = 0, category = '') {
  const runtime = api.systems?.gameSystems;
  const system = runtime?.definition(systemId);
  if (!system) { state.sendSystemMessage('Activity not found.'); return openList(api, state, returnPage, category); }
  const player = state.mobile;
  const active = runtime.instanceForPlayer(player, system.id)
    ?? runtime.joinableForSystem(system.id)
    ?? runtime.activeForSystem(system.id);
  const liveSystem = active ? runtime.definitionForInstance(active) : system;
  const joined = active?.participants?.has(player?.serial);
  const stage = active ? liveSystem.stages[active.stageIndex] : liveSystem.stages[0];
  const texts = [];
  const lines = ['{ page 0 }', '{ resizepic 0 0 5054 600 500 }', '{ checkertrans 12 12 576 476 }'];
  addText(lines, texts, 24, 16, 1153, system.name);
  addText(lines, texts, 24, 40, 70, `${system.category} · ${system.archetype} · difficulty ${system.difficulty}/10 · ${system.durationMinutes} min`);
  addText(lines, texts, 24, 68, 1152, system.summary);
  addText(lines, texts, 24, 105, 1153, active ? `Current stage ${active.stageIndex + 1}/${system.stages.length}` : 'Activity stages');
  liveSystem.stages.forEach((entry, index) => {
    const marker = active && index === active.stageIndex ? '▶' : index < (active?.stageIndex ?? 0) ? '✓' : '•';
    addText(lines, texts, 34, 126 + index * 14, index === active?.stageIndex ? 68 : 1152,
      `${marker} ${entry.name}${index === active?.stageIndex ? ` — ${active.progress}/${entry.goal}` : ''}`);
  });
  const controlsY = 300;
  if (system.clientMode === 'enhanced' && !supportsEnhanced(api, state)) {
    addText(lines, texts, 24, controlsY - 18, 33,
      'This system requires the NodeUO client. You can continue playing without it.');
  } else {
    if (!joined) {
      lines.push(`{ button 24 ${controlsY} 4005 4007 1 0 1 }`);
      addText(lines, texts, 58, controlsY + 2, 1152, 'Join / start');
    } else if (active.status === 'active') {
      if (stage?.allowManual) {
        (stage.actions?.length ? stage.actions : ['attempt']).forEach((action, index) => {
          const column = index & 1, row = index >> 1;
          const x = 24 + column * 275, y = controlsY + row * 30;
          lines.push(`{ button ${x} ${y} 4005 4007 1 0 ${20 + index} }`);
          const tactic = index === 0 ? 'execute' : index === 1 ? 'support' : 'prepare';
          addText(lines, texts, x + 34, y + 2, 1152, `${action} [${tactic}]`);
        });
      } else {
        addText(lines, texts, 24, controlsY - 18, 68, `World objective: ${stage?.description ?? stage?.name} [${stage?.event}]`);
      }
      lines.push('{ button 235 420 4017 4019 1 0 3 }');
      addText(lines, texts, 269, 422, 1152, 'Leave');
    } else {
      addText(lines, texts, 24, controlsY - 18, 68,
        `Waiting for ${Math.max(0, system.party.min - active.participants.size)} more player(s).`);
      lines.push(`{ button 235 ${controlsY} 4017 4019 1 0 3 }`);
      addText(lines, texts, 269, controlsY + 2, 1152, 'Leave');
    }
  }
  lines.push('{ button 390 420 4005 4007 1 0 4 }');
  addText(lines, texts, 424, 422, 1152, 'Leaderboard');
  lines.push('{ button 24 455 4014 4016 1 0 9 }');
  addText(lines, texts, 58, 457, 1152, 'Back to catalog');
  api.gumps.send(state, { gumpId: GUMP_ID, layout: lines.join(' '), texts }, (response) => {
    if (response.buttonId === 9 || response.buttonId === 0) return openList(api, state, returnPage, category);
    if (response.buttonId === 4) return openLeaderboard(api, state, system.id, returnPage, category);
    let result = null;
    if (response.buttonId === 1) result = runtime.join(player, system.id, { allowEnhanced: supportsEnhanced(api, state) });
    if (response.buttonId === 2) result = runtime.act(player, active?.id || system.id, stage?.actions?.[0]);
    if (response.buttonId >= 20 && response.buttonId < 28) {
      result = runtime.act(player, active?.id || system.id, stage?.actions?.[response.buttonId - 20]);
    }
    if (response.buttonId === 3) result = runtime.leave(player, active?.id || system.id);
    if (result && !result.ok) state.sendSystemMessage(result.error);
    openDetail(api, state, system.id, returnPage, category);
  });
}

function runCommand(api, ctx) {
  const runtime = api.systems?.gameSystems;
  if (!runtime) return ctx.state.sendSystemMessage('Game systems are unavailable on this shard.');
  const args = ctx.args ?? [];
  if (!args.length || args[0].toLowerCase() === 'open' || args[0].toLowerCase() === 'list') {
    if (supportsEnhanced(api, ctx.state)) {
      sendEnhanced(api, ctx.state, runtime.openSnapshot(ctx.sender));
      return;
    }
    openList(api, ctx.state);
    return;
  }
  const systemId = String(args[0]).toLowerCase();
  const system = runtime.definition(systemId);
  if (!system) return ctx.state.sendSystemMessage(`Unknown activity "${systemId}". Use [activities to browse.`);
  const action = String(args[1] ?? 'open').toLowerCase();
  if (action === 'open' || action === 'status') {
    if (supportsEnhanced(api, ctx.state)) sendEnhanced(api, ctx.state, runtime.openSnapshot(ctx.sender, { query: systemId }));
    else openDetail(api, ctx.state, system.id);
    return;
  }
  let result;
  if (action === 'join') result = runtime.join(ctx.sender, system.id, { allowEnhanced: supportsEnhanced(api, ctx.state) });
  else if (action === 'leave') result = runtime.leave(ctx.sender, system.id);
  else if (action === 'act' || action === 'attempt') result = runtime.act(ctx.sender, system.id, args[2]);
  else if (action === 'leaderboard') {
    const rows = runtime.leaderboard(system.id, 10);
    ctx.state.sendSystemMessage(`${system.name} leaderboard:`);
    rows.forEach((row, index) => ctx.state.sendSystemMessage(`${index + 1}. ${row.name}: ${row.score}`));
    return;
  } else return ctx.state.sendSystemMessage('Usage: [activity <id> [open|join|leave|act|leaderboard]');
  ctx.state.sendSystemMessage(result.ok ? (result.message ?? 'Activity updated.') : result.error);
}

export default function register(api) {
  api.commands.register({
    name: 'activities', aliases: ['activity', 'gamesystems', 'adventures'], access: 'Player',
    help: '[activities — browse and play server activities on Classic or NodeUO clients.',
    run: (ctx) => runCommand(api, ctx),
  });
  return () => api.commands.unregister?.('activities');
}
