// HouseCustomizationGump — full in-house editor backed by extracted UO
// content tables (`assets.housedata`) and routed through
// `houseCustomization` manager. Mirrors CUO `Game/UI/Gumps/HouseCustomizationGump.cs`
// structure: tool tabs (Walls / Doors / Floors / Stairs / Roof / Misc /
// Teleports / Eraser / Erase All / Backup / Restore / Commit / Revert
// / Floor 1-3) + a category list + a style grid for the current
// category.
//
// Source data: `assets.housedata.{walls,doors,floors,stairs,roofs,misc,teleprts}`
// — each is a list of `{ category, styles: [{ style, pieces: [graphic, ...] }] }`.
//
// The gump sets the active brush on `houseCustomization`; GameScene intercepts
// world clicks while edit mode is active and sends the matching 0xD7 add/delete
// operation. Outside edit mode normal walk/drag handling remains unchanged.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ItemPic } from '../controls/item-pic.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { houseCustomization } from '../../managers/house-customization-manager.js';
import { assets } from '../../assets/asset-manager.js';
import { world } from '../../world/world.js';
import { bus } from '../../core/event-bus.js';

// CUO tool tabs. The `kind` selects the standard roof/stair/item 0xD7
// operation; NodeUO derives item subtypes from the same housedata catalogue.
const TABS = [
  { key: 'walls',    table: 'walls',    kind: 'wall',  label: 'Walls'    },
  { key: 'doors',    table: 'doors',    kind: 'door',  label: 'Doors'    },
  { key: 'floors',   table: 'floors',   kind: 'floor', label: 'Floors'   },
  { key: 'stairs',   table: 'stairs',   kind: 'stair', label: 'Stairs'   },
  { key: 'roofs',    table: 'roofs',    kind: 'roof',  label: 'Roof'     },
  { key: 'misc',     table: 'misc',     kind: 'misc',  label: 'Misc'     },
  { key: 'teleprts', table: 'teleprts', kind: 'teleport', label: 'Teleport' },
];

class TabBtn extends Control {
  constructor(label, onClick) {
    super();
    this.width = 60; this.height = 22;
    this.acceptMouseInput = true;
    this._frame = new Graphics(); this.node.addChild(this._frame);
    this._draw(false, false);
    this._lbl = new Label(label, { fontSize: 10, hue: 0xfff0c0 });
    this._lbl.setPosition(6, 5);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
    this._active = false;
  }
  setActive(on) { this._active = !!on; this._draw(false, this._active); }
  _draw(hover, active) {
    this._frame.clear();
    this._frame.rect(0, 0, this.width, this.height)
      .fill({ color: active ? 0x3a4660 : (hover ? 0x21283a : 0x14263e), alpha: 0.95 })
      .stroke({ width: 1, color: active ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter() { this._draw(true, this._active); }
  onMouseLeave() { this._draw(false, this._active); }
  onClick() { this._onClick?.(); }
}

class CategoryRow extends Control {
  constructor(label, onClick) {
    super();
    this.width = 180; this.height = 18;
    this.acceptMouseInput = true;
    this._frame = new Graphics(); this.node.addChild(this._frame);
    this._draw(false, false);
    this._lbl = new Label(label, { fontSize: 11, hue: 0xfff0c0 });
    this._lbl.setPosition(6, 3);
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    this._onClick = onClick;
  }
  update(label, onClick) {
    this._lbl.setText(label);
    this._onClick = onClick;
    this.visible = true;
    this.node.visible = true;
  }
  setActive(on) { this._draw(false, on); }
  _draw(hover, active) {
    this._frame.clear();
    this._frame.rect(0, 0, this.width, this.height)
      .fill({ color: active ? 0x3a4660 : (hover ? 0x21283a : 0x161c2a), alpha: 0.85 })
      .stroke({ width: 1, color: active ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter() { this._draw(true, false); }
  onMouseLeave() { this._draw(false, false); }
  onClick() { this._onClick?.(); }
}

const PIECE_W = 44;

class PieceTile extends Control {
  constructor(graphic, onClick) {
    super();
    this.width = PIECE_W; this.height = PIECE_W;
    this.acceptMouseInput = true;
    this._frame = new Graphics();
    this.node.addChild(this._frame);
    this._draw(false);
    this._pic = new ItemPic(Math.max(0, graphic | 0), { hue: 0 });
    this._pic.setPosition(2, 2);
    this._pic.acceptMouseInput = false;
    this.add(this._pic);
    this.update(graphic, onClick);
  }
  update(graphic, onClick) {
    this.graphic = graphic | 0;
    this._onClick = onClick;
    if (this.graphic > 0) {
      this._pic.node.visible = true;
      this._pic.setItemId(this.graphic);
    } else {
      this._pic.node.visible = false;
    }
    this.visible = true;
    this.node.visible = true;
    this._draw(false);
  }
  _draw(hover) {
    this._frame.clear();
    this._frame.rect(0, 0, PIECE_W, PIECE_W)
      .fill({ color: hover ? 0x21283a : 0x14263e, alpha: 0.9 })
      .stroke({ width: 1, color: hover ? 0xfff0a0 : 0x6a4a18 });
  }
  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
  onClick() { if (this.graphic > 0) this._onClick?.(this.graphic); }
}

export class HouseCustomizationGump extends WindowGump {
  constructor(houseSerial) {
    super({ title: 'House Customization', width: 460, height: 380, x: 80, y: 80 });
    this.houseSerial = houseSerial >>> 0;
    this.activeTab = TABS[0];
    this.activeCategory = null;
    this.floor = 1;
    this._catRows = [];
    this._styleLabels = [];
    this._pieceTiles = [];

    houseCustomization.install();
    houseCustomization.beginEdit(this.houseSerial);
    queueMicrotask(() => houseCustomization.validate());

    // Tool tabs row.
    let cx = 8;
    this._tabs = TABS.map((tab) => {
      const b = new TabBtn(tab.label, () => this._setTab(tab));
      b.setPosition(cx, 28);
      this.add(b);
      cx += 64;
      return { tab, btn: b };
    });
    this._tabs[0].btn.setActive(true);

    // Floor switcher.
    let fx = 8;
    this._floorBtns = [];
    for (let i = 1; i <= 3; i++) {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        buttonId: 0, action: ButtonAction.Activate,
        width: 32, height: 18, label: `F${i}`,
      });
      b.setPosition(fx, 56);
      b.onClick = () => this._setFloor(i);
      this.add(b);
      this._floorBtns.push(b);
      fx += 36;
    }

    // Standard actions remain 0xD7 compatible with every emulator.
    const actions = [
      ['Backup',  () => houseCustomization.backup()],
      ['Restore', () => houseCustomization.restore()],
      ['Commit',  () => { if (houseCustomization.commit()) this.close(); }],
      ['Revert',  () => houseCustomization.revert()],
      ['Eraser',  () => houseCustomization.toggleEraser()],
      ['Exit',    () => { houseCustomization.exit(); this.close(); }],
    ];
    let ax = 130;
    for (const [label, fn] of actions) {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        buttonId: 0, action: ButtonAction.Activate,
        width: 50, height: 18, label,
      });
      b.setPosition(ax, 56);
      b.onClick = fn;
      this.add(b);
      ax += 54;
    }

    // NodeUO-enhanced authoring. These buttons are harmless when the
    // capability was not negotiated (manager falls back/no-ops).
    const richActions = [
      ['Undo', () => houseCustomization.undo()],
      ['Redo', () => houseCustomization.redo()],
      ['Check', () => houseCustomization.validate()],
      ['Copy 9×9', () => {
        const p = world.player; if (p) houseCustomization.copyArea(p.x - 4, p.y - 4, p.x + 4, p.y + 4);
      }],
      ['Paste', () => {
        const p = world.player; if (p) houseCustomization.pasteAt(p.x, p.y);
      }],
      ['Save tpl', () => {
        const name = globalThis.prompt?.('Template name (whole current design):');
        if (name) houseCustomization.saveTemplate(name);
      }],
      ['Load tpl', () => {
        const names = houseCustomization.toolState.templates.map((entry) => entry.name);
        const name = globalThis.prompt?.(`Template name${names.length ? ` (${names.join(', ')})` : ''}:`);
        const p = world.player;
        if (name && p) houseCustomization.applyTemplate(name, p.x, p.y);
      }],
    ];
    let rx = 8;
    for (const [label, fn] of richActions) {
      const b = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        buttonId: 0, action: ButtonAction.Activate,
        width: label.length > 6 ? 58 : 46, height: 18, label,
      });
      b.setPosition(rx, 78); b.onClick = fn; this.add(b);
      rx += label.length > 6 ? 62 : 50;
    }
    this._toolStatus = new Label('History: waiting for server', { fontSize: 9, hue: 0xb8c8d8 });
    this._toolStatus.setPosition(8, 101); this.add(this._toolStatus);
    this._toolUnsub = bus.on('house:tools-result', (state) => {
      const h = state.history;
      const check = state.validation
        ? ` · ${state.validation.ok ? 'valid' : `${state.validation.errors.length} error(s)`}` : '';
      this._toolStatus.setText(`${state.message ?? ''}${h ? ` · ${h.tileCount} tiles · undo ${h.canUndo ? 'yes' : 'no'} · redo ${h.canRedo ? 'yes' : 'no'}` : ''}${check}`.slice(0, 90));
      if (state.operation === 'commit' && state.ok) this.close();
    });

    // Category list (left pane).
    this._catScroll = new ScrollArea({ width: 184, height: 244 });
    this.addContent(this._catScroll, 8, 120);

    // Style grid (right pane).
    this._styleScroll = new ScrollArea({ width: 248, height: 244 });
    this.addContent(this._styleScroll, 200, 120);

    this._renderCategories();
  }

  get type() { return 'house-customization'; }
  get positionKey() { return 'house-customization'; }

  _setTab(tab) {
    this.activeTab = tab;
    for (const e of this._tabs) e.btn.setActive(e.tab.key === tab.key);
    this.activeCategory = null;
    this._renderCategories();
    this._renderStyles();
  }
  _setFloor(n) {
    this.floor = n;
    houseCustomization.goToFloor(n);
  }
  _setCategory(cat) {
    this.activeCategory = cat;
    this._renderCategories();
    this._renderStyles();
  }

  _renderCategories() {
    const list = assets.housedata?.[this.activeTab.table] ?? [];
    let y = 0;
    let used = 0;
    for (const cat of list) {
      const lbl = (cat.comment || `Category ${cat.category}`).slice(0, 28);
      let row = this._catRows[used];
      if (!row) {
        row = new CategoryRow(lbl, () => this._setCategory(cat));
        this._catRows[used] = row;
        this._catScroll.add(row);
      }
      row.update(lbl, () => this._setCategory(cat));
      row.setActive(this.activeCategory && this.activeCategory.category === cat.category);
      row.setPosition(2, y);
      y += 20;
      used++;
    }
    for (let i = used; i < this._catRows.length; i++) {
      this._catRows[i].visible = false;
      this._catRows[i].node.visible = false;
    }
    this._catScroll.setContentHeight?.(y);
  }

  _renderStyles() {
    let labelsUsed = 0;
    let tilesUsed = 0;
    if (!this.activeCategory) {
      this._hideStyleControls(0, 0);
      this._styleScroll.setContentHeight?.(0);
      return;
    }
    let y = 0;
    let x = 0;
    const COLS = 5;
    let col = 0;
    for (const style of this.activeCategory.styles) {
      // Label row per style.
      const lbl = this._styleLabels[labelsUsed] ?? new Label('', {
        fontSize: 10, hue: 0xc0a070,
      });
      if (!this._styleLabels[labelsUsed]) {
        lbl.acceptMouseInput = false;
        this._styleLabels[labelsUsed] = lbl;
        this._styleScroll.add(lbl);
      }
      lbl.setText(style.comment || `Style ${style.style}`);
      lbl.visible = true;
      lbl.node.visible = true;
      lbl.setPosition(2, y);
      labelsUsed++;
      y += 14;
      col = 0; x = 0;
      for (const piece of style.pieces) {
        let tile = this._pieceTiles[tilesUsed];
        if (!tile) {
          tile = new PieceTile(piece, (g) => this._pickPiece(g));
          this._pieceTiles[tilesUsed] = tile;
          this._styleScroll.add(tile);
        }
        tile.update(piece, (g) => this._pickPiece(g));
        tile.setPosition(x, y);
        x += PIECE_W + 4;
        tilesUsed++;
        if (++col >= COLS) {
          col = 0; x = 0; y += PIECE_W + 4;
        }
      }
      if (col !== 0) y += PIECE_W + 4;
      y += 6;
    }
    this._hideStyleControls(labelsUsed, tilesUsed);
    this._styleScroll.setContentHeight?.(y);
  }

  _hideStyleControls(labelsUsed, tilesUsed) {
    for (let i = labelsUsed; i < this._styleLabels.length; i++) {
      this._styleLabels[i].visible = false;
      this._styleLabels[i].node.visible = false;
    }
    for (let i = tilesUsed; i < this._pieceTiles.length; i++) {
      this._pieceTiles[i].visible = false;
      this._pieceTiles[i].node.visible = false;
    }
  }

  _pickPiece(graphic) {
    houseCustomization.setBrush(graphic, this.activeTab.kind);
  }

  dispose() {
    this._toolUnsub?.();
    houseCustomization.exit();
    super.dispose();
  }
}
