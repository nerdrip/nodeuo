// ChatGumpChooseName — first-time chat-handle picker. Mirrors CUO
// `Game/UI/Gumps/ChatGumpChooseName.cs`. Some shards require the
// player to set a chat alias before joining channels — this gump
// captures the choice and pushes it via `buildChatOpen`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { buildChatOpen } from '../../net/outgoing.js';
import { uiManager } from '../ui-manager.js';

export class ChatChooseNameGump extends WindowGump {
  constructor({ initial = '' } = {}) {
    super({ title: 'Choose Chat Name', width: 300, height: 140, x: 220, y: 220 });
    this._input = new TextInput({ width: 240, height: 22, fontSize: 12, maxLength: 30 });
    this._input.value = initial;
    this._input.setPosition(20, 40);
    this.add(this._input);

    const note = new Label('Choose your chat handle (4-30 chars):', { fontSize: 11, hue: 0xfff0c0 });
    note.setPosition(20, 22);
    this.add(note);

    const ok = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'OK', action: ButtonAction.Activate,
    });
    ok.setPosition(50, 80);
    ok.onClick = () => {
      const name = (this._input.value || '').trim();
      if (name.length < 4) return;
      try { net.send(buildChatOpen(name)); } catch { /* socket */ }
      this.close?.();
    };
    this.add(ok);

    const cancel = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Cancel', action: ButtonAction.Activate,
    });
    cancel.setPosition(160, 80);
    cancel.onClick = () => this.close?.();
    this.add(cancel);
  }
  get type() { return 'chat-choose-name'; }
}

/** Show the picker as a modal. */
export function showChatChooseName(opts = {}) {
  const g = new ChatChooseNameGump(opts);
  uiManager.addGump?.(g);
  try { uiManager.setModal?.(g); } catch { /* ignore */ }
  return g;
}
