// WorldViewportGump — sticky window that draws the live game viewport
// as a small re-positionable picture-in-picture. CUO's
// `Game/UI/Gumps/WorldViewportGump.cs` originally hosted the main world
// render; on shards that allow detaching it, the player can dock it
// elsewhere or open a second small viewport for radar / portrait /
// overhead-map purposes.
//
// We re-purpose the slot as a "minimap-plus" frame anchored bottom-right
// by default; the GameScene main viewport stays primary. The frame
// shows a stylised radar dot field of nearby mobiles + the player blip
// + a screenshot-still of the world layer (refreshed at 4 Hz to keep
// the GPU cost bounded — full live PIP would need a RenderTexture
// pipeline that's beyond MVP scope).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Graphics } from 'pixi.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { profile } from '../../managers/profile-manager.js';

const W = 220;
const H = 180;
const RADAR_RANGE = 18;

export class WorldViewportGump extends WindowGump {
  constructor() {
    const saved = profile.loadGumpState('world-viewport') ?? {};
    super({
      title: 'Viewport',
      width: saved.w ?? W,
      height: saved.h ?? H,
      x: saved.x ?? (window.innerWidth - W - 12),
      y: saved.y ?? (window.innerHeight - H - 70),
    });
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._hint = new Label('Radar', { fontSize: 10, hue: 0xa08868, stroke: false });
    this._hint.setPosition(10, 26);
    this.add(this._hint);

    this._lastDraw = 0;
    this._lastForcedDraw = 0;
    this._lastDrawKey = '';
    this._unsubs = [
      bus.on('frame:tick', (now) => this._maybeRedraw(now)),
    ];
    this.node.on?.('pointerup', () => this._save());
  }

  get type() { return 'world-viewport'; }

  dispose() {
    for (const u of this._unsubs) u();
    this._save();
    super.dispose();
  }

  _save() {
    profile.saveGumpState('world-viewport', {
      x: this.node.x | 0, y: this.node.y | 0, w: this._w, h: this._h,
    });
  }

  _maybeRedraw(now) {
    if (now - this._lastDraw < 250) return;       // 4 Hz cap
    this._lastDraw = now;
    const force = now - this._lastForcedDraw >= 2000;
    if (force) this._lastForcedDraw = now;
    this._draw(force);
  }

  _draw(force = false) {
    const p = world.player;
    const drawKey = p
      ? `${p.x | 0}|${p.y | 0}|${p.map ?? world.mapId ?? 1}|${this._w}|${this._h}|${world._mobileSpatialRevision ?? 0}`
      : `noplayer|${this._w}|${this._h}`;
    if (!force && drawKey === this._lastDrawKey) return;
    this._lastDrawKey = drawKey;
    const g = this._gfx;
    g.clear();
    const padX = 12, padY = 46;
    const innerW = this._w - padX * 2;
    const innerH = this._h - padY - 12;
    // Dark inset.
    g.roundRect(padX, padY, innerW, innerH, 4)
      .fill({ color: 0x0a0d18, alpha: 0.9 })
      .stroke({ width: 1, color: 0x3a2a14 });
    if (!p) return;
    const cx = padX + innerW / 2;
    const cy = padY + innerH / 2;
    const scale = Math.min(innerW, innerH) / (RADAR_RANGE * 2);
    // Player dot (cream).
    g.circle(cx, cy, 3).fill({ color: 0xfff0c0 });
    g.circle(cx, cy, 6).stroke({ width: 1, color: 0xfff0c0, alpha: 0.5 });
    // Nearby mobile blips.
    const map = p.map ?? world.mapId ?? 1;
    const paintMobile = (m) => {
      if (m === p || m.dead) return;
      if ((m.map ?? map) !== map) return;
      const dx = (m.x ?? 0) - (p.x ?? 0);
      const dy = (m.y ?? 0) - (p.y ?? 0);
      if (Math.abs(dx) > RADAR_RANGE || Math.abs(dy) > RADAR_RANGE) return;
      const sx = cx + dx * scale;
      const sy = cy + dy * scale;
      let color;
      const n = m.notoriety ?? 1;
      if (n === 1) color = 0x80c0ff;
      else if (n === 2) color = 0x80ff80;
      else if (n === 6) color = 0xff4444;
      else if (n === 4 || n === 5) color = 0xffa040;
      else color = 0xc0c0c0;
      g.circle(sx, sy, 2).fill({ color });
    };
    if (typeof world.forEachMobileNear === 'function') {
      world.forEachMobileNear(p.x, p.y, map, RADAR_RANGE, true, paintMobile);
    } else {
      const nearby = world.mobilesNear
        ? world.mobilesNear(p.x, p.y, map, RADAR_RANGE, true)
        : world.mobiles.values();
      for (const m of nearby) paintMobile(m);
    }
  }
}
