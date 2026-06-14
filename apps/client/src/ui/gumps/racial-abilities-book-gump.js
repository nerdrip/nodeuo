// RacialAbilitiesBookGump — port of ClassicUO
// `Game/UI/Gumps/RacialAbilitiesBookGump.cs`. Multi-page book-style
// gump listing the racial abilities for the player's current race.
//
// Audit rev.9 P2 #2 — full coverage:
//   • Human (4 passive abilities — Strong Back / Tough / Workhorse /
//     Jack-of-All-Trades)
//   • Elf (5 abilities — Night Sight, Infused Wisdom, Difficult to
//     Track, Wisdom of the Elves, Knowledge of Nature)
//   • Gargoyle (5 abilities — Flying, Berserk, Master Artisan,
//     Mystic Insight, Deadly Aim)
// Plus book-pagination chrome (left/right corners 0x08BB/0x08BC) and
// open/close click sound. Clicking an ability sends the appropriate
// server command:
//   - Flying  → 0xBF 0x32 ToggleGargoyleFlying (existing builder)
//   - All other passive abilities → 0x24 text command `[racialAbility <id>`

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { GumpPic } from '../controls/gump-pic.js';
import { net } from '../../net/net-client.js';
import { buildToggleGargoyleFlying, buildTextCommand } from '../../net/outgoing.js';
import { bus } from '../../core/event-bus.js';

const HUMAN_ABILITIES = [
  { id: 'strong-back',   name: 'Strong Back',
    desc: 'Carries 60 stones more before becoming over-weight.' },
  { id: 'tough',         name: 'Tough',
    desc: '+5 to hit-point regeneration. Survive heavier hits.' },
  { id: 'workhorse',     name: 'Workhorse',
    desc: 'Tireless. Movement does not consume stamina as quickly.' },
  { id: 'jack-of-all-trades', name: 'Jack of All Trades',
    desc: 'Minimum skill of 20 for every non-locked, non-redhand skill.' },
];
const ELF_ABILITIES = [
  { id: 'night-sight',     name: 'Night Sight',
    desc: 'Permanent low-light vision. Identical to the Night-Sight spell.' },
  { id: 'infused-wisdom',  name: 'Infused Wisdom',
    desc: '+20 cap on the Magic Resistance + Mana-Stat bonus.' },
  { id: 'difficult-track', name: 'Difficult to Track',
    desc: 'Stealth-skill bonus against Tracking; harder for trackers to find.' },
  { id: 'wisdom-elves',    name: 'Wisdom of the Elves',
    desc: '+20 intelligence cap (210 vs 225 hardcap).' },
  { id: 'knowledge-nature',name: 'Knowledge of Nature',
    desc: 'Spawns +20 % more reagents from Botany resource gathers.' },
];
const GARGOYLE_ABILITIES = [
  { id: 'flying',          name: 'Flying',
    desc: 'Toggle hover-flight (pseudo-mount). Bypasses terrain on certain tiles.' },
  { id: 'berserk',         name: 'Berserk',
    desc: '+3 % damage per 20 missing hit-points (max +30 % at 1 HP).' },
  { id: 'master-artisan',  name: 'Master Artisan',
    desc: 'Crafting bonus + 5 % exceptional chance on Imbuing.' },
  { id: 'mystic-insight',  name: 'Mystic Insight',
    desc: '+5 % Spell Damage Increase cap.' },
  { id: 'deadly-aim',      name: 'Deadly Aim',
    desc: '+5 % Throwing speed; 10 % crit on Mysticism / Throwing combos.' },
];

const TABLE = {
  human:    HUMAN_ABILITIES,
  elf:      ELF_ABILITIES,
  gargoyle: GARGOYLE_ABILITIES,
};
// Book corners — `gump.mul` ids verified in CUO RacialAbilitiesBookGump.
const GUMP_BOOK_LEFT  = 0x08BB;
const GUMP_BOOK_RIGHT = 0x08BC;
const PAGE_HEIGHT = 4;     // abilities per page in CUO

export class RacialAbilitiesBookGump extends WindowGump {
  constructor(race = 'human') {
    super({ title: 'Racial Abilities', width: 360, height: 320, x: 200, y: 180 });
    this._race = String(race).toLowerCase();
    this._abilities = TABLE[this._race] ?? TABLE.human;
    this._page = 0;
    this._pageCount = Math.max(1, Math.ceil(this._abilities.length / PAGE_HEIGHT));

    // Book corners (decorative).
    try {
      const left  = new GumpPic({ gumpId: GUMP_BOOK_LEFT });
      left.setPosition(8, 16); this.add(left);
      const right = new GumpPic({ gumpId: GUMP_BOOK_RIGHT });
      right.setPosition(this.width - 28, 16); this.add(right);
    } catch { /* legacy renderer — fallback to plain labels */ }

    // Open-book SFX, mirrors CUO playSound 55.
    try { bus.emit('audio:sfx', { sound: 0x0055, x: 0, y: 0, z: 0, ambient: true }); } catch { /* ignore */ }

    this._head = new Label(`Race: ${this._race.charAt(0).toUpperCase() + this._race.slice(1)}`, { fontSize: 13, hue: 0xFFE060 });
    this._head.setPosition(18, 28); this.add(this._head);

    this._pageLbl = new Label('', { fontSize: 11, hue: 0xa0a0a0 });
    this._pageLbl.setPosition(this.width - 70, this.height - 24); this.add(this._pageLbl);

    // Prev / Next book-page arrows.
    this._prev = new Button({
      normalGumpId: 0x0FAE, pressedGumpId: 0x0FAF,
      action: ButtonAction.Activate, width: 14, height: 12, label: '◀',
    });
    this._prev.setPosition(14, this.height - 26);
    this._prev.onClick = () => this._setPage(this._page - 1);
    this.add(this._prev);

    this._next = new Button({
      normalGumpId: 0x0FAC, pressedGumpId: 0x0FAD,
      action: ButtonAction.Activate, width: 14, height: 12, label: '▶',
    });
    this._next.setPosition(30, this.height - 26);
    this._next.onClick = () => this._setPage(this._page + 1);
    this.add(this._next);

    this._abilityNodes = [];
    this._renderPage();
  }

  get type() { return 'racial-abilities'; }

  _setPage(p) {
    const clamped = Math.max(0, Math.min(this._pageCount - 1, p));
    if (clamped === this._page) return;
    this._page = clamped;
    this._renderPage();
  }

  _renderPage() {
    // Tear down previous page's labels/buttons.
    for (const node of this._abilityNodes) {
      try { this.remove?.(node); } catch { /* ignore */ }
    }
    this._abilityNodes = [];

    const start = this._page * PAGE_HEIGHT;
    const slice = this._abilities.slice(start, start + PAGE_HEIGHT);
    if (slice.length === 0) {
      const note = new Label('No racial abilities on this page.', { fontSize: 12, hue: 0xfff0c0 });
      note.setPosition(40, 60); this.add(note);
      this._abilityNodes.push(note);
    } else {
      let y = 56;
      for (const a of slice) {
        const name = new Label(a.name, { fontSize: 13, hue: 0xfff0c0 });
        name.setPosition(40, y); this.add(name);
        this._abilityNodes.push(name);

        const desc = new Label(a.desc, { fontSize: 10, hue: 0xa0a0a0 });
        desc.setPosition(40, y + 16); this.add(desc);
        this._abilityNodes.push(desc);

        const use = new Button({
          normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
          buttonId: 0, action: ButtonAction.Activate,
          width: 70, height: 22, label: 'Use',
        });
        use.setPosition(this.width - 90, y);
        use.onClick = () => this._activate(a.id);
        this.add(use);
        this._abilityNodes.push(use);
        y += 56;
      }
    }
    this._pageLbl.setText(`${this._page + 1} / ${this._pageCount}`);
  }

  _activate(id) {
    try {
      if (id === 'flying') {
        net.send(buildToggleGargoyleFlying());
      } else {
        net.send(buildTextCommand(0x24, `racialAbility ${id}`));
      }
    } catch { /* ignore */ }
  }
}
