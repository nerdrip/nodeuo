// PartyGump — list of party members + their HP bars. Mirrors ClassicUO's
// Game/UI/Gumps/PartyManifestGump.cs at MVP scope.
//
// Receives roster from `party:update` (decoded from 0xBF subop 0x06)
// and HP from regular `mobile:hp` events for matching serials.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { bus } from '../../core/event-bus.js';
import { world } from '../../world/world.js';
import { net } from '../../net/net-client.js';
import { buildPartyAdd, buildPartyRemove } from '../../net/outgoing.js';
import { party as partyManager } from '../../managers/party-manager.js';

export class PartyGump extends WindowGump {
  constructor() {
    super({ title: 'Party', width: 240, height: 160, x: 80, y: 200 });
    /** @type {{serial:number}[]} */
    this._members = [];
    /** @type {Map<number, { name:Label, hpBg:Graphics, hpFg:Graphics }>} */
    this._rows = new Map();
    this._rowPool = [];
    this._rowPoolUsed = 0;
    this._roster = new Control();
    this._roster.setPosition(10, 28);
    this.add(this._roster);

    this._unsubs = [
      // PartyManager emits `party:roster` (canonical) after 0xBF 0x06
      // sub-0x01 / sub-0x02 — the old `party:update` listener never
      // fired because no one emitted it, so the gump stayed empty even
      // when the player was in a party. Also pull live HP off
      // mobile-status (0x11) and the 0xA1/A2/A3 trio, plus mobile-spawn
      // so re-zoning doesn't drop our bars.
      bus.on('party:roster', (info) => this._onRoster(info)),
      bus.on('mobile:hp',    (info) => this._onHp(info)),
      bus.on('mobile:status', (info) => this._onHp({
        serial: info.serial, current: info.hpCur, max: info.hpMax,
      })),
      bus.on('mobile:incoming', () => this._redraw()),
    ];
  }

  get type() { return 'party'; }

  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  _onRoster({ members }) {
    this._members = members ?? [];
    this._redraw();
  }

  _onHp({ serial, current, max }) {
    const row = this._rows.get(serial >>> 0);
    if (!row) return;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    row.hpRatio = ratio;
    row.hpFg.clear();
    row.hpFg.rect(0, 0, 120 * ratio, 8).fill({ color: 0x80c060 });
  }

  _redraw() {
    this._rows.clear();
    this._ensureHeader();
    this._rowPoolUsed = 0;
    let y = 18;

    for (const m of this._members) {
      const mob = world.mobiles.get(m.serial >>> 0);
      const serial = m.serial >>> 0;
      const row = this._acquireRow();
      row.visible = true;
      row.name.setText(mob?.name || `0x${serial.toString(16)}`);
      row.name.setHue(0xfff0c0);
      row.name.setPosition(0, y);
      // Clicking the name selects this member as "last target" — the
      // hotkeys manager listens for `combat:target` and the macro
      // TargetLast/AttackLast cascades route here. Lets a party
      // member be the heal-target of a Greater Heal macro without
      // a target prompt round-trip. Pure client-side.
      row.name.onClick = (btn) => {
        if (btn !== 0) return;
        bus.emit('combat:target', { serial });
        bus.emit('chat:system', { text: `Last target: ${mob?.name || 'party member'}` });
      };
      row.hpBg.position.set(100, y + 2);
      row.hpFg.position.set(100, y + 2);
      const ratio = (mob?.hpMax ?? 0) > 0 ? Math.max(0, Math.min(1, (mob.hp ?? 0) / mob.hpMax)) : 1;
      this._paintHp(row, ratio);
      // Kick — only meaningful when the player is the leader; server
      // rejects otherwise. Cheap to always offer.
      row.kick.setText('X');
      row.kick.setHue(0xff8080);
      row.kick.setPosition(222, y - 1);
      row.kick.onClick = (btn) => {
        if (btn !== 0) return;
        try { net.send(buildPartyRemove(serial)); } catch { /* socket */ }
      };
      this._rows.set(serial, row);
      y += 18;
    }
    for (let i = this._rowPoolUsed; i < this._rowPool.length; i++) {
      this._setRowVisible(this._rowPool[i], false);
    }
  }

  _ensureHeader() {
    if (!this._headerInvite) {
      // Header row — Invite + Leave buttons. ServUO `PartyCommands` honours
      // 0x01 add (serial=0 opens server-side target prompt → caster clicks
      // the friend) and 0x02 remove (serial=self leaves the party).
      this._headerInvite = this._mkButton('[ Invite ]', 0, 0, 0x80ffc0, () => {
        try { net.send(buildPartyAdd(0)); } catch { /* socket transient */ }
        bus.emit('chat:system', { text: 'Target a player to invite.' });
      });
      this._headerLeave = this._mkButton('[ Leave ]', 90, 0, 0xff8080, () => {
        const self = world.player?.serial;
        if (!self) return;
        try { net.send(buildPartyRemove(self)); } catch { /* socket */ }
      });
      this._headerLoot = this._mkButton('', 150, 0, 0xd8d080, () => {
        partyManager.setCanLoot(!partyManager.myCanLoot());
        this._redraw();
      });
      this._roster.add(this._headerInvite);
      this._roster.add(this._headerLeave);
      this._roster.add(this._headerLoot);
    }
    this._headerLoot.setText(partyManager.myCanLoot() ? '[ Loot On ]' : '[ Loot Off ]');
  }

  _mkButton(text, x, y, hue, onClick) {
    const lbl = new Label(text, { fontSize: 11, hue });
    lbl.setPosition(x, y);
    lbl.onClick = (btn) => { if (btn === 0) onClick(); };
    return lbl;
  }

  _acquireRow() {
    const idx = this._rowPoolUsed++;
    let row = this._rowPool[idx];
    if (!row) {
      const name = new Label('', { fontSize: 11, hue: 0xfff0c0 });
      const hpBg = new Graphics().rect(0, 0, 120, 8)
        .fill({ color: 0x000000 })
        .stroke({ width: 1, color: 0x4a3818 });
      const hpFg = new Graphics();
      const kick = new Label('X', { fontSize: 11, hue: 0xff8080 });
      row = { name, hpBg, hpFg, kick, hpRatio: -1 };
      this._rowPool[idx] = row;
      this._roster.add(name);
      this._roster.node.addChild(hpBg, hpFg);
      this._roster.add(kick);
    }
    this._setRowVisible(row, true);
    return row;
  }

  _setRowVisible(row, visible) {
    if (!row) return;
    row.name.visible = visible;
    row.name.node.visible = visible;
    row.hpBg.visible = visible;
    row.hpFg.visible = visible;
    row.kick.visible = visible;
    row.kick.node.visible = visible;
    if (!visible) {
      row.name.onClick = undefined;
      row.kick.onClick = undefined;
    }
  }

  _paintHp(row, ratio) {
    if (row.hpRatio === ratio) return;
    row.hpRatio = ratio;
    row.hpFg.clear();
    row.hpFg.rect(0, 0, 120 * ratio, 8).fill({ color: 0x80c060 });
  }
}
