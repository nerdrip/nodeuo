// ChatGump — port of ClassicUO `Game/UI/Gumps/ChatGump.cs`. Lists
// joined channels with join / leave + history view. The actual input
// stays in the game-scene SystemChatControl bar — this gump is the
// channel manager.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { chatManager } from '../../managers/chat-manager.js';
import { bus } from '../../core/event-bus.js';

const STANDARD = ['general', 'trade', 'help', 'roleplay', 'off-topic'];

export class ChatGump extends WindowGump {
  constructor() {
    super({ title: 'Chat Channels', width: 330, height: 340, x: 160, y: 160 });
    this._scroll = new ScrollArea({ width: 310, height: 212 });
    this.addContent(this._scroll, 8, 28);
    this._rows = [];
    this._channelsScratch = [];

    this._input = new TextInput({ width: 226, height: 24, placeholder: 'channel name' });
    this._input.setPosition(8, 254);
    this.add(this._input);

    const join = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      buttonId: 0, action: ButtonAction.Activate,
      width: 76, height: 22, label: 'Join',
    });
    join.setPosition(242, 255);
    join.onClick = () => {
      const v = (this._input.value || '').trim().toLowerCase();
      if (!v) return;
      chatManager.join(v);
      this._input.value = '';
    };
    this.add(join);

    this._unsubs = [bus.on?.('chat:channels-changed', () => this._render())];
    this._render();
  }
  get type() { return 'chat'; }
  dispose() { for (const u of this._unsubs ?? []) u?.(); super.dispose?.(); }

  _render() {
    const channels = this._channelsScratch;
    channels.length = 0;
    for (const c of STANDARD) channels.push(c);
    for (const c of chatManager.joined) {
      if (!channels.includes(c)) channels.push(c);
    }
    channels.sort();
    let y = 0;
    let used = 0;
    for (const c of channels) {
      const row = this._acquireRow(used++);
      const isJoined = chatManager.joined.has(c);
      row.label.setText(`#${c}`);
      row.label.setHue(isJoined ? 0xFFE060 : 0x808080);
      row.label.setPosition(8, y + 4);
      row.button.setLabel(isJoined ? 'Leave' : 'Join');
      row.button.setPosition(232, y + 1);
      row.button.onClick = () => isJoined ? chatManager.leave(c) : chatManager.join(c);
      row.label.node.visible = true;
      row.button.node.visible = true;
      y += 24;
    }
    for (let i = used; i < this._rows.length; i++) {
      this._rows[i].label.node.visible = false;
      this._rows[i].button.node.visible = false;
    }
    this._scroll.setContentHeight?.(y);
  }

  _acquireRow(index) {
    let row = this._rows[index];
    if (!row) {
      const label = new Label('', { fontSize: 12, hue: 0x808080 });
      label.acceptMouseInput = false;
      const button = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        buttonId: 0, action: ButtonAction.Activate,
        width: 60, height: 18, label: '',
      });
      row = { label, button };
      this._rows[index] = row;
      this._scroll.add(label);
      this._scroll.add(button);
    }
    return row;
  }
}
