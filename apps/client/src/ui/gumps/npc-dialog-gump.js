// NpcDialogGump — NodeUO's negotiated visual-novel interaction surface.
//
// It is deliberately not used for a normal UO connection. Only a server that
// negotiated the private NpcDialog capability can send this window; ServUO,
// RunUO and other shards keep their ordinary 0x06/gump/speech behaviour.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { ColorBox } from '../controls/color-box.js';
import { AnimatedCharacterFrame } from '../controls/animated-character-frame.js';
import { TextInput } from '../controls/text-input.js';
import { NodeUOJsonKind, NodeUONpcDialogMessage } from '@uo/nodeuo-protocol';
import { clientGumpDefinitions } from '../../managers/client-gump-definitions.js';
import { net } from '../../net/net-client.js';
import { world } from '../../world/world.js';
import { bus } from '../../core/event-bus.js';

const WIDTH = 780;
const HEIGHT = 390;
const ACTION_H = 30;
const ACTION_GLYPH = Object.freeze({
  talk: '◆', trade: '◈', service: '●', character: '◇',
});

function screenPosition() {
  const viewW = globalThis.innerWidth || 1024;
  const viewH = globalThis.innerHeight || 768;
  return {
    x: Math.max(12, Math.round((viewW - WIDTH) / 2)),
    y: Math.max(24, viewH - HEIGHT - 42),
  };
}

function equipmentFrom(payload) {
  if (Array.isArray(payload?.portrait?.equipment)) return payload.portrait.equipment;
  const mob = world.mobiles.get(payload?.npcSerial >>> 0);
  return [...(mob?.equipment?.entries?.() ?? [])].map(([layer, item]) => ({ layer, ...item }));
}

export class NpcDialogGump extends WindowGump {
  constructor({ requestId = 0, payload = {} } = {}) {
    const pos = screenPosition();
    super({ title: 'Conversation', width: WIDTH, height: HEIGHT, x: pos.x, y: pos.y });
    this.requestId = requestId >>> 0;
    this.npcSerial = payload.npcSerial >>> 0;
    this._closeSent = false;
    this._actionControls = [];
    this._bg.setLayoutId('window-background');
    this._title.setLayoutId('window-title');

    // A dark cinematic layer on top of the regular UO parchment frame keeps
    // long dialogue readable while retaining the same draggable gump shell.
    this._cinema = this._add(new ColorBox({
      width: WIDTH - 16, height: HEIGHT - 33,
      color: 0x0c0a08, alpha: 0.94, borderColor: 0xb58a42,
    }), 'cinema-panel', 8, 25);

    this._portraitPanel = this._add(new ColorBox({
      width: 202, height: 326,
      color: 0x17110b, alpha: 0.96, borderColor: 0x8f6a31,
    }), 'portrait-panel', 18, 38);

    this._portrait = new AnimatedCharacterFrame({
      width: 190, height: 312, drawFrame: false, scale: 2.7,
      body: payload?.portrait?.body ?? 0x190,
      hue: payload?.portrait?.hue ?? 0,
      equipment: equipmentFrom(payload),
      direction: 4,
    });
    this._add(this._portrait, 'npc-portrait', 24, 44);

    this._name = new Label('', { fontSize: 18, hue: 0xffd77d, fontWeight: 700 });
    this._add(this._name, 'npc-name', 240, 39);
    this._role = new Label('', { fontSize: 10, hue: 0xbfa875 });
    this._add(this._role, 'npc-title', 241, 64);
    this._historyButton = new Button({
      normalGumpId: 0, pressedGumpId: 0, flat: true, width: 72, height: 22,
      label: 'History', action: ButtonAction.Activate,
    });
    this._historyButton.onClick = () => {
      this._historyMode = !this._historyMode;
      this._historyButton.setLabel(this._historyMode ? 'Current' : 'History');
      this._renderDialogue();
    };
    this._add(this._historyButton, 'dialogue-history', 682, 43);

    this._dialoguePanel = this._add(new ColorBox({
      width: 528, height: 132,
      color: 0x20170e, alpha: 0.92, borderColor: 0x6f532a,
    }), 'dialogue-panel', 232, 84);
    this._dialogue = new Label('', {
      fontSize: 13, hue: 0xffedc0, maxWidth: 496, wordWrap: true, lineHeight: 19,
    });
    this._add(this._dialogue, 'dialogue-text', 248, 99);

    this._hint = new Label('Choose a response or service:', { fontSize: 10, hue: 0xbfa875 });
    this._add(this._hint, 'action-hint', 240, 226);
    this._actions = new ScrollArea({ width: 520, height: 116 });
    this._add(this._actions, 'action-list', 240, 244);

    if (net.supportsNodeUO?.('npc.generative')) {
      this._askInput = new TextInput({ width: 410, height: 22, maxLength: 1000,
        placeholder: 'Ask the character in your own words…', fontSize: 11 });
      this._askInput.onSubmit = () => this._askGenerated();
      this._add(this._askInput, 'generative-prompt', 240, 220);
      this._askButton = new Button({ normalGumpId: 0, pressedGumpId: 0, flat: true,
        width: 100, height: 22, label: 'Ask', action: ButtonAction.Activate });
      this._askButton.onClick = () => this._askGenerated();
      this._add(this._askButton, 'generative-submit', 656, 220);
      this._hint.setPosition(240, 247);
      this._actions.setPosition(240, 263);
      this._actions.height = 97;
    }
    this._unsubGenerated = bus.on('nodeuo:npc-generated', (line) => {
      if (!line?.ok || (line.npcSerial >>> 0) !== this.npcSerial) return;
      const history = [...(this._payload?.history ?? []), {
        speaker: line.speaker ?? this._payload?.name ?? 'NPC', text: line.text, generated: true,
      }].slice(-16);
      this._payload = { ...this._payload, history, dialogue: {
        ...(this._payload?.dialogue ?? {}), text: line.text, expression: line.expression,
      } };
      this._historyMode = false;
      this._renderDialogue();
      this._role.setText([this._payload.title, line.expression].filter(Boolean).join(' · '));
      this._hint.setText('Generated line received; scripted services remain server-authoritative.');
    });

    this.applyMessage({ requestId, payload });
  }

  get type() { return 'npc-dialog'; }
  get positionKey() { return 'npc-dialog'; }

  applyMessage({ requestId = this.requestId, payload = {} } = {}) {
    this.requestId = requestId >>> 0;
    this.npcSerial = payload.npcSerial >>> 0;
    this._closeSent = false;
    this._name.setText(payload.name || 'Unknown');
    this._role.setText([payload.title, payload.dialogue?.expression].filter(Boolean).join(' · '));
    this._payload = payload;
    this._historyMode = false;
    this._historyButton.setLabel('History');
    this._renderDialogue();
    this._portrait.setAppearance({
      body: payload?.portrait?.body ?? this._portrait.body,
      hue: payload?.portrait?.hue ?? this._portrait.hue,
      equipment: equipmentFrom(payload),
    });
    this._rebuildActions(payload.actions ?? [], !!payload.dialogue?.terminal);
    // The first pass is handled by UIManager after construction. Later
    // server messages replace action buttons, so reapply only control
    // overrides to the freshly built tree without resetting a dragged frame.
    if (this._uiManager) {
      clientGumpDefinitions.applyControls(this);
      this._syncActionContentHeight();
    }
  }

  _renderDialogue() {
    const payload = this._payload ?? {};
    if (!this._historyMode) {
      const rewards = (payload.dialogue?.rewards ?? []).map((entry) => entry.label ?? entry.name ?? entry.type).filter(Boolean);
      this._dialogue.setText(`${payload.dialogue?.text || '…'}${rewards.length ? `\nRewards: ${rewards.join(', ')}` : ''}`);
      return;
    }
    this._dialogue.setText((payload.history ?? []).slice(-6)
      .map((entry) => `${entry.speaker || 'NPC'}: ${entry.text || ''}`).join('\n') || 'No previous lines.');
  }

  _rebuildActions(actions, terminal) {
    this._actions.beginBulkUpdate?.();
    for (const control of this._actionControls) {
      this._actions.remove(control);
      control.dispose?.();
    }
    this._actionControls.length = 0;
    let y = 0;
    for (const [index, action] of actions.slice(0, 24).entries()) {
      const kind = action.kind || 'service';
      const button = new Button({
        normalGumpId: 0, pressedGumpId: 0, flat: true,
        width: 492, height: ACTION_H - 3,
        label: `${ACTION_GLYPH[kind] ?? '•'}  ${action.label || 'Continue'}${action.skillCheck ? ` [skill ${action.skillCheck.skillId}]` : ''}`,
        action: ButtonAction.Activate,
      });
      button.setLayoutId(`action-${index + 1}`);
      button.setPosition(0, y);
      button.enabled = action.enabled !== false;
      button.onClick = () => { if (button.enabled) this._select(action.id); };
      if (!button.enabled && action.reason) button.setLabel(`×  ${action.label} — ${action.reason}`);
      this._actions.add(button);
      this._actionControls.push(button);
      y += ACTION_H;
    }
    this._actions.endBulkUpdate?.();
    this._actions.setContentHeight(y);
    this._actions.scrollTo?.(0);
    this._hint.setText(actions.length
      ? (terminal ? 'The conversation has ended. Other actions:' : 'Choose a response or service:')
      : 'There is nothing more to discuss.');
  }

  onClientGumpDefinitionApplied() {
    this._syncActionContentHeight();
  }

  _syncActionContentHeight() {
    const bottom = this._actionControls.reduce(
      (max, control) => Math.max(max, control.y + control.height), 0,
    );
    this._actions.setContentHeight(bottom);
  }

  _add(control, id, x, y) {
    control.setLayoutId(id);
    control.setPosition(x, y);
    this.add(control);
    return control;
  }

  _select(actionId) {
    if (!actionId) return;
    try {
      const payload = { actionId: String(actionId) };
      net.sendNodeUOMessage({
        kind: NodeUOJsonKind.Event, feature: 'npc.dialog',
        payload: { operation: 'select', eventKind: NodeUONpcDialogMessage.Select,
          requestId: this.requestId, data: payload },
      });
    } catch {
      this._hint.setText('The connection closed before your choice was sent.');
    }
  }

  async _askGenerated() {
    const prompt = String(this._askInput?.value ?? '').trim();
    if (!prompt || !net.supportsNodeUO?.('npc.generative')) return;
    this._askButton.enabled = false;
    this._hint.setText('The character considers your question…');
    try {
      const result = await net.sendNodeUORequest({ capability: 'npc.generative',
        payload: { prompt }, timeoutMs: 15_000, ttlMs: 15_000,
        idempotencyKey: `npc:${this.requestId}:${Date.now()}` });
      if (!result?.ok) this._hint.setText(result?.error ?? 'The character has no answer.');
      else this._askInput.setValue('');
    } catch (error) { this._hint.setText(error?.message ?? 'Dialogue request failed.'); }
    finally { this._askButton.enabled = true; }
  }

  closeFromServer() {
    this._closeSent = true;
    super.close();
  }

  close() {
    if (!this._closeSent) {
      this._closeSent = true;
      try {
        const payload = { npcSerial: this.npcSerial };
        net.sendNodeUOMessage({
          kind: NodeUOJsonKind.Event, feature: 'npc.dialog',
          payload: { operation: 'close', eventKind: NodeUONpcDialogMessage.Close,
            requestId: this.requestId, data: payload },
        });
      } catch { /* transient disconnect */ }
    }
    super.close();
  }

  dispose() {
    this._unsubGenerated?.();
    super.dispose();
  }
}
