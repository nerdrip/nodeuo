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
  constructor(itemId, { hue = 0, width = 0, height = 0, amount = 1 } = {}) {
    super();
    this.itemId = itemId | 0;
    this.amount = Math.max(1, amount | 0);
    this._displayItemId = displayItemIdForAmount(this.itemId, this.amount);
    this.hue = hue | 0;
    this.width = width;
    this.height = height;
    /** @type {Sprite | null} */
    this._sprite = null;
    this._loadToken = 0;
    this._disposed = false;
    /** Gray-silver shimmer while the static texture resolves async.
     *  Same helper as GumpPic / Button / ResizePic so every loading
     *  surface in the client reads as one consistent state. */
    this._shimmer = createShimmer(this.width || 22, this.height || 22);
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
    this._loadToken++;
    if (this._sprite) releaseSprite(this._sprite);
    this._sprite = null;
    if (!this._shimmer) {
      this._shimmer = createShimmer(this.width || 22, this.height || 22);
      this.node.addChild(this._shimmer.gfx);
    }
    this._mountTexture();
  }

  async _mountTexture() {
    const token = ++this._loadToken;
    const tex = await assets.staticTexture(this._displayItemId);
    if (this._disposed || token !== this._loadToken) return;
    if (!tex) return; // stay on shimmer — id not in atlas
    this._sprite = acquireSprite(tex);
    this._sprite.position.set(0, 0);
    // Adopt the sprite's natural size when no explicit bounds were
    // given. Container grids typically pass nothing — items come in
    // many sizes (bottle 22×22, sword 60×40, …).
    if (this.width === 0 && this.height === 0) {
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
    this._disposed = true;
    this._loadToken++;
    if (this._sprite) releaseSprite(this._sprite);
    this._sprite = null;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
