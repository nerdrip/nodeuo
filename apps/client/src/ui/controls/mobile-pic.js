// NodeUO server-gump extension: a single correctly anchored animation frame
// for creature/mobile catalogue previews. Unknown `mobilepic` commands are
// simply ignored by classic clients, so the standard UO gump protocol remains
// compatible while our web client can show meaningful visual pickers.

import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { applyHueTo } from '../../renderer/hue-filter.js';
import { acquireUiSprite, releaseUiSprite } from '../../renderer/sprite-pool.js';
import { Action, resolveRenderableGroup } from '../../renderer/mobile-animation.js';
import { createShimmer } from '../loading-shimmer.js';

export class MobilePic extends Control {
  constructor(body, { hue = 0, direction = 0, width = 52, height = 52 } = {}) {
    super();
    this.body = body | 0;
    this.hue = hue | 0;
    this.direction = direction | 0;
    this.width = width | 0;
    this.height = height | 0;
    this.acceptMouseInput = false;
    this._sprite = null;
    this._shimmer = createShimmer(this.width, this.height);
    this.node.addChild(this._shimmer.gfx);
    this._mount();
  }

  async _mount() {
    const generation = this.captureAsyncGeneration();
    const group = resolveRenderableGroup(this.body, Action.Idle, {}, this.direction);
    const frame = await assets.mobileFrameTexture(this.body, group, this.direction, 0);
    if (!this.asyncGenerationValid(generation) || !frame) return;
    const sp = acquireUiSprite(frame.texture);
    const fit = Math.min(
      (this.width - 4) / Math.max(1, frame.w),
      (this.height - 4) / Math.max(1, frame.h + Math.max(0, frame.cy)),
      1,
    );
    sp.anchor.set(
      frame.w > 0 ? frame.cx / frame.w : 0.5,
      frame.h > 0 ? (frame.h + frame.cy) / frame.h : 1,
    );
    sp.scale.set(fit, fit);
    sp.position.set(this.width / 2, this.height - 2);
    const effectiveHue = assets.mobileRenderHue?.(this.body, this.hue) ?? this.hue;
    if (effectiveHue && assets.huesTexture && assets.huesMeta) {
      applyHueTo(sp, effectiveHue, 1, assets.huesTexture, assets.huesMeta.count);
    }
    this._sprite = sp;
    this.node.addChild(sp);
    this._shimmer?.dispose();
    this._shimmer = null;
  }

  dispose() {
    if (this._sprite) releaseUiSprite(this._sprite);
    this._sprite = null;
    this._shimmer?.dispose();
    this._shimmer = null;
    super.dispose();
  }
}
