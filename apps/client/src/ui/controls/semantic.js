// Small semantic UI kit for code-authored gumps. It keeps spacing, contrast,
// hit bounds and headings consistent without coupling screens to DOM/CSS.
import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

export const UI_SPACING = Object.freeze({ xs: 4, sm: 8, md: 12, lg: 18 });

export class SemanticPanel extends Control {
  constructor({ width = 200, height = 120, tone = 'default', label = '' } = {}) {
    super();
    this.tone = tone;
    this._surface = new Graphics();
    this.node.addChild(this._surface);
    this.setSize(width, height);
    this.acceptMouseInput = false;
    if (label) {
      this._ariaLabel = label;
      this._heading = new Label(label, { fontSize: 12, hue: 0xffe4a3, fontWeight: 650 });
      this._heading.setPosition(UI_SPACING.md, UI_SPACING.sm);
      this.add(this._heading);
    }
    this._draw();
  }

  _draw() {
    const colors = this.tone === 'danger'
      ? { bg: 0x251414, edge: 0x98534a }
      : { bg: 0x17130e, edge: 0x725b31 };
    this._surface.clear().roundRect(0, 0, this.width, this.height, 5)
      .fill({ color: colors.bg, alpha: 0.92 })
      .stroke({ color: colors.edge, width: 1 });
  }

  onResize() { this._draw(); }
}

export class SectionHeader extends Control {
  constructor(text, { width = 200, hint = '' } = {}) {
    super();
    this.setSize(width, hint ? 38 : 24);
    this._title = new Label(text, { fontSize: 13, hue: 0xffe4a3, fontWeight: 700 });
    this.add(this._title);
    if (hint) {
      this._hint = new Label(hint, { fontSize: 10, hue: 0xa99f8b, maxWidth: width, wordWrap: true });
      this._hint.setPosition(0, 18);
      this.add(this._hint);
    }
  }
}

export class FormRow extends Control {
  constructor(label, control, { width = 300, labelWidth = 120 } = {}) {
    super();
    this.setSize(width, Math.max(24, control?.height || 24));
    this._label = new Label(label, { fontSize: 11, hue: 0xcbbd9e, maxWidth: labelWidth - 8 });
    this._label.setPosition(0, 5);
    this.add(this._label);
    if (control) {
      control.setPosition(labelWidth, 0);
      this.add(control);
    }
  }
}

export class FooterBar extends Control {
  constructor({ width = 300, height = 36 } = {}) {
    super();
    this.setSize(width, height);
    this._line = new Graphics().rect(0, 0, width, 1).fill({ color: 0x725b31, alpha: 0.8 });
    this.node.addChild(this._line);
  }
}
