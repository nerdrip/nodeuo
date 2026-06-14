// ExpandableScroll — collapsible header + body container. Used by
// SkillGumpAdvanced for per-group expand/collapse. CUO has a richer
// "scroll" chrome (animated parchment unfurl); our MVP renders a
// header strip with a chevron + a body Container that hides on
// collapse.

import { Container, Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { Label } from './label.js';

export class ExpandableScroll extends Control {
  constructor({ label = '', width = 200, expanded = true } = {}) {
    super();
    this.acceptMouseInput = true;
    this.width = width;
    this.height = 20;
    this._expanded = !!expanded;
    this._headerH = 20;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._label = new Label(label, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    this._label.acceptMouseInput = false;
    this._label.setPosition(20, 4);
    this.add(this._label);
    this.body = new Container();
    this.body.position.set(8, this._headerH);
    this.node.addChild(this.body);
    this._draw();
  }

  setExpanded(on) {
    this._expanded = !!on;
    this.body.visible = this._expanded;
    this._draw();
    this.onToggle?.(this._expanded);
  }

  isExpanded() { return this._expanded; }

  setBodyHeight(h) {
    this.height = this._expanded ? this._headerH + h : this._headerH;
  }

  onClick() { this.setExpanded(!this._expanded); }

  _draw() {
    this._gfx.clear();
    // Header chrome.
    this._gfx.rect(0, 0, this.width, this._headerH).fill({ color: 0x261a10, alpha: 0.9 }).stroke({ width: 1, color: 0x6a4a18 });
    // Chevron.
    const x = 6, y = 6;
    if (this._expanded) {
      this._gfx.poly([x, y, x + 8, y, x + 4, y + 8]).fill({ color: 0xffe080 });
    } else {
      this._gfx.poly([x, y, x + 8, y + 4, x, y + 8]).fill({ color: 0xffe080 });
    }
  }
}
