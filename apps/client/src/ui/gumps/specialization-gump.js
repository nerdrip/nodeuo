import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { extNodeUOSpecialization, NodeUOSpecializationMessage } from '@uo/protocol';

const FACE = { normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA, action: ButtonAction.Activate };

export class SpecializationGump extends WindowGump {
  constructor({ requestId = 0, payload = {} } = {}) {
    super({ title: 'Specializations — choose your path', width: 720, height: 430, x: 115, y: 70 });
    this._toggleKey = 'specializations';
    this.requestId = requestId >>> 0;
    this.payload = payload;
    this._rows = [];

    this._header = new Label('', { fontSize: 12, hue: 0xffdf88 });
    this._header.setPosition(18, 32); this.add(this._header);
    this._message = new Label('Skills at 70, 90 and 110 unlock permanent points.', { fontSize: 10, hue: 0xcbb77a });
    this._message.setPosition(18, 51); this.add(this._message);

    const trees = Array.isArray(payload.trees) ? payload.trees : [];
    trees.slice(0, 4).forEach((tree, column) => this._buildTree(tree, 14 + column * 176));

    const reset = new Button({ ...FACE, width: 130, height: 24, label: 'Reset allocation' });
    reset.setPosition(450, 392); reset.onClick = () => this._send(NodeUOSpecializationMessage.Reset, {}); this.add(reset);
    const close = new Button({ ...FACE, width: 100, height: 24, label: 'Close' });
    close.setPosition(602, 392); close.onClick = () => this.close(); this.add(close);

    this._unsub = bus.on('nodeuo:specializations', (message) => {
      if (message?.kind !== NodeUOSpecializationMessage.Result) return;
      if ((message.requestId >>> 0) !== this.requestId) return;
      this.payload = message.payload ?? this.payload;
      this._message.setText(message.payload?.message ?? 'Specialization state updated.');
      this._refresh();
    });
    this._refresh();
  }

  _buildTree(tree, x) {
    const panel = new Graphics();
    panel.roundRect(x, 76, 166, 300, 5)
      .fill({ color: 0x11100c, alpha: 0.84 })
      .stroke({ color: tree.color ?? 0x9b7a3d, width: 1, alpha: 0.9 });
    this.node.addChild(panel);
    const title = new Label(tree.label ?? tree.id, { fontSize: 13, hue: tree.color ?? 0xffdf88 });
    title.setPosition(x + 10, 86); this.add(title);

    (tree.nodes ?? []).slice(0, 3).forEach((entry, row) => {
      const y = 120 + row * 82;
      if (row > 0) {
        const link = new Graphics();
        link.moveTo(x + 83, y - 18).lineTo(x + 83, y - 4)
          .stroke({ color: tree.color ?? 0x9b7a3d, width: 2, alpha: 0.8 });
        this.node.addChild(link);
      }
      const name = new Label(entry.label, { fontSize: 11, hue: 0xfff0c0 });
      name.setPosition(x + 9, y); this.add(name);
      const description = new Label(entry.description, { fontSize: 8, hue: 0xbeb59d });
      description.setPosition(x + 9, y + 17); this.add(description);
      const action = new Button({ ...FACE, width: 146, height: 22, label: 'Learn' });
      action.setPosition(x + 9, y + 43);
      action.onClick = () => this._send(NodeUOSpecializationMessage.Allocate, { nodeId: entry.id });
      this.add(action);
      this._rows.push({ entry, action });
    });
  }

  _refresh() {
    const state = this.payload?.state ?? {};
    const allocations = state.allocations ?? {};
    this._header.setText(`Points: ${state.available ?? 0} available  •  ${state.spent ?? 0}/${state.earned ?? 0} spent`);
    for (const row of this._rows) {
      const learned = !!allocations[row.entry.id];
      const locked = (row.entry.requires ?? []).some((id) => !allocations[id]);
      row.action.setLabel(learned ? 'Learned' : locked ? 'Locked' : 'Learn (1 point)');
    }
  }

  _send(kind, payload) {
    try { net.send(extNodeUOSpecialization({ kind, requestId: this.requestId, payload })); }
    catch { this._message.setText('Connection closed before the request was sent.'); }
  }

  dispose() {
    this._unsub?.();
    super.dispose();
  }
}
