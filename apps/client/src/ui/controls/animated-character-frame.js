// AnimatedCharacterFrame — compact Pixi mannequin preview.
// Used by race-change / character pickers where CUO hosts an
// AnimatedCharacterFrame instead of a static DOM silhouette.

import { Container, Graphics, Ticker } from 'pixi.js';
import { Control } from '../control.js';
import { assets } from '../../assets/asset-manager.js';
import { applyHueTo } from '../../renderer/hue-filter.js';
import { Action, MobileAnimation } from '../../renderer/mobile-animation.js';
import { acquireSprite, releaseSprite } from '../../renderer/sprite-pool.js';

const DEFAULT_WIDTH = 160;
const DEFAULT_HEIGHT = 220;

function approxHueColor(hue, fallback) {
  if (!hue) return fallback;
  const h = (hue & 0xFFFF) * 13;
  const r = (h * 7) & 0xFF;
  const g = (h * 11) & 0xFF;
  const b = (h * 13) & 0xFF;
  return ((100 + (r >> 1)) << 16) | ((60 + (g >> 1)) << 8) | (40 + (b >> 1));
}

function normalizeEquipment(equipment = []) {
  const out = [];
  for (const eq of equipment) {
    if (!eq || (eq.itemId | 0) <= 0) continue;
    out.push({
      layer: eq.layer | 0,
      itemId: eq.itemId | 0,
      hue: eq.hue | 0,
    });
  }
  out.sort((a, b) => a.layer - b.layer);
  return out;
}

export class AnimatedCharacterFrame extends Control {
  constructor({
    width = DEFAULT_WIDTH,
    height = DEFAULT_HEIGHT,
    body = 0x190,
    hue = 0,
    equipment = [],
    direction = 4,
    scale = 2.35,
    drawFrame = true,
  } = {}) {
    super();
    this.acceptMouseInput = false;
    this.width = width | 0;
    this.height = height | 0;
    this.body = body | 0;
    this.hue = hue | 0;
    this._scale = Number(scale) || 1;
    this._drawFrame = !!drawFrame;
    this._equipment = normalizeEquipment(equipment);
    this._equipSprites = new Map();
    this._spriteHue = new WeakMap();

    this._anim = new MobileAnimation();
    this._anim.setBody(this.body);
    this._anim.setDirection(direction);
    this._anim.setAction(Action.Idle);

    this._bg = new Graphics();
    this._stage = new Container();
    this._fallback = new Graphics();
    this._stage.addChild(this._fallback);
    this.node.addChild(this._bg);
    this.node.addChild(this._stage);
    this._layout();
    this._paintFrame();
    this._paintFallback();

    this._onTick = (ticker) => {
      const dt = ((ticker?.deltaMS ?? 16.7) / 1000) || (1 / 60);
      this.tick(dt);
    };
    Ticker.shared.add(this._onTick);
    this._renderFrame();
  }

  setSize(w, h) {
    super.setSize(w, h);
    this._layout();
    this._paintFrame();
    this._paintFallback();
  }

  setAppearance({ body = this.body, hue = this.hue, equipment = this._equipment, isFlying = false } = {}) {
    const nextBody = body | 0;
    const nextHue = hue | 0;
    if (nextBody !== this.body) {
      this.body = nextBody;
      this._anim.setBody(this.body);
    }
    if (nextHue !== this.hue) {
      this.hue = nextHue;
      this._spriteHue = new WeakMap();
    }
    this._anim.setContext({ isFlying: !!isFlying });
    this._equipment = normalizeEquipment(equipment);
    for (const key of this._equipSprites.keys()) {
      let equipped = false;
      for (const eq of this._equipment) {
        if (eq.layer === key) { equipped = true; break; }
      }
      if (!equipped) {
        releaseSprite(this._equipSprites.get(key));
        this._equipSprites.delete(key);
      }
    }
    this._paintFallback();
    this._renderFrame();
  }

  tick(dt) {
    this._anim.tick(dt);
    this._renderFrame();
  }

  _layout() {
    if (!this._stage) return;
    this._stage.position.set(Math.round(this.width / 2), this.height - 24);
    this._stage.scale.set(this._scale);
  }

  _paintFrame() {
    if (!this._bg) return;
    this._bg.clear();
    if (!this._drawFrame) return;
    this._bg.roundRect(0, 0, this.width, this.height, 4)
      .fill({ color: 0x1b130b, alpha: 0.92 })
      .stroke({ width: 1, color: 0x6e5224, alpha: 0.95 });
    this._bg.roundRect(4, 4, Math.max(0, this.width - 8), Math.max(0, this.height - 8), 3)
      .stroke({ width: 1, color: 0x2e2414, alpha: 0.9 });
  }

  _paintFallback() {
    if (!this._fallback) return;
    let hairHue = 0;
    let beardHue = 0;
    let hasHair = false;
    let hasBeard = false;
    for (const eq of this._equipment) {
      if (eq.layer === 11) {
        hairHue = eq.hue;
        hasHair = true;
      } else if (eq.layer === 16) {
        beardHue = eq.hue;
        hasBeard = true;
      }
    }
    const skin = approxHueColor(this.hue, 0xd8b07e);
    const hair = approxHueColor(hairHue, 0x5a3a1c);
    const beard = approxHueColor(beardHue, hair);
    this._fallback.clear();
    this._fallback.ellipse(0, -70, 13, 16).fill({ color: skin, alpha: 0.95 });
    this._fallback.roundRect(-18, -56, 36, 62, 16).fill({ color: skin, alpha: 0.9 });
    if (hasHair) {
      this._fallback.ellipse(0, -83, 18, 8).fill({ color: hair, alpha: 0.95 });
    }
    if (hasBeard) {
      this._fallback.ellipse(0, -58, 13, 7).fill({ color: beard, alpha: 0.95 });
    }
  }

  _ensureBodySprite() {
    if (this._bodySprite) return this._bodySprite;
    this._bodySprite = acquireSprite();
    this._stage.addChildAt(this._bodySprite, 0);
    return this._bodySprite;
  }

  _ensureEquipSprite(layer) {
    let sp = this._equipSprites.get(layer);
    if (sp) return sp;
    sp = acquireSprite();
    this._equipSprites.set(layer, sp);
    this._stage.addChild(sp);
    return sp;
  }

  _applySprite(sp, resolved, hue) {
    if (!resolved?.texture) return false;
    if (sp.texture !== resolved.texture) sp.texture = resolved.texture;
    const meta = resolved.meta ?? resolved;
    if (meta && meta.w > 0 && meta.h > 0) {
      sp.anchor.set(meta.cx / meta.w, (meta.h + meta.cy) / meta.h);
    } else {
      sp.anchor.set(0.5, 1);
    }
    sp.position.set(0, 0);
    sp.scale.x = resolved.mirror ? -1 : 1;
    sp.scale.y = 1;
    sp.visible = true;
    if (this._spriteHue.get(sp) !== hue) {
      applyHueTo(sp, hue, hue ? 1 : 0, assets.huesTexture, assets.huesMeta?.count);
      this._spriteHue.set(sp, hue);
    }
    return true;
  }

  _resolveEquipment(eq) {
    try {
      const map = assets.resolveEquipAnim?.(this.body, eq.itemId, eq.hue)
        ?? { animBody: eq.itemId, hue: eq.hue };
      const group = this._anim.currentGroupId(map.animBody);
      const tex = assets.mobileFrameTextureSync?.(
        map.animBody,
        group,
        this._anim.direction,
        this._anim.frame,
      );
      return tex ? { ...tex, hue: map.hue | 0, mirror: this._anim.mirror } : null;
    } catch {
      return null;
    }
  }

  _renderFrame() {
    const resolved = this._anim.resolveTextureSync();
    const bodyReady = this._applySprite(this._ensureBodySprite(), resolved, this.hue);
    this._fallback.visible = !bodyReady;
    if (this._bodySprite) this._bodySprite.visible = bodyReady;

    for (const eq of this._equipment) {
      const sp = this._ensureEquipSprite(eq.layer);
      const tex = this._resolveEquipment(eq);
      sp.visible = !!tex && this._applySprite(sp, tex, tex.hue | 0);
    }
  }

  dispose() {
    Ticker.shared.remove(this._onTick);
    releaseSprite(this._bodySprite);
    this._bodySprite = null;
    for (const sp of this._equipSprites.values()) releaseSprite(sp);
    this._equipSprites.clear();
    super.dispose();
  }
}
