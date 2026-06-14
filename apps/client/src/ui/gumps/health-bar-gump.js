// HealthBarGump — floating HP bar tracking a single mobile. Mirrors
// ClassicUO `Game/UI/Gumps/HealthBarGump.cs` (the vanilla UO non-custom
// path — `HealthBarGump.cs`, not `HealthBarGumpCustom.cs`).
//
// Wire format:
//   • Background gump 0x0803 (custom / self / pet — three bars)
//   • Background gump 0x0804 (foreign mob — single HP bar with the
//     creature-face silhouette baked into the art)
//   • Bar fill arts:
//       0x0805 — red    (HP, default)
//       0x0806 — blue   (mana / stam)
//       0x0808 — green  (HP when poisoned)
//       0x0809 — yellow (HP when invulnerable / yellow-bar)
//
// The earlier implementation drew the background as a parchment
// ResizePic (0x0A28) and painted bars with raw Pixi Graphics. It looked
// nothing like the real UO bar — Marcin asked for it to match the
// vanilla layout exactly. We now mount the canonical UO gump arts
// (already in our atlas) and stretch the fill arts horizontally per
// the current ratio.

import { Graphics } from 'pixi.js';
import { Gump } from '../gump.js';
import { Label } from '../controls/label.js';
import { GumpPic } from '../controls/gump-pic.js';
import { world } from '../../world/world.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { buildStatusRequest, buildLookReq, buildCloseStatusBarGump } from '../../net/outgoing.js';
import { profile } from '../../managers/profile-manager.js';
import { targetManager } from '../../managers/target-manager.js';

// Canonical UO gump background dimensions. 0x0803 / 0x0804 ship at 154×60
// in the extracted atlas (matches CUO `HealthBarGump.cs` HPB_WIDTH=115
// drawn ~7 px outside the bg silhouette, plus 39 px of art before the bar).
const BG_W = 154;
const BG_H = 60;

// Bar layout. Self / pet / party (background 0x0803, three bars) and
// foreign mob (background 0x0804, single bar) place the bars at
// different y offsets — CUO ships the same pair of constants.
const CUSTOM_BAR_X = 38;          // x inside background for fill bars
const CUSTOM_BAR_W = 100;         // max fill width (full hp)
const CUSTOM_HP_Y  = 14;
const CUSTOM_MP_Y  = 24;
const CUSTOM_ST_Y  = 34;

const MOB_BAR_X = 34;
const MOB_BAR_W = 95;
const MOB_HP_Y  = 38;

// Notoriety colour table for the name label. 24-bit RGB only — Pixi v8
// rejects 32-bit ARGB ints. Mirrors CUO's notoriety hue table.
const NOTO_HUE = {
  1: 0xfff0c0,    // innocent / cream
  2: 0x00ff80,    // friend
  3: 0xc0c0c0,    // grey
  4: 0xc080ff,    // criminal (purple)
  5: 0xff8030,    // enemy orange
  6: 0xff4040,    // murderer red
  7: 0xfff060,    // invulnerable yellow
};

export class HealthBarGump extends Gump {
  constructor(mobileSerial, x = 280, y = 80) {
    super();
    this.mobileSerial = mobileSerial >>> 0;
    // RMB-close stays enabled on every bar including self — Marcin wants
    // the player's own health/mana/stam bar dismissable like every other
    // gump. Re-open via shift-drag from the avatar or the topbar
    // healthbar shortcut.
    this.setPosition(x, y);
    this.setSize(BG_W, BG_H);
    this._isFull = false;       // re-evaluated on _draw

    // Background gump. Self/party/pet pick 0x0803 (three bar slots);
    // foreign mob picks 0x0804 (creature face icon + single bar slot).
    // We start with 0x0803 and swap if _draw decides this is a mob bar.
    this._bg = new GumpPic(0x0803, { width: BG_W, height: BG_H });
    this._bg.acceptMouseInput = true;
    this._bg.isDragHandle = true;
    this.add(this._bg);

    // Title position is per-background. 0x0803 (self/pet/party — three
    // bars) has its title panel at the TOP centre (y≈0, x≈16). 0x0804
    // (foreign mob — creature-face icon + single bar) has the title
    // SUNKEN into the chrome at y≈4 with x≈30 to clear the face.
    // `_repositionTitle` runs on every _draw after we know which bg
    // is mounted; constructor seeds with 0x0803 defaults.
    this._title = new Label('', { fontSize: 10, hue: 0xfff0c0 });
    this._title.setPosition(16, 0);
    this._title.acceptMouseInput = true;
    this._title.isDragHandle = true;
    this.add(this._title);

    // Close-X removed — RMB on the bar closes it (universal UIManager
    // dispatch). The 0x0837 sprite read as a shimmer placeholder
    // (Marcin: "niebieski diamencik") on installs missing that atlas
    // slice; RMB-close is consistent across every gump now.

    // Bar fills — three GumpPics for HP/Mana/Stam. We mount them ABOVE
    // the background by adding them after _bg. setSize is called per
    // frame to stretch the fill art proportional to the stat ratio.
    // gumpId for HP can switch between RED / GREEN / YELLOW depending
    // on status flags, so we rebuild via _ensureBar when the id changes.
    this._hpFill = null;
    this._mpFill = null;
    this._stFill = null;
    this._hpFillId = 0;
    this._drawQueued = false;
    this._disposed = false;
    this._lastDrawKey = '';
    this._barState = Object.create(null);

    // Single click sends status request (0x34 kind=4) so the displayed
    // numbers stay fresh. Double-click sends LookReq for name refresh.
    // When a target prompt is ACTIVE the single click resolves the
    // prompt to this mob's serial instead — CUO behaviour, lets a
    // mage cast on a party member by clicking their healthbar entry
    // without having to find the body sprite on a crowded screen.
    // Handler extracted into `_wireBgClicks(bg)` so the gump-swap path
    // in `_draw` (0x0803 ↔ 0x0804) can re-attach after replacing the
    // background sprite — without it the user clicked a mob's bar
    // post-swap and the click sailed through into the world handler
    // which cancelled the target prompt.
    this._wireBgClicks(this._bg);
    this._title.onClick = () => {
      if (targetManager?.isActive?.()) {
        targetManager.pickEntity({ serial: this.mobileSerial });
        return;
      }
      try { net.send(buildStatusRequest(this.mobileSerial, 4)); }
      catch { /* socket transient */ }
    };
    // Audit rev.4 P2 — HealthBarGumpCustom rename. CUO ships an
    // `StbTextBox` overlay so the user can type a personal alias for
    // the mob ("Tank-Bob" instead of "Robert"). We provide the same
    // capability via DOM prompt on title double-click; persisted in
    // `profile.ui.healthBarAliases` keyed by serial.
    this._title.onDoubleClick = () => this._promptAlias();

    // Initial login + resync only push 0xA1 healthUpdate for self —
    // 0xA2/0xA3 mana/stam never arrive until the player casts a spell or
    // exhausts a step. The bar then shows an empty mana/stam well even
    // for high-int mages who actually have 50/50 mana available. Fire
    // one status request (kind=4) so the server echoes all three
    // attribute packets and the well stops looking like a bug. Same
    // pattern StatusGump uses on construction.
    if (this.mobileSerial === (world.player?.serial >>> 0)) {
      try { net.send(buildStatusRequest(this.mobileSerial, 4)); }
      catch { /* socket transient */ }
    }

    this._unsubs = [
      bus.on('mobile:hp',     (info) => { if (info.serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('mobile:mana',   (info) => { if (info.serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('mobile:stamina',(info) => { if (info.serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('mobile:status', (info) => { if (info.serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('mobile:attrs',  (info) => { if (info.serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('entity:removed',({serial}) => { if (serial === this.mobileSerial) this.close(); }),
      // Client audit #5 #14 — listen for own-death events. The server
      // stops streaming 0xA1 after death so the bar would otherwise
      // stay frozen at the last-known HP forever.
      bus.on('mobile:death',  ({serial}) => { if (serial === this.mobileSerial) this._scheduleDraw(); }),
      bus.on('healthbar:close', ({serial}) => { if (serial === this.mobileSerial) this.close(); }),
    ];

    this._draw();
  }

  get type() { return `health-bar:${this.mobileSerial}`; }
  get positionKey() { return this.type; }

  close() {
    if (!this._closeNotified) {
      this._closeNotified = true;
      try { net.send(buildCloseStatusBarGump(this.mobileSerial)); }
      catch { /* socket transient */ }
    }
    super.close();
  }

  dispose() {
    this._disposed = true;
    if (this._drawRaf) {
      try { cancelAnimationFrame(this._drawRaf); } catch { /* ignore */ }
      this._drawRaf = 0;
    }
    for (const u of this._unsubs) u();
    super.dispose();
  }

  /** Re-attachable click handlers — `_draw` swaps the background gump
   *  between 0x0803 / 0x0804 by allocating a fresh GumpPic, so any
   *  hooks the constructor wired on the OLD instance get dropped.
   *  Calling this after every swap keeps the target-prompt + status
   *  refresh + look-req chain consistent regardless of how many bar
   *  transitions the mob went through. */
  _wireBgClicks(bg) {
    bg.onClick = () => {
      if (targetManager?.isActive?.()) {
        targetManager.pickEntity({ serial: this.mobileSerial });
        return;
      }
      try { net.send(buildStatusRequest(this.mobileSerial, 4)); }
      catch { /* socket transient */ }
    };
    bg.onDoubleClick = () => net.send(buildLookReq(this.mobileSerial));
  }

  /** Audit rev.4 P2 — open a tiny rename prompt. Stored aliases
   *  override the server-supplied name on this and future health-bar
   *  spawns for the same serial. Set empty string to clear. */
  async _promptAlias() {
    try {
      const map = profile.get('ui.healthBarAliases') ?? {};
      const cur = map[String(this.mobileSerial)] ?? '';

      const next = window.prompt('Custom alias for this mobile (blank = clear):', cur);
      if (next == null) return;
      const trimmed = next.trim();
      const out = { ...map };
      if (trimmed) out[String(this.mobileSerial)] = trimmed;
      else delete out[String(this.mobileSerial)];
      profile.set('ui.healthBarAliases', out);
      this._lastDrawKey = '';
      this._scheduleDraw();
    } catch (e) { console.warn('[health-bar] alias prompt failed', e); }
  }

  /** Lerp the HP fill colour from BLUE (full) → CYAN → YELLOW → RED
   *  (low) so the user reads health state at a glance even without
   *  looking at the numbers. Matches the "blue when full, red when
   *  ubywa" request — distinct from CUO's flat red, but the player
   *  wanted a smoother gradient. Returns a 24-bit RGB int. */
  _hpColor(ratio) {
    const r = Math.max(0, Math.min(1, ratio));
    // 0.0 .. 0.5 → red → yellow; 0.5 .. 1.0 → yellow → blue.
    let R, G, B;
    if (r < 0.5) {
      const t = r / 0.5;
      R = Math.round(0xff * (1 - t) + 0xff * t);  // red→yellow keeps R=ff
      G = Math.round(0x30 * (1 - t) + 0xc0 * t);
      B = Math.round(0x30 * (1 - t));
    } else {
      const t = (r - 0.5) / 0.5;
      R = Math.round(0xff * (1 - t));
      G = Math.round(0xc0 * (1 - t) + 0x80 * t);
      B = Math.round(0x10 * (1 - t) + 0xff * t);
    }
    return (R << 16) | (G << 8) | B;
  }

  /** Draw one bar slot — dark recessed gutter + coloured fill on top.
   *  Always paints the full slot (even at 0 fill) so MP / ST positions
   *  are visible before the server has pushed their max values.
   *  Replaces the previous GumpPic-stretched fill that produced 1-px
   *  invisible slivers when fill was zero. */
  _drawBar(slot, x, y, fillW, maxW, color) {
    const stateKey = `${x}|${y}|${fillW | 0}|${maxW | 0}|${color >>> 0}`;
    let gfx = this[slot];
    if (!gfx) {
      gfx = new Graphics();
      this[slot] = gfx;
      this.node.addChild(gfx);
    }
    if (this._barState[slot] === stateKey) {
      if (!gfx.visible) gfx.visible = true;
      return;
    }
    this._barState[slot] = stateKey;
    gfx.clear();
    // Dark recessed gutter (always visible).
    gfx.rect(x, y, maxW, 7)
      .fill({ color: 0x100806, alpha: 0.9 })
      .stroke({ width: 1, color: 0x000000, alpha: 0.8 });
    // Filled portion.
    const w = Math.max(0, Math.min(maxW, fillW | 0));
    if (w > 0) {
      gfx.rect(x, y, w, 7).fill({ color });
      // Highlight strip on top for a "glassy" 3D pop.
      gfx.rect(x, y, w, 2).fill({ color: 0xffffff, alpha: 0.18 });
    }
    gfx.visible = true;
  }

  _hideBar(slot) {
    const bar = this[slot];
    if (bar && bar.visible) bar.visible = false;
  }

  _scheduleDraw() {
    if (this._disposed || this._drawQueued) return;
    this._drawQueued = true;
    const raf = (typeof requestAnimationFrame === 'function')
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    this._drawRaf = raf(() => {
      this._drawRaf = 0;
      this._drawQueued = false;
      if (!this._disposed) this._draw();
    });
  }

  _draw() {
    const m = world.mobiles.get(this.mobileSerial);
    if (!m) return;
    const isSelf  = this.mobileSerial === (world.player?.serial >>> 0);
    // Three-bar layout (0x0803 art with the baked "H: / M: / S:" labels)
    // is reserved for SELF + pets the player controls. Earlier rule used
    // `knowsMP` (any non-zero manaMax) as the gate — but the server
    // initialises every mob with `manaMax = 50` baseline, so even non-
    // caster NPCs like Margaret the Innkeeper tripped the gate and
    // rendered the 3-bar bg with empty M:/S: slots beneath a filled HP
    // bar. Marcin: "popraw ułożenie tekstu w pasku życia npc". Foreign
    // mobs now consistently get 0x0804 (creature-face + single bar, no
    // labels) which matches classic UO behaviour.
    const isPet   = m.controlMaster != null
      && (m.controlMaster >>> 0) === (world.player?.serial >>> 0);
    const showFull = isSelf || isPet;
    const noto = m.notoriety ?? 1;

    // Hide the name on the player's own three-bar bar — the user can
    // tell at a glance it's theirs from the triple-bar layout, and the
    // name strip just consumes vertical pixels. Foreign / party / pet
    // bars KEEP the name (notoriety-coloured) so the user knows who
    // they're tracking. Marcin: "nie musisz tam dawac imienia bo
    // wiadomo ze to nasz pasek jak jest potrojny".
    let displayName = '';
    if (isSelf) {
      this._title.setText('');
      this._title.node.visible = false;
    } else {
      // Audit rev.4 P2 — alias overlay. Reads `ui.healthBarAliases`
      // synchronously (profile is loaded long before any health-bar
      // can spawn) and falls back to the server-supplied name.
      displayName = m.name || `0x${this.mobileSerial.toString(16)}`;
      const aliases = profile?.get?.('ui.healthBarAliases');
      const alias = aliases && aliases[String(this.mobileSerial)];
      if (alias) displayName = alias;
    }

    const hp = m.hp ?? 0,    hpMax = Math.max(1, m.hpMax ?? 50);
    const mp = m.mana ?? 0,  mpMax = Math.max(1, m.manaMax ?? 50);
    const st = m.stam ?? 0,  stMax = Math.max(1, m.stamMax ?? 50);
    const drawKey = [
      showFull ? 1 : 0,
      isSelf ? 1 : 0,
      noto | 0,
      displayName,
      hp | 0, hpMax | 0,
      mp | 0, mpMax | 0,
      st | 0, stMax | 0,
      m.flags | 0,
      m.healthbar ?? '',
    ].join('|');
    if (drawKey === this._lastDrawKey) return;
    this._lastDrawKey = drawKey;

    if (!isSelf) {
      this._title.setText(displayName);
      if (this._title.setHue) this._title.setHue(NOTO_HUE[noto] ?? 0xfff0c0);
      this._title.node.visible = true;
    }

    // Background art swap: 0x0803 (self/pet/party — three bar slots) vs
    // 0x0804 (foreign mob — creature-face icon + single bar slot).
    const wantBg = showFull ? 0x0803 : 0x0804;
    if (this._bg.gumpId !== wantBg) {
      const oldBg = this._bg;
      this._bg = new GumpPic(wantBg, { width: BG_W, height: BG_H });
      this._bg.acceptMouseInput = true;
      this._bg.isDragHandle = true;
      this._wireBgClicks(this._bg);
      this.node.addChildAt(this._bg.node, 0);
      oldBg.dispose?.();
    }
    // Per-background title position. The 0x0803 (self/pet) plate has a
    // wide title strip at the top; on 0x0804 (foreign mob) the face
    // icon takes the left edge so the title slides right + down a few
    // pixels. Without this the name overlapped the face on every
    // hostile-mob bar (user report 2026-05-17 — "tekst jest zle
    // wypozyucjonowany"). Numbers eyeball-matched to the CUO 2D
    // healthbar layout.
    if (showFull) this._title.setPosition(16, 0);
    else          this._title.setPosition(34, 1);
    // Notoriety hue tint — paint the bar chrome with the mob's
    // reputation colour. Hostile (orange/red murderer) mobs render red,
    // friends green, criminals purple, etc. Without this the bar
    // stayed cream-on-grey regardless of noto and the player couldn't
    // tell a friendly target apart from a kill-on-sight mob at a
    // glance (user report 2026-05-17 — "pasek zycia powinien miec
    // tinta czerwonego bo mob jest czerwony"). NOTO_HUE maps the
    // canonical 1..7 notoriety value to an RGB tint applied to the
    // GumpPic sprite.
    const notoHue = NOTO_HUE[noto | 0] ?? 0xfff0c0;
    this._bg?.setTint?.(notoHue);

    // HP gets a blue→red gradient based on ratio. Status overrides:
    // poisoned (flag 0x04) = green; yellow-hits/invul = yellow.
    const hpRatio = hp / hpMax;
    let hpColor = this._hpColor(hpRatio);
    if (m.flags & 0x04) hpColor = 0x40c040;
    else if ((m.flags & 0x08) || m.healthbar === 'yellow' || noto === 7) hpColor = 0xfff060;

    if (showFull) {
      const hpW = Math.floor(CUSTOM_BAR_W * Math.min(1, hpRatio));
      const mpW = Math.floor(CUSTOM_BAR_W * Math.min(1, mp / mpMax));
      const stW = Math.floor(CUSTOM_BAR_W * Math.min(1, st / stMax));
      this._drawBar('_hpFill', CUSTOM_BAR_X, CUSTOM_HP_Y, hpW, CUSTOM_BAR_W, hpColor);
      // Mana is the classic blue; stamina a warm gold so the three
      // slots are distinguishable at a glance.
      this._drawBar('_mpFill', CUSTOM_BAR_X, CUSTOM_MP_Y, mpW, CUSTOM_BAR_W, 0x4080ff);
      this._drawBar('_stFill', CUSTOM_BAR_X, CUSTOM_ST_Y, stW, CUSTOM_BAR_W, 0xe0b040);
    } else {
      const hpW = Math.floor(MOB_BAR_W * Math.min(1, hpRatio));
      this._drawBar('_hpFill', MOB_BAR_X, MOB_HP_Y, hpW, MOB_BAR_W, hpColor);
      this._hideBar('_mpFill');
      this._hideBar('_stFill');
    }
  }

  /** Right-click on the bar opens a context menu (bandage / cast last
   *  on this target / mark as last attack). MVP: bandage-self-on-target
   *  by raising a `bandage:target` event the bandage handler picks up. */
  onRightClick() {
    bus.emit('healthbar:right-click', { serial: this.mobileSerial });
  }
}
