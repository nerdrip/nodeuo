// ProfileGump — display a mobile's profile (header + title + body).
// Server-driven: opened on 0xB8 reply (decodeCharacterProfile). The
// "title" line is the player-set tagline; "body" is the long bio text.
// CUO mirrors `Game/UI/Gumps/ProfileGump.cs`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { buildGumpResponse, buildProfileUpdate } from '../../net/outgoing.js';

export class ProfileGump extends WindowGump {
  /** @param {{serial:number, header:string, title:string, body:string,
   *           editable?:boolean}} info */
  constructor(info) {
    super({ title: info.header || 'Profile', width: 400, height: 320, x: 200, y: 120 });
    this.info = info;

    if (info.title) {
      const t = new Label(`"${info.title}"`, { fontSize: 11, hue: 0xfff0c0 });
      this.addContent(t, 12, 30);
    }

    // Body is multi-line; render as a wrapped Label-set inside a
    // ScrollArea so long bios don't overflow the gump.
    const scroll = new ScrollArea({ width: 376, height: 220 });
    this.addContent(scroll, 12, 50);
    const body = String(info.body || '').replace(/\r/g, '');
    const lines = body.split('\n');
    let y = 0;
    for (const line of lines) {
      const lbl = new Label(line, { fontSize: 11, hue: 0xfff0c0 });
      lbl.setPosition(0, y);
      scroll.add(lbl);
      y += 16;
    }
    scroll.setContentSize?.(360, y);

    if (info.editable) {
      // Small text-input + save button so the player can edit their
      // own profile body. Server reads back via 0xB8 buttonId=1.
      this._editor = new TextInput({
        width: 376, height: 60, multiLine: true, maxLength: 1024, text: body,
      });
      this.addContent(this._editor, 12, 50);
      const save = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 60, height: 22,
        label: 'Save', action: ButtonAction.Activate,
      });
      save.setPosition(330, 290);
      save.onClick = () => {
        // Audit #35 F1 — CUO `ProfileGump.cs:219` calls
        // `Send_ProfileUpdate(LocalSerial, _textBox.Text)` which writes
        // 0xB8 (op + serial + writeFlag=1 + 0x0000 + UnicodeBE body).
        // Was emitting a 0xB1 gump response that the server profile-
        // save path doesn't listen to — text dropped silently.
        try { net.send(buildProfileUpdate(this.info.serial, this._editor.value)); }
        catch { /* socket transient */ }
        void buildGumpResponse;     // kept imported for sibling gumps
        this.close();
      };
      this.add(save);
    }
  }

  get type() { return `profile:${this.info.serial}`; }
  get positionKey() { return 'profile'; }
}
