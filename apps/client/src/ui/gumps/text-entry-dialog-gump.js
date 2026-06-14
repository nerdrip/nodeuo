// TextEntryDialogGump — server-driven text-entry prompt (0xAB).
//
// The server sends 0xAB with a title + prompt + maxLen. We render a small
// modal-ish window with a TextInput and OK/Cancel buttons; pressing OK
// returns 0xAC with response=1 + entered text, Cancel returns response=0
// with empty text. Mirrors CUO `TextEntryDialogGump.cs`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { buildTextEntryResponse } from '../../net/outgoing.js';

export class TextEntryDialogGump extends WindowGump {
  /**
   * @param {{serial:number, parentId:number, buttonId:number, maxLen:number, title:string, prompt:string}} info
   */
  constructor(info) {
    super({ title: 'Input', width: 320, height: 160, x: 200, y: 150 });
    this.info = info;

    const promptLbl = new Label(info.prompt || '', { fontSize: 11, hue: 0xfff0c0 });
    this.addContent(promptLbl, 12, 30);

    this._input = new TextInput({
      width: 296, height: 22, multiLine: false,
      maxLength: info.maxLen || 64, text: info.defaultText ?? '',
    });
    this.addContent(this._input, 12, 60);

    const ok = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22,
      label: 'OK', action: ButtonAction.Activate,
    });
    ok.setPosition(80, 110);
    ok.onClick = () => this._reply(true);
    this.add(ok);

    const cancel = new Button({
      normalGumpId: 0x0483, pressedGumpId: 0x0484,
      width: 60, height: 22,
      label: 'Cancel', action: ButtonAction.Activate,
    });
    cancel.setPosition(180, 110);
    cancel.onClick = () => this._reply(false);
    this.add(cancel);
  }

  get type() { return 'text-entry-dialog'; }

  _reply(ok) {
    net.send(buildTextEntryResponse({
      serial:   this.info.serial,
      parentId: this.info.parentId,
      buttonId: this.info.buttonId,
      ok,
      text:     ok ? this._input.value : '',
    }));
    this.close();
  }
}
