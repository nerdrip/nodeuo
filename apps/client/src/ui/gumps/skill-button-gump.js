// SkillButtonGump — single-skill quick-button. Mirrors ClassicUO's
// `Game/UI/Gumps/SkillButtonGump.cs`. Drag a skill row out of the
// SkillsGump and a small floating button drops to your screen — click
// it to use the skill (0x12 TextCommand "<skill name>"). The button
// remembers its position per-character and can be docked next to the
// hotbar / spellbook.

import { Gump } from '../gump.js';
import { Label } from '../controls/label.js';
import { Graphics } from 'pixi.js';
import { net } from '../../net/net-client.js';
import { buildUseSkill } from '../../net/outgoing.js';
import { profile } from '../../managers/profile-manager.js';
import { skillIdFromName } from '../../shared/skill-ids.js';

const SIZE = 44;

export class SkillButtonGump extends Gump {
  /** @param {{ id:number, name:string }} skill */
  constructor(skill, x = 200, y = 200) {
    super();
    this.skill = skill;
    const saved = profile.loadGumpState(`skill-btn:${skill.id}`) ?? {};
    this.node.x = saved.x ?? x;
    this.node.y = saved.y ?? y;
    this.acceptMouseInput = true;
    this.isDragHandle = true;
    this.width = SIZE;
    this.height = SIZE;

    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._gfx.roundRect(0, 0, SIZE, SIZE, 4)
      .fill({ color: 0x1a1d2a, alpha: 0.9 })
      .stroke({ width: 1, color: 0x6a4a18 });

    // Short label — first 5 chars of the skill name (e.g. "Magery" → "Mage").
    this._lbl = new Label((skill.name || '?').slice(0, 5), { fontSize: 10, hue: 0xfff0c0, stroke: true });
    this._lbl.setPosition(4, SIZE - 14);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);

    this.node.on?.('pointerup', () => this._save());
  }

  get type() { return `skill-btn:${this.skill.id}`; }

  _save() {
    profile.saveGumpState(`skill-btn:${this.skill.id}`, {
      x: this.node.x | 0, y: this.node.y | 0,
    });
  }

  onClick(btn) {
    if (btn !== 0) return;
    const skillId = skillIdFromName(this.skill.name) ?? ((this.skill.id | 0) + 1);
    try { net.send(buildUseSkill(skillId)); }
    catch { /* socket transient */ }
  }
}
