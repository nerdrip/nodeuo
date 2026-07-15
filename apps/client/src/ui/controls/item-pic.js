// ItemPic — renders a world item icon (a static sprite from art.mul)
// inside a UI gump. Mirrors ClassicUO's `ItemGump` (Game/UI/Controls/
// ItemGump.cs) which calls `Arts.GetArt(graphic)` — that's the STATIC
// art atlas, NOT the gump atlas. Containers / paperdoll grids ship
// items by their world graphic id (e.g. 0x0F0E for a potion bottle)
// and the icon is the same bitmap that would tile on the ground.
//
// We use this control wherever a `GumpPic(itemId)` was a category
// mistake — backpack contents, shop listings, hot-bar slots, etc.

import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { applyHueTo } from '../../renderer/hue-filter.js';
import { createShimmer } from '../loading-shimmer.js';
import { acquireSprite, releaseSprite } from '../../renderer/sprite-pool.js';
import { displayItemIdForAmount } from '../../shared/stack-graphics.js';

export class ItemPic extends Control {
  constructor(itemId, {
    hue = 0, width = 0, height = 0, amount = 1,
    maxWidth = 0, maxHeight = 0,
  } = {}) {
    super();
    this.itemId = itemId | 0;
    this.amount = Math.max(1, amount | 0);
    this._displayItemId = displayItemIdForAmount(this.itemId, this.amount);
    this.hue = hue | 0;
    this.width = width;
    this.height = height;
    // Optional aspect-preserving containment box. Container grids used to
    // poll this control for at most 20 animation frames and scale its whole
    // node after the texture arrived. A lazily streamed atlas page can take
    // longer than that, leaving swords/coins at their natural (sometimes
    // hundreds-of-pixels) size across the entire desktop. Fit at the exact
    // moment the texture resolves instead, with no timing race.
    this.maxWidth = Math.max(0, maxWidth | 0);
    this.maxHeight = Math.max(0, maxHeight | 0);
    /** @type {Sprite | null} */
    this._sprite = null;
    /** Gray-silver shimmer while the static texture resolves async.
     *  Same helper as GumpPic / Button / ResizePic so every loading
     *  surface in the client reads as one consistent state. */
    this._shimmer = createShimmer(this.width || this.maxWidth || 22, this.height || this.maxHeight || 22);
    this.node.addChild(this._shimmer.gfx);
    this._mountTexture();
  }

  setHue(h) {
    this.hue = h | 0;
    if (this._sprite && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, this.hue ? 1 : 0, assets.huesTexture, assets.huesMeta.count);
    }
  }

  setItemId(id, amount = this.amount) {
    const nextItemId = id | 0;
    const nextAmount = Math.max(1, amount | 0);
    const nextDisplayId = displayItemIdForAmount(nextItemId, nextAmount);
    if (nextItemId === this.itemId && nextAmount === this.amount && nextDisplayId === this._displayItemId) return;
    const oldDisplayId = this._displayItemId;
    this.itemId = id | 0;
    this.amount = nextAmount;
    this._displayItemId = nextDisplayId;
    if (nextDisplayId === oldDisplayId) return;
    this.beginAsyncGeneration();
    if (this._sprite) releaseSprite(this._sprite);
    this._sprite = null;
    if (!this._shimmer) {
      this._shimmer = createShimmer(this.width || 22, this.height || 22);
      this.node.addChild(this._shimmer.gfx);
    }
    this._mountTexture();
  }

  async _mountTexture() {
    const generation = this.captureAsyncGeneration();
    const loaded = await assets.staticTexture(this._displayItemId);
    if (!this.asyncGenerationValid(generation)) return;
    const tex = loaded ?? assets.placeholderTexture('static', this.maxWidth || this.width || 22, this.maxHeight || this.height || 22);
    this._sprite = acquireSprite(tex);
    this._sprite._uoMissingAsset = !loaded ? { kind: 'static', id: this._displayItemId } : null;
    this._sprite.position.set(0, 0);
    // Adopt the sprite's natural size when no explicit bounds were
    // given. Container grids typically pass nothing — items come in
    // many sizes (bottle 22×22, sword 60×40, …).
    if (this.maxWidth > 0 || this.maxHeight > 0) {
      const boxW = this.maxWidth || tex.width;
      const boxH = this.maxHeight || tex.height;
      const fit = Math.min(boxW / Math.max(1, tex.width), boxH / Math.max(1, tex.height), 1);
      this._sprite.scale.set(fit, fit);
      this._sprite.position.set(
        Math.round((boxW - tex.width * fit) / 2),
        Math.round((boxH - tex.height * fit) / 2),
      );
      this.width = boxW;
      this.height = boxH;
    } else if (this.width === 0 && this.height === 0) {
      this.width = tex.width; this.height = tex.height;
    } else {
      this._sprite.width  = this.width;
      this._sprite.height = this.height;
    }
    if (this.hue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._sprite, this.hue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this.node.addChild(this._sprite);
    this._shimmer?.dispose();
    this._shimmer = null;
  }

  dispose() {
    if (this._sprite) releaseSprite(this._sprite);
    this._sprite = null;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
