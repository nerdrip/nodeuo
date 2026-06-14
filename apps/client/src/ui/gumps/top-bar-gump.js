// TopBarGump — pinned compact toolbar of common gump shortcuts.
// Mirrors CUO `Game/UI/Gumps/TopBarGump.cs` (the *minimised* state):
// a thin strip of single-letter icon buttons that fits ~250 px wide,
// not the dev-mode "Discord toolbar" Marcin reported earlier.
//
// Each button toggles the corresponding gump via the macro:gump bus
// event the GameScene already listens to. Hover modulates the panel
// art alpha + label hue + shows a one-line hotkey tooltip.

import { Gump } from '../gump.js';
import { Control } from '../control.js';
import { Label } from '../controls/label.js';
import { Graphics } from 'pixi.js';
import { bus } from '../../core/event-bus.js';
import { tooltips } from '../../managers/tooltip-manager.js';

// Compact CUO-style icon button row. Letters mirror the in-game hot-
// keys so the shortcut is visible at a glance. `tip` is the long form
// for the hover tooltip.
const BUTTONS = [
  ['paperdoll', 'Paperdoll', 'Paperdoll  (P)'],
  ['journal',   'Journal',   'Journal    (J)'],
  ['skills',    'Skills',    'Skills     (K)'],
  ['status',    'Status',    'Status     (T)'],
  ['minimap',   'Map',       'Mini map   (M)'],
  ['party',     'Party',     'Party      (R)'],
  ['options',   'Options',   'Options    (O)'],
  // Audit rev.4 P3 — top-bar extras matching CUO `TopBarGump.cs:59-70`.
  // Surface chat / help / debug / netstats / worldmap / macros buttons
  // so the user can reach them without learning hotkeys. All emit the
  // same `gump:*` bus events the existing routes use.
  ['worldmap',  'WMap',      'World map  (Ctrl+M)'],
  ['chat',      'Chat',      'Channel manager (Ctrl+C)'],
  ['macros',    'Macros',    'Macros     (Ctrl+Y)'],
  ['help',      'Help',      'Help / FAQ (Ctrl+H)'],
  ['netstats',  'Net',       'Network stats panel'],
  ['debug',     'Dbg',       'Debug overlay (F11)'],
  ['logout',    'Logout',    'Logout'],
];

// Sized to match journal-gump tabs (50×20) — Marcin wanted the top
// bar to read as deliberate UI chrome, not a cramped 22×18 strip.
const BTN_W = 50;
const BTN_H = 20;
const PAD   = 4;
const COLLAPSED_W = 22;
const TITLE_H = 0;          // no title strip — bar is a thin top stripe

/** A single bar button — Graphics-drawn so adjacent buttons read as
 *  one continuous strip without the 0x098D ribbon's end-cap curls
 *  showing up between every label. CUO's TopBarGump uses Graphics
 *  rects for the same reason. */
class TopBtn extends Control {
  constructor(kind, label, tip) {
    super();
    this.kind = kind;
    this.tip = tip;
    this.width = BTN_W;
    this.height = BTN_H;
    this.acceptMouseInput = true;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._lbl = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    // Centre the label horizontally once Pixi has measured it.
    requestAnimationFrame(() => {
      if (this._lbl?.width) {
        this._lbl.setPosition(((BTN_W - this._lbl.width) >> 1) | 0, 4);
      } else {
        this._lbl.setPosition(6, 4);
      }
    });
    this._draw(false);
  }
  _draw(hover) {
    this._gfx.clear();
    // Hover = warm brass fill + brighter border; idle = transparent so
    // the bar's 0x0BB9 ribbon shows through.
    if (hover) {
      this._gfx.roundRect(1, 1, BTN_W - 2, BTN_H - 2, 3)
        .fill({ color: 0x6a4a18, alpha: 0.85 })
        .stroke({ width: 1, color: 0xc59533, alpha: 1 });
    } else {
      this._gfx.roundRect(1, 1, BTN_W - 2, BTN_H - 2, 3)
        .fill({ color: 0x000000, alpha: 0 });
    }
  }
  onMouseEnter(e) {
    this._draw(true);
    this._lbl?.setHue?.(0xfff070);
    if (this.tip) tooltips.showText(e.global.x, e.global.y, this.tip);
  }
  onMouseLeave() {
    this._draw(false);
    this._lbl?.setHue?.(0xfff0c0);
    tooltips.hide();
  }
  onClick() { bus.emit('macro:gump', { kind: this.kind }); }
}

/** Minimise / maximise chevron — same Graphics styling as TopBtn so
 *  the leftmost cell blends with the button strip instead of looking
 *  like a separate ribbon. */
class CollapseBtn extends Control {
  constructor(onToggle) {
    super();
    this.width = COLLAPSED_W;
    this.height = BTN_H;
    this.acceptMouseInput = true;
    this._onToggle = onToggle;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._lbl = new Label('«', { fontSize: 13, hue: 0xfff0c0, stroke: true });
    this._lbl.acceptMouseInput = false;
    this.add(this._lbl);
    requestAnimationFrame(() => {
      if (this._lbl?.width) {
        this._lbl.setPosition(((this.width - this._lbl.width) >> 1) | 0, 3);
      } else {
        this._lbl.setPosition(6, 3);
      }
    });
    this._draw(false);
  }
  setCollapsed(yes) {
    this._lbl.setText(yes ? '»' : '«');
  }
  _draw(hover) {
    this._gfx.clear();
    if (hover) {
      this._gfx.roundRect(1, 1, this.width - 2, BTN_H - 2, 3)
        .fill({ color: 0x6a4a18, alpha: 0.85 })
        .stroke({ width: 1, color: 0xc59533 });
    }
  }
  onMouseEnter() { this._draw(true); this._lbl?.setHue?.(0xfff070); }
  onMouseLeave() { this._draw(false); this._lbl?.setHue?.(0xfff0c0); }
  onClick() { this._onToggle?.(); }
}

export class TopBarGump extends Gump {
  constructor(x = 8, y = 4) {
    super();
    // The top bar is pinned-by-default — RMB on it should NOT close
    // it (that would be a footgun every time the user wanted to RMB
    // an entity behind it). Use the chevron to minimise instead.
    this.canCloseWithRMB = false;
    this._collapsed = false;
    this._fullW  = COLLAPSED_W + PAD + BUTTONS.length * (BTN_W + PAD) + PAD;
    this._fullH  = BTN_H + PAD * 2 + TITLE_H;
    this._narrowW = COLLAPSED_W + PAD * 2;
    this.setPosition(x, y);
    this.setSize(this._fullW, this._fullH);

    // Continuous bar background — Graphics rounded rect. We used to
    // stretch the 0x0BB9 UO ribbon over the full bar AND mount per-
    // button 0x098D ribbons on top, which produced "ribbon end-cap
    // curls" between every button label. Marcin: "kreski jak
    // cudzyslowy". Replacing with a single dark-brass strip + per-
    // button hover-only highlight removes the visual fragmentation.
    this._chrome = new Graphics();
    this.node.addChild(this._chrome);
    this._paintChrome();
    // Drag handle: a transparent Control sitting on top of the strip
    // so the WHOLE bar is grabbable, not just a ribbon edge.
    const drag = new Control();
    drag.width = this._fullW;
    drag.height = this._fullH;
    drag.acceptMouseInput = true;
    drag.isDragHandle = true;
    this.add(drag);
    this._dragHandle = drag;

    // Collapse / expand chevron at the very left.
    this._collapse = new CollapseBtn(() => this._toggle());
    this._collapse.setPosition(PAD, PAD);
    this.add(this._collapse);

    // Icon button row.
    /** @type {TopBtn[]} */
    this._btns = [];
    let cx = COLLAPSED_W + PAD * 2;
    for (const [kind, label, tip] of BUTTONS) {
      const b = new TopBtn(kind, label, tip);
      b.setPosition(cx, PAD);
      this.add(b);
      this._btns.push(b);
      cx += BTN_W + PAD;
    }
  }

  get type() { return 'topbar'; }

  _paintChrome() {
    const w = this._collapsed ? this._narrowW : this._fullW;
    const h = this._fullH;
    this._chrome.clear();
    this._chrome
      .roundRect(0, 0, w, h, 3)
      .fill({ color: 0x261810, alpha: 0.92 })
      .stroke({ width: 1, color: 0x6a4a18, alpha: 0.95 });
  }

  _toggle() {
    this._collapsed = !this._collapsed;
    const w = this._collapsed ? this._narrowW : this._fullW;
    this.setSize(w, this._fullH);
    if (this._dragHandle) this._dragHandle.width = w;
    this._paintChrome();
    for (const b of this._btns) b.node.visible = !this._collapsed;
    this._collapse.setCollapsed(this._collapsed);
  }
}
