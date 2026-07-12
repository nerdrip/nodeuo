import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { Combobox } from '../controls/combobox.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import {
  extNodeUOSpellComposer,
  NodeUOSpellComposerMessage,
} from '@uo/protocol';

const BUTTON = {
  normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
  action: ButtonAction.Activate, flat: true,
};

export class SpellComposerGump extends WindowGump {
  constructor({ requestId = 0, payload = {} } = {}) {
    super({ title: 'Spell Composer — draft workshop', width: 620, height: 570, x: 150, y: 45 });
    this._toggleKey = 'spell-composer';
    this.requestId = requestId >>> 0;
    this.catalog = payload.catalog ?? {};
    this.drafts = Array.isArray(payload.drafts) ? payload.drafts : [];
    this._sequence = [];
    this._timelineRows = [];

    this._section(12, 28, 596, 48);
    this._status = new Label(
      'Drafts are inert until an administrator validates and publishes them.',
      { fontSize: 11, hue: 0xcbb77a },
    );
    this._status.setPosition(22, 44); this.add(this._status);
    this._areaPreview = new Graphics();
    this.node.addChild(this._areaPreview);
    this._label('AoE', 548, 34, 0xffdf88);

    this._section(12, 86, 288, 280);
    this._section(310, 86, 298, 280);
    this._label('Identity & casting', 24, 96, 0xffdf88);
    this._label('Effect component', 322, 96, 0xffdf88);

    this._draftPicker = this._combo(
      this.drafts.map((draft) => draft.name), 'New spell', 24, 120, 252,
      (name) => this._loadDraft(this.drafts.find((draft) => draft.name === name)),
    );
    this._name = this._input('Name', 'Arc Flash', 24, 158, 252, 40);
    this._school = this._combo(this.catalog.schools ?? ['custom'], 'custom', 24, 205, 252);
    this._target = this._combo(this.catalog.targets ?? ['mobile'], 'mobile', 24, 250, 252);
    this._mana = this._input('Mana', '12', 24, 296, 56, 3);
    this._range = this._input('Range', '10', 104, 296, 56, 2);
    this._castTime = this._input('Cast ms', '750', 184, 296, 82, 5);

    const effects = (this.catalog.effects ?? [{ id: 'damage' }]).map((effect) => effect.id);
    this._effect = this._combo(effects, effects[0] ?? 'damage', 322, 120, 260);
    this._element = this._combo(this.catalog.elements ?? ['physical'], 'energy', 322, 166, 260);
    this._amount = this._input('Amount', '20', 322, 212, 84, 4);
    this._duration = this._input('Duration ms', '0', 430, 212, 128, 6);
    this._graphic = this._input('Graphic', '0x36BD', 322, 260, 108, 8);
    this._hue = this._input('Hue', '0', 454, 260, 104, 8);
    this._shape = this._combo(
      this.catalog.areaShapes ?? ['single'], 'single', 322, 308, 112,
      () => this._drawAreaPreview(),
    );
    this._label('Area shape', 322, 292);
    this._radius = this._input('Radius', '3', 452, 292, 54, 2);
    this._angle = this._input('Cone °', '90', 522, 292, 54, 3);
    this._cooldown = this._input('Cooldown ms', '1500', 322, 338, 128, 6);
    this._radius.onChange = () => this._drawAreaPreview();
    this._angle.onChange = () => this._drawAreaPreview();
    this._drawAreaPreview();

    this._section(12, 382, 596, 126);
    this._label('Effect & sound timeline', 24, 390, 0xffdf88);
    this._timeline = new ScrollArea({ width: 350, height: 88 });
    this.addContent(this._timeline, 22, 412);
    this._cueKind = this._combo(this.catalog.sequenceKinds ?? ['visual', 'sound'], 'visual', 386, 412, 92);
    this._cueAt = this._input('At ms', '0', 492, 396, 82, 6);
    this._cueAsset = this._input('Graphic / sound', '0x36BD', 386, 448, 118, 8);
    this._cueHue = this._input('Hue', '0', 520, 448, 58, 8);
    const addCue = new Button({ ...BUTTON, width: 92, height: 22, label: 'Add cue' });
    addCue.setPosition(386, 484); addCue.onClick = () => this._addCue(); this.add(addCue);
    const removeCue = new Button({ ...BUTTON, width: 92, height: 22, label: 'Remove last' });
    removeCue.setPosition(486, 484); removeCue.onClick = () => this._removeCue(); this.add(removeCue);

    const fresh = new Button({ ...BUTTON, width: 100, height: 24, label: 'New draft' });
    fresh.setPosition(18, 530); fresh.onClick = () => this._clear(); this.add(fresh);
    const save = new Button({ ...BUTTON, width: 130, height: 24, label: 'Save draft' });
    save.setPosition(170, 530); save.onClick = () => this._save(); this.add(save);
    const publish = new Button({ ...BUTTON, width: 140, height: 24, label: 'Validate & publish' });
    publish.setPosition(320, 530); publish.onClick = () => this._publish(); this.add(publish);
    const close = new Button({ ...BUTTON, width: 100, height: 24, label: 'Close' });
    close.setPosition(502, 530); close.onClick = () => this.close(); this.add(close);

    this._unsub = bus.on('nodeuo:spell-composer', (message) => {
      if (message?.kind !== NodeUOSpellComposerMessage.Result) return;
      if ((message.requestId >>> 0) !== this.requestId) return;
      if (message.payload?.ok) {
        const saved = message.payload.draft;
        const index = this.drafts.findIndex((draft) => draft.id === saved.id);
        if (index >= 0) this.drafts[index] = saved; else this.drafts.push(saved);
        this._draftPicker.setValues(this.drafts.map((draft) => draft.name));
        this._draftPicker.setValue(saved.name, { silent: true });
        this._status.setText(message.payload.published
          ? `Published ${saved.name}. Server balance checks passed.`
          : `Saved ${saved.name}. Draft is inert until publication.`);
      } else {
        this._status.setText(`Rejected: ${(message.payload?.errors ?? ['invalid draft']).join(' ')}`);
      }
    });
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
    const combo = new Combobox({ values, value, width, height: 22, onChange });
    combo.setPosition(x, y); this.add(combo); return combo;
  }

  _number(input) {
    return Number.parseInt(input.value, 0) || 0;
  }

  _draft() {
    return {
      name: this._name.value,
      school: this._school._value,
      target: this._target._value,
      mana: this._number(this._mana),
      range: this._number(this._range),
      castTimeMs: this._number(this._castTime),
      cooldownMs: this._number(this._cooldown),
      effect: {
        type: this._effect._value,
        element: this._element._value,
        amount: this._number(this._amount),
        durationMs: this._number(this._duration),
        graphic: this._number(this._graphic),
        hue: this._number(this._hue),
      },
      area: {
        shape: this._shape._value,
        radius: this._number(this._radius),
        angle: this._number(this._angle),
      },
      sequence: this._sequence.map((cue) => ({ ...cue })),
    };
  }

  _drawAreaPreview() {
    if (!this._areaPreview) return;
    const graphic = this._areaPreview;
    const shape = this._shape?._value ?? 'single';
    const radius = Math.max(1, Math.min(12, this._number(this._radius ?? { value: '1' })));
    const size = 4 + radius * 1.5;
    const cx = 570, cy = 58;
    graphic.clear();
    graphic.circle(cx, cy, 3).fill({ color: 0xffe080, alpha: 1 });
    if (shape === 'circle') {
      graphic.circle(cx, cy, size).fill({ color: 0x4ca6ff, alpha: 0.2 })
        .stroke({ width: 1, color: 0x8fc8ff, alpha: 0.9 });
    } else if (shape === 'cone') {
      const angle = Math.max(15, Math.min(180, this._number(this._angle ?? { value: '90' }))) * Math.PI / 180;
      graphic.moveTo(cx, cy).arc(cx, cy, size, -angle / 2, angle / 2).closePath()
        .fill({ color: 0xff7b42, alpha: 0.24 }).stroke({ width: 1, color: 0xffb080 });
    } else if (shape === 'line') {
      graphic.roundRect(cx, cy - 3, size + 8, 6, 2)
        .fill({ color: 0x9d76ff, alpha: 0.28 }).stroke({ width: 1, color: 0xc8b0ff });
    } else {
      graphic.circle(cx, cy, 6).stroke({ width: 1, color: 0xffe080, alpha: 0.9 });
    }
  }

  _addCue() {
    if (this._sequence.length >= 16) {
      this._status.setText('Timeline limit: 16 cues.');
      return;
    }
    const kind = this._cueKind._value;
    const asset = this._number(this._cueAsset);
    this._sequence.push({
      atMs: Math.max(0, this._number(this._cueAt)), kind,
      graphic: kind === 'visual' ? asset : 0,
      sound: kind === 'sound' ? asset : 0,
      hue: kind === 'visual' ? this._number(this._cueHue) : 0,
    });
    this._sequence.sort((a, b) => a.atMs - b.atMs);
    this._rebuildTimeline();
  }

  _removeCue() {
    this._sequence.pop();
    this._rebuildTimeline();
  }

  _rebuildTimeline() {
    for (const row of this._timelineRows) {
      this._timeline.remove?.(row);
      row.dispose?.();
    }
    this._timelineRows = [];
    let y = 0;
    for (const cue of this._sequence) {
      const asset = cue.kind === 'sound' ? cue.sound : cue.graphic;
      const label = new Label(
        `${String(cue.atMs).padStart(5)} ms  ${cue.kind.padEnd(6)}  0x${(asset | 0).toString(16).padStart(4, '0')}${cue.hue ? `  hue 0x${cue.hue.toString(16)}` : ''}`,
        { fontSize: 10, hue: cue.kind === 'sound' ? 0x9fd5ff : 0xffc27d },
      );
      label.setPosition(4, y); this._timeline.add?.(label); this._timelineRows.push(label); y += 18;
    }
    this._timeline.setContentHeight?.(Math.max(88, y));
  }

  _save() {
    this._status.setText('Validating on server…');
    this._send(NodeUOSpellComposerMessage.Save);
  }

  _publish() {
    this._status.setText('Running publication and balance checks…');
    this._send(NodeUOSpellComposerMessage.Publish);
  }

  _send(kind) {
    try {
      net.send(extNodeUOSpellComposer({
        kind,
        requestId: this.requestId,
        payload: this._draft(),
      }));
    } catch (error) {
      this._status.setText(`Send failed: ${error?.message ?? error}`);
    }
  }

  _loadDraft(draft) {
    if (!draft) return;
    this._name.setValue(draft.name ?? '');
    this._school.setValue(draft.school ?? 'custom');
    this._target.setValue(draft.target ?? 'mobile');
    this._mana.setValue(String(draft.mana ?? 0));
    this._range.setValue(String(draft.range ?? 0));
    this._castTime.setValue(String(draft.castTimeMs ?? 0));
    this._cooldown.setValue(String(draft.cooldownMs ?? 0));
    this._effect.setValue(draft.effect?.type ?? 'damage');
    this._element.setValue(draft.effect?.element ?? 'physical');
    this._amount.setValue(String(draft.effect?.amount ?? 0));
    this._duration.setValue(String(draft.effect?.durationMs ?? 0));
    this._graphic.setValue(`0x${(draft.effect?.graphic ?? 0).toString(16)}`);
    this._hue.setValue(`0x${(draft.effect?.hue ?? 0).toString(16)}`);
    this._shape.setValue(draft.area?.shape ?? 'single');
    this._radius.setValue(String(draft.area?.radius ?? 0));
    this._angle.setValue(String(draft.area?.angle ?? 0));
    this._sequence = Array.isArray(draft.sequence) ? draft.sequence.map((cue) => ({ ...cue })) : [];
    this._rebuildTimeline();
  }

  _clear() {
    this._draftPicker.setValue('New spell', { silent: true });
    this._name.setValue('');
    this._sequence = [];
    this._rebuildTimeline();
    this._status.setText('New inert draft. Fill the fields and validate it on the server.');
  }

  tick() {
    const draft = this._draft();
    const preview = { range: draft.range, target: draft.target, area: draft.area };
    const signature = JSON.stringify(preview);
    if (signature === this._previewSignature) return;
    this._previewSignature = signature;
    bus.emit('spell-composer:range-preview', preview);
  }

  dispose() {
    bus.emit('spell-composer:range-preview', null);
    this._unsub?.();
    super.dispose?.();
  }
}
