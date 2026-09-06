import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { Combobox } from '../controls/combobox.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import { uiManagerInstance } from '../ui-manager-singleton.js';
import { NodeUOJsonKind, NodeUOSpellComposerMessage } from '@uo/nodeuo-protocol';

const BUTTON = {
  normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
  action: ButtonAction.Activate, flat: true,
};
const NODE_W = 122;
const NODE_H = 42;
const NODE_COLORS = {
  start: 0xe6c85c, damage: 0xef735f, heal: 0x62cf85, modifier: 0xc48aff,
  mana: 0x5c8cff, stamina: 0xe9c45d, shield: 0x80aaff, poison: 0x5faf63,
  cleanse: 0xc8fff0, 'time-gate': 0xc890ff, 'chance-gate': 0xff9ed8,
  transform: 0xffb85c,
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
  if (node.type === 'mana') return `+${cfg.amount ?? 0} mana`;
  if (node.type === 'stamina') return `+${cfg.amount ?? 0} stamina`;
  if (node.type === 'shield') return `armor +${cfg.amount ?? 0}`;
  if (node.type === 'poison') return `venom ${cfg.amount ?? 1}`;
  if (node.type === 'cleanse') return 'remove poison';
  if (node.type === 'time-gate') return cfg.phase ?? 'night';
  if (node.type === 'chance-gate') return `${cfg.chance ?? 50}%`;
  if (node.type === 'transform') return `item 0x${(cfg.artId ?? 0).toString(16)} hue ${cfg.hue ?? 0}`;
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

function scribingSummary(draft) {
  const materials = Array.isArray(draft?.scribingRequirements) ? draft.scribingRequirements : [];
  return materials.length
    ? ` Scribe cost: ${materials.map((entry) => `${entry.amount}× ${entry.name}`).join(', ')}.`
    : '';
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
    this._mana = this._input('Mana', '20', 608, 74, 48, 5);
    this._range = this._input(
      'Range', String(Math.min(10, this.catalog.limits?.range?.[1] ?? 10)), 666, 74, 48, 4,
    );
    this._castTime = this._input('Cast ms', '750', 724, 74, 76, 5);

    this._section(12, 124, 562, 482);
    this._label('Graph canvas', 22, 132, 0xffdf88);
    this._label('Drag blocks. Drag ● output → ● input to wire; repeat to disconnect.', 122, 133, 0xa99f8b);
    this._canvas = new ScrollArea({ width: 542, height: 438, contentHeight: 420 });
    this.addContent(this._canvas, 22, 158);

    this._section(584, 124, 224, 482);
    this._label('Block palette', 596, 132, 0xffdf88);
    const nodeKinds = (this.catalog.nodeTypes ?? []).filter((entry) => entry.id !== 'start');
    this._palette = new ScrollArea({ width: 202, height: 82,
      contentHeight: Math.max(82, Math.ceil(nodeKinds.length / 2) * 27) });
    this.addContent(this._palette, 594, 154);
    nodeKinds.forEach((entry, index) => {
      const label = entry.unlocked ? `+ ${entry.label ?? entry.id}` : `🔒 ${entry.id} R${entry.requiredRank}`;
      const add = new Button({ ...BUTTON, label, width: 96, height: 22 });
      add.setPosition((index % 2) * 100, Math.floor(index / 2) * 27);
      add.onClick = () => this._addNode(entry.id);
      add.enabled = !!this.permissions.edit && entry.unlocked !== false;
      this._palette.add(add);
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
    this._duration = this._input('Duration / delay ms', '10000', 596, 378, 116, 9);
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
    this._radius = this._input('Radius', '3', 700, 494, 42, 4);
    this._angle = this._input('Cone °', '90', 750, 494, 42, 3);
    this._cooldown = this._input('Cooldown ms', '1500', 596, 542, 112, 9);
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
        ? `Published ${saved.name} as spell #${saved.spellId}. +${message.payload.xpGained ?? 0} research. ${progressionSummary(this.progression)}${scribingSummary(saved)}`
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
        : type === 'mana' || type === 'stamina' ? { scope: 'target', amount: 10 }
        : type === 'modifier' ? { scope: 'target', attribute: 'str', amount: 5, durationMs: 10000 }
          : type === 'shield' ? { scope: 'target', amount: 10, durationMs: 10000 }
            : type === 'poison' ? { scope: 'target', amount: 1, durationMs: 10000 }
              : type === 'cleanse' ? { scope: 'target' }
                : type === 'time-gate' ? { phase: 'night' }
                  : type === 'chance-gate' ? { chance: 50 }
                    : type === 'transform' ? { artId: 0x0EED, hue: 0 }
          : type === 'visual' ? { scope: 'target', graphic: 0x36BD, hue: 0 }
            : type === 'sound' ? { scope: 'target', sound: 0x0207 }
              : { ms: 500 };
    const index = this._graph.nodes.length;
    const node = { id, type, x: 20 + (index % 3) * 170, y: 40 + Math.floor(index / 3) * 85, config };
    this._graph.nodes.push(node);
    this._selectedId = id;
    this._rebuildGraph(); this._selectNode(id);
  }

  _selectNode(id) {
    const node = this._node(id);
    if (!node) return;
    this._selectedId = id;
    this._selectedTitle.setText(`Selected: ${node.type} (${node.id})`);
    const cfg = node.config ?? {};
    this._scope.setValue(cfg.scope ?? 'target', { silent: true });
    if (node.type === 'damage') {
      this._variant.setValues(this.catalog.availableElements ?? this.catalog.elements ?? ['physical']);
    } else if (node.type === 'modifier') {
      this._variant.setValues(this.catalog.modifierAttributes ?? ['str', 'dex', 'int']);
    } else if (node.type === 'time-gate') {
      this._variant.setValues(['day', 'night', 'dawn', 'dusk']);
    } else {
      this._variant.setValues(['physical']);
    }
    this._variant.setValue(cfg.element ?? cfg.attribute ?? cfg.phase ?? 'physical', { silent: true });
    this._amount.setValue(String(cfg.chance ?? cfg.amount ?? 0));
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
    if (node.type === 'mana' || node.type === 'stamina') {
      node.config = { scope, amount: this._number(this._amount) };
    }
    if (node.type === 'modifier') node.config = {
      scope, attribute: this._variant._value, amount: this._number(this._amount),
      durationMs: this._number(this._duration),
    };
    if (node.type === 'visual') node.config = {
      scope, graphic: this._number(this._asset), hue: this._number(this._hue),
    };
    if (node.type === 'sound') node.config = { scope, sound: this._number(this._asset) };
    if (node.type === 'delay') node.config = { ms: this._number(this._duration) };
    if (node.type === 'shield' || node.type === 'poison') node.config = {
      scope, amount: this._number(this._amount), durationMs: this._number(this._duration),
    };
    if (node.type === 'cleanse') node.config = { scope };
    if (node.type === 'time-gate') node.config = { phase: this._variant._value };
    if (node.type === 'chance-gate') node.config = { chance: this._number(this._amount) };
    if (node.type === 'transform') node.config = {
      artId: this._number(this._asset), hue: this._number(this._hue),
    };
    this._status.setText(`Updated ${node.id}.`);
    this._rebuildGraph();
  }

  _beginConnect() {
    if (!this.permissions.edit || !this._selectedId) return;
    this._connectFrom = this._selectedId;
    this._status.setText(`Wiring ${this._selectedId}: click or drag to a block's left input port.`);
  }

  _toggleConnection(from, to) {
    if (!this.permissions.edit || !from || !to || from === to) return false;
    const duplicate = this._graph.edges.some((edge) => edge.from === from && edge.to === to);
    if (duplicate) {
      this._graph.edges = this._graph.edges.filter((edge) => edge.from !== from || edge.to !== to);
      this._status.setText(`Disconnected ${from} → ${to}.`);
    } else if (this._graph.edges.length < (this.catalog.limits?.edges ?? 64)) {
      this._graph.edges.push({ from, fromPort: 'flow', to, toPort: 'flow' });
      this._status.setText(`Connected ${from}.flow → ${to}.flow.`);
    } else {
      this._status.setText('This schema has reached its connection limit.');
      return false;
    }
    this._connectFrom = null;
    this._rebuildGraph();
    return true;
  }

  _contentPoint(screenX, screenY) {
    const ui = uiManagerInstance.get();
    const point = ui?.screenToLogical?.(screenX, screenY) ?? { x: screenX, y: screenY };
    return {
      x: point.x - this.x - this._canvas.x,
      y: point.y - this.y - this._canvas.y + this._canvas.scrollY,
    };
  }

  _startNodeDrag(node, button, btn, localX) {
    if (!this.permissions.edit || btn !== 0) return;
    this._nodeDragCleanup?.();
    const ui = uiManagerInstance.get();
    const press = ui?._pressed;
    const start = this._contentPoint(press?.sx ?? 0, press?.sy ?? 0);
    const x0 = node.x, y0 = node.y;
    const wire = localX >= NODE_W - 18;
    if (wire) {
      this._connectFrom = node.id;
      this._status.setText(`Drag ${node.id}.flow to a left input port.`);
    }
    const onMove = (event) => {
      const point = this._contentPoint(event.clientX, event.clientY);
      if (wire) {
        this._drawEdges(point);
        return;
      }
      node.x = Math.max(0, Math.min(4000, Math.round(x0 + point.x - start.x)));
      node.y = Math.max(0, Math.min(4000, Math.round(y0 + point.y - start.y)));
      button.setPosition(node.x, node.y);
      this._drawEdges();
    };
    const cleanup = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      this._nodeDragCleanup = null;
    };
    const onUp = (event) => {
      cleanup();
      if (wire) {
        const hit = ui?.pickAtScreen?.(event.clientX, event.clientY);
        const targetId = hit?.control?._schemaNodeId;
        if (targetId && targetId !== node.id && (hit.lx ?? NODE_W) <= 22) {
          this._toggleConnection(node.id, targetId);
          return;
        }
        this._connectFrom = null;
        this._status.setText('Wire cancelled: release over a left input port.');
      }
      this._rebuildGraph();
    };
    this._nodeDragCleanup = cleanup;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
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

  _drawEdges(pointer = null) {
    if (this._edgeGraphic) {
      try { this._canvas.content.removeChild(this._edgeGraphic); } catch { /* detached */ }
      this._edgeGraphic.destroy();
    }
    const edges = new Graphics();
    const byId = new Map(this._graph.nodes.map((node) => [node.id, node]));
    const drawWire = (x1, y1, x2, y2, temporary = false) => {
      const mid = x1 + (x2 - x1) / 2;
      edges.moveTo(x1, y1).bezierCurveTo(mid, y1, mid, y2, x2, y2)
        .stroke({ width: temporary ? 1 : 2, color: temporary ? 0x80cfff : 0xd3b76d, alpha: 0.9 });
      if (!temporary) edges.moveTo(x2, y2).lineTo(x2 - 7, y2 - 4)
        .lineTo(x2 - 7, y2 + 4).closePath().fill({ color: 0xd3b76d, alpha: 0.9 });
    };
    for (const edge of this._graph.edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      if (from && to) drawWire(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2);
    }
    const from = pointer && byId.get(this._connectFrom);
    if (from) drawWire(from.x + NODE_W, from.y + NODE_H / 2, pointer.x, pointer.y, true);
    this._edgeGraphic = edges;
    this._canvas.addContent(edges);
  }

  _rebuildGraph() {
    for (const control of this._nodeControls.splice(0)) {
      this._canvas.remove(control); control.dispose?.();
    }
    this._drawEdges();
    for (const node of this._graph.nodes) {
      const selected = node.id === this._selectedId ? '◆ ' : '';
      const button = new Button({
        ...BUTTON, width: NODE_W, height: NODE_H,
        label: `${selected}${node.type}\n${nodeSummary(node)}`,
      });
      button._schemaNodeId = node.id;
      button.setPosition(node.x, node.y);
      button.onClick = (_btn, lx) => {
        if (lx >= NODE_W - 18) {
          this._selectedId = node.id;
          this._beginConnect();
        } else if (lx <= 22 && this._connectFrom) {
          this._toggleConnection(this._connectFrom, node.id);
        } else this._selectNode(node.id);
      };
      button.onDragStart = (btn, lx) => this._startNodeDrag(node, button, btn, lx);
      const tint = new Graphics();
      tint.roundRect(2, 2, NODE_W - 4, 4, 2).fill({ color: NODE_COLORS[node.type] ?? 0xffffff, alpha: 0.95 });
      tint.circle(4, NODE_H / 2, 4).fill({ color: 0x80cfff }).stroke({ width: 1, color: 0xffffff });
      tint.circle(NODE_W - 4, NODE_H / 2, 4).fill({ color: 0xffd66d }).stroke({ width: 1, color: 0xffffff });
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
    try {
      net.sendNodeUOMessage({
        kind: NodeUOJsonKind.Event, feature: 'spell.composer',
        payload: { operation: kind === NodeUOSpellComposerMessage.Publish ? 'publish'
          : kind === NodeUOSpellComposerMessage.Scribe ? 'scribe' : 'save',
          eventKind: kind, requestId: this.requestId, data: payload },
        idempotencyKey: `spell:${this.requestId}:${kind}:${payload?.id ?? payload?.name ?? ''}`,
      });
    }
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
    this._status.setText(draft.published
      ? `Published spell #${draft.spellId}.${scribingSummary(draft)}`
      : 'Draft loaded.');
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
    this._nodeDragCleanup?.();
    this._unsub?.();
    super.dispose?.();
  }
}
