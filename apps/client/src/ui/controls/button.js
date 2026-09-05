// Button — a clickable UI element. Mirrors ClassicUO's
// Game/UI/Controls/Button.cs.
//
// Construction parameters mirror the GumpLayout DSL:
//   buttonId        — server-defined response id (0 = close gump)
//   pageNo          — page to switch to in the same gump (0 = none)
//   normalGumpId    — gump.mul id for the released sprite
//   pressedGumpId   — gump.mul id for the pressed sprite
//   action          — 'reply' (ack to server) or 'switch' (local page swap)
//   label           — optional Pixi-text caption rendered on top
//
// Until the gump asset atlas lands the button paints a flat colour pulled
// from the gump id (so visually unique server gumps stay distinct).

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { createShimmer } from '../loading-shimmer.js';
import { acquireUiSprite, releaseUiSprite } from '../../renderer/sprite-pool.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';

export const ButtonAction = Object.freeze({
  SwitchPage: 0,
  Activate:   1,
});

const BUTTON_LABEL_STYLE = new TextStyle({
  fill: 0xfff0c0,
  fontSize: 12,
  fontFamily: UI_FONT_FAMILY,
  fontWeight: 600,
  stroke: { color: 0x000000, width: 1, join: 'round' },
});

export class Button extends Control {
  constructor(options = {}) {
    const {
      normalGumpId, pressedGumpId,
      width = 50, height = 22,
      buttonId = 0, pageNo = 0, action = ButtonAction.Activate,
      label = '', flat = false,
    } = options;
    super();
    this.keyboardFocusable = true;
    this.normalGumpId  = normalGumpId  | 0;
    this.pressedGumpId = pressedGumpId | 0;
    this.buttonId = buttonId | 0;
    this.pageNo   = pageNo   | 0;
    this.action   = action   | 0;
    this.flat = !!flat;
    // Do not infer intent from the numeric default. A code-authored 50×22
    // button is explicitly 50×22 and must not jump to its atlas sprite's
    // natural dimensions a frame later. Server layout buttons omit bounds
    // and therefore still adopt their native UO art size.
    this._explicitSize = this.flat
      || Object.prototype.hasOwnProperty.call(options, 'width')
      || Object.prototype.hasOwnProperty.call(options, 'height');
    this.width  = width;
    this.height = height;

    this._wrap = new Container();
    /** Gray-silver shimmer placeholder shown until the real gump sprite
     *  resolves. CUO standard buttons (0x0FA5/0x0FB1/etc.) ARE in our
     *  atlas, but server-supplied gumps occasionally use ids without
     *  art — the shimmer keeps the button visible AND tells the user
     *  the asset is loading rather than missing. */
    this._shimmer = this.flat ? null : createShimmer(this.width, this.height, { radius: 3 });
    if (this._shimmer) this._wrap.addChild(this._shimmer.gfx);
    this._flatFace = this.flat ? new Graphics() : null;
    if (this._flatFace) this._wrap.addChild(this._flatFace);
    /** @type {Sprite | null} loaded gump-art face (replaces shimmer once mounted) */
    this._sprite = null;
    this._faceCache = { normalId: 0, pressedId: 0 };
    this._faceToken = 0;

    this._label = new Text({
      text: label || '',
      style: BUTTON_LABEL_STYLE,
      resolution: UI_TEXT_RESOLUTION,
      roundPixels: true,
    });
    this._label.anchor.set(0.5);
    this._wrap.addChild(this._label);

    this.node.addChild(this._wrap);
    this._pressed = false;
    this._hovered = false;
    this._draw();
    if (!this.flat) this._mountSprite();
  }

  /** Resolve the normal/pressed gump textures and swap the placeholder
   *  rounded-rect for a real Sprite. Auto-fits the button bounds to the
   *  gump's natural size unless the caller passed explicit dimensions. */
  async _mountSprite() {
    const id = this.normalGumpId;
    if (!id) return;
    const generation = this.captureAsyncGeneration();
    const loaded = await assets.gumpTexture(id);
    if (!this.asyncGenerationValid(generation)) return;
    if (this._sprite) return;
    const tex = loaded ?? assets.placeholderTexture('gump', this.width || 22, this.height || 22);
    const sp = acquireUiSprite(tex);
    sp._uoMissingAsset = !loaded ? { kind: 'gump', id } : null;
    sp.position.set(0, 0);
    this._wrap.addChildAt(sp, 0);
    this._sprite = sp;
    // Adopt the gump's natural size so 30×22 button arts (CUO 0x0FA5
    // family) don't get stretched into a 50×22 placeholder default.
    if (!this._explicitSize) {
      this.width = tex.width; this.height = tex.height;
    }
    this._shimmer?.dispose();
    this._shimmer = null;
    this._draw();
    this.onResize?.();
  }

  setLabel(t) {
    const next = t ?? '';
    if (this._label.text === next) return;
    this._label.text = next;
    this._layout();
  }

  setSize(w, h) { this._explicitSize = true; super.setSize(w, h); this._draw(); }

  _draw() {
    if (this._flatFace) {
      const face = this._pressed ? 0x3d2913 : (this._hovered ? 0x674820 : 0x251b12);
      const edge = this._hovered ? 0xf2c96d : 0x9c7334;
      this._flatFace.clear()
        .roundRect(0, 0, this.width, this.height, 3)
        .fill({ color: face, alpha: 0.98 })
        .stroke({ width: 1, color: edge, alpha: 0.95 });
    } else if (this._sprite) {
      // Real gump face — swap texture for pressed/released state.
      const id = this._pressed ? (this.pressedGumpId || this.normalGumpId) : this.normalGumpId;
      this._maybeSwapTexture(id);
      this._sprite.width = this.width;
      this._sprite.height = this.height;
    } else if (this._shimmer) {
      // Shimmer keeps animating itself; just keep its rect in sync with
      // any size changes the caller pushed via `setSize`.
      this._shimmer.resize(this.width, this.height);
    }
    this._layout();
  }

  async _maybeSwapTexture(id) {
    if (!id) return;
    if (!this._sprite) return;                       // race: sprite gone
    const token = ++this._faceToken;
    const generation = this.captureAsyncGeneration();
    if (this._sprite._currentId === id) return;
    const tex = await assets.gumpTexture(id);
    // Race: gump closed (and the sprite torn down by Pixi) before the
    // texture promise resolved. Pixi's measure mixin throws when you
    // assign `.texture` on a destroyed sprite, so bail early.
    if (!this.asyncGenerationValid(generation) || token !== this._faceToken) return;
    if (!tex || !this._sprite || this._sprite.destroyed) return;
    this._sprite.texture = tex;
    this._sprite._currentId = id;
  }

  _layout() {
    // Native labels are allowed to be long, but never to paint outside the
    // clickable face. Scale only the caption, preserving the button bounds.
    this._label.scale.set(1);
    const maxW = Math.max(1, this.width - 8);
    const maxH = Math.max(1, this.height - 4);
    const scale = Math.min(1, maxW / Math.max(1, this._label.width), maxH / Math.max(1, this._label.height));
    this._label.scale.set(scale);
    this._label.position.set(this.width / 2, this.height / 2);
  }

  onMouseDown(_btn) { if (this.enabled === false) return; this._pressed = true; this._draw(); }
  onMouseUp(_btn)   { this._pressed = false; this._draw(); }
  onMouseEnter()    { if (this.enabled === false) return; this._hovered = true; this._draw(); }
  onMouseLeave()    { this._hovered = false; this._pressed = false; this._draw(); }

  onClick(_btn) {
    if (this.enabled === false) return;
    // Switch a page in this gump locally (no round-trip to the server).
    if (this.action === ButtonAction.SwitchPage) {
      const gump = this._rootGump();
      if (gump && this.pageNo > 0) gump.setActivePage(this.pageNo);
      return;
    }
    // Default: send the buttonId back to the server. close-button
    // semantics (id == 0) just closes the gump locally and ALSO sends 0
    // — ServUO's GumpRequest expects an explicit close response.
    const gump = this._rootGump();
    if (!gump) return;
    gump.respond({ buttonId: this.buttonId });
    if (this.buttonId === 0) gump.close();
  }

  _rootGump() {
    let n = this.parent;
    while (n && n.parent) n = n.parent;
    return n;
  }

  dispose() {
    this._faceToken++;
    if (this._sprite) releaseUiSprite(this._sprite);
    this._sprite = null;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
