// NameOverheadPopupGump — per-mob draggable name plate. Mirrors CUO
// `Game/UI/Gumps/NameOverheadGump.cs`. Triggered when the user
// LMB-clicks the overhead name in the world; produces a small panel
// the player can drag to the side and right-click to open the mob's
// context menu without re-clicking the world sprite.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import {
  buildAttackReq, buildUseReq, buildLookReq, buildPopupMenuRequest,
} from '../../net/outgoing.js';
import { world } from '../../world/world.js';
import { NOTORIETY_HUE } from '../../shared/notoriety-hues.js';

export class NameOverheadPopupGump extends WindowGump {
  constructor(serial) {
    const mob = world.mobiles?.get?.(serial >>> 0);
    const name = mob?.name || `Serial 0x${(serial >>> 0).toString(16)}`;
    const noto = mob?.notoriety ?? 1;
    super({ title: name, width: 200, height: 72, x: 250, y: 200 });
    this.serial = serial >>> 0;

    const nameLbl = new Label(name, {
      fontSize: 12, hue: NOTORIETY_HUE[noto] ?? 0xfff0c0, stroke: true,
    });
    nameLbl.setPosition(10, 26);
    this.add(nameLbl);

    // Quick-action row: Attack / Use / Look / Menu.
    const ACTIONS = [
      ['Atk',  () => net.send(buildAttackReq(this.serial))],
      ['Use',  () => net.send(buildUseReq(this.serial))],
      ['Look', () => net.send(buildLookReq(this.serial))],
      ['Menu', () => net.send(buildPopupMenuRequest(this.serial))],
    ];
    let x = 8;
    for (const [label, fn] of ACTIONS) {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 42, height: 18, label, action: ButtonAction.Activate,
      });
      b.setPosition(x, 48);
      b.onClick = () => { try { fn(); } catch { /* socket */ } };
      this.add(b);
      x += 46;
    }
  }
  get type() { return 'name-overhead-popup'; }
}
