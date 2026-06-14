// WindowGump — common chrome shared by hardcoded UI windows
// (Paperdoll, Journal, Status, Skills, Spellbook, Container).
// Provides:
//   - parchment-style ResizePic background (or a single-sprite GumpPic
//     for native-art windows like real container chrome)
//   - title bar
//   - drag handle = the title bar area
//
// Closing: RMB anywhere on the gump (handled by UIManager). The
// dedicated close-X button used to live on the title bar but read as
// a "blue diamond" shimmer when the 0x0837 atlas slice was missing —
// Marcin asked us to drop it once RMB-close was wired.
//
// Mirrors ClassicUO's pattern of subclassing `Gump` with a fixed layout.

import { Gump } from '../gump.js';
import { ResizePic } from '../controls/resize-pic.js';
import { GumpPic } from '../controls/gump-pic.js';
import { Label } from '../controls/label.js';

const TITLE_H = 22;

export class WindowGump extends Gump {
  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {number} [opts.x]
   * @param {number} [opts.y]
   * @param {number} [opts.backgroundId] — gump.mul id used for the chrome
   * @param {boolean} [opts.singleSprite] — when true the background is a
   *        single fixed-size GumpPic (e.g. real container arts like the
   *        backpack 0x003C). When false (default) it's a 9-patch
   *        ResizePic that stretches to the requested width × height
   *        (parchment 0x0A28, paperdoll backplate, etc).
   */
  constructor({ title, width = 200, height = 200, x = 60, y = 60, backgroundId = 0x0A28, singleSprite = false } = {}) {
    super();
    this._titleText = title || '';
    this._w = width;
    this._h = height;
    this.setPosition(x, y);
    this.setSize(width, height);

    if (singleSprite) {
      // Real container/paperdoll/etc. art — single sprite, NOT a
      // 9-patch. Pass explicit width/height so GumpPic stretches to
      // the requested chrome size; usually the caller has already
      // taken the natural sprite dimensions from the atlas.
      this._bg = new GumpPic(backgroundId, { width, height });
    } else {
      this._bg = new ResizePic(backgroundId, width, height);
    }
    this._bg.acceptMouseInput = true; // grab drags
    this._bg.isDragHandle = true;
    this.add(this._bg);

    this._title = new Label(this._titleText, { fontSize: 12, hue: 0xfff0c0 });
    this._title.setPosition(10, 4);
    this._title.acceptMouseInput = true;
    this._title.isDragHandle = true;
    this.add(this._title);
  }

  /** Convenience: place a child control inside the window's content
   * area (below the title bar). */
  addContent(ctrl, x = 10, y = TITLE_H + 4) {
    ctrl.setPosition(x, y);
    this.add(ctrl);
    return ctrl;
  }

  setTitle(t) { this._titleText = t; this._title.setText(t); }

  /** Title bar drag area: only the top strip of the window initiates
   * a drag. ClassicUO's gump headers behave the same so click-on-content
   * doesn't accidentally drag. */
  hitTest(lx, ly) {
    if (!super.hitTest(lx, ly)) return false;
    return true;
  }
}
