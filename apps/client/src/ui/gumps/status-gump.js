// StatusGump — extended version. Mirrors the small CUO StatusGump
// (the 0x0802 minimal variant) plus the post-AOS resists/dmg row that
// the Trinsic shard cares about.
//
// Live-updated from:
//   - 0xA1/0xA2/0xA3 — HP / Mana / Stamina (current+max)
//   - 0x11 MobileStatus — full payload (str/dex/int + gold + weight +
//     followers + resists + dmg)
//   - 0x2D MobileAttributes — alternative HP/MP/STAM packet some
//     ServUO scripts emit when only the bars change.
//
// Layout (216 × 200): name, three bars, two-column stat table.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Graphics, Text } from 'pixi.js';
import { Control } from '../control.js';
import { GumpPic } from '../controls/gump-pic.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildStatusRequest, buildStatLockRequest } from '../../net/outgoing.js';

/** Status panel HP/Mana/Stam bar — uses canonical UO bar-fill arts
 *  (0x0805 red / 0x0806 blue, same set HealthBarGump uses) stretched
 *  to the current value/max ratio. Replaces the earlier flat
 *  Graphics rect that read as "modern progress bar" rather than UO.
 *
 *  The `kind` param picks the fill colour family:
 *    'hp'   → 0x0805 (red)
 *    'mana' → 0x0806 (blue)
 *    'stam' → 0x0806 (blue — CUO uses the same blue art for stam too;
 *                     the field label distinguishes them).
 */
class Bar extends Control {
  constructor(width, height, kind = 'hp') {
    super();
    this.width = width; this.height = height;
    this.acceptMouseInput = false;
    this._kind = kind;
    this._cur = 0; this._max = 1;
    // Dark well behind the fill — a 1-pixel dark Graphics. Cheap and
    // ensures the bar reads against a parchment background.
    this._well = new Graphics();
    this.node.addChild(this._well);
    this._well.rect(0, 0, width, height).fill({ color: 0x110a05, alpha: 0.9 });
    // Fill — GumpPic that we resize per tick. We don't recreate
    // every update — `setSize` reuses the underlying sprite.
    this._fillId = kind === 'hp' ? 0x0805 : 0x0806;
    this._fill = new GumpPic(this._fillId, { width: 0, height: height - 2 });
    this._fill.acceptMouseInput = false;
    this._fill.setPosition(1, 1);
    this.add(this._fill);
    // Faint dark border on top.
    this._frame = new Graphics();
    this._frame.rect(0, 0, width, height).stroke({ width: 1, color: 0x000000, alpha: 0.95 });
    this.node.addChild(this._frame);
  }
  setValues(cur, max) {
    this._cur = cur;
    this._max = Math.max(1, max);
    const ratio = Math.max(0, Math.min(1, this._cur / this._max));
    const fillW = Math.max(0, Math.floor((this.width - 2) * ratio));
    this._fill.setSize(fillW, this.height - 2);
    this._fill.node.visible = fillW > 0;
  }
  /** Status fill swap (poisoned → green, yellow-bar → yellow). Same
   *  arts the HealthBarGump uses (0x0808 / 0x0809). */
  setKind(kind) {
    if (this._kind === kind) return;
    this._kind = kind;
    const id = kind === 'hp-pois'  ? 0x0808
            :  kind === 'hp-yel'   ? 0x0809
            :  kind === 'hp'       ? 0x0805
            :                        0x0806;
    if (this._fillId !== id) {
      this._fillId = id;
      this._fill.dispose?.();
      this._fill = new GumpPic(id, { width: 0, height: this.height - 2 });
      this._fill.setPosition(1, 1);
      this.add(this._fill);
      // setValues will resize on next tick.
    }
  }
}

/** Tiny lock-cycle button drawn next to a stat row. State maps to ServUO
 *  Lock enum: 0=Up (gain), 1=Down (lose), 2=Locked. Click cycles the
 *  state and pushes 0xBF 0x1A to the server. CUO renders these as a
 *  triangle/arrow icon — we use a plain glyph (▲/▼/■) until the gump
 *  art for ids 0x0985-0x098A is wired in. */
class StatLockButton extends Control {
  constructor(statId) {
    super();
    this.statId = statId | 0;
    this.lock = 0;
    this.width = 12; this.height = 12;
    this.acceptMouseInput = true;
    this._gfx = new Graphics();
    this.node.addChild(this._gfx);
    this._txt = new Text({
      text: '▲',
      style: { fill: 0xfff0c0, fontSize: 10, fontFamily: 'Consolas, monospace' },
    });
    this._txt.anchor.set(0.5);
    this._txt.position.set(6, 6);
    this.node.addChild(this._txt);
    this._draw();
  }
  setLock(lock) { this.lock = lock & 0x3; this._draw(); }
  _draw() {
    this._gfx.clear();
    this._gfx.roundRect(0, 0, this.width, this.height, 2)
             .fill({ color: 0x202018, alpha: 0.85 })
             .stroke({ width: 1, color: 0x4a3a18 });
    const g = this.lock === 0 ? '▲' : this.lock === 1 ? '▼' : '■';
    this._txt.text = g;
    // Locked = warning hue.
    this._txt.style.fill = this.lock === 2 ? 0xc06060 : 0xfff0c0;
  }
  onClick() {
    // 0=up → 1=down → 2=locked → 0=up...
    const next = (this.lock + 1) % 3;
    this.lock = next;
    this._draw();
    try { net.send(buildStatLockRequest(this.statId, next)); }
    catch { /* socket transient */ }
  }
}

// CUO StatusGump variants. The canonical UO art (0x0802) is the
// extended-format 282×151 sprite used by `StatusGump.cs` post-AOS;
// it has the name strip, three bar wells and a 4-column stat grid
// already painted into the background, so we just position labels
// over the bake.
const VARIANTS = {
  // 'mini' is an alias kept for the shift-drag-from-self gesture
  // (game-scene.js spawns `new StatusGump('mini')` for the compact
  // CUO-style three-bar view). For now the same compact 0x0803 art
  // backs both; the difference between mini / small is purely a
  // future-extension hook.
  mini:     { width: 154, height: 60,  showLocks: false, showSecondary: false, art: 0x0803 },
  small:    { width: 154, height: 60,  showLocks: false, showSecondary: false, art: 0x0803 },
  default:  { width: 282, height: 151, showLocks: true,  showSecondary: true,  art: 0x0802 },
};

export class StatusGump extends WindowGump {
  constructor(variant = 'default') {
    const v = VARIANTS[variant] ?? VARIANTS.default;
    // The UO 0x0802 art has every label baked in ("CHARACTER STATUS",
    // HP / Mana / Stam, Str / Dex / Int, Sex, Hits Inc, Stam Inc,
    // Mana Inc, Followers, Armor, Weight, Gold, plus the AOS resist
    // column). Passing an empty title prevents WindowGump from
    // overlaying a redundant "Status" label on top of the baked
    // header. Marcin: "gump zawiera juz teksty w grafice".
    super({
      title: '', width: v.width, height: v.height,
      x: 16, y: 60, backgroundId: v.art, singleSprite: true,
    });
    this._variant = variant;
    this._variantCfg = v;

    // CUO uses hue 0x021D (warm cream) for every value in the classic
    // StatusGump. Our `valueStyle` mirrors that with a thin stroke so
    // it stays readable against the parchment art at every zoom.
    const valueStyle = { fontSize: 11, hue: 0xfff0c0, stroke: true };
    this._name = new Label('', { fontSize: 11, hue: 0xfff0c0, stroke: true });

    // ---- Classic 0x0802 layout — exact CUO StatusGumpClassic coords -----
    // Pulled directly from ClassicUO Game/UI/Gumps/StatusGumpClassic.cs.
    // The art bakes EVERY label (HP / Mana / Stam / Str / Dex / Int /
    // Sex / AR / Gold / Wt + the column dividers), so we only mount
    // VALUE text + the optional stat-lock buttons + the name strip at
    // the bottom — no labels of our own, no bar Graphics overlapping
    // the baked wells.
    if (v.art === 0x0802) {
      // Left column — primary stats. CUO offsets (85, 36/56/76/96/116).
      const mk = (key, x, y) => {
        const c = new Label('-', valueStyle);
        c.setPosition(x, y); this.add(c);
        this[`_${key}`] = c;
      };
      // Audit #35 F2 — Y offsets shifted +24 px so they align with the
      // baked 0x0802 art's stat rows. CUO `StatusGump.cs:217-287` puts
      // Str/Dex/Int/Sex/AR at y=62/74/86/98/110 (classic-mode coords);
      // we previously stamped 38/58/78/98/118 which painted the values
      // and lock icons one row above their labels.
      mk('str',  86, 62);
      mk('dex',  86, 74);
      mk('int',  86, 86);
      mk('sex',  86, 98);
      mk('ar',   86, 110);

      // Right column — bar cur/max + economy.
      mk('hp',   171, 62);
      mk('stm',  171, 74);
      mk('mp',   171, 86);
      mk('gld',  171, 98);
      mk('wt',   171, 110);

      // Name value lands next to the baked "NAME:" label at the TOP of
      // the 0x0802 art (above the stat block, ~y=36). Earlier we
      // anchored at y=138 (bottom-center) which left the name dangling
      // below the gump border while the "NAME:" label at the top sat
      // empty — Marcin: "imię postaci jest w złym miejscu, powinno być
      // na górze". CUO `StatusGumpClassic.cs:200` reads the name into
      // the top-row slot at (90, 33) too.
      this._name.setPosition(90, 33);
      this.add(this._name);

      // Stat-lock buttons — sit between baked "Str/Dex/Int" labels and
      // the value column. Tiny 9×11 sprites at x=40 in CUO classic
      // mode (not 76, which was the UseUOPGumps variant offset).
      if (v.showLocks) {
        this._strLock = new StatLockButton(0); this._strLock.setPosition(40, 62); this.add(this._strLock);
        this._dexLock = new StatLockButton(1); this._dexLock.setPosition(40, 74); this.add(this._dexLock);
        this._intLock = new StatLockButton(2); this._intLock.setPosition(40, 86); this.add(this._intLock);
      }
      // Aliases so the existing _refresh handlers (which look up
      // `_${key}` by name) still find these — the bar fields are now
      // pure text and we keep the old key names so external callers
      // don't break.
      this._hpVal = this._hp;
      this._stVal = this._stm;
      this._mpVal = this._mp;
      this._fol = this._sex;   // followers populates the "Sex" slot
                                // (we don't ship sex/race; followers is
                                //  more useful information for the user)
    } else {
      // ---- Mini / small 0x0803 layout (compact three-bar variant) -----
      this._name.setPosition(16, 0);
      this.add(this._name);

      this._hp = new Bar(95, 7, 'hp');
      this._hp.setPosition(34, 14); this.add(this._hp);
      this._mp = new Bar(95, 7, 'mana');
      this._mp.setPosition(34, 24); this.add(this._mp);
      // Field name `_stm` (not `_st`) keeps the mini variant in sync
      // with the default 0x0802 layout — _writeBar/_setVal/_maybeUpdateST
      // all look up `this._stm`, so naming the Bar `_st` here left the
      // stam well permanently at 0/1 even after 0xA3 arrived.
      this._stm = new Bar(95, 7, 'stam');
      this._stm.setPosition(34, 34); this.add(this._stm);
    }

    this._unsubs = [
      bus.on('mobile:hp',      (i) => this._maybeUpdateHP(i)),
      bus.on('mobile:mana',    (i) => this._maybeUpdateMP(i)),
      bus.on('mobile:stamina', (i) => this._maybeUpdateST(i)),
      bus.on('mobile:status',  (i) => this._maybeStatus(i)),
      bus.on('mobile:attrs',   (i) => this._maybeAttrs(i)),
      bus.on('mobile:update',  () => this._refresh()),
      bus.on('mobile:stat-locks', (i) => this._maybeStatLocks(i)),
    ];
    // Ask the server for a full snapshot (kind=4 = status). Without this
    // the gump opens with only the bars — the stat block stays "-" until
    // the next 0x11 broadcast (which only happens on stat change).
    if (world.player) {
      try { net.send(buildStatusRequest(world.player.serial, 4)); }
      catch { /* socket transient */ }
    }
    this._refresh();
  }

  get type() { return 'status'; }

  /** Swap variants without disposing the gump (CUO has a small toggle
   *  arrow at the top-right that cycles 154→172→192→208). */
  setVariant(name) {
    if (this._variant === name) return;
    this.dispose();
    const replacement = new StatusGump(name);
    replacement.setPosition?.(this.x | 0, this.y | 0);
    return replacement;
  }

  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  _refresh() {
    const p = world.player;
    if (!p) return;
    this._name.setText(p.name || `0x${p.serial.toString(16)}`);
    // Classic 0x0802 layout: bar slots are pure text "cur/max" — call
    // _writeBar which handles either Bar control (mini variant) or
    // Label (classic variant).
    this._writeBar('hp', p.hp ?? 0, p.hpMax);
    this._writeBar('mp', p.mp ?? p.mana ?? 0, p.mpMax ?? p.manaMax);
    this._writeBar('stm', p.st ?? p.stam ?? 0, p.stMax ?? p.stamMax);
    this._setVal('str', p.str);
    this._setVal('dex', p.dex);
    this._setVal('int', p.int);
    this._setVal('ar',  p.ar);
    this._setVal('wt',  p.weight, p.weightMax);
    this._setVal('gld', p.gold);
    this._setVal('fol', p.followers, p.followersMax);
  }
  /** Bar slot writer — uses Bar.setValues on the mini variant, Label
   *  setText on the classic 0x0802 variant. Either way it updates the
   *  visible "cur/max" representation. */
  _writeBar(key, cur, max) {
    const c = this[`_${key}`];
    if (!c || max == null) return;
    if (typeof c.setValues === 'function') c.setValues(cur, max);
    else if (typeof c.setText === 'function') c.setText(`${cur}/${max}`);
  }
  _setVal(k, v, max) {
    const ctrl = this[`_${k}`];
    if (!ctrl) return;
    if (v === undefined || v === null) { ctrl.setText('-'); return; }
    if (typeof v === 'string') { ctrl.setText(v); return; }
    ctrl.setText(max != null ? `${v}/${max}` : String(v));
  }
  _maybeUpdateHP({ serial, current, max }) {
    if (serial !== world.player?.serial) return;
    world.player.hp = current; world.player.hpMax = max;
    this._writeBar('hp', current, max);
  }
  _maybeUpdateMP({ serial, current, max }) {
    if (serial !== world.player?.serial) return;
    world.player.mp = current; world.player.mpMax = max;
    this._writeBar('mp', current, max);
  }
  _maybeUpdateST({ serial, current, max }) {
    if (serial !== world.player?.serial) return;
    world.player.st = current; world.player.stMax = max;
    this._writeBar('stm', current, max);
  }
  _maybeStatus(info) {
    if (info.serial !== world.player?.serial) return;
    this._refresh();
  }
  _maybeAttrs(info) {
    if (info.serial !== world.player?.serial) return;
    this._writeBar('hp',  info.hpCur, info.hpMax);
    this._writeBar('mp',  info.mpCur, info.mpMax);
    this._writeBar('stm', info.stCur, info.stMax);
  }
  _maybeStatLocks(info) {
    if (info.serial !== world.player?.serial) return;
    this._strLock?.setLock(info.strLock | 0);
    this._dexLock?.setLock(info.dexLock | 0);
    this._intLock?.setLock(info.intLock | 0);
  }
}

export const STATUS_VARIANTS = Object.keys(VARIANTS);
