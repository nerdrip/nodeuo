// Mobile animation state machine. Mirrors a heavily-stripped version of
// ClassicUO's MobileAnimation.cs / Renderer/Animations/Animation.cs.
//
// Resolves a (body, action, direction, frame, mirror) tuple to a
// Texture for the current Pixi sprite via `assets.mobileFrameTexture`.
// Each mobile sprite owns one of these; the renderer calls `tick(dt)`
// every frame and reads `currentTexture()` + `cx/cy/mirror`.
//
// CRITICAL: action ids are NOT universal across body types. CUO splits
// them per `AnimationGroupsType` (Monster/Animal/Human). Action 2 means
// "RunUnarmed" for humans but "Die1" for monsters. Earlier the client
// hard-coded `Idle = 2` and treated it as a universal stand-still pose
// — the local player visibly ran-in-place because group 2 = run for
// humans. We now use abstract action *labels* (Walk/Stand/Attack/...)
// and the resolver maps them to the body-type-specific group id.

import { assets } from '../assets/asset-manager.js';

// Abstract action labels. These are what callers (renderer, walk-latch,
// 0x6E custom anim handler) use; the resolver below translates each
// label to a numeric group id specific to the body type.
export const Action = {
  Walk:    'walk',
  Run:     'run',
  Idle:    'idle',          // body's resting / stand pose
  Fidget:  'fidget',
  Attack:  'attack',
  Bow:     'attackBow',     // bow draw + release
  Cast:    'cast',
  GetHit:  'getHit',
  DieFwd:  'die1',
  DieBack: 'die2',
  // Gargoyle flying — Stygian Abyss action group. CUO `AnimationsLoader.cs`
  // maps Fly to a Gargoyle-specific frame block; for non-gargoyle bodies
  // we fall through to Walk/Idle so the toggle never crashes the rig.
  Fly:        'fly',
  FlyIdle:    'flyIdle',
  FlyAttack:  'flyAttack',
};

// Per-body-type group lookup tables. Mirror CUO
// `AnimationsLoader.cs:1572-...` enums. Missing entries fall back to
// the closest sensible default at lookup time.
// PEOPLE animation groups (CUO PEOPLE_ANIMATION_GROUP enum, verified
// against ClassicUO/src/Game/Data/Animations.cs):
//   0 WalkUnarmed, 1 WalkArmed, 2 RunUnarmed, 3 RunArmed,
//   4 Stand (peaceful idle, ALWAYS — even when armed),
//   5 Fidget1, 6 Fidget2,
//   7 StandOnehandedAttack  (war stance — unarmed OR 1H weapon),
//   8 StandTwohandedAttack  (war stance — 2H weapon equipped),
//   9 AttackOnehanded, 10 AttackUnarmed1, 11 AttackUnarmed2,
//   12 AttackTwohandedDown, 13 AttackTwohandedWide,
//   14 AttackTwohandedJab, 15 WalkWarmode,
//   16 CastDirected, 17 CastArea, 18 AttackBow, 19 AttackCrossbow,
//   20 GetHit, 21 Die1, 22 Die2,
//   23 OnmountRideSlow, 24 OnmountRideFast, 25 OnmountStand,
//   26 OnmountAttack, 27 OnmountAttackBow, 28 OnmountAttackCrossbow,
//   29 OnmountSlap.
//
// HISTORY: idleArmed used to map to 7 and idleWar to 8. Both wrong.
// Group 7 IS the 1H war stance (StandOnehandedAttack) — Marcin saw
// his unarmed character "raise both arms" the moment war mode kicked
// in because group 8 (the 2H stance) was being used unconditionally.
// CUO's CorrectAnimationGroup uses 4 in peace regardless of weapon
// and 7 vs 8 in war based on the 2H weapon flag.
/** One-time warning set — logs each missing-primary-group fallback
 *  exactly once so console doesn't flood when an entire creature
 *  family lacks the canonical group entries. */
const _fallbackWarned = new Set();

const PEOPLE_GROUP = {
  walk: 0, walkArmed: 1, walkWar: 15, run: 2, runArmed: 3,
  idle: 4, idleWar: 7, idleWar2H: 8,
  fidget: 5, fidget2: 6,
  attack: 9, attackUnarmed: 10, attackUnarmed2: 11,
  attack2H: 12, attack2HWide: 13, attack2HJab: 14,
  attackBow: 18, attackXbow: 19,
  cast: 16, castArea: 17,
  getHit: 20, die1: 21, die2: 22,
  rideSlow: 23, rideFast: 24, rideStand: 25,
  rideAttack: 26, rideAttackBow: 27,
  // CUO `MobileAnimation.cs:132-166` maps the SA flying state to dedicated
  // animation groups for gargoyles (body 0x029A/B + 0x29A..0x2A0 wings):
  //   group 19 = AG_FLY              (in-air idle / hover loop)
  //   group 62 = ACTION_FLY_FORWARD  (slow forward flight)
  //   group 64 = ACTION_FLY_ATTACK   (in-air swing)
  //   group 71 = ACTION_FLY_GETHIT
  //   group 72 = ACTION_FLY_LAND
  //   group 75 = ACTION_FLY_TAKEOFF
  //   group 76 = ACTION_FLY_BLOCK
  //   group 77 = ACTION_FLY_FIRE     (cast / spell-from-air)
  // Audit #46 P2 — previously mapped fly/flyIdle/flyAttack to the base
  // PEOPLE walk/idle/attack frame indices so gargoyles flapped as if
  // walking. Now: hover = 19, forward = 62, attack = 64, getHit = 71.
  fly: 62, flyIdle: 19, flyAttack: 64,
  flyGetHit: 71, flyLand: 72, flyTakeoff: 75, flyBlock: 76, flyFire: 77,
};
const HIGH_GROUP = {  // monsters
  walk: 0, idle: 1, fidget: 17, attack: 4,
  cast: 12, getHit: 13, die1: 2, die2: 3,
};
const LOW_GROUP = {   // animals
  walk: 0, run: 1, idle: 2, fidget: 9, attack: 5,
  die1: 8, die2: 12,
};
const GROUP_NAME = new Map([
  [PEOPLE_GROUP, 'people'],
  [LOW_GROUP, 'low'],
  [HIGH_GROUP, 'high'],
]);

const HUMAN_REMAP = Object.freeze({
  0: 0, 2: 21, 3: 22, 4: 9, 5: 11, 6: 13, 7: 18, 8: 19, 9: 9,
  10: 20, 12: 16, 13: 17, 14: 16, 15: 30, 16: 30, 17: 5, 18: 6,
  19: 1, 21: 20,
});
const ANIMAL_REMAP = Object.freeze({
  0: 0, 2: 8, 3: 12, 4: 5, 5: 6, 6: 5, 7: 5, 8: 5, 9: 5,
  10: 7, 11: 3, 12: 5, 13: 5, 14: 5, 17: 9, 18: 10, 19: 1, 21: 7,
});
const SEA_REMAP = Object.freeze({
  0: 0, 2: 8, 3: 8, 4: 5, 5: 6, 6: 5, 7: 5, 8: 5, 9: 5,
  10: 7, 12: 5, 13: 5, 14: 5, 17: 3, 18: 4, 19: 19, 21: 7,
});
const LOW_TO_HIGH_REMAP = Object.freeze({
  0: 0, 1: 19, 3: 11, 5: 4, 6: 5, 7: 10, 8: 2, 9: 17,
  10: 18, 11: 10, 12: 3,
});
const SEMANTIC_FALLBACK_KEYS = Object.freeze({
  walk: ['run', 'idle'],
  walkArmed: ['walk', 'runArmed', 'run', 'idle'],
  walkWar: ['walkArmed', 'walk', 'run', 'idle'],
  run: ['walk', 'idle'],
  runArmed: ['run', 'walkArmed', 'walk', 'idle'],
  idle: ['walk'],
  idleWar: ['idle', 'walkWar', 'walk'],
  idleWar2H: ['idleWar', 'idle', 'walkWar', 'walk'],
  fidget: ['fidget2', 'idle', 'walk'],
  fidget2: ['fidget', 'idle', 'walk'],
  attack: ['attackUnarmed', 'attackUnarmed2', 'attack2H', 'attack2HWide', 'attack2HJab', 'attackBow', 'cast', 'idle'],
  attackUnarmed: ['attack', 'attackUnarmed2', 'idle'],
  attackUnarmed2: ['attackUnarmed', 'attack', 'idle'],
  attack2H: ['attack2HWide', 'attack2HJab', 'attack', 'idle'],
  attack2HWide: ['attack2H', 'attack2HJab', 'attack', 'idle'],
  attack2HJab: ['attack2H', 'attack2HWide', 'attack', 'idle'],
  attackBow: ['attackXbow', 'attack', 'idle'],
  attackXbow: ['attackBow', 'attack', 'idle'],
  cast: ['castArea', 'attack', 'idle'],
  castArea: ['cast', 'idle'],
  getHit: ['idle', 'walk'],
  die1: ['die2', 'idle'],
  die2: ['die1', 'idle'],
  rideSlow: ['walk', 'idle'],
  rideFast: ['rideSlow', 'run', 'walk', 'idle'],
  rideStand: ['idle', 'walk'],
  rideAttack: ['attack', 'idle'],
  rideAttackBow: ['attackBow', 'attack', 'idle'],
  fly: ['flyIdle', 'walk', 'run', 'idle'],
  flyIdle: ['fly', 'idle', 'walk'],
  flyAttack: ['attack', 'flyIdle', 'idle'],
  flyGetHit: ['getHit', 'flyIdle', 'idle'],
});

function tableForBody(body) {
  if (body >= 400) return PEOPLE_GROUP;
  if (body >= 200) return LOW_GROUP;
  return HIGH_GROUP;
}

function resolveActionKey(body, label, ctx = null) {
  if (typeof label === 'number') return null;
  const table = tableForBody(body);
  let key = label === 'die' ? 'die1' : label;
  if (table === PEOPLE_GROUP && ctx) {
    if (ctx.isFlying) {
      if (key === 'walk' || key === 'run') key = 'fly';
      else if (key === 'idle')             key = 'flyIdle';
      else if (key === 'attack')           key = 'flyAttack';
      else if (key === 'getHit')           key = 'flyGetHit';
      else if (key === 'cast')             key = 'flyFire';
    } else if (ctx.isMounted) {
      if (key === 'walk' || key === 'run')   key = ctx.run ? 'rideFast' : 'rideSlow';
      else if (key === 'idle')               key = 'rideStand';
      else if (key === 'attack')             key = 'rideAttack';
      else if (key === 'attackBow')          key = 'rideAttackBow';
    } else if (ctx.inWarMode) {
      if (key === 'walk' || key === 'run')   key = 'walkWar';
      else if (key === 'idle')               key = ctx.armed2H ? 'idleWar2H' : 'idleWar';
      else if (key === 'attack')             key = ctx.armed2H ? 'attack2H' : 'attack';
    } else if (ctx.armed) {
      if (key === 'walk')                    key = 'walkArmed';
      else if (key === 'run')                key = 'runArmed';
    }
  }
  return { table, key };
}

function pushUnique(out, value) {
  if (value == null) return;
  const n = value | 0;
  if (!out.includes(n)) out.push(n);
}

function labelGroupCandidates(body, label, ctx = null) {
  const resolved = resolveActionKey(body, label, ctx);
  if (!resolved) return [];
  const tables = resolved.table === HIGH_GROUP
    ? [HIGH_GROUP, LOW_GROUP, PEOPLE_GROUP]
    : resolved.table === LOW_GROUP
      ? [LOW_GROUP, HIGH_GROUP, PEOPLE_GROUP]
      : [PEOPLE_GROUP, HIGH_GROUP, LOW_GROUP];
  const out = [];
  pushUnique(out, resolved.table[resolved.key]);
  for (const table of tables) {
    if (table !== resolved.table) pushUnique(out, table[resolved.key]);
  }
  const keys = SEMANTIC_FALLBACK_KEYS[resolved.key] ?? [];
  for (const table of tables) {
    for (const key of keys) pushUnique(out, table[key]);
  }
  return out;
}

function numericGroupCandidates(body, group) {
  const g = group | 0;
  const out = [g];
  if (body >= 400) {
    pushUnique(out, HUMAN_REMAP[g] ?? 4);
    pushUnique(out, g % 35);
    pushUnique(out, PEOPLE_GROUP.idle);
  } else if (body >= 200) {
    pushUnique(out, ANIMAL_REMAP[g] ?? SEA_REMAP[g] ?? 2);
    pushUnique(out, g % 13);
    pushUnique(out, LOW_GROUP.idle);
  } else {
    pushUnique(out, LOW_TO_HIGH_REMAP[g]);
    pushUnique(out, ANIMAL_REMAP[g]);
    pushUnique(out, g % 22);
    pushUnique(out, HIGH_GROUP.idle);
    pushUnique(out, LOW_GROUP.idle);
  }
  pushUnique(out, 0);
  return out;
}

function groupCandidates(body, label, ctx = null) {
  return typeof label === 'number'
    ? numericGroupCandidates(body, label)
    : labelGroupCandidates(body, label, ctx);
}

function hasExactAction(body, groupId, direction = null) {
  return typeof assets.mobileActionExists === 'function'
    && assets.mobileActionExists(body, groupId, direction);
}

export function resolveRenderableGroup(body, label, ctx = null, direction = null) {
  const candidates = groupCandidates(body, label, ctx);
  if (candidates.length === 0) return resolveGroup(body, label, ctx);
  if (typeof assets.mobileActionExists !== 'function') return candidates[0];
  for (const groupId of candidates) {
    if (hasExactAction(body, groupId, direction)) return groupId;
  }
  return candidates[0];
}

/** Pick the per-body-type group id for an abstract action label.
 *  Numeric actions (e.g. 0x6E `mobileAnim` from server, custom 0xE2)
 *  pass through unchanged — the server side knows which file group it
 *  is requesting and we should not re-translate.
 *
 *  `ctx.isMounted` / `ctx.inWarMode` / `ctx.armed` only affect People
 *  bodies — they map walk→walkWar, idle→idleWar, walk→rideSlow, etc.
 *  Mirrors CUO `MobileAnimation.cs::CorrectAnimationGroup`. */
export function resolveGroup(body, label, ctx = null) {
  if (typeof label === 'number') return label;
  // Mirror CUO `CalculateTypeByGraphic` body-range inference (anim.mul
  // default file): body < 200 = Monster (High), 200..399 = Animal (Low),
  // ≥400 = Human/Equipment (People). Equipment bodies (431/434/449/...)
  // animate with People frames — the earlier 0x190..0x193 narrow check
  // routed them to HIGH_GROUP where idle = 1 (= WalkArmed for People).
  // Result: clothes played frame 0 of "walk" while the body played
  // frame 0 of "stand" — visible desync between body and overlays.
  const resolved = resolveActionKey(body, label, ctx);
  const { table, key } = resolved;
  let g = table[key];
  if (g == null) g = table.idle ?? table.walk ?? 0;
  return g;
}

// Per-label animation FPS. Ports CUO `MobileAnimation.cs` /
// `MovementSpeed.cs`. The .mul format itself doesn't ship a per-frame
// interval — speed is hard-coded by action.
//
// BUMPED 2026-05-11: walk/run cycles were running too SLOW vs the
// step pacing — server WALK_DELAY=400 ms/tile, RUN_DELAY=200 ms/tile.
// Old walk fps=8 with 6-frame cycles = 750 ms cycle while the avatar
// crossed two tiles in 800 ms — anim looked frozen mid-step then
// snapped on tile boundary. Tightening to 12 (walk) / 18 (run) makes
// each tile crossing roughly = one anim cycle, which is what CUO
// produces visually with the same source frames.
const ACTION_FPS = {
  walk:     12,
  run:      18,
  idle:      6,
  fidget:    8,
  attack:   12,
  attackBow: 6,
  cast:      8,
  getHit:    8,
  die1:      6,
  die2:      6,
};
const DEFAULT_FPS = 8;

export class MobileAnimation {
  constructor() {
    this.body = 0;
    this.action = Action.Idle;
    this.direction = 0;
    /** mirrored on screen (UO directions 5..7 reuse 3..1) */
    this.mirror = false;
    /** current frame index */
    this.frame = 0;
    /** ms since last frame change */
    this._frameAt = 0;
    /** total frames for the current (action, direction); 0 = unknown */
    this._frameCount = 0;
    /** Custom-anim overrides from 0x6E / 0xE2 — non-zero means the
     *  server pushed an explicit frameCount / delay for this action. */
    this._frameCountOverride = 0;
    this._repeatCountOverride = 0;
    this._customDelayMs = 0;
    /** when set, switch back to Idle once the action completes */
    this._oneShot = false;
    /** cached texture for the current frame */
    this._currentTex = null;
    /** cached cx/cy for the current frame (foot-on-tile anchor in src px) */
    this._currentMeta = null;
    /** caller-set context flags for People-body group selection */
    this.isMounted = false;
    this.inWarMode = false;
    this.armed = false;
    this.armed2H = false;
    this.run = false;
    this.isFlying = false;
    /** seconds remaining until the next random idle fidget */
    this._idleFidgetIn = 5 + Math.random() * 25;
  }

  /** Update the context flags that drive People-body anim group swaps
   *  (mount/war/armed). Cached texture cleared on flag change so the
   *  next resolveTexture() loads the correct group's frames. */
  setContext(flags) {
    let changed = false;
    if (typeof flags.isMounted === 'boolean' && flags.isMounted !== this.isMounted) {
      this.isMounted = flags.isMounted; changed = true;
    }
    if (typeof flags.inWarMode === 'boolean' && flags.inWarMode !== this.inWarMode) {
      this.inWarMode = flags.inWarMode; changed = true;
    }
    if (typeof flags.armed === 'boolean' && flags.armed !== this.armed) {
      this.armed = flags.armed; changed = true;
    }
    if (typeof flags.armed2H === 'boolean' && flags.armed2H !== this.armed2H) {
      this.armed2H = flags.armed2H; changed = true;
    }
    if (typeof flags.isFlying === 'boolean' && flags.isFlying !== this.isFlying) {
      this.isFlying = flags.isFlying; changed = true;
    }
    if (typeof flags.run === 'boolean') this.run = flags.run;
    if (changed) {
      this._currentTex = null;
      this._frameCount = 0;
      // Warm the new (action × direction × group) cycle so the next
      // tick's sync resolve is a guaranteed hit.
      this.prefetch();
    }
  }

  /** Switch the animated body. Resets to Idle to avoid showing wrong frames. */
  setBody(body) {
    if (body === this.body) return;
    this.body = body;
    this.action = Action.Idle;
    this.frame = 0;
    this._currentTex = null;
    this._frameCount = 0;
    this.prefetch();
  }

  /** Switch the screen-space direction. UO direction byte is 0..7
   *  (0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW). The .mul stores only
   *  5 unique frame sets per action; CUO mirrors them at runtime. The
   *  canonical mapping (Animation.cs:76 `GetAnimDirection`) is:
   *
   *      UO  →  anim_dir   mirror
   *       0     3          true   (N  uses W flipped)
   *       1     2          true   (NE uses SW flipped)
   *       2     1          true   (E  uses S  flipped)
   *       3     0          false  (SE)
   *       4     1          false  (S)
   *       5     2          false  (SW)
   *       6     3          false  (W)
   *       7     4          false  (NW)
   *
   *  Our previous heuristic ("d>=5 mirror, realDir = 8-d") put NE frames
   *  on the South facing — characters looked sideways every step. */
  setDirection(uoDir) {
    const d = uoDir & 7;
    let realDir, isMirror;
    switch (d) {
      case 0: realDir = 3; isMirror = true;  break;  // N  → W frame, mirrored
      case 1: realDir = 2; isMirror = true;  break;  // NE → SW frame, mirrored
      case 2: realDir = 1; isMirror = true;  break;  // E  → S frame, mirrored
      case 3: realDir = 0; isMirror = false; break;  // SE
      case 4: realDir = 1; isMirror = false; break;  // S
      case 5: realDir = 2; isMirror = false; break;  // SW
      case 6: realDir = 3; isMirror = false; break;  // W
      case 7: realDir = 4; isMirror = false; break;  // NW
      default: realDir = 0; isMirror = false;        // unreachable
    }
    if (realDir === this.direction && isMirror === this.mirror) return;
    this.direction = realDir;
    this.mirror = isMirror;
    this.frame = 0;
    this._currentTex = null;
    this._frameCount = 0;
    this.prefetch();
  }

  /** Begin / change the active action. `oneShot` plays it once and falls back
   *  to Idle on completion (for attack / death).
   *
   *  Walk↔Run transitions PRESERVE the current frame index (modulo new
   *  frame count when known). Without this preservation the avatar's
   *  legs snapped back to frame 0 every time the player switched
   *  cadence (key release after sustained run, or auto-run kick-in)
   *  and the gait visibly stuttered. CUO does the same — the same
   *  6-frame cycle is shared across Walk and Run, only the FPS changes. */
  setAction(action, { oneShot = false, frameCount, repeatCount, delay, reverse = false, staticFrame = null } = {}) {
    if (this.action === action && this._oneShot === oneShot
        && frameCount == null && delay == null && staticFrame == null
        && this._staticFrame == null) return;
    const wasLocomotion = (this.action === Action.Walk || this.action === Action.Run);
    const newLocomotion = (action === Action.Walk || action === Action.Run);
    const keepFrame = wasLocomotion && newLocomotion;
    this.action = action;
    this._oneShot = oneShot;
    if (!keepFrame) {
      this.frame = 0;
      this._frameAt = 0;
    }
    this._currentTex = null;
    this._frameCount = 0;
    // Custom-anim metadata from 0x6E / 0xE2 — server-scripted emotes
    // ship explicit frame count + per-frame delay so the visual length
    // matches the gameplay timer. CUO `Mobile.SetAnimation(action,
    // delay, frameCount, repeatCount)`. When `frameCountOverride` is
    // set, tick() uses it instead of the loader-provided count.
    this._frameCountOverride = (frameCount && frameCount > 0) ? (frameCount | 0) : 0;
    // Audit #40 client P1 #4 — repeatCount was stored but never
    // decremented by the wrap-handler in tick() → server-scripted
    // emotes with `repeatCount=3` looped forever. Track remaining
    // wraps explicitly; when the counter drains, fall back to Idle.
    this._repeatCountOverride = (repeatCount && repeatCount > 0) ? (repeatCount | 0) : 0;
    this._repeatRemaining = this._repeatCountOverride;
    // Audit #40 client P1 #4 — `reverse` decodes from 0x6E byte
    // forward=false. CUO mirrors frames when set; we just remember
    // the flag so tick() can step frame-- instead of frame++.
    this._playReverse = !!reverse;
    this._customDelayMs = (delay && delay > 0) ? (delay | 0) : 0;
    this._staticFrame = Number.isFinite(staticFrame) ? Math.max(0, staticFrame | 0) : null;
    if (this._staticFrame != null) {
      this.frame = this._staticFrame;
      this._frameAt = 0;
    }
    this.prefetch();
  }

  /** Advance the frame timer. */
  tick(dt) {
    if (this._staticFrame != null) {
      this.frame = this._staticFrame;
      this._frameAt = 0;
      return;
    }
    // Paralyze freeze — CUO `Game/GameObjects/Mobile.cs IsParalyzed`
    // short-circuits `ProcessSteps` and pins the sprite at the first
    // Idle frame. Without this, frozen mobs still played the Walk
    // latch and Fidget cycle as if unaffected.
    if (this.frozen) {
      this.frame = 0;
      this._frameAt = 0;
      return;
    }
    this._frameAt += dt;
    // Custom-anim delay override (0x6E / 0xE2 per-frame ms). Falls back
    // to the per-action FPS table when none was supplied.
    const interval = this._customDelayMs > 0
      ? (this._customDelayMs / 1000)
      : (1 / (ACTION_FPS[this.action] ?? DEFAULT_FPS));
    while (this._frameAt >= interval) {
      this._frameAt -= interval;
      // Audit #40 client P1 #4 — step backwards when `reverse` was
      // set (CUO `Mobile.SetAnimation` mirrors frames for forward=false).
      this.frame += this._playReverse ? -1 : 1;
      // We don't yet know the frame count — the loader populates it on
      // first lookup. Loop here once we have it; one-shots end with Idle.
      // Custom-anim override (server-scripted emote) wins over the
      // loader-provided count so an emote that ships 20 frames at
      // 50 ms each holds for the full 1 s the script intends.
      const effectiveCount = this._frameCountOverride > 0
        ? this._frameCountOverride
        : this._frameCount;
      const wrapped = this._playReverse
        ? (effectiveCount > 0 && this.frame < 0)
        : (effectiveCount > 0 && this.frame >= effectiveCount);
      if (wrapped) {
        if (this._oneShot) {
          this.action = Action.Idle;
          this._oneShot = false;
          this._frameCountOverride = 0;
          this._repeatCountOverride = 0;
          this._repeatRemaining = 0;
          this._customDelayMs = 0;
          this._playReverse = false;
        }
        // Cast actions hold the LAST frame instead of looping.
        else if (this.action === Action.Cast) {
          this.frame = this._frameCount - 1;
          this._frameAt = 0;
          break;
        }
        // Audit #40 client P1 #4 — decrement repeatCount on each wrap.
        // When the counter reaches 0 the loop ends and the mob goes
        // back to Idle (CUO `Mobile.ProcessSteps` behaviour). Was: no
        // decrement → repeatCount byte purely decorative.
        else if (this._repeatRemaining > 0) {
          this._repeatRemaining -= 1;
          if (this._repeatRemaining <= 0) {
            this.action = Action.Idle;
            this._frameCountOverride = 0;
            this._repeatCountOverride = 0;
            this._customDelayMs = 0;
            this._playReverse = false;
            this.frame = 0;
            this._frameAt = 0;
            this._currentTex = null;
            break;
          }
        }
        this.frame = this._playReverse ? Math.max(0, effectiveCount - 1) : 0;
        this._frameAt = 0;
      }
      this._currentTex = null; // force refresh
    }
    // Random idle fidget cycle (CUO Mobile.CalculateRandomIdleTime).
    // Static idle bodies otherwise stand frozen — every 5..30 s play
    // a one-shot fidget and return to idle.
    if (this.action === Action.Idle && !this._oneShot && !this.isMounted) {
      this._idleFidgetIn -= dt;
      if (this._idleFidgetIn <= 0) {
        this._idleFidgetIn = 8 + Math.random() * 25;
        this.setAction(Action.Fidget, { oneShot: true });
      }
    }
  }

  /** Numeric anim group id for the current (body, action). Equipment
   *  overlays use the same id so layers stay in lock-step with the body. */
  currentGroupId(body = this.body) {
    return resolveRenderableGroup(body, this.action, this._context(), this.direction);
  }

  _context() {
    return {
      isMounted: this.isMounted, inWarMode: this.inWarMode,
      armed: this.armed, armed2H: this.armed2H, run: this.run,
      isFlying: this.isFlying,
    };
  }

  _warnFallback(body, requested, selected) {
    const primary = resolveGroup(body, this.action, this._context());
    if (selected === primary) return;
    const key = `${body}:${this.action}:${primary}:${selected}`;
    if (_fallbackWarned.has(key)) return;
    _fallbackWarned.add(key);
    const name = typeof this.action === 'number' ? `group ${this.action}` : `action '${this.action}'`;
    const primaryName = GROUP_NAME.get(tableForBody(body)) ?? 'primary';
    console.warn(
      `[mobile-anim] body ${body} ${name} missing in ${primaryName} group ${requested}; ` +
      `using remapped group ${selected}.`,
    );
  }

  /** Synchronous texture resolve. Returns null when the underlying
   *  atlas page hasn't streamed in yet — caller should KEEP the
   *  previously-rendered frame and rely on `prefetch()` (kicked off
   *  here as a side-effect) to warm the page for the next tick.
   *
   *  This is the primary entry point for the renderer hot path.
   *  Switching the body + every equipment overlay onto SYNC lookups
   *  guarantees they all resolve in lockstep — no body-on-new-frame
   *  while equipment-still-on-old-frame desync.
   */
  resolveTextureSync() {
    if (this._currentTex) {
      return { texture: this._currentTex, meta: this._currentMeta, mirror: this.mirror };
    }
    const ctx = this._context();
    const primaryGroupId = resolveGroup(this.body, this.action, ctx);
    const groupId = resolveRenderableGroup(this.body, this.action, ctx, this.direction);
    if (groupId !== primaryGroupId && !hasExactAction(this.body, primaryGroupId, this.direction)) {
      this._warnFallback(this.body, primaryGroupId, groupId);
    }
    let tex = assets.mobileFrameTextureSync(this.body, groupId, this.direction, this.frame);
    if (!tex) {
      // Page miss — kick off async preload so the NEXT tick has it.
      // We don't await; the call returns immediately, the load runs
      // in the background, and we keep `_currentTex` null so the
      // caller knows to skip the swap this frame.
      assets.prefetchMobileCycle?.(this.body, groupId, this.direction);
      return null;
    }
    this._currentTex = tex.texture;
    this._currentMeta = { cx: tex.cx, cy: tex.cy, w: tex.w, h: tex.h };
    this._frameCount = tex.frameCount;
    return { texture: this._currentTex, meta: this._currentMeta, mirror: this.mirror };
  }

  /** Async wrapper — kept for callers that want to await a guaranteed
   *  texture (corpse render, drag preview). Renderer hot path uses
   *  `resolveTextureSync` instead. */
  async resolveTexture() {
    if (this._currentTex) return { texture: this._currentTex, meta: this._currentMeta, mirror: this.mirror };
    const groupId = resolveRenderableGroup(this.body, this.action, this._context(), this.direction);
    const tex = await assets.mobileFrameTexture(this.body, groupId, this.direction, this.frame);
    if (tex) {
      this._currentTex = tex.texture;
      this._currentMeta = { cx: tex.cx, cy: tex.cy, w: tex.w, h: tex.h };
      this._frameCount = tex.frameCount;
      return { texture: this._currentTex, meta: this._currentMeta, mirror: this.mirror };
    }
    return null;
  }

  /** Eagerly warm every frame in the current (action, direction) cycle.
   *  Called by mobile-renderer when action/direction/group changes so
   *  the very next tick has all needed textures cached and the body +
   *  equipment can lock to a synchronous render path. */
  prefetch() {
    if (!assets.prefetchMobileCycle) return;
    const groupId = resolveRenderableGroup(this.body, this.action, this._context(), this.direction);
    // Fire-and-forget — caller doesn't await. Multiple parallel
    // prefetches for the same page coalesce inside `_loadAtlasPage`.
    assets.prefetchMobileCycle(this.body, groupId, this.direction).catch(() => {});
  }
}
