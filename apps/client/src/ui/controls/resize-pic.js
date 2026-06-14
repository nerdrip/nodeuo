// ResizePic — a 9-patch panel background. UO stores nine consecutive
// gump.mul ids starting at `gumpId` (top-left, top, top-right, left,
// fill, right, bottom-left, bottom, bottom-right). Mirrors
// ClassicUO Renderer/Resizable.cs.
//
// We mount nine Pixi Sprites and reposition / scale them to fit the
// requested width × height. Until each gump texture loads we fall back
// to a flat panel so the gump still has a visible chrome.

import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { createShimmer } from '../loading-shimmer.js';
import { acquireSprite, releaseSprite } from '../../renderer/sprite-pool.js';

export class ResizePic extends Control {
  constructor(gumpId, w = 100, h = 80) {
    super();
    this.gumpId = gumpId | 0;
    this.width = w;
    this.height = h;
    this.isDragHandle = true;
    /** Gray-silver shimmer placeholder while the 9-patch slices stream
     *  in. Replaces the previous flat dark-blue fallback rect — every
     *  loading surface in the client now uses the same calm shimmer. */
    this._shimmer = createShimmer(this.width, this.height, { radius: 4 });
    this.node.addChild(this._shimmer.gfx);
    /** @type {(Sprite | null)[]} 0..8 nine-patch slices, top-left first */
    this._slices = new Array(9).fill(null);
    /** @type {{ w:number, h:number }[]} natural sizes of the slices */
    this._sizes = new Array(9).fill({ w: 0, h: 0 });
    this._loadToken = 0;
    this._disposed = false;
    this._mountSlices();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._shimmer?.resize(w, h);
    this._layout();
  }

  async _mountSlices() {
    const token = ++this._loadToken;
    const promises = [];
    for (let i = 0; i < 9; i++) {
      promises.push(assets.gumpTexture(this.gumpId + i).then((tex) => ({ i, tex })));
    }
    const results = await Promise.all(promises);
    if (this._disposed || token !== this._loadToken) return;
    for (const { i, tex } of results) {
      if (!tex) continue;
      const sp = acquireSprite(tex);
      this._slices[i] = sp;
      this._sizes[i]  = { w: tex.width, h: tex.height };
      this.node.addChild(sp);
    }
    if (this._slices.some((s) => s)) {
      this._shimmer?.dispose();
      this._shimmer = null;
    }
    this._layout();
  }

  dispose() {
    this._disposed = true;
    this._loadToken++;
    for (let i = 0; i < this._slices.length; i++) {
      if (this._slices[i]) releaseSprite(this._slices[i]);
      this._slices[i] = null;
    }
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }

  _layout() {
    const s = this._slices;
    const z = this._sizes;
    if (!s.some((x) => x)) return;
    // Edge sizes derive from corner art: top edge height = top-left height,
    // left edge width = top-left width, etc. Use the first present slice
    // for each dimension.
    const tlW = z[0]?.w || z[2]?.w || z[6]?.w || 8;
    const tlH = z[0]?.h || z[1]?.h || z[2]?.h || 8;
    const trW = z[2]?.w || tlW;
    const blH = z[6]?.h || tlH;
    const brW = z[8]?.w || trW;
    // Position + scale every slice.
    const W = this.width, H = this.height;
    if (s[0]) { s[0].position.set(0, 0); s[0].width = tlW; s[0].height = tlH; }
    if (s[2]) { s[2].position.set(W - trW, 0); s[2].width = trW; s[2].height = tlH; }
    if (s[6]) { s[6].position.set(0, H - blH); s[6].width = tlW; s[6].height = blH; }
    if (s[8]) { s[8].position.set(W - brW, H - blH); s[8].width = brW; s[8].height = blH; }
    if (s[1]) { s[1].position.set(tlW, 0); s[1].width = Math.max(0, W - tlW - trW); s[1].height = tlH; }
    if (s[7]) { s[7].position.set(tlW, H - blH); s[7].width = Math.max(0, W - tlW - brW); s[7].height = blH; }
    if (s[3]) { s[3].position.set(0, tlH); s[3].width = tlW; s[3].height = Math.max(0, H - tlH - blH); }
    if (s[5]) { s[5].position.set(W - trW, tlH); s[5].width = trW; s[5].height = Math.max(0, H - tlH - blH); }
    if (s[4]) { s[4].position.set(tlW, tlH); s[4].width = Math.max(0, W - tlW - trW); s[4].height = Math.max(0, H - tlH - blH); }
  }
}
