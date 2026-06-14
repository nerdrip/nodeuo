// GumpPicTiled — tiled gump.mul texture used by server gump layouts.
// Mirrors ClassicUO `Game/UI/Controls/GumpPicTiled.cs`: the source art is
// repeated across the requested rectangle instead of stretched.

import { TilingSprite } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { applyHueTo } from '../../renderer/hue-filter.js';
import { createShimmer } from '../loading-shimmer.js';

export class GumpPicTiled extends Control {
  constructor(gumpId, { hue = 0, width = 0, height = 0 } = {}) {
    super();
    this.gumpId = gumpId | 0;
    this.hue = hue | 0;
    this._requestedWidth = width | 0;
    this._requestedHeight = height | 0;
    this.width = this._requestedWidth || 32;
    this.height = this._requestedHeight || 32;
    /** @type {TilingSprite | null} */
    this._sprite = null;
    this._loadToken = 0;
    this._disposed = false;
    this._shimmer = createShimmer(this.width, this.height);
    this.node.addChild(this._shimmer.gfx);
    this._mountTexture();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._requestedWidth = w | 0;
    this._requestedHeight = h | 0;
    if (this._sprite) {
      this._sprite.width = this.width;
      this._sprite.height = this.height;
    } else {
      this._shimmer?.resize(this.width, this.height);
    }
  }

  setHue(h) {
    this.hue = h | 0;
    if (this._sprite && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, this.hue ? 1 : 0, assets.huesTexture, assets.huesMeta.count);
    }
  }

  async _mountTexture() {
    const token = ++this._loadToken;
    const tex = await assets.gumpTexture(this.gumpId);
    if (this._disposed || token !== this._loadToken) return;
    if (!tex) return; // stay on shimmer placeholder
    if (!this._requestedWidth) this.width = tex.width;
    if (!this._requestedHeight) this.height = tex.height;
    this._sprite = new TilingSprite({ texture: tex, width: this.width, height: this.height });
    this._sprite.position.set(0, 0);
    if (this.hue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this.node.addChild(this._sprite);
    this._shimmer?.dispose();
    this._shimmer = null;
    this.onResize?.();
  }

  dispose() {
    this._disposed = true;
    this._loadToken++;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
