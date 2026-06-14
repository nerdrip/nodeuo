// CraftGump — recipe browser for the [craft command
// (ServUO `Services/Craft/Gumps/CraftGump.cs`).
//
// Triggered by `[craft gump <skill>`. Server sends:
//   @@OPEN_CRAFT_GUMP@@<skill>|<skillVal>|id|name|skillId|min|max;…
//
// Up to 80 recipes are shown in a scrollable list. Each row has a
// "Make" button that dispatches `[craft <name>` and closes the gump.
// Skill check + ingredient consumption + tool charge are handled by
// the existing crafting pipeline (commands/crafting/craft.js).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';

const ROW_H = 24;

export class CraftGump extends WindowGump {
  /** @param {{ net?: any, skill?: string, skillVal?: number, recipes?: Array<{id,name,skillId,min,max}> }} opts */
  constructor(opts = {}) {
    const recipes = Array.isArray(opts.recipes) ? opts.recipes : [];
    const skill = opts.skill ?? 'all';
    const skillVal = Number(opts.skillVal) || 0;
    super({ title: `Crafting — ${skill}`, width: 520, height: 480, x: 200, y: 100 });
    this._net = opts.net;

    this.addContent(new Label(`Your skill: ${skillVal.toFixed(1)}`,
      { fontSize: 12, hue: 0xffe0a0 }), 12, 30);
    this.addContent(new Label(`${recipes.length} recipe(s)`,
      { fontSize: 10, hue: 0xa0a0a0 }), 200, 32);

    const listY = 56;
    const listH = 400;
    let scroll;
    try {
      scroll = new ScrollArea({ width: 500, height: listH, contentHeight: recipes.length * ROW_H + 8 });
      scroll.setPosition(8, listY);
      this.add(scroll);
    } catch { scroll = null; }

    recipes.forEach((r, i) => {
      const y = i * ROW_H;
      const canCraft = skillVal >= (r.min ?? 0);
      const nameHue = canCraft ? 0xffffff : 0x808080;
      const nameLabel = new Label(`${r.name}`, { fontSize: 11, hue: nameHue });
      const rangeLabel = new Label(`(${r.min}–${r.max})`, { fontSize: 9, hue: 0xa0a0a0 });
      nameLabel.acceptMouseInput = false;
      rangeLabel.acceptMouseInput = false;
      if (scroll) {
        nameLabel.setPosition(8, y);
        rangeLabel.setPosition(220, y + 2);
        scroll.add(nameLabel);
        scroll.add(rangeLabel);
      } else {
        this.addContent(nameLabel, 12, listY + y);
        this.addContent(rangeLabel, 220, listY + y + 2);
      }
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 90, height: 20,
        label: 'Make', action: ButtonAction.Activate,
      });
      b.enabled = canCraft;
      if (scroll) {
        b.setPosition(390, y - 2);
        scroll.add(b);
      } else {
        b.setPosition(390, listY + y - 2);
        this.add(b);
      }
      b.onClick = () => {
        if (!canCraft) return;
        this._sendCmd(`craft ${r.id}`);
        // Don't close — players typically craft in batches.
      };
    });
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'craft'; }
}

export function parseCraftPayload(raw) {
  if (!raw || typeof raw !== 'string') return { skill: 'all', skillVal: 0, recipes: [] };
  const idx1 = raw.indexOf('|');
  const idx2 = raw.indexOf('|', idx1 + 1);
  const skill = raw.slice(0, idx1);
  const skillVal = parseFloat(raw.slice(idx1 + 1, idx2));
  const rest = raw.slice(idx2 + 1);
  const recipes = rest.split(';').filter(Boolean).map((row) => {
    const [id, name, skillId, min, max] = row.split('|');
    return { id: id | 0, name, skillId: skillId | 0, min: min | 0, max: max | 0 };
  });
  return { skill, skillVal, recipes };
}
