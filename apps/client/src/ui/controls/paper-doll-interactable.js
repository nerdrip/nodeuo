// PaperDollInteractable — clickable paperdoll equipment layer.
// Encapsulates the per-layer click/drag/drop/use hooks that CUO keeps
// in PaperDollInteractable.cs while PaperdollGump owns the surrounding
// frame and buttons.

import { GumpPic } from './gump-pic.js';

export class PaperDollInteractable extends GumpPic {
  constructor({
    gumpId,
    hue = 0,
    layer = 0,
    equipment = null,
    isBackpackSlot = false,
    onTarget = null,
    onDropHeld = null,
    onLift = null,
    onUse = null,
    onPreviewEnter = null,
    onPreviewLeave = null,
  } = {}) {
    // Equipment gumps are sparse full-body overlays. A generic 32x32
    // loading/missing placeholder at the paperdoll body offset looked like a
    // miniature shirt in its top-left corner, especially after rapid re-open.
    // Wait invisibly for the authoritative art instead.
    super(gumpId, { hue, showShimmer: false, showFallback: false });
    this.layer = layer | 0;
    this.equipment = equipment;
    this.isBackpackSlot = !!isBackpackSlot;
    this.acceptMouseInput = true;
    this.enablePixelCheck();
    this._hooks = {
      onTarget,
      onDropHeld,
      onLift,
      onUse,
      onPreviewEnter,
      onPreviewLeave,
    };
  }

  onClick() {
    if (this._hooks.onTarget?.(this) === true) return;
    this._hooks.onDropHeld?.(this);
  }

  onDragStart() {
    if (this.isBackpackSlot) return;
    this._hooks.onLift?.(this);
  }

  onDoubleClick() {
    this._hooks.onUse?.(this);
  }

  onDrop() {
    this._hooks.onDropHeld?.(this);
  }

  onMouseEnter() {
    this._hooks.onPreviewEnter?.(this);
  }

  onMouseLeave() {
    this._hooks.onPreviewLeave?.(this);
  }
}
