// UseAbilityButtonGump — floating hotbar shortcut for one weapon
// special-ability slot. Mirrors ClassicUO
// `Game/UI/Gumps/UseAbilityButtonGump.cs`. Drag a slot out of the
// CombatBookGump and we spawn one of these gumps at the drop point.
// Click the icon → fires `[wpn primary` or `[wpn secondary` (queued
// special, consumed on the next swing — same path as the war-mode
// ability bar which already uses `state.queuedAbility`).

import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { ItemPic } from '../controls/item-pic.js';
import { Label } from '../controls/label.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand } from '../../net/outgoing.js';
import { tooltips } from '../../managers/tooltip-manager.js';

const ICON = 44;

class HotbarIcon extends Control {
  constructor(slot, ability) {
    super();
    this.slot = slot;     // 'primary' | 'secondary'
    this.ability = ability;
    this.width = ICON;
    this.height = ICON;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    const iconId = ability?.icon ?? (slot === 'primary' ? 0x09F8 : 0x09FB);
    this._pic = new ItemPic(iconId, { hue: 0 });
    this._pic.acceptMouseInput = false;
    this._pic.setPosition(2, 2);
    this.add(this._pic);
    // Tiny "1" / "2" badge in the corner so the user can tell two
    // adjacent ability buttons apart at a glance.
    const badge = new Label(slot === 'primary' ? '1' : '2',
      { fontSize: 9, hue: 0xFFE060 });
    badge.setPosition(ICON - 9, ICON - 13);
    badge.acceptMouseInput = false;
    this.add(badge);
  }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, ICON, ICON)
      .fill({ color: hover ? 0x3a4660 : 0x14263e, alpha: 0.9 })
      .stroke({ width: 2, color: hover ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter(e) {
    this._draw(true);
    const name = this.ability?.name ?? this.slot;
    tooltips.showText(e.global.x, e.global.y,
      `${this.slot === 'primary' ? 'Primary' : 'Secondary'}: ${name}`);
  }
  onMouseLeave() { this._draw(false); tooltips.hide(); }
  onClick() {
    try { net.send(buildTextCommand(0x12, `wpn ${this.slot}`)); }
    catch { /* socket transient */ }
  }
}

export class UseAbilityButtonGump extends Gump {
  /** @param {'primary'|'secondary'} slot */
  constructor(slot, ability, x = 240, y = 240) {
    super();
    this.setPosition(x, y);
    this.setSize(ICON, ICON);
    this.slot = slot;
    const icon = new HotbarIcon(slot, ability);
    icon.isDragHandle = true;
    this.add(icon);
  }
  get type() { return `use-ability:${this.slot}`; }
}
