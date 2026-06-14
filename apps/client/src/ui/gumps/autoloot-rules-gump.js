// AutoLootRulesGump — manage the AutoLootManager allowlist. Two-column
// list (item id / hue / name + priority on the left, [×] remove on the
// right) with a free-text input row at the bottom. Mirrors the CUO
// Game/UI/Gumps/MenuGump-style add-rule dialog the AutoLoot panel uses.
//
// Wire: opens via `[autoloot` / macro `open-autoloot-rules`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button } from '../controls/button.js';
import { TextInput } from '../controls/text-input.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { autoloot } from '../../managers/autoloot-manager.js';
import { profile } from '../../managers/profile-manager.js';
import { Checkbox } from '../controls/checkbox.js';

const ROW_H = 22;

class AutoLootRuleRow extends Control {
  constructor(width) {
    super();
    this.width = width;
    this.height = ROW_H;
    this.acceptMouseInput = false;
    this._label = new Label('', { fontSize: 11, hue: 0xc0b890, stroke: false });
    this._label.setPosition(4, 2);
    this._label.acceptMouseInput = false;
    this.add(this._label);
    this._remove = new Button({ label: '×', width: 20 });
    this._remove.setPosition(width - 30, 0);
    this.add(this._remove);
  }

  update(rule, idx, onRemove) {
    const parts = [];
    if (rule.itemId != null) parts.push(`0x${rule.itemId.toString(16).padStart(4, '0')}`);
    if (rule.hue    != null) parts.push(`hue 0x${rule.hue.toString(16).padStart(4, '0')}`);
    if (rule.name)           parts.push(`"${rule.name}"`);
    if (rule.priority)       parts.push(`prio ${rule.priority}`);
    this._label.setText(`${idx + 1}. ${parts.join(' · ')}`);
    this._remove.onClick = onRemove;
    this.visible = true;
    this.node.visible = true;
  }
}

export class AutoLootRulesGump extends WindowGump {
  constructor() {
    super({ title: 'AutoLoot rules', width: 460, height: 360, x: 120, y: 90 });

    const enableCb = new Checkbox({ kind: 'checkbox', checked: !!profile.get('autoloot.enabled'), size: 16 });
    enableCb.setPosition(12, 30);
    const baseClick = enableCb.onClick.bind(enableCb);
    enableCb.onClick = (...a) => { baseClick(...a); profile.set('autoloot.enabled', enableCb.checked); };
    this.add(enableCb);
    const enableLbl = new Label('Enable AutoLoot', { fontSize: 12, hue: 0xfff0c0, stroke: true });
    enableLbl.setPosition(34, 31);
    this.add(enableLbl);

    // Rule list
    this._scroll = new ScrollArea({ width: this._w - 20, height: this._h - 130 });
    this.addContent(this._scroll, 10, 56);
    this._rows = [];

    // Add-rule row: itemId hex | hue hex | name substring | priority | [Add]
    const formY = this._h - 60;
    this._itemIdInput   = new TextInput({ width: 70,  height: 20, placeholder: 'itemId', fontSize: 11 });
    this._hueInput      = new TextInput({ width: 60,  height: 20, placeholder: 'hue',    fontSize: 11 });
    this._nameInput     = new TextInput({ width: 130, height: 20, placeholder: 'name…',  fontSize: 11 });
    this._priorityInput = new TextInput({ width: 40,  height: 20, placeholder: 'prio',   fontSize: 11 });
    this._itemIdInput.setPosition(10, formY);
    this._hueInput.setPosition(85, formY);
    this._nameInput.setPosition(150, formY);
    this._priorityInput.setPosition(285, formY);
    this.add(this._itemIdInput);
    this.add(this._hueInput);
    this.add(this._nameInput);
    this.add(this._priorityInput);

    const addBtn = new Button({ label: 'Add', width: 50 });
    addBtn.onClick = () => this._onAdd();
    addBtn.setPosition(330, formY);
    this.add(addBtn);

    this._redraw();
  }

  get type() { return 'autoloot-rules'; }

  _onAdd() {
    const itemIdRaw = (this._itemIdInput.value || '').trim();
    const hueRaw    = (this._hueInput.value    || '').trim();
    const name      = (this._nameInput.value   || '').trim();
    const prioRaw   = (this._priorityInput.value || '').trim();
    const itemId = itemIdRaw ? parseInt(itemIdRaw, 16) : null;
    const hue    = hueRaw    ? parseInt(hueRaw, 16)    : null;
    const priority = prioRaw ? (parseInt(prioRaw, 10) | 0) : 0;
    if (itemId == null && hue == null && !name) return;       // nothing to bind
    autoloot.addRule(itemId, hue, { name: name || undefined, priority });
    this._itemIdInput.value = ''; this._hueInput.value = '';
    this._nameInput.value = '';   this._priorityInput.value = '';
    this._redraw();
  }

  _redraw() {
    let y = 0;
    let used = 0;
    for (let idx = 0; idx < autoloot.rules.length; idx++) {
      const row = this._rows[used] ?? new AutoLootRuleRow(this._w - 40);
      if (!this._rows[used]) {
        this._rows[used] = row;
        this._scroll.add(row);
      }
      row.update(autoloot.rules[idx], idx, () => { autoloot.removeRuleAt(idx); this._redraw(); });
      row.setPosition(0, y);
      y += ROW_H;
      used++;
    }
    for (let i = used; i < this._rows.length; i++) {
      this._rows[i].visible = false;
      this._rows[i].node.visible = false;
    }
    this._scroll.setContentHeight(y);
  }
}
