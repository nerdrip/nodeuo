// CheckerTrans — server-gump translucent black overlay.

import { AlphaBlendControl } from './alpha-blend-control.js';

export class CheckerTrans extends AlphaBlendControl {
  constructor({ width = 1, height = 1 } = {}) {
    super({ width, height, color: 0x000000, alpha: 0.5 });
  }
}
