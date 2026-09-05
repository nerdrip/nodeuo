import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { ColorBox } from '../controls/color-box.js';
import { TextInput } from '../controls/text-input.js';
import { requestNodeUOGameSystems } from '../../net/nodeuo-services.js';
import { net } from '../../net/net-client.js';
import { world } from '../../world/world.js';

const WIDTH = 850;
const HEIGHT = 520;
const ROW_HEIGHT = 31;

function screenPosition() {
  return {
    x: Math.max(12, Math.round(((globalThis.innerWidth || 1100) - WIDTH) / 2)),
    y: Math.max(12, Math.round(((globalThis.innerHeight || 760) - HEIGHT) / 2)),
  };
}

function percent(progress, goal) {
  return goal > 0 ? Math.max(0, Math.min(100, Math.round(progress * 100 / goal))) : 0;
}

export class GameSystemsGump extends WindowGump {
  constructor(payload = {}) {
    const pos = screenPosition();
    super({ title: 'Activities & Adventures', width: WIDTH, height: HEIGHT, x: pos.x, y: pos.y });
    this._payload = payload;
    this._bg.setLayoutId('window-background');
    this._title.setLayoutId('window-title');
    this._systems = Array.isArray(payload.systems) ? payload.systems : [];
    this._live = Array.isArray(payload.live) ? payload.live : [];
    this._instances = Array.isArray(payload.instances) ? payload.instances : [];
    this._selectedId = this._instances[0]?.systemId ?? this._systems[0]?.id ?? '';
    this._systemControls = [];
    this._detailControls = [];

    this._add(new ColorBox({ width: 818, height: 464, color: 0x0c1118, alpha: 0.95, borderColor: 0x6387a8 }), 'surface', 16, 38);
    this._search = new TextInput({ width: 270, height: 25, maxLength: 96, placeholder: 'Filter 100 systems…', fontSize: 11 });
    this._search.onChange = () => this._renderCatalog();
    this._add(this._search, 'search', 28, 50);
    this._summary = this._add(new Label('', { fontSize: 10, hue: 0xaac7dd }), 'summary', 28, 82);
    this._catalog = this._add(new ScrollArea({ width: 300, height: 380 }), 'catalog', 28, 105);
    this._detailPanel = this._add(new ColorBox({ width: 492, height: 435, color: 0x151d27, alpha: 0.96, borderColor: 0x496782 }), 'detail-panel', 330, 50);
    this._name = this._add(new Label('', { fontSize: 18, hue: 0xffd77d, fontWeight: 700, maxWidth: 450 }), 'system-name', 348, 67);
    this._meta = this._add(new Label('', { fontSize: 10, hue: 0xaac7dd, maxWidth: 450 }), 'system-meta', 348, 94);
    this._description = this._add(new Label('', { fontSize: 12, hue: 0xe7edf4, maxWidth: 450, wordWrap: true, lineHeight: 17 }), 'system-description', 348, 120);
    this._stage = this._add(new Label('', { fontSize: 12, hue: 0xb8d98b, maxWidth: 450, wordWrap: true, lineHeight: 18 }), 'system-stage', 348, 195);
    this._participants = this._add(new Label('', { fontSize: 10, hue: 0xaac7dd, maxWidth: 450, wordWrap: true, lineHeight: 16 }), 'participants', 348, 310);
    this._specialHelp = this._add(new Label('', { fontSize: 10, hue: 0xc6a7ff, maxWidth: 450 }), 'special-help', 348, 347);
    this._specialData = this._add(new TextInput({ width: 450, height: 25, maxLength: 512,
      placeholder: 'Optional advanced JSON override', fontSize: 10 }), 'special-data', 348, 368);
    this._status = this._add(new Label('', { fontSize: 10, hue: 0xe1ba69, maxWidth: 450 }), 'status', 348, 455);
    this._renderCatalog();
    this._renderDetail();
  }

  get type() { return 'game-systems'; }
  get positionKey() { return 'game-systems'; }

  _add(control, id, x, y) {
    control.setLayoutId(id); control.setPosition(x, y); this.add(control); return control;
  }

  applyMessage(payload = {}) {
    if (payload.operation === 'update' && payload.instance) {
      const index = this._instances.findIndex((entry) => entry.id === payload.instance.id);
      if (index >= 0) this._instances[index] = payload.instance;
      else this._instances.push(payload.instance);
      const liveIndex = this._live.findIndex((entry) => entry.id === payload.instance.id);
      if (['completed', 'failed', 'cancelled'].includes(payload.instance.status)) {
        if (liveIndex >= 0) this._live.splice(liveIndex, 1);
      } else if (liveIndex >= 0) this._live[liveIndex] = payload.instance;
      else this._live.push(payload.instance);
      this._status.setText(`Server update: ${String(payload.reason ?? 'state changed').replaceAll('-', ' ')}`);
    } else {
      if (Array.isArray(payload.systems)) this._systems = payload.systems;
      if (Array.isArray(payload.live)) this._live = payload.live;
      if (Array.isArray(payload.instances)) this._instances = payload.instances;
      if (payload.profile) this._payload.profile = payload.profile;
    }
    this._renderCatalog(); this._renderDetail();
  }

  _filtered() {
    const query = String(this._search?.value ?? '').trim().toLowerCase();
    return this._systems.filter((system) => !query
      || `${system.name} ${system.id} ${system.category} ${system.summary}`.toLowerCase().includes(query));
  }

  _renderCatalog() {
    this._catalog.beginBulkUpdate?.();
    for (const control of this._systemControls) { this._catalog.remove(control); control.dispose?.(); }
    this._systemControls.length = 0;
    const rows = this._filtered();
    this._summary.setText(`${rows.length}/${this._systems.length} systems · ${this._live.length} live · ${this._payload.profile?.tokens ?? 0} tokens`);
    let y = 0;
    for (const system of rows) {
      const joined = this._instances.some((entry) => entry.systemId === system.id && !['completed', 'failed', 'cancelled'].includes(entry.status));
      const live = this._live.some((entry) => entry.systemId === system.id);
      const button = new Button({
        normalGumpId: 0, pressedGumpId: 0, flat: true, width: 276, height: ROW_HEIGHT - 3,
        label: `${joined ? '◆' : live ? '◇' : '·'} ${system.name}  [${system.category}]`,
        action: ButtonAction.Activate,
      });
      button.setPosition(0, y); button.setLayoutId(`system-${system.id}`);
      button.onClick = () => { this._selectedId = system.id; this._specialCommandIndex = 0; this._actionIndex = 0; this._renderDetail(); };
      this._catalog.add(button); this._systemControls.push(button); y += ROW_HEIGHT;
    }
    this._catalog.endBulkUpdate?.(); this._catalog.setContentHeight(y); this._catalog.scrollTo?.(0);
  }

  _clearDetailButtons() {
    for (const control of this._detailControls) { this.remove(control); control.dispose?.(); }
    this._detailControls.length = 0;
  }

  _detailButton(label, x, action, y = 405, width = 135) {
    const button = new Button({ normalGumpId: 0, pressedGumpId: 0, flat: true,
      width, height: 28, label, action: ButtonAction.Activate });
    button.setPosition(x, y); button.onClick = action; this.add(button); this._detailControls.push(button);
    return button;
  }

  _renderDetail() {
    this._clearDetailButtons();
    const system = this._systems.find((entry) => entry.id === this._selectedId);
    this._specialHelp.node.visible = false;
    this._specialData.node.visible = false;
    if (!system) {
      this._name.setText('No activity selected'); this._meta.setText(''); this._description.setText('');
      this._stage.setText(''); this._participants.setText(''); return;
    }
    const instance = this._instances.find((entry) => entry.systemId === system.id
      && !['completed', 'failed', 'cancelled'].includes(entry.status))
      ?? this._live.find((entry) => entry.systemId === system.id);
    this._name.setText(system.name);
    this._meta.setText(`${system.category} · ${system.archetype} · difficulty ${system.difficulty}/10 · ${system.durationMinutes} min · ${system.clientMode}`);
    this._description.setText(system.summary);
    const stage = instance?.stage ?? system.stages?.[0];
    const stageLines = (system.stages ?? []).map((entry, index) => {
      const marker = instance && index === instance.stageIndex ? '▶' : index < (instance?.stageIndex ?? 0) ? '✓' : '·';
      return `${marker} ${entry.name}${index === instance?.stageIndex ? ` — ${instance.progress}/${entry.goal} (${percent(instance.progress, entry.goal)}%)` : ''}`;
    });
    this._stage.setText(stageLines.join('\n'));
    const participantRows = instance?.participants ?? [];
    const enhancedSummary = summarizeSpecialState(instance?.specialState);
    const teamSummary = (instance?.teamScores?.length ?? 0) > 1
      ? `\nTeams: ${instance.teamScores.map((score, index) => `${index + 1}:${score}`).join(' · ')}${instance.winnerTeam ? ` · winner ${instance.winnerTeam}` : ''}` : '';
    this._participants.setText(instance
      ? `${instance.status.toUpperCase()} · ${participantRows.length}/${system.party.max} players${teamSummary}\n${participantRows.slice(0, 8).map((row) => `${row.name}: ${row.score} · T${row.team} · focus ${row.focus ?? 0} · streak ${row.streak ?? 0}`).join(' | ')}${enhancedSummary ? `\n${enhancedSummary}` : ''}`
      : `No live instance · party ${system.party.min}-${system.party.max} · reward ${system.reward.gold} gold + ${system.reward.tokens} tokens`);
    const joined = (instance?.participants ?? []).some((entry) => entry.serial === worldPlayerSerial());
    if (!instance || !joined) {
      this._detailButton('Join / start', 348, () => this._request('join', { systemId: system.id }));
    } else {
      if (instance.status === 'active' && system.specializedCommands?.length) {
        const commandIndex = Math.min(this._specialCommandIndex ?? 0, system.specializedCommands.length - 1);
        const command = system.specializedCommands[commandIndex];
        this._specialHelp.setText(`Enhanced engine · ${commandIndex + 1}/${system.specializedCommands.length} · ${command} · blank input uses safe suggested values`);
        this._specialHelp.node.visible = true; this._specialData.node.visible = true;
        this._specialData.placeholder = specialPlaceholder(command);
        this._detailButton(`Run ${command}`, 348, () => this._specialRequest(instance, command), 405, 210);
        this._detailButton('Next command', 568, () => {
          this._specialCommandIndex = (commandIndex + 1) % system.specializedCommands.length;
          this._specialData.setValue('', { silent: true }); this._renderDetail();
        }, 405, 110);
      } else if (instance.status === 'active' && stage?.allowManual !== false) {
        const actions = stage?.actions?.length ? stage.actions : ['attempt'];
        const actionIndex = Math.min(this._actionIndex ?? 0, actions.length - 1);
        const action = actions[actionIndex];
        const tactic = actionIndex === 0 ? 'execute: highest progress, uses focus'
          : actionIndex === 1 ? 'support: builds team momentum' : 'prepare: half stamina, builds focus';
        this._specialHelp.setText(`Stage action · ${actionIndex + 1}/${actions.length} · ${action} · ${tactic}`);
        this._specialHelp.node.visible = true;
        this._detailButton(`Run ${action}`, 348,
          () => this._request('action', { instanceId: instance.id, actionId: action }), 405, 210);
        if (actions.length > 1) this._detailButton('Next action', 568, () => {
          this._actionIndex = (actionIndex + 1) % actions.length; this._renderDetail();
        }, 405, 110);
      } else if (instance.status === 'active') {
        this._status.setText(`World objective: ${stage?.description ?? stage?.name} [${stage?.event}]`);
      } else {
        this._status.setText(`Waiting for ${Math.max(0, system.party.min - participantRows.length)} more player(s).`);
      }
      if (!system.specializedCommands?.length) this._detailButton('Leave', 688, () => this._request('leave', { instanceId: instance.id }), 405, 110);
      else this._detailButton('Leave', 688, () => this._request('leave', { instanceId: instance.id }), 405, 110);
    }
    if (!joined) this._detailButton('Leaderboard', 638, () => this._request('leaderboard', { systemId: system.id, limit: 12 }));
  }

  async _request(operation, options) {
    this._status.setText(`${operation}…`);
    try {
      const result = await requestNodeUOGameSystems(net, operation, options);
      if (!result?.ok) throw new Error(result?.error ?? 'Activity request failed.');
      if (result.instance) this.applyMessage({ operation: 'update', reason: operation, instance: result.instance });
      if (result.leaderboard) this._participants.setText(result.leaderboard.length
        ? result.leaderboard.map((row, index) => `${index + 1}. ${row.name} — ${row.score}`).join('\n')
        : 'No leaderboard entries yet.');
      this._status.setText(result.message ?? `${operation} completed.`);
    } catch (error) { this._status.setText(error?.message ?? 'Activity request failed.'); }
  }

  async _specialRequest(instance, command) {
    let data = specialDefaultData(command, instance?.specialState);
    const raw = String(this._specialData.value ?? '').trim();
    try { if (raw) data = { ...data, ...JSON.parse(raw) }; }
    catch { this._status.setText('Enhanced command data must be valid JSON.'); return; }
    await this._request('special', { instanceId: instance.id, command, data });
  }

  dispose() { super.dispose(); }
}

function specialPlaceholder(command) {
  const examples = {
    'set-deck': '{"cards":["strike","strike","strike","strike","guard","guard","bolt","mend","insight","riposte"]}',
    'play-card': '{"handIndex":0,"targetSerial":"123"}',
    'choose-route': '{"route":"battle"}',
    'choose-card': '{"card":"bolt"}',
    'set-tempo': '{"tempo":120}',
    'set-instrument': '{"track":0,"instrument":"harp"}',
    'add-note': '{"track":0,"beat":0,"pitch":60,"length":1}',
    'remove-note': '{"track":0,"note":0}',
    'clear-track': '{"track":0}',
    resize: '{"width":16,"height":16}',
    'set-palette': '{"colors":[0,33,68,88,115,130]}',
    paint: '{"x":0,"y":0,"color":1}',
    'add-node': '{"id":"start","kind":"story","title":"Arrival"}',
    'edit-node': '{"id":"start","title":"New title","body":"Story text"}',
    'delete-node': '{"id":"unused"}',
    'set-start': '{"id":"start"}',
    connect: '{"from":"start","to":"ending"}',
    validate: '{}', publish: '{}',
    'select-event': '{"cursor":0}',
    seek: '{"cursor":0}', step: '{"direction":1}', speed: '{"speed":2}', viewpoint: '{"serial":123}',
    bookmark: '{"label":"Boss defeated"}',
  };
  return examples[command] ?? '{}';
}

function specialDefaultData(command, state) {
  const projectNodes = Object.keys(state?.project?.nodes ?? {});
  const painted = state?.canvas?.pixels ?? {};
  const blankPixel = (() => {
    const width = state?.canvas?.width ?? 16, height = state?.canvas?.height ?? 16;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!Object.hasOwn(painted, `${x},${y}`)) return { x, y };
    }
    return { x: 0, y: 0 };
  })();
  const noteCount = state?.project?.tracks?.[0]?.notes?.length ?? 0;
  const defaults = {
    'set-deck': { cards: ['strike', 'strike', 'strike', 'strike', 'guard', 'guard', 'bolt', 'mend', 'insight', 'riposte'] },
    'play-card': { handIndex: 0, ...(state?.opponents?.[0]?.serial ? { targetSerial: state.opponents[0].serial } : {}) },
    'choose-route': { route: 'battle' },
    'choose-card': { card: state?.run?.cardRewards?.[0] ?? 'strike' },
    'set-tempo': { tempo: state?.project?.tempo ?? 120 },
    'set-instrument': { track: 0, instrument: state?.project?.tracks?.[0]?.instrument ?? 'lute' },
    'add-note': { track: 0, beat: noteCount, pitch: 60 + (noteCount % 12), length: 1 },
    'remove-note': { track: 0, note: Math.max(0, noteCount - 1) },
    'clear-track': { track: 0 },
    resize: { width: state?.canvas?.width ?? 16, height: state?.canvas?.height ?? 16 },
    'set-palette': { colors: state?.canvas?.palette ?? [0, 33, 68, 88, 115, 130] },
    paint: { ...blankPixel, color: 1 },
    'add-node': { id: `node-${projectNodes.length + 1}`, kind: projectNodes.length ? 'ending' : 'story', title: projectNodes.length ? 'Ending' : 'Beginning' },
    'edit-node': { id: projectNodes[0] ?? 'node-1', title: 'Edited scene' },
    'delete-node': { id: projectNodes.at(-1) ?? 'node-1' },
    'set-start': { id: projectNodes[0] ?? 'node-1' },
    connect: { from: projectNodes[0] ?? 'node-1', to: projectNodes[1] ?? 'node-2' },
    'select-event': { cursor: Math.max(0, (state?.timeline?.length ?? 1) - 1) },
    seek: { cursor: state?.viewer?.cursor ?? 0 }, step: { direction: 1 }, speed: { speed: 2 },
    viewpoint: { serial: worldPlayerSerial() }, bookmark: { label: `Moment ${(state?.viewer?.cursor ?? 0) + 1}` },
  };
  return defaults[command] ?? {};
}

function summarizeSpecialState(state) {
  if (!state) return '';
  if (state.kind === 'card-game') return `Round ${state.round || 0} · turn ${state.turn || 'waiting'} · HP ${state.player?.health ?? 20} · mana ${state.player?.mana ?? 0}\nHand: ${state.player?.hand?.join(', ') || 'empty'}`;
  if (state.kind === 'deckbuilding') return state.run ? `Floor ${state.run.floor} · HP ${state.run.health} · energy ${state.run.energy} · deck ${state.run.deck.length} · relics ${state.run.relics.join(', ') || 'none'}${state.run.cardRewards?.length ? `\nChoose card: ${state.run.cardRewards.join(', ')}` : ''}` : 'Choose a route to begin.';
  if (state.kind === 'music-studio') return state.project ? `${state.project.tempo} BPM · ${state.project.tracks.length} track(s) · ${state.project.tracks.reduce((sum, track) => sum + track.notes.length, 0)} notes` : 'New music project.';
  if (state.kind === 'painting') return state.canvas ? `${state.canvas.width}×${state.canvas.height} canvas · ${Object.keys(state.canvas.pixels ?? {}).length} painted tiles · revision ${state.canvas.revision}` : 'New canvas.';
  if (state.kind === 'adventure-authoring') return state.project ? `${Object.keys(state.project.nodes ?? {}).length} nodes · ${state.project.publishedRevision < 0 ? 'unpublished' : `published r${state.project.publishedRevision}`}` : 'New adventure graph.';
  if (state.kind === 'replay') return `${state.timeline?.length ?? 0} events · cursor ${state.viewer?.cursor ?? 0} · ${state.viewer?.speed ?? 1}×`;
  return '';
}

function worldPlayerSerial() {
  return Number(world.player?.serial) >>> 0;
}
