// PartyHealthSidebar — vertical strip of compact health rows, one per
// party member, anchored to the screen edge. Mirrors the side-strip
// behaviour of `BaseHealthBarGump` (PartyMember mode) in ClassicUO's
// `Game/UI/Gumps/HealthBarGump.cs`. Existing `PartyGump` is the manifest
// (invite / disband / loot-flag controls); this is the at-a-glance HP
// readout you keep open during groupplay.
//
// Each row renders: name (cream), HP bar (red), Mana bar (blue), Stam
// bar (yellow). Hue swaps to green when poisoned, gray when dead, gold
// when invul (matches CUO HealthBarGump bar art tinting).

import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { profile } from '../../managers/profile-manager.js';
import { party as partyManager } from '../../managers/party-manager.js';

const ROW_H = 36;
const NAME_X = 6;
const BAR_X = 6;
const BAR_W = 130;
const BAR_H = 6;
const ROW_PAD = 2;

function barColor(stat, mob) {
  if (stat === 'hp') {
    if (mob?.dead) return 0x404040;
    if (mob?.invulnerable) return 0xc0a040;
    if (mob?.poisoned) return 0x40b040;
    return 0xb02020;
  }
  if (stat === 'mp') return 0x2040c0;
  return 0xc0a020;                  // stam
}

class MemberRow {
  constructor(serial, name) {
    this.serial = serial;
    this.name = name || '?';
    this.gfx = new Graphics();
    this.lbl = new Label(this.name, { fontSize: 11, hue: 0xfff0c0, stroke: true });
    // CanLoot is a self flag in CUO/ServUO: "party can loot my corpse".
    // Only the player's own row gets the toggle.
    this._lootHitArea = null;
  }

  draw(yOffset) {
    const m = world.mobiles.get(this.serial);
    const hp  = Math.max(0, Math.min(1, (m?.hp  ?? 0) / Math.max(1, m?.hpMax  ?? 100)));
    const mp  = Math.max(0, Math.min(1, (m?.mp  ?? 0) / Math.max(1, m?.mpMax  ?? 100)));
    const st  = Math.max(0, Math.min(1, (m?.st  ?? 0) / Math.max(1, m?.stMax  ?? 100)));
    this.lbl.setPosition(NAME_X, yOffset);
    this.gfx.clear();
    const isSelf = this.serial === (world.player?.serial >>> 0);
    if (isSelf) {
      const canLoot = partyManager.canLoot(this.serial);
      const lootX = BAR_X + BAR_W - 10;
      this.gfx.rect(lootX, yOffset, 9, 9)
        .fill({ color: canLoot ? 0x60c060 : 0x602020, alpha: 0.9 })
        .stroke({ width: 1, color: 0x000000 });
      this._lootHitArea = { x: lootX, y: yOffset, w: 9, h: 9, serial: this.serial };
    } else {
      this._lootHitArea = null;
    }
    let y = yOffset + 14;
    this._drawBar(y, hp, 'hp', m); y += BAR_H + 1;
    this._drawBar(y, mp, 'mp', m); y += BAR_H + 1;
    this._drawBar(y, st, 'stam', m);
    // Wire click → toggle via the row's gfx.eventMode.
    this.gfx.eventMode = 'static';
    if (!this.gfx._clickHook) {
      this.gfx._clickHook = (ev) => {
        const local = ev.getLocalPosition?.(this.gfx) ?? { x: ev.global?.x ?? 0, y: ev.global?.y ?? 0 };
        const a = this._lootHitArea;
        if (!a) return;
        if (local.x >= a.x && local.x < a.x + a.w && local.y >= a.y && local.y < a.y + a.h) {
          const cur = partyManager.canLoot(this.serial);
          partyManager.setCanLoot(this.serial, !cur);
        }
      };
      try { this.gfx.on('pointerdown', this.gfx._clickHook); } catch { /* old pixi */ }
    }
  }

  _drawBar(y, val, kind, mob) {
    this.gfx.roundRect(BAR_X, y, BAR_W, BAR_H, 2).fill({ color: 0x0a0908, alpha: 0.85 })
      .stroke({ width: 1, color: 0x3a2a14, alpha: 0.7 });
    if (val > 0) {
      this.gfx.roundRect(BAR_X, y, BAR_W * val, BAR_H, 2).fill({ color: barColor(kind, mob) });
    }
  }
}

export class PartyHealthSidebarGump extends WindowGump {
  constructor() {
    const saved = profile.loadGumpState('party-health-sidebar') ?? {};
    super({
      title: 'Party',
      width: saved.w ?? 150,
      height: saved.h ?? 240,
      x: saved.x ?? (window.innerWidth - 170),
      y: saved.y ?? 80,
    });
    /** @type {Map<number, MemberRow>} */
    this._rows = new Map();
    /** @type {{serial:number, name?:string}[]} */
    this._members = [];
    this._liveSerials = new Set();
    this._lastDrawKey = '';
    this._redrawQueued = false;
    this._disposed = false;

    this._unsubs = [
      bus.on('party:roster', ({ members }) => this._onRoster(members)),
      bus.on('mobile:hp',     (info) => this._scheduleRedraw(info)),
      bus.on('mobile:mana',   (info) => this._scheduleRedraw(info)),
      bus.on('mobile:stam',   (info) => this._scheduleRedraw(info)),
      bus.on('mobile:stamina',(info) => this._scheduleRedraw(info)),
      bus.on('mobile:status', (info) => this._scheduleRedraw(info)),
    ];

    // Persist drag position on the way out so the sidebar re-opens
    // exactly where the user parked it last session.
    this.node.on?.('pointerup', () => this._save());
  }

  get type() { return 'party-health-sidebar'; }

  dispose() {
    this._disposed = true;
    for (const u of this._unsubs) u();
    this._save();
    super.dispose();
  }

  _save() {
    profile.saveGumpState('party-health-sidebar', {
      x: this.node.x | 0, y: this.node.y | 0,
      w: this._w, h: this._h,
    });
  }

  _onRoster(members) {
    this._members = Array.isArray(members) ? members.slice() : [];
    // Drop rows for members who left.
    const live = this._liveSerials;
    live.clear();
    for (const m of this._members) live.add(m.serial >>> 0);
    for (const [k, row] of this._rows) {
      if (!live.has(k)) {
        try { row.lbl.dispose?.(); } catch { /* ignore */ }
        try { row.gfx.destroy?.(); } catch { /* ignore */ }
        this._rows.delete(k);
      }
    }
    // Add rows for new members.
    for (const m of this._members) {
      const ser = m.serial >>> 0;
      if (!this._rows.has(ser)) {
        const mob = world.mobiles.get(ser);
        const row = new MemberRow(ser, m.name ?? mob?.name);
        this._rows.set(ser, row);
        this.add(row.lbl);
        this.node.addChild(row.gfx);
      }
    }
    this._lastDrawKey = '';
    this._redraw();
  }

  _scheduleRedraw(info = null) {
    const serial = (info?.serial ?? info?.mobile ?? 0) >>> 0;
    if (serial && !this._rows.has(serial)) return;
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn) => setTimeout(fn, 16);
    raf(() => {
      this._redrawQueued = false;
      if (!this._disposed) this._redraw();
    });
  }

  _drawKey() {
    const parts = [this._members.length];
    for (const m of this._members) {
      const serial = m.serial >>> 0;
      const mob = world.mobiles.get(serial);
      parts.push(
        serial,
        mob?.hp ?? 0, mob?.hpMax ?? 0,
        mob?.mp ?? 0, mob?.mpMax ?? 0,
        mob?.st ?? 0, mob?.stMax ?? 0,
        mob?.dead ? 1 : 0,
        mob?.invulnerable ? 1 : 0,
        mob?.poisoned ? 1 : 0,
        partyManager.canLoot(serial) ? 1 : 0,
      );
    }
    return parts.join('|');
  }

  _redraw() {
    const key = this._drawKey();
    if (key === this._lastDrawKey) return;
    this._lastDrawKey = key;
    let y = 28;
    for (const m of this._members) {
      const row = this._rows.get(m.serial >>> 0);
      if (!row) continue;
      row.draw(y);
      y += ROW_H + ROW_PAD;
    }
  }
}
