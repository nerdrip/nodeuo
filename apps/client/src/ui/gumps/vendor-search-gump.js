// VendorSearchGump — vendor-stone client UI (ServUO `Gumps/VendorSearchGump.cs`).
// Faza G #6.
//
// Wraps the `[vsearch` command in a form-style gump. Rather than having
// players type `min:50 max:1000 kind:weapon prop:di sort:asc`, this
// builds the same query string from button presses + a single text-entry
// (item-name substring).
//
// Each "Search" press concatenates filters and sends `[vsearch <query>`.
// The server already renders results via `renderResultsToSysmsg`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const KINDS = [
  ['Any',     null],
  ['Weapon',  'weapon'],
  ['Armor',   'armor'],
  ['Jewelry', 'jewelry'],
  ['Scroll',  'scroll'],
  ['Potion',  'potion'],
  ['Resource','resource'],
  ['Decor',   'decor'],
];

const PROP_SHORTCUTS = [
  ['(none)',          null],
  ['Damage Increase', 'di'],
  ['Hit Chance',      'hci'],
  ['Defense',         'dci'],
  ['Spell Channeling','channeling'],
  ['Mage Weapon',     'mage-weapon'],
  ['Mana Leech',      'mana-leech'],
  ['Hit Lower Att',   'hla'],
  ['Reflect Physical','reflect'],
  ['Cold Resist',     'cold-resist'],
];

const SORTS = [
  ['Price ↑', 'asc'],
  ['Price ↓', 'desc'],
  ['Name',    'name'],
];

export class VendorSearchGump extends WindowGump {
  /** @param {{ net?: any, ui?: any }} opts */
  constructor(opts = {}) {
    super({ title: 'Vendor Search', width: 420, height: 380, x: 220, y: 130 });
    this._net = opts.net;
    this._ui = opts.ui;
    this._query = { text: '', kind: null, property: null, minPrice: 0, maxPrice: 0, sort: 'asc' };

    this.addContent(new Label('Item name contains:', { fontSize: 11, hue: 0xffe0a0 }), 14, 28);
    this.addContent(new Label('(type and press Search)', { fontSize: 9, hue: 0x808080 }), 200, 30);

    // Text box for item-name substring — bound to _query.text via setText.
    // Implementation note: reuse the chat input adapter we use for runebooks.
    this._textInput = this._addTextInput(14, 46, 380, 22, (v) => this._query.text = v);

    this.addContent(new Label('Category:', { fontSize: 11, hue: 0xffe0a0 }), 14, 76);
    this._addRadioRow(KINDS, 14, 94, (v) => this._query.kind = v);

    this.addContent(new Label('Property filter:', { fontSize: 11, hue: 0xffe0a0 }), 14, 144);
    this._addRadioRow(PROP_SHORTCUTS, 14, 162, (v) => this._query.property = v);

    this.addContent(new Label('Price range:', { fontSize: 11, hue: 0xffe0a0 }), 14, 220);
    this.addContent(new Label('min', { fontSize: 10, hue: 0xffffff }), 14, 240);
    this._minInput = this._addTextInput(48, 238, 90, 20, (v) => this._query.minPrice = parseInt(v, 10) | 0);
    this.addContent(new Label('max', { fontSize: 10, hue: 0xffffff }), 150, 240);
    this._maxInput = this._addTextInput(184, 238, 90, 20, (v) => this._query.maxPrice = parseInt(v, 10) | 0);

    this.addContent(new Label('Sort:', { fontSize: 11, hue: 0xffe0a0 }), 14, 272);
    this._addRadioRow(SORTS, 14, 290, (v) => this._query.sort = v);

    const search = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 110, height: 24,
      label: 'Search', action: ButtonAction.Activate,
    });
    search.setPosition(14, 332);
    search.onClick = () => this._submit();
    this.add(search);

    const close = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 110, height: 24,
      label: 'Close', action: ButtonAction.Cancel,
    });
    close.setPosition(286, 332);
    close.onClick = () => this.close();
    this.add(close);
  }

  _addRadioRow(options, x, y, onPick) {
    // Simple horizontal button row; each press updates the bound value
    // and re-styles the pressed button (cheap "radio").
    let cx = x;
    const buttons = [];
    for (const [label, val] of options) {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: Math.max(60, label.length * 7 + 12),
        height: 20, label,
        action: ButtonAction.Activate,
      });
      b.setPosition(cx, y);
      b.onClick = () => {
        onPick(val);
        for (const other of buttons) other.normalGumpId = 0x0481;
        b.normalGumpId = 0x0482;
        this.requestRedraw?.();
      };
      this.add(b);
      buttons.push(b);
      cx += b.width + 4;
      if (cx > 380) { cx = x; y += 22; }
    }
  }

  _addTextInput(x, y, w, h, onChange) {
    // The window-gump framework may not export a TextEntry control;
    // fall back to a label-styled stub that captures keystrokes when
    // focused. The real chat-style entry routes through the framework's
    // text-entry-dialog-gump for free-form input.
    const input = new Label('', { fontSize: 11, hue: 0xffffff, background: 0x404040 });
    input.width = w; input.height = h; input.editable = true;
    input.onChange = onChange;
    this.addContent(input, x, y);
    return input;
  }

  _submit() {
    const parts = [];
    if (this._query.text) parts.push(this._query.text);
    if (this._query.kind) parts.push(`kind:${this._query.kind}`);
    if (this._query.property) parts.push(`prop:${this._query.property}`);
    if (this._query.minPrice > 0) parts.push(`min:${this._query.minPrice}`);
    if (this._query.maxPrice > 0) parts.push(`max:${this._query.maxPrice}`);
    if (this._query.sort) parts.push(`sort:${this._query.sort}`);
    const cmd = `vsearch ${parts.join(' ')}`.trim();
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'vendor-search'; }
}
