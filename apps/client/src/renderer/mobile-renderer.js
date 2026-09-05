// Animated mobile renderer. Each visible mobile owns:
//   - a MobileAnimation state machine (action / direction / frame)
//   - one Pixi Sprite that swaps Textures as frames advance
//   - a name plate Text overlay
//
// The state machine is driven by world events:
//   - mobile:incoming / mobile:moving → setDirection + Walk action
//   - mobile:idle (synthesized after a short movement grace) → Idle
//   - mobile:anim (0x6E / 0xE2 from server) → setAction(custom, oneShot=true)

import { Container, Graphics, Text, TextStyle, MeshSimple, ColorMatrixFilter } from 'pixi.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../ui/text-quality.js';

// Shared TextStyle for every name-plate — client perf round 2 #15.
// Pixi v8 caches glyph rasters per TextStyle, so reusing a singleton
// across N mob sprites cuts the canvas-cache cost from O(N) to O(1).
const NAME_PLATE_STYLE = new TextStyle({
  fill: 0xf0e8c0, fontSize: 13,
  fontFamily: UI_FONT_FAMILY, fontWeight: 650,
  stroke: { color: 0x000000, width: 2, join: 'round' },
});
import { worldToScreenX, worldToScreenY, depthKey, LAYER_MOBILE } from './iso.js';
import { world } from '../world/world.js';
import { assets } from '../assets/asset-manager.js';
import { applyHueTo } from './hue-filter.js';
import { MobileAnimation, Action, ANIMATION_PRIORITY } from './mobile-animation.js';
import { bus } from '../core/event-bus.js';
import { audio } from '../managers/audio-manager.js';
import { auraManager } from '../managers/aura-manager.js';
import { macroManager } from '../managers/macro-manager.js';
import { profile } from '../managers/profile-manager.js';
import { acquireSprite, releaseSprite } from './sprite-pool.js';
import { mountInfoForItem } from '../shared/mount-data.js';

// Shared shadow indices buffer — every MobileSprite reuses it (Pixi only
// reads it on geometry construction). Saves an allocation per mob.
const SHADOW_INDICES = new Uint32Array([0, 1, 2, 1, 3, 2]);

// Footstep sound ids. ClassicUO `Mobile.cs::PlayFootstepSounds` alternates
// between two indices each tile so the cadence isn't monotonous. Mount
// running uses 0x0129. We try the canonical UO ids; missing audio bins
// just no-op via audio.playSfx.
const FOOTSTEP_SFX = [0x012B, 0x012C];
const MOUNT_RUN_SFX = 0x0129;

// Grace after one interpolation before returning to idle. The actual latch is
// step-duration + this small scheduling margin, so Run no longer keeps playing
// for 600 ms after the player has stopped.
const WALK_LATCH_SLACK_MS = 80;

// War-mode equipment fallback. Equipment overlays (cloaks, sleeves,
// hats, etc.) frequently ship in the atlas with only the peaceful
// People-group frames. When the body's animation context resolves to
// a war-mode / combat group, this table points back to the equivalent
// peaceful group so the cloak still has a frame to draw instead of
// freezing on the last peace-mode texture. Mirrors CUO
// PEOPLE_GROUP IDs (see mobile-animation.js):
//   0  walk      1  walkArmed   2  run         3  runArmed
//   4  idle      5  fidget      6  fidget2     7  idleWar
//   8  idleWar2H 9  attack     10  attackUnarmed  11  attackUnarmed2
//   12 attack2H  13 attack2HWide 14 attack2HJab  15 walkWar
//   16 cast      17 castArea    18 attackBow   19 attackXbow
//   20 getHit    21 die1         22 die2
const WAR_TO_PEACE_FALLBACK = {
  // Idle / walk variants
  7: 4, 8: 4, 15: 0,
  // Attack variants — fall back to nearest peace anim when atlas
  // doesn't ship the war frames for a worn item.
  9: 5, 10: 5, 11: 5, 12: 5, 13: 5, 14: 5,
  16: 4, 17: 4, 18: 4, 19: 4, 20: 4,
  // Walk-armed / run-armed often ship in atlas, but if not fall to bare.
  1: 0, 3: 2,
};

// Per-direction equipment draw order — mirrors CUO LayerOrder.UsedLayers
// (LayerOrder.cs:7-64). Same 23 layer ids per row, but the relative
// position of Cloak / Helmet / TwoHanded changes with the facing so
// the cloak hangs correctly behind the body when looking SE/NE/S etc.
//
// Layer enum ids (Layers.cs):
//   OneHanded=1 TwoHanded=2 Shoes=3 Pants=4 Shirt=5 Helmet=6 Gloves=7
//   Ring=8 Talisman=9 Necklace=10 Hair=11 Waist=12 Torso=13 Bracelet=14
//   Face=15 Beard=16 Tunic=17 Earrings=18 Arms=19 Cloak=20 Robe=22
//   Skirt=23 Legs=24
//
// Anim direction is the post-mapping value (0..4) computed by
// `MobileAnimation.setDirection`. We index by anim direction × mirror
// flag → 8 logical "facings" matching CUO.
const L = {
  Shirt: 5, Pants: 4, Shoes: 3, Legs: 24, Torso: 13, Ring: 8, Talisman: 9,
  Bracelet: 14, Face: 15, Arms: 19, Gloves: 7, Skirt: 23, Tunic: 17,
  Robe: 22, Necklace: 10, Hair: 11, Waist: 12, Beard: 16, Earrings: 18,
  OneHanded: 1, Helmet: 6, TwoHanded: 2, Cloak: 20,
};
const LAYER_ORDER_SE = Object.freeze([
  L.Cloak, L.Shirt, L.Pants, L.Shoes, L.Legs, L.Torso, L.Ring, L.Talisman,
  L.Bracelet, L.Face, L.Arms, L.Gloves, L.Skirt, L.Tunic, L.Robe, L.Waist,
  L.Necklace, L.Hair, L.Beard, L.Earrings, L.Helmet, L.OneHanded, L.TwoHanded,
]);
const LAYER_ORDER_DEFAULT = Object.freeze([
  L.Shirt, L.Pants, L.Shoes, L.Legs, L.Torso, L.Ring, L.Talisman, L.Bracelet,
  L.Face, L.Arms, L.Gloves, L.Skirt, L.Tunic, L.Robe, L.Necklace, L.Hair,
  L.Waist, L.Beard, L.Earrings, L.OneHanded, L.Cloak, L.Helmet, L.TwoHanded,
]);
// Indexes 1..4 share the same order in CUO LayerOrder.cs — single shared
// frozen array, no per-direction copies.
const LAYER_ORDER_BY_DIR = [
  LAYER_ORDER_SE,
  LAYER_ORDER_DEFAULT,
  LAYER_ORDER_DEFAULT,
  LAYER_ORDER_DEFAULT,
  LAYER_ORDER_DEFAULT,
];

function pickLayerOrder(animDir) {
  return LAYER_ORDER_BY_DIR[animDir & 7] ?? LAYER_ORDER_BY_DIR[0];
}

class MobileSprite {
  constructor(serial) {
    this.serial = serial >>> 0;
    this.container = new Container();
    this.container.label = `mob(${this.serial.toString(16)})`;
    this._body = new Graphics();
    this._dir = new Graphics();
    /** @type {Sprite | null} */
    this._sprite = null;
    /** @type {Map<number, Sprite>} layer id -> overlay sprite (eq) */
    this._equipSprites = new Map();
    /** @type {number} */
    this._spriteHue = -1;
    /** @type {string} hash of the equipment state we last mounted */
    this._equipHash = 0;
    /** anim direction used last time equipment z-order was applied */
    this._lastLayerDir = -1;
    /** @type {MeshSimple | null} sheared half-height shadow under feet */
    this._shadow = null;
    /** @type {Graphics | null} aura ring under feet (party / notoriety) */
    this._aura = null;
    /** @type {Sprite | null} mount sprite (Layer 25) — drawn beneath body */
    this._mountSprite = null;
    /** @type {MobileAnimation} dedicated state machine for the mount */
    this._mountAnim = new MobileAnimation();
    this._mountBody = 0;
    this._mountHueApplied = -1;
    this._riderOffsetY = 0;
    /** desaturate + alpha filter applied while mob is hidden / dead */
    this._dimFilter = null;
    /** monotone X+Y so we can detect whole-tile crossings for footstep audio */
    this._lastTileX = 0;
    this._lastTileY = 0;
    this._stepIndex = 0;
    this._anim = new MobileAnimation();
    /** ms timestamp of last mobile:moving event */
    this._lastMoveAt = 0;
    this._moveDurationMs = 400;
    /** @type {Text} */
    this._label = new Text({
      text: '', style: NAME_PLATE_STYLE, resolution: UI_TEXT_RESOLUTION, roundPixels: true,
    });
    this._label.anchor.set(0.5, 1);
    // Y is set dynamically in tick() using the body's current frame
    // height — `-22` was the old static fallback that put the label
    // under the chin for tall (78px) human bodies. Will be overwritten
    // every tick once we have a meta.h.
    this._label.position.set(0, -78);
    this.container.addChild(this._body, this._dir, this._label);
    this._stackDirty = true;
    this._lastStackDir = -1;
    this._seenStamp = 0;
  }

  /** One-shot custom action driven by 0x6E / 0xE2. */
  playAction(action, opts = {}) {
    // CUO `Mobile.SetAnimation(action, delay, frameCount, repeatCount)`
    // — server-scripted long emotes ship a custom frame count + delay
    // so the visual length matches the gameplay timer (axe swing 3 s,
    // staff cast 4 s). Previously we ignored everything except the
    // action id, so every custom anim collapsed to default speed.
    this._anim.setAction(action, {
      oneShot: opts.oneShot ?? true,
      frameCount: opts.frameCount,
      repeatCount: opts.repeatCount,
      delay: opts.delay,
      reverse: opts.reverse,
      staticFrame: opts.staticFrame,
      priority: opts.priority ?? ANIMATION_PRIORITY.Server,
      holdLastFrame: opts.holdLastFrame,
    });
  }

  /** Build / refresh the drop-shadow mesh. Mirrors CUO Batcher2D
   *  `DrawShadow` (Batcher2D.cs:308-361) — a sheared half-height copy of
   *  the body bitmap, painted with SHADER_SHADOW (black tint, 45 %α).
   *  All coords are mesh-local (origin = body anchor / tile centre):
   *    topY = -h - cy + 0.5h - 10 = -0.5h - cy - 10
   *    botY = topY + 0.5h
   *    skew = 0.5h to the right at top vertices */
  _updateShadow(meta, mirror) {
    if (!meta || meta.w <= 0 || meta.h <= 0) {
      if (this._shadow) this._shadow.visible = false;
      return;
    }
    const { w, h, cx, cy } = meta;
    const skew = h * 0.5;
    const topY = -h - cy + skew - 10;
    const botY = topY + skew;
    const left = -cx;
    const right = -cx + w;
    // Per-instance scratch buffers — re-used across frames so the GC
    // doesn't have to reclaim N×16-byte Float32Arrays per second on a
    // crowded scene (city centre with 50+ mobs = thousands of allocations
    // per second before this fix). Indices never change and stay shared.
    if (!this._shadowVerts) {
      this._shadowVerts = new Float32Array(8);
      this._shadowUvs   = new Float32Array(8);
    }
    const verts = this._shadowVerts;
    verts[0] = left + skew; verts[1] = topY;     // 0 top-left  (sheared)
    verts[2] = right + skew; verts[3] = topY;    // 1 top-right
    verts[4] = left;         verts[5] = botY;    // 2 bot-left
    verts[6] = right;        verts[7] = botY;    // 3 bot-right
    const uvs = this._shadowUvs;
    if (mirror) { uvs[0]=1; uvs[1]=0; uvs[2]=0; uvs[3]=0; uvs[4]=1; uvs[5]=1; uvs[6]=0; uvs[7]=1; }
    else        { uvs[0]=0; uvs[1]=0; uvs[2]=1; uvs[3]=0; uvs[4]=0; uvs[5]=1; uvs[6]=1; uvs[7]=1; }
    if (!this._shadow || this._shadow.destroyed || this._shadow.texture !== this._sprite?.texture) {
      this._shadow?.destroy();
      // Indices are immutable — share one Uint32Array per process.
      const indices = SHADOW_INDICES;
      // Pass copies on first creation since Pixi may store references and
      // we want our scratch buffers to remain hot-update targets only.
      this._shadow = new MeshSimple({
        texture: this._sprite.texture,
        vertices: new Float32Array(verts),
        uvs:      new Float32Array(uvs),
        indices,
      });
      this._shadow.autoUpdate = false;
      this._shadow.onRender = null;
      this._shadow.tint = 0x000000;
      this._shadow.alpha = 0.45;
      this.container.addChild(this._shadow);
      this._stackDirty = true;
    } else {
      // Vertices and UVs change with the animation frame — copy our scratch
      // values into Pixi's internal buffer and request a GPU upload.
      const posBuf = this._shadow.geometry.getBuffer('aPosition');
      if (posBuf) {
        if (posBuf.data?.length === 8) { posBuf.data.set(verts); }
        else { posBuf.data = new Float32Array(verts); }
        posBuf.update();
      }
      const uvBuf = this._shadow.geometry.getBuffer('aUV');
      if (uvBuf) {
        if (uvBuf.data?.length === 8) { uvBuf.data.set(uvs); }
        else { uvBuf.data = new Float32Array(uvs); }
        uvBuf.update();
      }
    }
    this._shadow.visible = true;
  }

  /** Audit #36 P3 #13 — yellow-orange halo under the current combat
   *  target. CUO `TargetManager.LastAttack` is reflected as a ground
   *  ring so the player knows who they're locked onto in a crowd.
   *  Renders a thin elliptical outline distinct from the party aura. */
  _updateCombatHalo(isTarget, alive, now) {
    if (!isTarget || !alive) {
      if (this._combatHalo) this._combatHalo.visible = false;
      return;
    }
    if (!this._combatHalo) {
      this._combatHalo = new Graphics();
      this.container.addChildAt(this._combatHalo, 0);    // beneath sprite
      this._stackDirty = true;
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / 280);
    this._combatHalo.clear();
    this._combatHalo
      .ellipse(0, -2, 26, 11)
      .stroke({ color: 0xff8030, width: 2, alpha: 0.5 + pulse * 0.4 });
    this._combatHalo.visible = true;
  }

  /** Aura ring under feet — coloured glow used by CUO when party-aura
   *  or noto-aura is enabled (MobileView.cs:52-63). We render a soft
   *  ellipse Graphics; cheap and matches CUO visual at MVP scope. */
  _updateAura(notoColor, isParty, alive, now) {
    const enabled = alive && notoColor != null;
    if (!enabled) {
      if (this._aura) this._aura.visible = false;
      return;
    }
    if (!this._aura) {
      this._aura = new Graphics();
      this.container.addChild(this._aura);
      this._stackDirty = true;
    }
    const color = isParty ? 0x40c0ff : notoColor;
    // Bigger / pulsing for the local player so it's findable on a
    // crowded screen — animation atlases are tiny (22×39 idle frame)
    // and at low zoom the avatar otherwise vanishes into the floor.
    const pulse = 0.5 + 0.5 * Math.sin(now / 320);
    this._aura.clear();
    this._aura.ellipse(0, -2, 24, 10).fill({ color, alpha: 0.25 + pulse * 0.15 });
    this._aura.ellipse(0, -2, 16, 6).fill({ color, alpha: 0.5 + pulse * 0.2 });
    this._aura.visible = true;
  }

  /** Apply transient selection/range/damage tint to the assembled mobile.
   *  Body, equipment and mount are separate Pixi sprites; tinting only the
   *  body made clothing remain brightly coloured and also left a stale gray
   *  tint after an entity returned into range. */
  _setVisualTint(tint) {
    if (this._sprite) this._sprite.tint = tint;
    if (this._mountSprite) this._mountSprite.tint = tint;
    for (const sp of this._equipSprites.values()) sp.tint = tint;
  }

  /** Mark this mobile as moving — animation switches to Walk. */
  markMoving(now = performance.now(), running = false, durationMs = running ? 200 : 400) {
    this._lastMoveAt = now;
    this._moveDurationMs = Math.max(1, durationMs | 0);
    const action = running ? Action.Run : Action.Walk;
    if (this._anim.action !== action) {
      this._anim.setAction(action, { priority: ANIMATION_PRIORITY.Locomotion });
    }
  }

  /** Per-frame update. */
  tick(dt, mob, isPlayer, partyContains = false, now = performance.now()) {
    // Movement interpolation — Mobile.offsetX/Y decays from old-tile
    // delta (-22,-22 etc) to 0 over walk animation. Sprite slides
    // instead of teleporting. Logical (x,y) is already the new tile.
    const stillLerping = mob.tickMoveStep(now);
    // Multi-step deque — when the current lerp ends and there are more
    // pending steps queued (NPC multi-tile MoveTo), start the next.
    const startedQueuedStep = (mob.queuedStepCount ?? mob.steps?.length ?? 0) > 0
      ? mob.drainNextStep(now)
      : false;
    const isMovingNow = stillLerping || startedQueuedStep || mob.offsetEndAt > now;
    if (isMovingNow) {
      this._lastMoveAt = now;
      const durationMs = (mob.offsetEndAt ?? 0) - (mob.offsetStartAt ?? 0);
      if (durationMs > 0) this._moveDurationMs = durationMs;
      const locomotion = mob.moveRunning ? Action.Run : Action.Walk;
      if (this._anim.action !== locomotion) {
        this._anim.setAction(locomotion, { priority: ANIMATION_PRIORITY.Locomotion });
      }
    }
    // NB: do NOT zero `_lastMoveAt` the moment a lerp ends. Continuous
    // RMB-walk fires `markMoving()` each cadence step (~200-400 ms);
    // the previous lerp routinely finishes 1-2 frames before the next
    // markMoving lands. Snapping to Idle in that gap caused the
    // "skok" Marcin reported — the next `setAction(Walk)` resets
    // `frame=0` (Idle→Walk is not a locomotion-preserving transition)
    // so the legs jerked back to the start frame each step. The
    // movement-latch gate further down handles the legitimate "user
    // actually stopped walking" case at 600 ms.
    void stillLerping;
    const projX = worldToScreenX(mob.x, mob.y);
    const projY = worldToScreenY(mob.x, mob.y, mob.z);
    // CUO MobileView.cs:43 lifts mobiles 3 px above the tile floor.
    // Math.round on the final screen position kills sub-pixel shimmer
    // during walk lerp — offsetX/Y are fractional (decay 22→0 over
    // the step) and Pixi's `roundPixels` flag is honoured per sprite
    // only, not for the whole container subtree. Equipment overlays
    // inherit container.position so rounding here also stabilises
    // the cloak / staff / body lockstep.
    // Audit rev.4 P2 — hurt recoil shake. CUO `MobileView` does a
    // brief sprite jitter on hit; we add a 2-3px horizontal oscillation
    // for 280 ms after `damage:apply`. The jitter wraps the existing
    // walk-lerp offsetX so it doesn't fight the walk animation.
    let shakeX = 0;
    const recoilUntil = mob._hurtRecoilUntil | 0;
    if (recoilUntil > now) {
      const t = (recoilUntil - now) / 280;     // 1 -> 0
      // Decaying sinusoid; 3 cycles total across 280ms feels like a hit.
      shakeX = Math.round(Math.sin((1 - t) * Math.PI * 6) * 3 * t);
    }
    this.container.position.set(
      Math.round(projX + mob.offsetX + shakeX),
      Math.round(projY + mob.offsetY - 3 - mob.offsetZ - (mob.sitPoseOffsetY | 0)),
    );

    // Animation state. Audit #33 P3.3 — CUO `Mobile.CheckGraphicChange`
    // remaps a dead human body (0x190 male / 0x191 female) to the
    // matching ghost body (0x192 / 0x193) for animation. Without this
    // the ghost walked with the live walk-cycle frames instead of the
    // ghost float frames.
    const renderBody = (mob.isDead && (mob.body === 0x190 || mob.body === 0x191))
      ? mob.body + 2
      : mob.body;
    this._anim.setBody(renderBody);
    this._anim.setDirection(mob.direction & 7);
    // People-body group selectors (CUO MobileAnimation::CorrectAnimationGroup):
    // mounted bodies use OnmountRideSlow/Fast (23/24); war-mode walk
    // uses WalkWarmode (15) instead of WalkUnarmed (0); equipped weapon
    // promotes Idle/Walk to the *Armed* groups. Without this the
    // ridden character animated as "running alongside" the mount and
    // war-mode walk used the peaceful idle gait.
    const oneHanded = mob.equipment?.get?.(1);
    const twoHanded = mob.equipment?.get?.(2);
    const armed = !!(oneHanded || twoHanded);
    // 2H detection: layer 2 is the "TwoHanded" wear slot but it's also
    // the shield slot. Mirror CUO Mobile.IsTwoHanded — only treat the
    // layer-2 item as a 2H weapon when its tiledata has the Weapon
    // flag (bit 0x2). A shield occupies the same layer but lacks the
    // flag, so the war stance falls through to the 1H pose (group 7).
    const tlFlags = twoHanded
      ? (assets.tiledata?.statics?.[twoHanded.itemId | 0]?.flags | 0)
      : 0;
    const armed2H = !!twoHanded && (tlFlags & 0x2) !== 0;
    this._anim.setContext({
      isMounted: !!mob.isMounted,
      // Mobile.warMode is the field name in world.js (set from
      // FLAG_WARMODE in the 0x77 / 0x78 decoder). My initial port
      // read mob.inWarMode which never existed — every mobile read as
      // peaceful regardless of the actual war-mode flag.
      inWarMode: !!mob.warMode,
      // Gargoyle flying — CUO `Mobile.IsFlying` (0xBF subop 0x32 ack +
      // ToggleGargoyleFly macro). When set, resolveGroup remaps walk/
      // idle/attack to the fly* labels.
      isFlying: !!mob.isFlying,
      armed,
      armed2H,
      run: this._anim.action === Action.Run || !!mob.moveRunning,
      moveDurationMs: isMovingNow ? this._moveDurationMs : 0,
    });
    // Paralyze freeze — set the anim-side flag so tick() pins frame 0.
    // CUO mirrors the same gate in Mobile.IsParalyzed.
    this._anim.frozen = !!mob.frozen;

    // Footstep sound on full-tile crossings (CUO `Mobile.PlayFootstepSounds`).
    // Throttled to 1 sound per 280 ms so a running player (200 ms/step)
    // does not fire 5 sounds per second. The limit gives ~3.5 footsteps
    // per second max, which matches the sprite's walk-cycle pacing
    // (8-frame run anim @ 70ms/frame = 560ms full cycle, 2 footsteps
    // per cycle ≈ 280ms apart). Hidden mobs / dead mobs stay silent.
    if (this._lastTileX !== mob.x || this._lastTileY !== mob.y) {
      const moved = (this._lastTileX !== 0 || this._lastTileY !== 0);
      this._lastTileX = mob.x;
      this._lastTileY = mob.y;
      // CUO `Mobile.cs:529-568` `ProcessFootstepsSound` gates on
      // `IsHuman && !IsHidden && !IsDead && !IsFlying`. Without the
      // human gate every rat / scorpion / deer in view played the
      // walking-leather-boots sound. Audit #37 P2 #6: Body ids
      // 0x190..0x193 (Human), 0x025D/0x025E (Elf), 0x029A/0x029B
      // (Gargoyle) are all PEOPLE-table humanoids per CUO
      // `Mobile.IsHuman`. Was: only the human range matched, so Elf
      // and Gargoyle characters walked silently and had no shadow.
      // 0x190..0x193 are the
      // canonical human bodies (male + female + GM + GM-female).
      const _body = mob.body | 0;
      const isHuman = (_body >= 0x190 && _body <= 0x193)
                   || (_body === 0x025D || _body === 0x025E)
                   || (_body === 0x029A || _body === 0x029B);
      if (moved && isHuman && !mob.hidden && !mob.isDead) {
        const nowMs = now;
        const running = this._anim?.action === Action.Run || !!mob.moveRunning;
        const FOOTSTEP_MIN_INTERVAL_MS = mob.isMounted
          ? 170
          : (running ? 170 : 330);
        if (!this._lastFootstepAt || (nowMs - this._lastFootstepAt) >= FOOTSTEP_MIN_INTERVAL_MS) {
          this._lastFootstepAt = nowMs;
          // CUO only plays the horse-gallop SFX (0x0129) for mounted
          // RUNNING. Mounted walking is silent — both for ambience
          // and because the gallop sound at walk-speed reads as
          // chaotic. Approximate "running" via the animation action.
          let sfx;
          if (mob.isMounted) {
            const action = this._anim?.action;
            sfx = (action === 'run') ? MOUNT_RUN_SFX : null;
          } else {
            sfx = FOOTSTEP_SFX[(this._stepIndex++) & 1];
          }
          if (sfx) {
            try { audio.play?.(sfx); } catch { /* audio is best-effort */ }
          }
        }
      }
    }
    // Sit-anim: when the mob stands on a chair / throne static, swap the
    // walking/idle action to a static "sitting" pose. Mirrors CUO
    // SittingInfoData detection (Mobile.IsSitting check). MVP: detect a
    // chair static at the same tile and override frame to Idle frame 0.
    const canSit = this._anim.action === Action.Idle
      || this._anim.action === Action.Walk
      || this._anim.action === Action.Run;
    const sitting = !isPlayer && canSit && detectChairUnder(mob);
    if (sitting && this._anim.action !== Action.Idle) {
      this._anim.setAction(Action.Idle, { priority: ANIMATION_PRIORITY.Locomotion });
      this._anim._frameAt = 0;
    }
    if (!sitting && (this._anim.action === Action.Walk || this._anim.action === Action.Run)) {
      // _lastMoveAt is refreshed on every interpolation frame, not only at
      // step start, so only scheduler slack is needed after the feet arrive.
      if (now - this._lastMoveAt > WALK_LATCH_SLACK_MS) {
        this._anim.setAction(Action.Idle);
        // Force the equipment overlay loop to re-resolve textures this
        // tick. Without invalidating its `_lastEqAction` cache the
        // overlay would skip the work (cache says "still on Walk") and
        // the user would see the cloak/staff stuck on the LAST walk
        // frame for one paint after the body switched to Idle —
        // matched Marcin's "ostatnia klatka inny kierunek + war mode"
        // report (the last walk-armed frame visually overlaps the
        // war-stance pose).
        this._lastEqAction = null;
        this._lastEqFrame  = -1;
        this._lastEqDir    = -1;
      }
    }
    if (sitting) {
      this._anim.frame = 0;          // hold first idle frame
      // Audit rev.4 P3 — sit-pose Y offset. CUO `MobileView.cs:18`
      // (SIT_OFFSET_Y = 4) lifts the body 4 px so the seat art shows.
      // We stash it on the mob so the position.set() above picks it
      // Audit #46 P3 — per-anim-group sit Y offset. Humans (PEOPLE 400+)
      // settle 4 px; gargoyles (665-667) sit deeper (8 px); animals
      // (200-399) much less (1-2 px). CUO `MobileView.cs` table.
      const b = mob.body | 0;
      let dy = 4;
      if (b >= 665 && b <= 667) dy = 8;
      else if (b >= 200 && b < 400) dy = 1;
      else if (b < 200) dy = 2;
      mob.sitPoseOffsetY = dy;
    } else {
      this._anim.tick(dt);
      if (mob.sitPoseOffsetY) mob.sitPoseOffsetY = 0;
    }

    // SYNC LOCKSTEP RESOLVE — body + equipment must lock to the same
    // frame on the same tick or the user sees the body advance one
    // frame ahead of the cloak / staff. We resolve body AND every
    // equipment layer using the SYNC path; if ANY of them isn't
    // cached yet (different atlas page still streaming) we keep
    // every sprite on its previous frame and let prefetch warm the
    // pages for the next tick. Result: every visible swap is atomic
    // across body + equipment — no "ostatnia klatka body w innym
    // kierunku" desync.
    const resolved = this._anim.resolveTextureSync();
    // Pre-resolve every equipment layer's texture sync. Collect into a
    // staging array so we can either apply ALL or apply NONE.
    const animDir   = this._anim.direction;
    const animFrame = this._anim.frame;
    if (resolved) {
      const eqHash = equipHash(mob);
      if (eqHash !== this._equipHash || this._equipRefreshPending) {
        this._equipHash = eqHash;
        try { this._equipRefreshPending = !this._refreshEquipment(mob); } catch (e) {
          if (!this._eqWarned) { console.warn('[mobile] equip refresh', e); this._eqWarned = true; }
          this._equipRefreshPending = false;
        }
        this._lastLayerDir = this._anim.direction;
      }
    }
    const _stagingSprites = this._stagingEqSprites ?? (this._stagingEqSprites = []);
    const _stagingTextures = this._stagingEqTextures ?? (this._stagingEqTextures = []);
    let _stagingCount = 0;
    let _eqAllReady = !this._equipRefreshPending;
    for (const [layer, sp] of this._equipSprites) {
      const eq = mob.equipment?.get?.(layer);
      if (!eq) continue;
      let eqTex = null;
      try {
        const map = assets.resolveEquipAnim(mob.body, eq.itemId, eq.hue);
        const eqGroup = this._anim.currentGroupId(map.animBody);
        eqTex = assets.mobileFrameTextureSync?.(
          map.animBody, eqGroup, animDir, animFrame,
        );
        // War-mode fallback: many cloak/clothing equipment animations
        // ship only the peaceful group (4 idle / 0 walk). When the
        // body context resolves to a war variant (7 idleWar / 15
        // walkWar / 8 idleWar2H) we'd otherwise leave the cloak
        // sprite stuck on the previous frame because there is no
        // war-group texture for it when war mode flips. Mirror CUO's behaviour and
        // fall back to the peaceful equivalent so the cloak swings
        // along with the body even if the wardrobe lacks a war pose.
        if (!eqTex) {
          const peaceGroup = WAR_TO_PEACE_FALLBACK[eqGroup];
          if (peaceGroup != null && peaceGroup !== eqGroup) {
            eqTex = assets.mobileFrameTextureSync?.(
              map.animBody, peaceGroup, animDir, animFrame,
            );
            if (eqTex) {
              // Warm the war group too so a future tick can swap up.
              assets.prefetchMobileCycle?.(map.animBody, eqGroup, animDir);
            }
          }
        }
        if (!eqTex) {
          // Distinguish a TRANSIENT miss (atlas page still loading)
          // from a PERMANENT miss (this animBody / action / dir simply
          // isn't in the extracted manifest — common for clothing /
          // weapon items whose anim body id falls outside the
          // extractor's MAX_BODY range, or that ship only a subset of
          // actions). For permanent misses we must NOT gate the body
          // sprite on the equipment — otherwise the whole character
          // freezes mid-walk waiting on an animation that will never
          // arrive. Only flag _eqAllReady=false when the manifest has
          // a matching dirs entry; that's the only case where prefetch
          // can actually deliver a texture next tick.
          const hasManifestEntry = hasMobileManifestEntry(map.animBody, eqGroup, animDir);
          if (hasManifestEntry) {
            assets.prefetchMobileCycle?.(map.animBody, eqGroup, animDir);
            _eqAllReady = false;
          }
        }
      } catch { /* tolerate */ }
      _stagingSprites[_stagingCount] = sp;
      _stagingTextures[_stagingCount] = eqTex;
      _stagingCount++;
    }
    _stagingSprites.length = _stagingCount;
    _stagingTextures.length = _stagingCount;
    // If body is ready BUT equipment isn't, treat body as "not ready"
    // too — we keep the previous body frame so it stays in lockstep
    // with the cloak/staff that hasn't loaded yet.
    if (resolved && !_eqAllReady) {
      // Suppress the body swap this frame.
      // (Don't null `_currentTex` — that field is the cache; we just
      // skip the texture-replace below by clearing `resolved`.)
    }
    if (resolved && _eqAllReady) {
      if (!this._sprite) {
        const sp = acquireSprite(resolved.texture);
        this._sprite = sp;
        this.container.addChildAt(sp, 0);
        this._body.visible = false;
        this._dir.visible = false;
        this._stackDirty = true;
      } else if (this._sprite.texture !== resolved.texture) {
        this._sprite.texture = resolved.texture;
      }
      // Defensive — somewhere in the equipment / shadow / aura updates
      // a stale Pixi state could flip these flags. Force them every
      // frame so the body is always painted.
      this._sprite.visible = true;
      this._sprite.alpha   = 1;
      if (this._sprite.scale.y !== 1) this._sprite.scale.y = 1;
      // Anchor uses the (cx, cy) baked into each .mul frame so the
      // sprite's foot-on-tile pixel aligns with the iso tile centre.
      // Mirrors CUO MobileView.cs:706-715:
      //   x -= cx                  (or  width-cx  when mirrored)
      //   y -= height + cy
      // Pixi flips around the anchor so we keep anchor.x = cx/w in
      // both modes and just toggle scale.x.
      const m = resolved.meta;
      if (m && m.w > 0 && m.h > 0) {
        this._sprite.anchor.set(m.cx / m.w, (m.h + m.cy) / m.h);
      } else {
        this._sprite.anchor.set(0.5, 1);
      }
      this._sprite.scale.x = resolved.mirror ? -1 : 1;
      // Hue-recolour when it changes. We deliberately DO NOT auto-apply
      // a default skin tone for unhued human bodies any more: with the
      // fragment-shader filter active on the SPRITE, the partial-hue
      // path was rewriting every grey pixel to whatever the LUT row
      // for hue 0x03EA stored — and on this build the filter pipeline
      // came out near-white for unset hues, which let the body sprite
      // visually disappear against the parchment / sand floor. The
      // canonical UO bitmap for body 0x190 already ships with skin
      // tone, so leaving mob.hue at 0 (no filter) renders correctly.
      const effectiveHue = assets.mobileRenderHue?.(renderBody, mob.hue) ?? (mob.hue | 0);
      const hueMode = effectiveHue === 0 ? 0 : 1;
      if (effectiveHue !== this._spriteHue && assets.huesTexture && assets.huesMeta) {
        applyHueTo(this._sprite, effectiveHue, hueMode, assets.huesTexture, assets.huesMeta.count);
        this._spriteHue = effectiveHue;
      }
      // Mount sprite — when the mobile has a Layer 25 (Mount) item
      // equipped, render the mount body beneath the human. The mount
      // body graphic comes from tiledata.statics[mountItemId].animId
      // (CUO `MobileAnimation.GetMountAnimation`). When unmounted,
      // destroy the sprite. Hidden = no mount visual either (the
      // entire mob is masked with the dim filter below).
      try {
        if (mob.isMounted && !mob.hidden && !mob.isDead) {
          this._refreshMount(mob, dt);
        } else if (this._mountSprite) {
          // A2 — return to pool instead of destroying so the mount
          // sprite slot survives PvP-style mount/dismount churn.
          if (typeof releaseSprite === 'function') {
            try { releaseSprite(this._mountSprite); }
            catch { try { this._mountSprite.destroy(); } catch { /* ignore */ } }
          } else {
            this._mountSprite.destroy();
          }
          this._mountSprite = null;
          this._mountBody   = 0;
          this._mountHueApplied = -1;
          this._riderOffsetY = 0;
          this._stackDirty = true;
        } else {
          this._riderOffsetY = 0;
        }
      } catch (e) {
        if (!this._mountWarned) { console.warn('[mobile] mount render failed', e); this._mountWarned = true; }
      }
      // CUO draws the mount at the tile origin, then applies the mount-table
      // offset to the rider and every worn layer. Keeping that as one shared
      // offset prevents shirts/robes from hovering away from the body on
      // unicorns, skeletal steeds and newer tall mounts.
      const riderY = this._riderOffsetY | 0;
      this._sprite.position.set(0, riderY);
      this._body.position.set(0, riderY);
      this._dir.position.set(0, riderY);
      if (this._shadow) this._shadow.position.set(0, riderY);
      for (const sp of this._equipSprites.values()) sp.position.set(0, riderY);

      // Hidden / dead — desaturate + alpha. CUO uses
      // `EnableBlackWhiteEffect` shader for the dead variant; we share a
      // ColorMatrixFilter on this mob's container. Living-and-hidden uses
      // 50% alpha so the player can still spot themselves but enemies
      // visually fade. Dead applies fully desaturated (alpha 0.6 to keep
      // the avatar visible while the world filter dims everything).
      const wantsDeadFilter = !!mob.isDead;
      if (wantsDeadFilter) {
        if (!this._dimFilter) {
          this._dimFilter = new ColorMatrixFilter();
          this._dimFilter.desaturate();
          // One container pass keeps body, clothing and mount visually
          // coherent and is cheaper than one filter pass per equipment layer.
          this.container.filters = [this._dimFilter];
        }
        this.container.alpha = 0.6;
      } else if (this._dimFilter) {
        this.container.filters = null;
        // Client audit #4 A1 — Pixi v8 ColorMatrixFilter holds a GPU
        // uniform buffer + compiled program; nulling without destroy()
        // leaked an instance every hide/unhide toggle.
        try { this._dimFilter.destroy?.(); } catch { /* ignore */ }
        this._dimFilter = null;
        this.container.alpha = mob.hidden ? 0.5 : 1;
      } else {
        // Hidden living mobiles use translucency, not the death grayscale.
        this.container.alpha = mob.hidden ? 0.5 : 1;
      }
      // Hit-flash — short red tint after taking damage. Reads
      // `_hitFlashUntil` set by the damage bus listener in
      // MobileRenderer.update. ~200 ms duration; sprite tint clears
      // when timer elapses. Pixi sprite.tint is GPU-cheap (single
      // uniform) so we don't bother with a filter.
      const flashUntil = mob._hitFlashUntil | 0;
      let visualTint = 0xFFFFFF;
      if (flashUntil > now) {
        const t = Math.max(0, Math.min(1, (flashUntil - now) / 200));
        // Lerp from white→red: high red, low green/blue at t=1, full white at t=0
        const r = 255;
        const gB = Math.round(64 + 191 * (1 - t));
        visualTint = (r << 16) | (gB << 8) | gB;
      }
      // Selection outline — when this mobile is our target, lerp a
      // faint gold tint over the sprite. Cheaper than a real Pixi filter
      // (no extra render pass) and reads as "this one is selected".
      // Suppress while a hit-flash is active so the red flash wins.
      if (!(flashUntil > now) && (mob._isLastTarget || mob._isLastAttack)) {
        const pulse = 0.5 + 0.5 * Math.sin(now / 220);
        const gold = 255;
        const blueComp = Math.round(160 + 60 * pulse);
        const greenComp = Math.round(200 + 40 * pulse);
        visualTint = (gold << 16) | (greenComp << 8) | blueComp;
      }
      if (!(flashUntil > now) && !mob._isLastTarget && !mob._isLastAttack && mob._outOfRangeNoColor) {
        visualTint = 0x8c8c8c;
      }
      this._setVisualTint(visualTint);

      // Drop shadow + aura — both sit BELOW the body sprite. CUO
      // ShadowsEnabled+ShadowsMobile and PartyAura/Notoriety toggles
      // are skipped here; we always show shadow on living humans, aura
      // only for party members + the local player. Suppress on dead
      // mobs and when sitting (CUO Mobile.IsDead / IsSitting branches).
      // Wrapped: a Pixi runtime hiccup in MeshSimple/Graphics must NOT
      // stop the body sprite from rendering — we'd lose the avatar.
      try {
        const isAlive = !mob.isDead;
        const _b = mob.body | 0;
        const isHuman = (_b >= 0x190 && _b <= 0x193)
                     || (_b === 0x025D || _b === 0x025E)
                     || (_b === 0x029A || _b === 0x029B);
        if (isAlive && isHuman && !sitting) {
          this._updateShadow(resolved.meta, resolved.mirror);
        } else if (this._shadow) {
          this._shadow.visible = false;
        }
        // AuraManager decides — always-on (mode 3), war-mode only (1),
        // ctrl+shift (2), or off (0). Player always gets gold so they
        // can find themselves in a crowd.
        const wantsAura = isPlayer || auraManager.shouldPaint(mob, isPlayer, partyContains);
        const notoColor = wantsAura ? auraManager.colorFor(mob, isPlayer, partyContains) : null;
        this._updateAura(notoColor, partyContains, isAlive, now);
        // Audit #36 P3 #13 — combat target halo.
        const isCombatTarget = !isPlayer
          && (macroManager._lastAttack >>> 0) === (mob.serial >>> 0);
        this._updateCombatHalo(isCombatTarget, isAlive, now);
      } catch (e) {
        if (!this._fxWarned) {
          console.warn('[mobile] shadow/aura failed', e);
          this._fxWarned = true;
        }
      }
      // Equipment was pre-staged at the top of `tick()` (along with the
      // body sync resolve). We get here only when BOTH body and every
      // equipment layer's texture were ready — `_eqAllReady === true`
      // is guaranteed by the outer `if (resolved && _eqAllReady)`.
      // OPT: skip the per-layer loop when nothing changed since last
      // frame (animation hasn't ticked). Saves dozens of texture-pointer
      // writes when ~50 mobiles render in town.
      const animAction = this._anim.action;
      const eqStateUnchanged = (
        this._lastEqDir    === animDir   &&
        this._lastEqFrame  === animFrame &&
        this._lastEqAction === animAction &&
        this._lastEqMirror === resolved.mirror &&
        this._lastEqBody   === mob.body
      );
      if (!eqStateUnchanged) {
        this._lastEqDir = animDir; this._lastEqFrame = animFrame;
        this._lastEqAction = animAction; this._lastEqMirror = resolved.mirror;
        this._lastEqBody = mob.body;
        for (let i = 0; i < _stagingCount; i++) {
          const sp = _stagingSprites[i];
          const eqTex = _stagingTextures[i];
          if (!eqTex) continue;
          if (eqTex.texture !== sp.texture) {
            sp.texture = eqTex.texture;
            if (eqTex.w > 0 && eqTex.h > 0) {
              sp.anchor.set(eqTex.cx / eqTex.w, (eqTex.h + eqTex.cy) / eqTex.h);
            }
          }
          sp.scale.x = resolved.mirror ? -1 : 1;
        }
      }
      // Normalise z-order at the end of every tick so the body sprite
      // never gets stranded behind equipment / shadow / aura. Pixi
      // container children are drawn lowest-index first; we want:
      //   aura → shadow → body → equipment (per-direction order) → label
      const stackDir = this._anim.direction & 7;
      if (this._stackDirty || this._lastStackDir !== stackDir) {
        this._restackChildren();
        this._stackDirty = false;
        this._lastStackDir = stackDir;
      }
    } else if (!this._sprite) {
      // Fallback shimmer: subtle dark drop-shadow ellipse at the
      // mobile's feet. Marcin reported the previous magenta crosshair
      // (intended as a debug aid) was visually jarring — every NPC /
      // player flashed bright pink for ~100 ms while the body sprite
      // resolved. The ellipse here reads as "something is loading
      // here" without screaming for attention; the verbose console
      // log below still fires so the actual symptom is debuggable.
      this._body.clear();
      this._body.ellipse(0, -2, 16, 7).fill({ color: 0x000000, alpha: 0.35 });
      this._dir.clear();
      // Verbose log on every transition so the user can paste it back
      // for debugging. Debounced to once per second so we don't spam
      // the console in the hot path.
      if (!this._fallbackAt || now - this._fallbackAt > 1000) {
        this._fallbackAt = now;
        console.warn('[mobile] fallback — body=0x' + (mob.body || 0).toString(16) +
          ' action=' + this._anim.action + ' dir=' + this._anim.direction +
          ' frame=' + this._anim.frame + ' atlas?=' + !!assets.mobilesAtlas +
          ' bodyInAtlas?=' + !!assets.mobilesAtlas?.bodies?.[mob.body || 0] +
          ' isPlayer=' + isPlayer);
      }
    }

    // Always show a label for the local player — until 0x77/0x78 brings
    // a name we fall back to the serial so the avatar is locatable.
    const labelText = mob.name || (isPlayer ? `0x${mob.serial.toString(16)}` : '');
    if (this._label.text !== labelText) this._label.text = labelText;
    // Park the label above the head: container origin is foot-on-tile,
    // body sprite extrudes upward by `meta.h + meta.cy`. Add ~6px of
    // breathing room. Falls back to a sensible static height when the
    // sprite hasn't resolved yet (early tick / atlas miss).
    const meta = this._anim._currentMeta;
    const headY = (meta && meta.h > 0 ? -(meta.h + meta.cy + 6) : -78)
      + (this._riderOffsetY | 0);
    if (this._label.y !== headY) this._label.y = headY;
    // Publish the head pixel offset on the Mobile so other overlays
    // (world-text speech bubbles, future damage popups) can sit above
    // the actual sprite top instead of a static -28 that lands in the
    // middle of a 60-px human body.
    mob._spriteHeadOffset = headY;
  }

  /** Enforce child draw order on the mob container. Called at the end
   *  of every successful tick so newly-mounted shadow / aura / equipment
   *  sprites don't accidentally land at indices that hide the body. */
  _restackChildren() {
    const c = this.container;
    let idx = 0;
    const place = (child) => {
      if (!child || child.parent !== c) return;
      if (c.getChildIndex(child) !== idx) c.setChildIndex(child, idx);
      idx++;
    };
    place(this._combatHalo);
    place(this._aura);
    place(this._shadow);
    place(this._mountSprite);   // mount sits BELOW the rider human
    place(this._sprite);
    place(this._body);  // legacy fallback Graphics — invisible once sprite is up
    place(this._dir);
    const order = pickLayerOrder(this._anim.direction);
    for (const layer of order) place(this._equipSprites.get(layer));
    place(this._label);
  }

  /** Mount sprite — Layer 25 carries the mount item's graphic id. The
   *  actual *renderable* body comes from tiledata.statics[itemId].animId
   *  (CUO `Mobile.GetMountAnimation`). Render it below the human at the
   *  same screen position; the human's anim group switches to Walk/Run
   *  via the Mounted variant on the asset side. */
  _refreshMount(mob, dt = 1 / 60) {
    const eq = mob.equipment?.get?.(25);
    if (!eq) {
      this._riderOffsetY = 0;
      // Just dismounted? Fade the mount sprite out before destroying
      // so the rider doesn't pop free of the mount in one frame.
      if (this._mountSprite) {
        const sp = this._mountSprite;
        this._mountSprite = null;
        const generation = sp._uoPoolGeneration;
        const t0 = performance.now();
        const fade = () => {
          if (!sp || sp.destroyed || sp._uoPoolGeneration !== generation) return;
          const t = (performance.now() - t0) / 250;
          if (t >= 1) { try { releaseSprite(sp); } catch { /* ignore */ } return; }
          sp.alpha = Math.max(0, 1 - t);
          requestAnimationFrame(fade);
        };
        try { fade(); } catch { try { releaseSprite(sp); } catch { /* ignore */ } }
      }
      return;
    }
    const g = eq.itemId | 0;
    const mountInfo = mountInfoForItem(g);
    // ClassicUO's canonical mount table wins. Tiledata remains a compatibility
    // fallback for custom emulator mounts outside the retail range.
    const mountBody = mountInfo?.body
      ?? ((assets.tiledata?.statics?.[g]?.animId | 0) || 0);
    this._riderOffsetY = mountInfo?.riderOffsetY ?? 0;
    if (!mountBody) {
      if (this._mountSprite) { releaseSprite(this._mountSprite); this._mountSprite = null; }
      this._riderOffsetY = 0;
      return;
    }
    // (Re)compute frame parameters whenever body or direction changes.
    if (this._mountBody !== mountBody) {
      this._mountAnim.setBody(mountBody);
      this._mountBody = mountBody;
      this._mountHueApplied = -1;
    }
    // Mount is in lock-step with the human's facing + walk action.
    const wantDir = mob.direction & 7;
    const wantAct = this._anim.action === Action.Run
      ? Action.Run
      : (this._anim.action === Action.Walk ? Action.Walk : Action.Idle);
    this._mountAnim.setDirection(wantDir);
    this._mountAnim.setAction(wantAct);
    this._mountAnim.setContext({
      run: wantAct === Action.Run,
      moveDurationMs: (wantAct === Action.Walk || wantAct === Action.Run)
        ? this._moveDurationMs
        : 0,
    });
    // Client perf round 2 #6: pass real dt so the mount leg-cycle stays
    // in phase with the rider under throttle (was hardcoded 1/60).
    this._mountAnim.tick(dt);
    const resolved = this._mountAnim.resolveTextureSync();
    if (!resolved) return;
    if (!this._mountSprite) {
      this._mountSprite = acquireSprite(resolved.texture);
      this.container.addChild(this._mountSprite);
      this._stackDirty = true;
      // Fade-in transition on first appear (mounting). 250 ms ramp
      // from alpha 0 → 1 so the rider doesn't pop onto a horse the
      // moment 0x2E equipUpdate arrives.
      const sp = this._mountSprite;
      const generation = sp._uoPoolGeneration;
      sp.alpha = 0;
      const t0 = performance.now();
      const fade = () => {
        if (!sp || sp.destroyed || sp._uoPoolGeneration !== generation || this._mountSprite !== sp) return;
        const t = (performance.now() - t0) / 250;
        if (t >= 1) { sp.alpha = 1; return; }
        sp.alpha = t;
        requestAnimationFrame(fade);
      };
      try { fade(); } catch { sp.alpha = 1; }
    } else if (this._mountSprite.texture !== resolved.texture) {
      this._mountSprite.texture = resolved.texture;
    }
    const m = resolved.meta;
    if (m && m.w > 0 && m.h > 0) {
      this._mountSprite.anchor.set(m.cx / m.w, (m.h + m.cy) / m.h);
    } else {
      this._mountSprite.anchor.set(0.5, 1);
    }
    this._mountSprite.scale.x = resolved.mirror ? -1 : 1;
    this._mountSprite.scale.y = 1;
    this._mountSprite.position.set(0, 0);
    const mountHue = assets.mobileRenderHue?.(mountBody, eq.hue) ?? (eq.hue | 0);
    if (mountHue !== this._mountHueApplied && assets.huesTexture && assets.huesMeta) {
      applyHueTo(this._mountSprite, mountHue, mountHue === 0 ? 0 : 1, assets.huesTexture, assets.huesMeta.count);
      this._mountHueApplied = mountHue;
    }
  }

  /** Mount one Pixi Sprite per equipped layer (idempotent). Each sprite
   *  rides on top of the base body sprite; the renderer ticks them
   *  every frame so action/dir/frame stay synced. */
  _refreshEquipment(mob) {
    if (!mob?.equipment) return true;
    // Build the replacement set off-screen. Clearing the currently visible
    // set first meant a war/peace switch removed every robe/torch while its
    // new atlas page streamed, then recreated it a few frames later.
    const nextSprites = new Map();
    const releaseNext = () => {
      for (const sp of nextSprites.values()) releaseSprite(sp);
      nextSprites.clear();
    };
    const order = pickLayerOrder(this._anim.direction);
    for (const layer of order) {
      const eq = mob.equipment.get?.(layer);
      if (!eq) continue;
      const map = assets.resolveEquipAnim(mob.body, eq.itemId, eq.hue);
      const eqGroup = this._anim.currentGroupId(map.animBody);
      let tex = assets.mobileFrameTextureSync?.(
        map.animBody, eqGroup, this._anim.direction, this._anim.frame,
      );
      let requestedGroup = eqGroup;
      if (!tex) {
        const peaceGroup = WAR_TO_PEACE_FALLBACK[eqGroup];
        if (peaceGroup != null && peaceGroup !== eqGroup) {
          tex = assets.mobileFrameTextureSync?.(
            map.animBody, peaceGroup, this._anim.direction, this._anim.frame,
          );
          if (!tex && hasMobileManifestEntry(map.animBody, peaceGroup, this._anim.direction)) {
            requestedGroup = peaceGroup;
          }
        }
      }
      if (!tex) {
        if (hasMobileManifestEntry(map.animBody, requestedGroup, this._anim.direction)) {
          assets.prefetchMobileCycle?.(map.animBody, requestedGroup, this._anim.direction);
          releaseNext();
          return false;
        }
        continue;
      }
      const sp = acquireSprite(tex.texture);
      if (tex.w > 0 && tex.h > 0) {
        sp.anchor.set(tex.cx / tex.w, (tex.h + tex.cy) / tex.h);
      } else {
        sp.anchor.set(0.5, 1);
      }
      sp.position.set(0, 0);
      nextSprites.set(layer, sp);
      sp._currentTex = tex.texture;
      if (map.hue && assets.huesTexture && assets.huesMeta) {
        applyHueTo(sp, map.hue, 1, assets.huesTexture, assets.huesMeta.count);
      }
    }
    if (this._equipSprites.size > 0 || nextSprites.size > 0) this._stackDirty = true;
    for (const sp of this._equipSprites.values()) releaseSprite(sp);
    this._equipSprites.clear();
    for (const [layer, sp] of nextSprites) {
      this.container.addChild(sp);
      this._equipSprites.set(layer, sp);
    }
    return true;
  }

  destroy() {
    if (this._dimFilter) {
      this.container.filters = null;
      try { this._dimFilter.destroy?.(); } catch { /* ignore */ }
      this._dimFilter = null;
    }
    for (const sp of this._equipSprites.values()) releaseSprite(sp);
    this._equipSprites.clear();
    if (this._sprite) {
      releaseSprite(this._sprite);
      this._sprite = null;
    }
    if (this._mountSprite) {
      releaseSprite(this._mountSprite);
      this._mountSprite = null;
    }
    this.container.destroy({ children: true });
  }
}

/** Common chair / throne / stool static graphic ids — taken from CUO
 *  SittingInfos seed data. When a non-player mobile stands on a tile
 *  that contains one of these statics the renderer holds Idle frame 0
 *  (the sitting pose). Players are excluded so the local avatar doesn't
 *  freeze when crossing a tile that happens to host a chair static. */
const CHAIR_GRAPHICS = new Set([
  0x0459, 0x045A, 0x045B, 0x045C,             // marble chairs
  0x0B2C, 0x0B2D, 0x0B2E, 0x0B2F,             // basic wooden chairs
  0x0B30, 0x0B31, 0x0B32, 0x0B33, 0x0B4E,     // benches / fancy chairs
  0x0B4F, 0x0B50, 0x0B51, 0x0B52, 0x0B53,
  0x0B54, 0x0B55, 0x0B56, 0x0B57,
  0x0FB4, 0x0FB7, 0x0FB8, 0x0FB9,             // thrones
  0x1218, 0x1219, 0x121A, 0x121B,             // stools
]);

function detectChairUnder(mob) {
  if (!assets.staticsMeta || !assets._staticsData) return false;
  const cx = Math.floor(mob.x / 8);
  const cy = Math.floor(mob.y / 8);
  // assets.fetchStatics is async + caches; use the sync cache helper.
  const list = assets.staticsAt?.(cx, cy);
  if (!list || !Array.isArray(list)) return false;
  const ix = mob.x % 8, iy = mob.y % 8;
  for (const it of list) {
    if (it.x === ix && it.y === iy && CHAIR_GRAPHICS.has(it.id)) return true;
  }
  return false;
}

/** Stable hash of the mobile's equipped set, used to debounce overlay refresh.
 *  Client perf round 2 #7: the previous formula post-mixed `h` with imul
 *  AFTER each XOR, which is order-dependent — re-equipping the same set
 *  in a different layer order changed the hash and forced a full
 *  `_refreshEquipment` rebuild (sprite acquire/release churn for every
 *  layer). Each tuple is pre-mixed (commutative on `h`) so insertion
 *  order doesn't matter. */
function equipHash(mob) {
  if (!mob?.equipment) return 0;
  const rev = mob._equipmentRevision | 0;
  if (mob._equipmentHashRevision === rev) return mob._equipmentHash >>> 0;
  let h = 0x811c9dc5 | 0;
  for (const [layer, eq] of mob.equipment) {
    let v = (((layer & 0xff) << 24) ^ ((eq.itemId & 0xffff) << 8) ^ (eq.hue & 0xffff)) | 0;
    v = Math.imul(v, 0x01000193) | 0;
    // XOR + add are both commutative on the accumulator → independent of
    // the order in which (layer, itemId, hue) tuples arrive.
    h = ((h ^ v) + 0x9E3779B9) | 0;
  }
  mob._equipmentHash = h >>> 0;
  mob._equipmentHashRevision = rev;
  return mob._equipmentHash;
}

function hasMobileManifestEntry(body, group, direction) {
  return assets.mobileActionExists?.(body, group, direction) === true;
}

export class MobileRenderer {
  /** @param {import('pixi.js').Container} parent */
  constructor(parent) {
    this.parent = parent;
    /** @type {Map<number, MobileSprite>} */
    this.sprites = new Map();
    this._seenStamp = 0;
    /** @type {Set<number>} party member serials — drives aura colour */
    this.party = new Set();

    // Hook movement → Walk action latch.
    this._unsubs = [
      bus.on('mobile:moving', (m) => {
        const sp = this.sprites.get(m.serial);
        const now = performance.now();
        // 0x77 is also used for a facing-only turn, body refresh and
        // notoriety update. Only latch locomotion when a real interpolated
        // step exists; otherwise animals "walked/jumped" in place whenever
        // their AI merely turned toward a target.
        const hasStep = typeof m.hasActiveMoveStep === 'function'
          ? m.hasActiveMoveStep(now)
          : ((m.offsetEndAt ?? 0) > now || (m.queuedStepCount ?? 0) > 0);
        if (sp && hasStep) {
          const durationMs = Math.max(1, (m.offsetEndAt ?? 0) - (m.offsetStartAt ?? 0));
          sp.markMoving(now, !!m.moveRunning, durationMs);
        }
      }),
      bus.on('anim:custom', ({ serial, action, frameCount, repeatCount, delay, reverse, staticFrame }) => {
        const sp = this.sprites.get(serial >>> 0);
        // Audit #40 client P1 #4 — forward the `reverse` flag so
        // emote animations that step backwards (e.g. holstering)
        // play in the right direction. Was: silently dropped.
        if (sp) sp.playAction(action, { frameCount, repeatCount, delay, reverse, staticFrame });
      }),
      // Audit #32 P1 #1 — play Die1/Die2 one-shot when a 0xAF arrives.
      // CUO sets the death anim BEFORE the corpse replaces the mobile;
      // we do it on the existing sprite so the player sees a fall
      // animation instead of an instant teleport into the corpse.
      bus.on('mobile:death-anim', ({ serial, running }) => {
        const sp = this.sprites.get(serial >>> 0);
        if (!sp) return;
        sp.playAction(running ? 'die2' : 'die1', {
          repeatCount: 1,
          oneShot: true,
          priority: ANIMATION_PRIORITY.Death,
          holdLastFrame: true,
        });
      }),
      bus.on('party:update', ({ members }) => {
        this.party.clear();
        for (const m of members ?? []) this.party.add(m.serial >>> 0);
      }),
      // Damage → 200 ms red hit-flash + 280 ms sprite-shake recoil +
      // GetHit anim frame play. CUO `MobileView` plays the `Hit` action
      // frame on `_lastActionIndex = HitReact` for 250-400ms.
      // Audit #46 P2 — rev.5 wired tint+shake but never played the
      // wince frame. Now also call `setAction('getHit', oneShot)` so
      // the sprite actually animates the recoil pose.
      bus.on('damage:apply', ({ serial }) => {
        const m = world.mobiles.get((serial ?? 0) >>> 0);
        if (!m) return;
        const now = performance.now();
        m._hitFlashUntil = now + 200;
        m._hurtRecoilUntil = now + 280;
        // Find the sprite's anim ctx and trigger one-shot GetHit (group
        // 20 People / 13 High / inferred via resolveGroup). Skip when
        // already in an animation that should not be interrupted (cast,
        // die). The sprite manager owns the per-mob anim state.
        try {
          const sprite = this.sprites?.get(m.serial >>> 0);
          if (sprite?._anim?.setAction) {
            sprite._anim.setAction('getHit', {
              oneShot: true,
              priority: ANIMATION_PRIORITY.Hit,
            });
          }
        } catch { /* best-effort */ }
      }),
    ];
  }

  /** Sync sprites with `world.mobiles`; advance animations. */
  update(dt, now = performance.now()) {
    let seenStamp = (this._seenStamp + 1) >>> 0;
    if (seenStamp === 0) {
      for (const sprite of this.sprites.values()) sprite._seenStamp = 0;
      seenStamp = 1;
    }
    this._seenStamp = seenStamp;
    // Camera-bound culling: skip the per-frame tick for any mobile that
    // sits more than 18 tiles + 4 margin away from the player. Outside
    // that radius the server hasn't sent us up-to-date 0x77 anyway, so
    // we'd be ticking a stale sprite. Cuts roughly 30 % off the
    // mob-renderer cost in dense cities (50+ NPCs in vendor squares)
    // without changing visible behaviour.
    const player = world.player;
    const px = player ? player.x : 0;
    const py = player ? player.y : 0;
    const CULL_RADIUS = 22;
    const noColorOutOfRange = profile.get('graphics.noColorObjectsOutOfRange') === true;
    const colorRange = Math.max(1, (world.viewRange | 0) || 18);
    const map = player?.map ?? world.mapId ?? 1;
    let sortDirty = false;
    const visit = (m) => {
      if (player && (m.map ?? map) !== map) return undefined;
      let sprite = this.sprites.get(m.serial);
      if (!sprite) {
        sprite = new MobileSprite(m.serial);
        this.parent.addChild(sprite.container);
        this.sprites.set(m.serial, sprite);
        sortDirty = true;
      }
      sprite._seenStamp = seenStamp;
      const dx = m.x - px, dy = m.y - py;
      if (player && (dx > CULL_RADIUS || dx < -CULL_RADIUS ||
                     dy > CULL_RADIUS || dy < -CULL_RADIUS)) {
        if (sprite.container.visible) sprite.container.visible = false;
        return undefined;
      }
      if (!sprite.container.visible) sprite.container.visible = true;
      const inParty = this.party.has(m.serial >>> 0);
      m._outOfRangeNoColor = noColorOutOfRange && player && m !== player
        && (Math.abs(dx) > colorRange || Math.abs(dy) > colorRange);
      try { sprite.tick(dt ?? 1 / 60, m, m.isPlayer, inParty, now); }
      catch (e) { console.error('[mob-renderer] tick threw', e); }
      // CUO Chunk.cs:194 nudges Mobile priorityZ by +1 so mobs render
      // ABOVE same-tile floor decorations. Bumped to +2 to clear
      // height>0 statics at the same tile.
      //
      // WALK-LERP DEPTH: during a step the sprite renders at
      // an interpolated screen position (proj + offsetX/offsetY) while
      // mob.x/y is already NEW. If we depth-sort with NEW (x+y), the
      // OLD tile (with HIGHER row when walking N) draws ABOVE the
      // sprite and covers its legs for the whole lerp.
      //
      // Approach 1 (fractional row from offsetY) was wrong: it pinned
      // mobile depth to the *current* visual row, which is BELOW NEW
      // when walking S — making the NEW tile draw above the sprite
      // (regression on every direction).
      //
      // Approach 2 (this one): mobile depth = MAX(oldRow, newRow). The
      // sprite always sorts at the further-from-camera of the two
      // tiles it occupies during transition. Correct in both cases:
      //   • walk N: max(20, 19) = 20 → mobile sorts at OLD row →
      //             OLD-tile static loses (layer tie-break favours
      //             mobile=8 over static=4) → no leg cover.
      //   • walk S: max(20, 21) = 21 → mobile sorts at NEW row →
      //             same instant-snap behaviour as before; tile at
      //             (x+1, y+1) row 22 still wins (correct iso).
      // Never reconstruct the old row from offsetStartY. That screen-space
      // value includes elevation (`dz * 4`), so a normal 5-z stair produced
      // round((22 + 20) / 22) == 2 and sorted the avatar a whole extra row
      // toward the camera — in front of the stairwell wall. Mobile keeps the
      // exact logical start/end rows for the active step instead.
      const newRow = Number.isFinite(m.moveSortEndRow)
        ? m.moveSortEndRow
        : (m.x + m.y);
      const oldRow = Number.isFinite(m.moveSortStartRow)
        ? m.moveSortStartRow
        : newRow;
      const effRow = oldRow > newRow ? oldRow : newRow;
      const mzBias = (m.z | 0) + 2;
      const z = depthKey(effRow, 0, mzBias, LAYER_MOBILE);
      if (sprite.container.zIndex !== z) {
        sprite.container.zIndex = z;
        sortDirty = true;
      }
      return undefined;
    };
    if (player && world.forEachMobileNear) {
      world.forEachMobileNear(px, py, map, CULL_RADIUS, true, visit);
    } else {
      const nearby = player && world.mobilesNear
        ? world.mobilesNear(px, py, map, CULL_RADIUS, true)
        : world.mobiles.values();
      for (const m of nearby) visit(m);
    }
    for (const [serial, sprite] of this.sprites) {
      if (!world.mobiles.has(serial)) {
        sprite.destroy(); this.sprites.delete(serial);
        continue;
      }
      if (sprite._seenStamp !== seenStamp && sprite.container.visible) {
        sprite.container.visible = false;
      }
    }
    if (!this.parent.sortableChildren) this.parent.sortableChildren = true;
    // zIndex changes only on tile/depth transitions, not on every lerp frame.
    // Sort immediately when dirty: delaying by 32 ms exposed a wrong layer for
    // one or two frames when a mobile crossed behind a wall or tall static.
    if (sortDirty) {
      this.parent.sortChildren();
      this._lastSortAt = now;
      this._sortPending = false;
    }
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    for (const s of this.sprites.values()) s.destroy();
    this.sprites.clear();
  }
}
