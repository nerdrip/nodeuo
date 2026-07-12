// PetTrainingGump — trick / ability selection for trained pets.
// ServUO `Services/Pet Training/PetTrainingGump.cs`. Faza F.3.11.
//
// Renders a list of tricks/abilities the player may invest training
// points into. Selecting a trick sends `[pet train <name>` to the
// server, which deducts points and applies the bonus.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const DEFAULT_TRICKS = [
  { key: 'extra-damage',   label: 'Extra Damage (+5 melee)',         cost: 1 },
  { key: 'extra-hp',       label: 'Extra HP (+200)',                  cost: 1 },
  { key: 'extra-armor',    label: 'Extra Armor (+10 phys resist)',    cost: 1 },
  { key: 'magic-resist',   label: 'Magic Resist (+10 all elemental)', cost: 2 },
  { key: 'fast-attacks',   label: 'Fast Attacks (-200ms swing)',      cost: 2 },
  { key: 'wrestling-100',  label: 'Wrestling 100',                    cost: 1 },
  { key: 'anatomy-100',    label: 'Anatomy 100',                      cost: 1 },
  { key: 'magery-100',     label: 'Magery 100 (pet caster)',          cost: 3 },
  { key: 'fire-breath',    label: 'Fire Breath special',              cost: 3 },
  { key: 'poison-attack',  label: 'Poison Attack',                    cost: 2 },
];

export class PetTrainingGump extends WindowGump {
  /**
   * @param {{ ui?: any, net?: any, petSerial: number, availablePoints: number, tricks?: typeof DEFAULT_TRICKS }} opts
   */
  constructor(opts) {
    const tricks = opts.tricks ?? DEFAULT_TRICKS;
    super({ title: 'Pet Training', width: 360, height: 60 + 28 * tricks.length, x: 200, y: 120 });
    this._net = opts.net;
    this._petSerial = opts.petSerial >>> 0;
    this._learned = new Set(opts.learned ?? []);

    this.addContent(new Label(`Available points: ${opts.availablePoints}`, { fontSize: 11, hue: 0xffffa0 }), 12, 28);

    let y = 56;
    for (const t of tricks) {
      const learned = this._learned.has(t.key);
      const enough = !learned && opts.availablePoints >= t.cost;
      const lbl = new Label(`${t.label}  (${learned ? 'learned' : `${t.cost} pt`})`, { fontSize: 10, hue: learned ? 0x70d890 : enough ? 0xffffff : 0x808080 });
      this.addContent(lbl, 36, y + 4);
      const b = new Button({
        normalGumpId: enough ? 0x0481 : 0x0483, pressedGumpId: 0x0482,
        width: 14, height: 14,
        label: '+', action: ButtonAction.Activate,
      });
      b.setPosition(12, y);
      if (enough) b.onClick = () => { this._train(t.key); this.close(); };
      this.add(b);
      y += 28;
    }
  }

  _train(trickKey) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(`pet train ${trickKey} ${this._petSerial.toString(16)}`); } catch { /* */ }
    }
  }

  get type() { return 'pet-training'; }
}
