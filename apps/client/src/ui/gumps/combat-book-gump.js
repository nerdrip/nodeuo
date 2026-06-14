// CombatBookGump — per-weapon ability preview + special-move slot picker.
// Mirrors ClassicUO `Game/UI/Gumps/CombatBookGump.cs`.
//
// Each weapon has 2 special abilities (primary + secondary) drawn from a
// fixed table indexed by weapon's body. The combat book lists the slot
// names + lets the player click to assign one of the two abilities to
// the active "special-move slot 1" or "slot 2" (used by [special command).
//
// Layout: parchment background, weapon name at top, two ability blocks
// (icon + name + cliloc description), arrows to flip between weapons in
// the player's pack.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { ItemPic } from '../controls/item-pic.js';
import { bus } from '../../core/event-bus.js';
import { UseAbilityButtonGump } from './use-ability-button-gump.js';

// Default weapon→ability table. The server sends `combat-book:open` with
// per-weapon abilities; we fall back to this if the payload is empty.
const DEFAULT_ABILITIES = {
  default: [
    { id: 'armor-ignore',   name: 'Armor Ignore',   icon: 0x09F8 },
    { id: 'bleed-attack',   name: 'Bleed Attack',   icon: 0x09FB },
  ],
};
// Throwing-weapon abilities (Gargoyle racial). Drawn from CUO
// `Game/Data/SpecialMoves.cs`. Shown on a dedicated tab so gargoyle
// players don't have to scroll past melee/ranged when picking their
// active move. Icons taken from the SA art expansion.
const THROWING_ABILITIES = [
  { id: 'mystic-arc',      name: 'Mystic Arc',        icon: 0x0A02 },
  { id: 'talon-strike',    name: 'Talon Strike',      icon: 0x0A03 },
  { id: 'feint',           name: 'Feint',             icon: 0x0A04 },
  { id: 'whirlwind-attack',name: 'Whirlwind Attack',  icon: 0x09FE },
];

class AbilityBlock extends Control {
  constructor(ability, slot, opts = {}) {
    super();
    this.width = 200;
    this.height = 50;
    this._slot = slot;
    this._opts = opts;
    this._pic = new ItemPic(ability?.icon ?? 0x09F8, { hue: 0 });
    this._pic.setPosition(0, 8);
    this.add(this._pic);
    this._name = new Label(ability?.name ?? '(none)',
                           { fontSize: 12, hue: 0xfff0c0 });
    this._name.setPosition(50, 4);
    this.add(this._name);
    this._desc = new Label(`Slot ${slot}`,
                           { fontSize: 10, hue: 0xa0a0a0 });
    this._desc.setPosition(50, 22);
    this.add(this._desc);
    this._setBtn = new Button({
      normalGumpId: 0x0FAB, pressedGumpId: 0x0FAD, buttonId: 0,
      action: ButtonAction.Activate, width: 64, height: 12,
      label: `Set Slot ${slot}`,
    });
    this._setBtn.setPosition(50, 36);
    this._setBtn.onClick = () => {
      bus.emit('combat-book:assign', { ability: ability?.id, slot });
      opts.onAssign?.(ability?.id, slot);
    };
    this.add(this._setBtn);

    // Drag the icon out of the gump → spawn a floating UseAbilityButtonGump
    // hotbar shortcut. Mirrors CUO drag-out from CombatBookGump where
    // each ability slot becomes a one-button hotbar.
    this._pic.acceptMouseInput = true;
    this._pic.onDragStart = (e) => {
      bus.emit('combat-book:drag-out', {
        slot: slot === 1 ? 'primary' : 'secondary',
        ability,
        x: e?.global?.x ?? 240,
        y: e?.global?.y ?? 240,
      });
    };
  }
}

export class CombatBookGump extends WindowGump {
  constructor(payload = {}) {
    super({ title: 'Combat Book', width: 260, height: 320, x: 200, y: 80 });
    this._payload = payload;
    this._tab = 'weapon';                  // 'weapon' | 'throwing'
    this._content = [];

    // Tab strip — Weapon (legacy abilities) + Throwing (gargoyle racial).
    // CUO has a third Mystic tab; we collapse Mystic abilities into the
    // spellbook gump, so two tabs are sufficient.
    const mkTab = (label, id, x) => {
      const lbl = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
      lbl.setPosition(x, 28);
      lbl.acceptMouseInput = true;
      lbl.node.eventMode = 'static';
      lbl.node.cursor = 'pointer';
      lbl.node.on('pointerdown', (ev) => {
        ev?.stopPropagation?.();
        this._switchTab(id);
      });
      this.add(lbl);
      this._tabLabels = this._tabLabels ?? {};
      this._tabLabels[id] = lbl;
      return lbl;
    };
    mkTab('[ Weapon ]',   'weapon',   12);
    mkTab('[ Throwing ]', 'throwing', 100);
    this._switchTab('weapon');
  }

  _switchTab(id) {
    this._tab = id;
    // Highlight the active tab.
    for (const [k, l] of Object.entries(this._tabLabels ?? {})) {
      l.setHue?.(k === id ? 0xffd070 : 0xfff0c0);
    }
    // Dispose previous tab content.
    for (const c of this._content) {
      try { c.dispose?.(); } catch { /* ignore */ }
    }
    this._content = [];
    if (id === 'throwing') {
      this._buildThrowingTab();
    } else {
      this._buildWeaponTab();
    }
  }

  _buildWeaponTab() {
    const abilities = this._payload.abilities ?? DEFAULT_ABILITIES.default;
    this._weaponLbl = new Label(this._payload.weapon ?? 'Weapon',
                                 { fontSize: 14, hue: 0xfff0c0 });
    this._weaponLbl.setPosition(10, 50);
    this.add(this._weaponLbl);
    this._content.push(this._weaponLbl);

    const b1 = new AbilityBlock(abilities[0], 1, { onAssign: () => this.refresh() });
    b1.setPosition(20, 80);
    this.add(b1); this._content.push(b1);
    const b2 = new AbilityBlock(abilities[1], 2, { onAssign: () => this.refresh() });
    b2.setPosition(20, 150);
    this.add(b2); this._content.push(b2);

    this._hint = new Label('Click "Set Slot N" to bind the special move.',
                            { fontSize: 10, hue: 0x808080 });
    this._hint.setPosition(10, 220);
    this.add(this._hint); this._content.push(this._hint);
  }

  _buildThrowingTab() {
    const hdr = new Label('Gargoyle Throwing Abilities', { fontSize: 12, hue: 0xfff0c0 });
    hdr.setPosition(10, 50);
    this.add(hdr); this._content.push(hdr);
    // Stack the four throwing moves in a 2×2 grid; each block is a
    // drag-source for UseAbilityButtonGump like the weapon tab.
    for (let i = 0; i < THROWING_ABILITIES.length; i++) {
      const slot = (i % 2) + 1;
      const blk = new AbilityBlock(THROWING_ABILITIES[i], slot,
                                    { onAssign: () => this.refresh() });
      blk.setPosition(20 + (i % 2) * 120, 80 + Math.floor(i / 2) * 70);
      this.add(blk); this._content.push(blk);
    }
  }

  refresh() {
    // Trigger a redraw by toggling the hint colour briefly. The slot
    // assignment lives on the server; the next combat-book:open will
    // re-render with the persisted slots.
    this._hint.setText?.('Saved.');
  }
}

export function installCombatBookListener(uiManager) {
  bus.on('combat-book:open', (payload) => {
    const g = new CombatBookGump(payload);
    uiManager.add(g);
  });
  bus.on('combat-book:drag-out', ({ slot, ability, x, y }) => {
    const g = new UseAbilityButtonGump(slot, ability, x | 0, y | 0);
    uiManager.add(g);
  });
}
