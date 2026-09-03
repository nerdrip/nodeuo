import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { Combobox } from '../controls/combobox.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import { extNodeUOSpellComposer, NodeUOSpellComposerMessage } from '@uo/protocol';

const BUTTON = {
  normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
  action: ButtonAction.Activate, flat: true,
};
const NODE_W = 122;
const NODE_H = 42;
const NODE_COLORS = {
  start: 0xe6c85c, damage: 0xef735f, heal: 0x62cf85, modifier: 0xc48aff,
  visual: 0x6db7ff, sound: 0x75d3d0, delay: 0xc1a58d,
};

function initialGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'start', x: 20, y: 125, config: {} },
      { id: 'visual-1', type: 'visual', x: 190, y: 70,
        config: { scope: 'target', graphic: 0x36BD, hue: 0 } },
      { id: 'damage-1', type: 'damage', x: 370, y: 125,
        config: { scope: 'target', amount: 20, element: 'physical' } },
    ],
    edges: [{ from: 'start', to: 'visual-1' }, { from: 'visual-1', to: 'damage-1' }],
  };
}

function cloneGraph(graph) {
  return {
    version: 1,
    nodes: (graph?.nodes ?? []).map((node) => ({ ...node, config: { ...(node.config ?? {}) } })),
    edges: (graph?.edges ?? []).map((edge) => ({ ...edge })),
  };
}

function nodeSummary(node) {
  const cfg = node.config ?? {};
  if (node.type === 'damage') return `${cfg.amount ?? 0} ${cfg.element ?? 'physical'}`;
  if (node.type === 'heal') return `+${cfg.amount ?? 0} hp`;
  if (node.type === 'modifier') return `${cfg.attribute ?? 'str'} ${cfg.amount >= 0 ? '+' : ''}${cfg.amount ?? 0}`;
  if (node.type === 'visual') return `gfx 0x${(cfg.graphic ?? 0).toString(16)}`;
  if (node.type === 'sound') return `sound 0x${(cfg.sound ?? 0).toString(16)}`;
  if (node.type === 'delay') return `${cfg.ms ?? 0} ms`;
  return 'entry';
}

function progressionSummary(profile) {
  if (!profile) return 'Spellcraft progression unavailable.';
  if (profile.admin) return 'Administrator: every block and limit is unlocked.';
  const next = profile.next
    ? `next R${profile.next.level}: ${profile.next.xp} research + ${profile.next.inscription} Inscription`
    : 'maximum rank';
  return `R${profile.level} ${profile.rank} · ${profile.xp} research · Inscription ${profile.inscription} · ${next}`;
}

export class SpellComposerGump extends WindowGump {
  constructor({ requestId = 0, payload = {} } = {}) {
    super({ title: 'Arcane Schema — spell graph', width: 820, height: 680, x: 70, y: 24 });
    this._toggleKey = 'spell-composer';
    this.requestId = requestId >>> 0;
    this.catalog = payload.catalog ?? {};
    this.drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
    this.progression = payload.progression ?? null;
    this.permissions = payload.permissions ?? { edit: true, publish: true, scribe: false };
    this.sourceSerial = payload.sourceSerial >>> 0;
    this._graph = initialGraph();
    this._draftId = null;
    this._spellId = null;
    this._selectedId = 'start';
    this._connectFrom = null;
    this._nodeControls = [];
    this._edgeGraphic = null;
    this._nextNode = 2;

    this._section(12, 28, 796, 42);
    this._status = this._label(
      payload.truncated
        ? `Showing newest schemas only. ${progressionSummary(this.progression)}`
        : progressionSummary(this.progression),
      22, 42, 0xcbb77a,
    );

    this._draftPicker = this._combo(
      ['New spell', ...this.drafts.map((draft) => draft.name)], 'New spell', 18, 82, 170,
      (name) => {
        if (name === 'New spell') this._clear();
        else this._loadDraft(this.drafts.find((draft) => draft.name === name));
      },
    );
    this._name = this._input('Name', 'Arc Flash', 198, 74, 180, 40);
    this._school = this._combo(this.catalog.schools ?? ['custom'], 'custom', 388, 90, 100);
    this._target = this._combo(this.catalog.availableTargets ?? this.catalog.targets ?? ['mobile'], 'mobile', 498, 90, 100);
    this._mana = this._input('Mana', '20', 608, 74, 48, 3);
    this._range = this._input(
      'Range', String(Math.min(10, this.catalog.limits?.range?.[1] ?? 10)), 666, 74, 48, 2,
    );
    this._castTime = this._input('Cast ms', '750', 724, 74, 76, 5);

    this._section(12, 124, 562, 482);
    this._label('Graph canvas', 22, 132, 0xffdf88);
    this._label('Select source → Connect → destination. Repeat a connection to remove it.', 122, 133, 0xa99f8b);
    this._canvas = new ScrollArea({ width: 542, height: 438, contentHeight: 420 });
    this.addContent(this._canvas, 22, 158);

    this._section(584, 124, 224, 482);
    this._label('Block palette', 596, 132, 0xffdf88);
    const nodeKinds = (this.catalog.nodeTypes ?? []).filter((entry) => entry.id !== 'start');
    nodeKinds.forEach((entry, index) => {
      const label = entry.unlocked ? `+ ${entry.id}` : `🔒 ${entry.id} R${entry.requiredRank}`;
      const add = this._button(label, 594 + (index % 2) * 104, 154 + Math.floor(index / 2) * 27, 98, 22,
        () => this._addNode(entry.id));
      add.enabled = !!this.permissions.edit && entry.unlocked !== false;
    });

    this._selectedTitle = this._label('Selected: Start', 596, 246, 0xffdf88);
    this._scope = this._combo(
      this.catalog.availableScopes ?? this.catalog.scopes ?? ['target', 'caster'],
      'target', 596, 280, 196,
    );
    this._variant = this._combo(
      [...(this.catalog.availableElements ?? this.catalog.elements ?? ['physical']),
        ...(this.catalog.modifierAttributes ?? ['str'])],
      'physical', 596, 310, 196,
    );
    this._amount = this._input('Amount', '20', 596, 332, 86, 5);
    this._asset = this._input('Graphic / sound', '0x36BD', 694, 332, 98, 8);
    this._duration = this._input('Duration / delay ms', '10000', 596, 378, 116, 6);
    this._hue = this._input('Hue', '0', 724, 378, 68, 8);

    const apply = this._button('Apply block', 596, 430, 94, 23, () => this._applyInspector());
    const connect = this._button('Connect', 698, 430, 94, 23, () => this._beginConnect());
    const remove = this._button('Delete', 596, 460, 94, 23, () => this._deleteSelected());
    for (const button of [apply, connect, remove]) button.enabled = !!this.permissions.edit;
    this._button('←', 698, 460, 22, 23, () => this._moveSelected(-20, 0)).enabled = !!this.permissions.edit;
    this._button('→', 722, 460, 22, 23, () => this._moveSelected(20, 0)).enabled = !!this.permissions.edit;
    this._button('↑', 746, 460, 22, 23, () => this._moveSelected(0, -20)).enabled = !!this.permissions.edit;
    this._button('↓', 770, 460, 22, 23, () => this._moveSelected(0, 20)).enabled = !!this.permissions.edit;

    this._shape = this._combo(
      this.catalog.availableAreaShapes ?? this.catalog.areaShapes ?? ['single'],
      'single', 596, 510, 94,
    );
    this._radius = this._input('Radius', '3', 700, 494, 42, 2);
    this._angle = this._input('Cone °', '90', 750, 494, 42, 3);
    this._cooldown = this._input('Cooldown ms', '1500', 596, 542, 112, 6);
    this._areaPreview = new Graphics(); this.node.addChild(this._areaPreview);
    this._shape.onChange = () => this._drawAreaPreview();
    this._radius.onChange = () => this._drawAreaPreview();
    this._angle.onChange = () => this._drawAreaPreview();

    const fresh = this._button('New', 18, 632, 82, 25, () => this._clear());
    const save = this._button('Save draft', 112, 632, 116, 25, () => this._save());
    const publish = this._button('Validate & publish', 240, 632, 154, 25, () => this._publish());
    const scribe = this._button('Scribe scroll', 406, 632, 124, 25, () => this._scribe());
    this._button('Close', 708, 632, 94, 25, () => this.close());
    fresh.enabled = save.enabled = !!this.permissions.edit;
    publish.enabled = !!this.permissions.publish;
    scribe.enabled = !!this.permissions.scribe;

    this._unsub = bus.on('nodeuo:spell-composer', (message) => {
      if (message?.kind !== NodeUOSpellComposerMessage.Result
          || (message.requestId >>> 0) !== this.requestId) return;
      if (!message.payload?.ok) {
        this._status.setText(`Rejected: ${(message.payload?.errors ?? ['invalid schema']).join(' ')}`);
        return;
      }
      if (message.payload.scribed) {
        this._status.setText(`Scribed ${message.payload.draft?.name ?? 'spell'} onto a new scroll.`);
        return;
      }
      if (message.payload.progression) this.progression = message.payload.progression;
      const saved = message.payload.draft;
      const index = this.drafts.findIndex((draft) => draft.id === saved.id);
      if (index >= 0) this.drafts[index] = saved; else this.drafts.push(saved);
      this._draftId = saved.id;
      this._spellId = saved.spellId;
      this._draftPicker.setValues(['New spell', ...this.drafts.map((draft) => draft.name)]);
      this._draftPicker.setValue(saved.name, { silent: true });
      this._status.setText(message.payload.published
        ? `Published ${saved.name} as spell #${saved.spellId}. +${message.payload.xpGained ?? 0} research. ${progressionSummary(this.progression)}`
        : `Saved ${saved.name}. Publish it before scribing.`);
    });

    this._rebuildGraph();
    this._selectNode('start');
    this._drawAreaPreview();
  }

  get type() { return 'spell-composer'; }

  _section(x, y, width, height) {
    const graphic = new Graphics();
    graphic.roundRect(x, y, width, height, 5)
      .fill({ color: 0x0d1520, alpha: 0.82 })
      .stroke({ width: 1, color: 0x8a6a2c, alpha: 0.7 });
    this.node.addChild(graphic);
  }

  _label(text, x, y, hue = 0xc0b090) {
    const label = new Label(text, { fontSize: 11, hue, stroke: true });
    label.setPosition(x, y); this.add(label); return label;
  }

  _input(label, value, x, y, width, maxLength) {
    this._label(label, x, y);
    const input = new TextInput({ width, height: 22, text: value, maxLength });
    input.setPosition(x, y + 16); this.add(input); return input;
  }

  _combo(values, value, x, y, width, onChange = null) {
    const safeValues = values.length ? values : [value];
    const combo = new Combobox({ values: safeValues, value, width, height: 22, onChange });
    combo.setPosition(x, y); this.add(combo); return combo;
  }

  _button(label, x, y, width, height, onClick) {
    const button = new Button({ ...BUTTON, label, width, height });
    button.setPosition(x, y); button.onClick = onClick; this.add(button); return button;
  }

  _number(input) { return Number.parseInt(input?.value, 0) || 0; }

  _node(id) { return this._graph.nodes.find((node) => node.id === id); }

  _addNode(type) {
    if (!this.permissions.edit || this._graph.nodes.length >= (this.catalog.limits?.nodes ?? 32)) return;
    const entry = (this.catalog.nodeTypes ?? []).find((candidate) => candidate.id === type);
    if (entry?.unlocked === false) {
      this._status.setText(`${entry.label ?? type} is locked. Find its schema fragment and meet rank R${entry.requiredRank}.`);
      return;
    }
    const id = `${type}-${this._nextNode++}`;
    const config = type === 'damage' ? { scope: 'target', amount: 10, element: 'physical' }
      : type === 'heal' ? { scope: 'target', amount: 10 }
        : type === 'modifier' ? { scope: 'target', attribute: 'str', amount: 5, durationMs: 10000 }
          : type === 'visual' ? { scope: 'target', graphic: 0x36BD, hue: 0 }
            : type === 'sound' ? { scope: 'target', sound: 0x0207 }
              : { ms: 500 };
    const index = this._graph.nodes.length;
    const node = { id, type, x: 20 + (index % 3) * 170, y: 40 + Math.floor(index / 3) * 85, config };
    this._graph.nodes.push(node);
    if (this._selectedId && this._graph.edges.length < (this.catalog.limits?.edges ?? 64)) {
      this._graph.edges.push({ from: this._selectedId, to: id });
    }
    this._selectedId = id;
    this._rebuildGraph(); this._selectNode(id);
  }

  _selectNode(id) {
    const node = this._node(id);
    if (!node) return;
    if (this._connectFrom && this._connectFrom !== id) {
      const duplicate = this._graph.edges.some((edge) => edge.from === this._connectFrom && edge.to === id);
      if (duplicate) {
        this._graph.edges = this._graph.edges
          .filter((edge) => edge.from !== this._connectFrom || edge.to !== id);
        this._status.setText(`Disconnected ${this._connectFrom} → ${id}.`);
      } else if (this._graph.edges.length < (this.catalog.limits?.edges ?? 64)) {
        this._graph.edges.push({ from: this._connectFrom, to: id });
        this._status.setText(`Connected ${this._connectFrom} → ${id}.`);
      }
      this._connectFrom = null;
    }
    this._selectedId = id;
    this._selectedTitle.setText(`Selected: ${node.type} (${node.id})`);
    const cfg = node.config ?? {};
    this._scope.setValue(cfg.scope ?? 'target', { silent: true });
    if (node.type === 'damage') {
      this._variant.setValues(this.catalog.availableElements ?? this.catalog.elements ?? ['physical']);
    } else if (node.type === 'modifier') {
      this._variant.setValues(this.catalog.modifierAttributes ?? ['str', 'dex', 'int']);
    }
    this._variant.setValue(cfg.element ?? cfg.attribute ?? 'physical', { silent: true });
    this._amount.setValue(String(cfg.amount ?? 0));
    this._asset.setValue(`0x${(cfg.graphic ?? cfg.sound ?? 0).toString(16)}`);
    this._duration.setValue(String(cfg.durationMs ?? cfg.ms ?? 0));
    this._hue.setValue(`0x${(cfg.hue ?? 0).toString(16)}`);
    this._rebuildGraph();
  }

  _applyInspector() {
    if (!this.permissions.edit) return;
    const node = this._node(this._selectedId);
    if (!node || node.type === 'start') return;
    const scope = this._scope._value;
    if (node.type === 'damage') node.config = { scope, amount: this._number(this._amount), element: this._variant._value };
    if (node.type === 'heal') node.config = { scope, amount: this._number(this._amount) };
    if (node.type === 'modifier') node.config = {
      scope, attribute: this._variant._value, amount: this._number(this._amount),
      durationMs: this._number(this._duration),
    };
    if (node.type === 'visual') node.config = {
      scope, graphic: this._number(this._asset), hue: this._number(this._hue),
    };
    if (node.type === 'sound') node.config = { scope, sound: this._number(this._asset) };
    if (node.type === 'delay') node.config = { ms: this._number(this._duration) };
    this._status.setText(`Updated ${node.id}.`);
    this._rebuildGraph();
  }

  _beginConnect() {
    if (!this.permissions.edit || !this._selectedId) return;
    this._connectFrom = this._selectedId;
    this._status.setText(`Connecting from ${this._selectedId}: click the destination block.`);
  }

  _deleteSelected() {
    if (!this.permissions.edit || this._selectedId === 'start') return;
    const id = this._selectedId;
    this._graph.nodes = this._graph.nodes.filter((node) => node.id !== id);
    this._graph.edges = this._graph.edges.filter((edge) => edge.from !== id && edge.to !== id);
    this._selectedId = 'start';
    this._rebuildGraph(); this._selectNode('start');
  }

  _moveSelected(dx, dy) {
    if (!this.permissions.edit) return;
    const node = this._node(this._selectedId);
    if (!node) return;
    node.x = Math.max(0, Math.min(390, node.x + dx));
    node.y = Math.max(0, Math.min(900, node.y + dy));
    this._rebuildGraph();
  }

  _rebuildGraph() {
    for (const control of this._nodeControls.splice(0)) {
      this._canvas.remove(control); control.dispose?.();
    }
    if (this._edgeGraphic) {
      this._canvas.content.removeChild(this._edgeGraphic);
      this._edgeGraphic.destroy();
    }
    const edges = new Graphics();
    const byId = new Map(this._graph.nodes.map((node) => [node.id, node]));
    for (const edge of this._graph.edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (!from || !to) continue;
      const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
      const x2 = to.x, y2 = to.y + NODE_H / 2;
      const mid = x1 + (x2 - x1) / 2;
      edges.moveTo(x1, y1).bezierCurveTo(mid, y1, mid, y2, x2, y2)
        .stroke({ width: 2, color: 0xd3b76d, alpha: 0.8 });
      edges.moveTo(x2, y2).lineTo(x2 - 7, y2 - 4).lineTo(x2 - 7, y2 + 4).closePath()
        .fill({ color: 0xd3b76d, alpha: 0.9 });
    }
    this._edgeGraphic = edges;
    this._canvas.addContent(edges);
    for (const node of this._graph.nodes) {
      const selected = node.id === this._selectedId ? '◆ ' : '';
      const button = new Button({
        ...BUTTON, width: NODE_W, height: NODE_H,
        label: `${selected}${node.type}\n${nodeSummary(node)}`,
      });
      button.setPosition(node.x, node.y);
      button.onClick = () => this._selectNode(node.id);
      const tint = new Graphics();
      tint.roundRect(2, 2, NODE_W - 4, 4, 2).fill({ color: NODE_COLORS[node.type] ?? 0xffffff, alpha: 0.95 });
      button.node.addChild(tint);
      this._canvas.add(button); this._nodeControls.push(button);
    }
    const height = Math.max(438, ...this._graph.nodes.map((node) => node.y + NODE_H + 20));
    this._canvas.setContentHeight(height);
  }

  _draft() {
    return {
      id: this._draftId,
      spellId: this._spellId,
      name: this._name.value,
      school: this._school._value,
      target: this._target._value,
      mana: this._number(this._mana), range: this._number(this._range),
      castTimeMs: this._number(this._castTime), cooldownMs: this._number(this._cooldown),
      area: {
        shape: this._shape._value,
        radius: this._number(this._radius), angle: this._number(this._angle),
      },
      graph: cloneGraph(this._graph),
    };
  }

  _send(kind, payload = this._draft()) {
    try { net.send(extNodeUOSpellComposer({ kind, requestId: this.requestId, payload })); }
    catch (error) { this._status.setText(`Send failed: ${error?.message ?? error}`); }
  }

  _save() {
    if (!this.permissions.edit) return;
    this._status.setText('Validating graph on the server…');
    this._send(NodeUOSpellComposerMessage.Save);
  }

  _publish() {
    if (!this.permissions.publish) return;
    this._status.setText('Running graph, cost and cooldown checks…');
    this._send(NodeUOSpellComposerMessage.Publish);
  }

  _scribe() {
    if (!this.permissions.scribe || !this._draftId) {
      this._status.setText('Select a published spell before scribing.');
      return;
    }
    this._status.setText('Scribing onto a blank scroll…');
    this._send(NodeUOSpellComposerMessage.Scribe, { id: this._draftId, sourceSerial: this.sourceSerial });
  }

  _loadDraft(draft) {
    if (!draft) return;
    this._draftId = draft.id ?? null; this._spellId = draft.spellId ?? null;
    this._name.setValue(draft.name ?? ''); this._school.setValue(draft.school ?? 'custom');
    this._target.setValue(draft.target ?? 'mobile'); this._mana.setValue(String(draft.mana ?? 0));
    this._range.setValue(String(draft.range ?? 0)); this._castTime.setValue(String(draft.castTimeMs ?? 0));
    this._cooldown.setValue(String(draft.cooldownMs ?? 0)); this._shape.setValue(draft.area?.shape ?? 'single');
    this._radius.setValue(String(draft.area?.radius ?? 0)); this._angle.setValue(String(draft.area?.angle ?? 0));
    this._graph = cloneGraph(draft.graph ?? initialGraph());
    this._nextNode = this._graph.nodes.length + 1;
    this._selectedId = this._graph.nodes[0]?.id ?? 'start';
    this._connectFrom = null;
    this._rebuildGraph(); this._selectNode(this._selectedId); this._drawAreaPreview();
    this._status.setText(draft.published ? `Published spell #${draft.spellId}.` : 'Draft loaded.');
  }

  _clear() {
    if (!this.permissions.edit) return;
    this._draftId = null; this._spellId = null; this._name.setValue('');
    this._graph = initialGraph(); this._selectedId = 'start'; this._connectFrom = null;
    this._rebuildGraph(); this._selectNode('start');
    this._status.setText('New schema. Add and connect blocks, then validate it.');
  }

  _drawAreaPreview() {
    const g = this._areaPreview;
    if (!g) return;
    const shape = this._shape?._value ?? 'single';
    const radius = Math.max(1, Math.min(12, this._number(this._radius)));
    const size = 5 + radius * 1.4, x = 754, y = 574;
    g.clear().circle(x, y, 3).fill({ color: 0xffe080 });
    if (shape === 'circle') g.circle(x, y, size).fill({ color: 0x4ca6ff, alpha: 0.2 }).stroke({ width: 1, color: 0x8fc8ff });
    else if (shape === 'cone') {
      const angle = Math.max(15, Math.min(180, this._number(this._angle))) * Math.PI / 180;
      g.moveTo(x, y).arc(x, y, size, -angle / 2, angle / 2).closePath()
        .fill({ color: 0xff7b42, alpha: 0.24 }).stroke({ width: 1, color: 0xffb080 });
    } else if (shape === 'line') g.roundRect(x, y - 3, size + 8, 6, 2)
      .fill({ color: 0x9d76ff, alpha: 0.28 }).stroke({ width: 1, color: 0xc8b0ff });
  }

  tick() {
    const draft = this._draft();
    const signature = JSON.stringify({ range: draft.range, target: draft.target, area: draft.area });
    if (signature === this._previewSignature) return;
    this._previewSignature = signature;
    bus.emit('spell-composer:range-preview', { range: draft.range, target: draft.target, area: draft.area });
  }

  dispose() {
    bus.emit('spell-composer:range-preview', null);
    this._unsub?.();
    super.dispose?.();
  }
}
