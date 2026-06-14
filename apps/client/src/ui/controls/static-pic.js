// StaticPic — server-gump static art tile. This is the ClassicUO
// `StaticPic` equivalent: it uses art/static atlas graphics, not gump art.

import { ItemPic } from './item-pic.js';

export class StaticPic extends ItemPic {
  constructor(graphic, { hue = 0, width = 0, height = 0 } = {}) {
    super(graphic, { hue, width, height });
  }

  get graphic() { return this.itemId; }
  set graphic(id) { this.setItemId(id); }
}
