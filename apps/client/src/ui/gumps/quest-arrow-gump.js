// QuestArrowGump — floating arrow that points the player toward a quest
// destination at the screen edge. Mirrors ClassicUO
// Game/UI/Gumps/QuestArrowGump.cs.
//
// Server drives this with 0xBA QuestArrow (1 byte active + 4 byte serial
// + 2x i16 coords). Active=0 hides the arrow; non-zero shows.
//
// Implementation: a fixed Pixi sprite anchored at the screen edge in the
// direction (dx,dy) from the player to the target, with the arrow
// rotated to match. We piggy-back on the overlay app from ui-manager.

import { Graphics, Container, Rectangle } from 'pixi.js';
import { world } from '../../world/world.js';
import { camera } from '../../renderer/camera.js';
import { net } from '../../net/net-client.js';
import { buildClickQuestArrow } from '../../net/outgoing.js';

class QuestArrow {
  constructor() {
    this.container = new Container();
    this.container.eventMode = 'static';
    this.container.cursor = 'pointer';
    this.container.hitArea = new Rectangle(-12, -14, 42, 28);
    this.container.on('pointertap', (event) => {
      const button = event?.button ?? event?.nativeEvent?.button ?? 0;
      if (button !== 0) return;
      event?.stopPropagation?.();
      this._ack(false);
    });
    this.container.on('rightdown', (event) => {
      event?.stopPropagation?.();
      this._ack(true);
      this.setTarget(null);
    });
    this._gfx = new Graphics();
    this.container.addChild(this._gfx);
    this._draw();
    this._target = null;     // { x, y, serial }
    this._mounted = false;
    this._lastUpdateKey = '';
  }

  /** Build a 22×22 yellow chevron pointing right. We rotate the
   *  container to point in the right direction. */
  _draw() {
    this._gfx.clear();
    this._gfx.poly([
      0, -10,
      18, 0,
      0, 10,
      4, 0,
    ]).fill({ color: 0xFFE060 }).stroke({ width: 2, color: 0x884400 });
  }

  setTarget(t) {
    this._target = t ? {
      x: t.x | 0,
      y: t.y | 0,
      serial: t.serial >>> 0,
    } : null;
    this._lastUpdateKey = '';
    if (!t) {
      if (this._mounted && this.container.parent) {
        this.container.parent.removeChild(this.container);
        this._mounted = false;
      }
    }
  }

  clear() {
    this.setTarget(null);
  }

  _ack(rightClick) {
    try { net.send(buildClickQuestArrow(!!rightClick)); } catch { /* socket */ }
  }

  hasTarget() { return !!this._target; }

  /** Called every frame — re-positions the arrow at the screen edge in
   *  the direction of the target. Player coords come from world.player. */
  update(stage) {
    if (!this._target || !stage) return;
    if (!this._mounted) {
      stage.addChild(this.container);
      this._mounted = true;
    }
    const player = world.player;
    if (!player) return;
    const dx = this._target.x - player.x;
    const dy = this._target.y - player.y;
    const angle = Math.atan2(dy, dx);
    const cx = camera.viewX + camera.viewW / 2;
    const cy = camera.viewY + camera.viewH / 2;
    const radius = Math.max(8, Math.min(camera.viewW, camera.viewH) / 2 - 24);
    const key = [
      this._target.x, this._target.y,
      player.x | 0, player.y | 0,
      camera.viewX | 0, camera.viewY | 0,
      camera.viewW | 0, camera.viewH | 0,
    ].join('|');
    if (key === this._lastUpdateKey) return;
    this._lastUpdateKey = key;
    this.container.position.set(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    this.container.rotation = angle;
  }
}

export const questArrow = new QuestArrow();
