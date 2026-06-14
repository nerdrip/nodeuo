// InfoBarBuilderGump — UI to pick which variables show in the info bar.
// Mirrors ClassicUO `Game/UI/Gumps/InfoBarBuilderGump.cs`.
//
// Audit rev.4 P2 — hardcoded 18+ vars in info-bar-manager.js were not
// surfacing a chooser UI; users couldn't customise the strip layout.
// This gump exposes a checkbox per InfoBarVar; commits via setItems().
//
// Usage: open via `[infobar gump` chat command, top-bar button, or
// double-click on the info-bar strip itself.

import { Gump } from '../gump.js';
import { Label } from '../controls/label.js';
import { Button } from '../controls/button.js';
import { Checkbox } from '../controls/checkbox.js';
import { ResizePic } from '../controls/resize-pic.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { infoBar, InfoBarVar } from '../../managers/info-bar-manager.js';
import { bus } from '../../core/event-bus.js';

const W = 360;
const H = 440;
const ROW_H = 22;

// Order list — matches CUO's drop-down sequence. Each row carries label
// + var id. We exclude `0` (UnusedVariableCanBeRemoved sentinel).
const VAR_ROWS = [
  { id: InfoBarVar.HitPoints,    label: 'Hit Points' },
  { id: InfoBarVar.Mana,         label: 'Mana' },
  { id: InfoBarVar.Stamina,      label: 'Stamina' },
  { id: InfoBarVar.Weight,       label: 'Weight' },
  { id: InfoBarVar.Followers,    label: 'Followers' },
  { id: InfoBarVar.Damage,       label: 'Damage Range' },
  { id: InfoBarVar.Gold,         label: 'Gold' },
  { id: InfoBarVar.Str,          label: 'Strength' },
  { id: InfoBarVar.Dex,          label: 'Dexterity' },
  { id: InfoBarVar.Int,          label: 'Intelligence' },
  { id: InfoBarVar.StatCap,      label: 'Stat Cap' },
  { id: InfoBarVar.HitMax,       label: 'Max HP' },
  { id: InfoBarVar.ManaMax,      label: 'Max Mana' },
  { id: InfoBarVar.StamMax,      label: 'Max Stam' },
  { id: InfoBarVar.HitLoss,      label: 'HP Loss (delta)' },
  { id: InfoBarVar.ManaLoss,     label: 'Mana Loss (delta)' },
  { id: InfoBarVar.StamLoss,     label: 'Stam Loss (delta)' },
  { id: InfoBarVar.PhysResist,   label: 'Phys Resist' },
  { id: InfoBarVar.FireResist,   label: 'Fire Resist' },
  { id: InfoBarVar.ColdResist,   label: 'Cold Resist' },
  { id: InfoBarVar.PoisonResist, label: 'Poison Resist' },
  { id: InfoBarVar.EnergyResist, label: 'Energy Resist' },
  { id: InfoBarVar.ResistAll,    label: 'Resist Sum' },
  { id: InfoBarVar.Luck,         label: 'Luck' },
  { id: InfoBarVar.TithingPoints,label: 'Tithing Points' },
  { id: InfoBarVar.HitChanceInc, label: 'Hit Chance Inc' },
  { id: InfoBarVar.DefChanceInc, label: 'Def Chance Inc' },
  { id: InfoBarVar.DamageInc,    label: 'Damage Inc' },
  { id: InfoBarVar.SpellDamageInc,  label: 'Spell Damage Inc' },
  { id: InfoBarVar.SwingSpeedInc,   label: 'Swing Speed Inc' },
  { id: InfoBarVar.LowerManaCost,   label: 'Lower Mana Cost' },
  { id: InfoBarVar.LowerReagentCost,label: 'Lower Reagent Cost' },
  { id: InfoBarVar.ReflectPhysical, label: 'Reflect Physical Dmg' },
  { id: InfoBarVar.EquippedWeapon,  label: 'Equipped Weapon' },
];

export class InfoBarBuilderGump extends Gump {
  constructor(x = 200, y = 80) {
    super();
    this.setPosition(x, y);
    this.setSize(W, H);

    this.add(new ResizePic(0x0A28, { width: W, height: H }));

    const title = new Label('CUSTOMIZE INFO BAR', { fontSize: 13, hue: 0xfff0c0 });
    title.setPosition(W / 2 - 70, 14);
    this.add(title);

    const sub = new Label('Tick the fields you want to display.', { fontSize: 10, hue: 0xc0b890 });
    sub.setPosition(20, 34);
    this.add(sub);

    // Build a checkbox + colour swatch per var. Group A (left col) +
    // Group B (right col). Initial state seeded from current items;
    // hue defaults to white (0xc0c0c0) when the user enables a field.
    // Audit rev.9 P2 #4 — per-variable colour swatch (CUO ships custom
    // hue per stat). Click the swatch to cycle a 10-colour palette.
    this._cur = new Map(infoBar.getItems().map((it) => [it.var, it.hue]));
    this._rowBoxes = new Map();
    this._swatches = new Map();

    // CUO `Game/UI/Gumps/InfoBarGump.cs` ships a 10-colour cycle for
    // the per-var hue picker. We mirror the palette so saved bars
    // travel between CUO and our client without re-tinting.
    const HUE_PALETTE = [
      0xC0C0C0, 0xFFFFFF, 0xFFE080, 0xFFB060, 0xE05050,
      0x40E040, 0x40C0FF, 0xC080FF, 0xFFA0A0, 0x808080,
    ];

    const scroll = new ScrollArea({ width: W - 40, height: H - 100 });
    scroll.setPosition(20, 56);
    this.add(scroll);
    let y2 = 0;
    for (const r of VAR_ROWS) {
      const cb = new Checkbox({ checked: this._cur.has(r.id) });
      cb.setPosition(2, y2);
      const baseOnClick = cb.onClick.bind(cb);
      cb.onClick = () => {
        baseOnClick();
        if (cb.checked) {
          if (!this._cur.has(r.id)) this._cur.set(r.id, HUE_PALETTE[0]);
        } else {
          this._cur.delete(r.id);
        }
        this._refreshSwatch(r.id);
      };
      const lbl = new Label(r.label, { fontSize: 11, hue: 0xe8d0a0 });
      lbl.setPosition(24, y2 + 2);
      // Swatch: 14-px coloured square at the right edge — click cycles
      // the palette. Disabled (alpha 0.3) when the row is unchecked.
      const swatch = new Button({
        width: 18, height: 14,
        label: '',
        normalGumpId: 0x0824, pressedGumpId: 0x0825,
      });
      swatch.setPosition(W - 80, y2 + 2);
      swatch.onClick = () => {
        if (!this._cur.has(r.id)) return;
        const cur = this._cur.get(r.id) ?? HUE_PALETTE[0];
        const next = HUE_PALETTE[(HUE_PALETTE.indexOf(cur) + 1) % HUE_PALETTE.length];
        this._cur.set(r.id, next);
        this._refreshSwatch(r.id);
      };
      scroll.add(cb);
      scroll.add(lbl);
      scroll.add(swatch);
      this._rowBoxes.set(r.id, cb);
      this._swatches.set(r.id, swatch);
      y2 += ROW_H;
    }
    for (const r of VAR_ROWS) this._refreshSwatch(r.id);

    // Apply / Reset / Close buttons at the bottom.
    const apply = new Button('Apply', { width: 90 });
    apply.setPosition(20, H - 30);
    apply.onClick = () => this._commit();
    this.add(apply);

    const reset = new Button('Reset', { width: 90 });
    reset.setPosition(120, H - 30);
    reset.onClick = () => this._reset();
    this.add(reset);

    const close = new Button('Close', { width: 90 });
    close.setPosition(W - 110, H - 30);
    close.onClick = () => this.close();
    this.add(close);

    // Live preview — apply on any toggle so the strip updates immediately.
    // Users hit Apply to PERSIST; Close without Apply reverts via _reset.
  }

  get type() { return 'info-bar-builder'; }

  _commit() {
    const items = [...this._cur.entries()].map(([varId, hue]) => ({ var: varId, hue }));
    infoBar.setItems(items);
    bus.emit('infobar:changed', { items });
  }

  _reset() {
    this._cur = new Map(infoBar.getItems().map((it) => [it.var, it.hue]));
    for (const [id, cb] of this._rowBoxes) {
      cb.setChecked?.(this._cur.has(id));
      this._refreshSwatch(id);
    }
  }

  /** Restyle a per-var swatch based on the current hue + enabled state. */
  _refreshSwatch(id) {
    const sw = this._swatches.get(id);
    if (!sw) return;
    const hue = this._cur.get(id);
    sw.node.alpha = (hue == null) ? 0.3 : 1.0;
    try { sw.node.tint = hue ?? 0x808080; } catch { /* no Pixi tint */ }
  }
}

// Wire chat command + bus event for opening.
bus.on('macro:gump', ({ kind }) => {
  if (kind !== 'info-bar-builder') return;
  bus.emit('gump:open', { gump: new InfoBarBuilderGump() });
});
