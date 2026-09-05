// GuildGump — guild management UI (ServUO `Gumps/Guilds/GuildGump.cs`).
// Phase G #5.
//
// Three views, switched by `mode` constructor arg:
//   • 'roster'  — list members + leave/chat buttons
//   • 'charter' — show guild abbreviation, type (Standard/Order/Chaos), website
//   • 'war'     — list active wars + declare/cancel buttons
//
// All actions route through chat commands (`[guild leave`, `[guild say`,
// `[guildwar declare <name>` etc.) so the server-side surface stays
// command-driven and the gump is a thin facade.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

const MODE_ROSTER  = 'roster';
const MODE_CHARTER = 'charter';
const MODE_WAR     = 'war';

export class GuildGump extends WindowGump {
  /**
   * @param {{
   *   net?: any,
   *   mode?: 'roster'|'charter'|'war',
   *   guild?: { name: string, abbr?: string, type?: string, members?: Array<{ name: string, online?: boolean, rank?: string }> },
   *   wars?: Array<{ enemy: string, since?: number }>,
   * }} opts
   */
  constructor(opts = {}) {
    const mode = opts.mode ?? MODE_ROSTER;
    super({
      title: opts.guild?.name ? `Guild: ${opts.guild.name}` : 'Guild',
      width: 420, height: 360, x: 200, y: 120,
    });
    this._net = opts.net;
    this._mode = mode;
    this._guild = opts.guild ?? { name: '(unaffiliated)', members: [] };
    this._wars = opts.wars ?? [];

    this._renderTabs();
    if (mode === MODE_ROSTER) this._renderRoster();
    else if (mode === MODE_CHARTER) this._renderCharter();
    else if (mode === MODE_WAR) this._renderWars();
  }

  _renderTabs() {
    const tabs = [
      ['Roster',   MODE_ROSTER],
      ['Charter',  MODE_CHARTER],
      ['Wars',     MODE_WAR],
    ];
    let x = 12;
    for (const [label, m] of tabs) {
      const b = new Button({
        normalGumpId: m === this._mode ? 0x0482 : 0x0481,
        pressedGumpId: 0x0482,
        width: 90, height: 22,
        label, action: ButtonAction.Activate,
      });
      b.setPosition(x, 30);
      b.onClick = () => this._switchMode(m);
      this.add(b);
      x += 100;
    }
  }

  _renderRoster() {
    this.addContent(new Label(
      `Members: ${this._guild.members?.length ?? 0}`,
      { fontSize: 11, hue: 0xffe0a0 },
    ), 12, 64);
    const members = this._guild.members ?? [];
    let y = 84;
    for (const m of members.slice(0, 12)) {
      const dotHue = m.online ? 0x44 : 0xc0c0c0;
      this.addContent(new Label('●', { fontSize: 10, hue: dotHue }), 16, y + 2);
      const rank = m.rank ? ` [${m.rank}]` : '';
      this.addContent(new Label(`${m.name}${rank}`, { fontSize: 11, hue: 0xffffff }), 30, y);
      y += 16;
    }
    if (members.length > 12) {
      this.addContent(new Label(
        `... and ${members.length - 12} more`,
        { fontSize: 10, hue: 0xc0c0c0 },
      ), 30, y);
      y += 14;
    }
    this._addBottomActions(['Chat', 'Leave Guild', 'Close']);
  }

  _renderCharter() {
    const g = this._guild;
    this.addContent(new Label(`Name: ${g.name}`, { fontSize: 11, hue: 0xffffff }), 16, 64);
    this.addContent(new Label(`Abbreviation: ${g.abbr ?? '???'}`, { fontSize: 11, hue: 0xffffff }), 16, 82);
    this.addContent(new Label(`Type: ${g.type ?? 'Standard'}`, { fontSize: 11, hue: 0xffffff }), 16, 100);
    this.addContent(new Label(`Members: ${g.members?.length ?? 0}`, { fontSize: 11, hue: 0xc0c0c0 }), 16, 118);
    this._addBottomActions(['Set Charter', 'Close']);
  }

  _renderWars() {
    this.addContent(new Label(
      `Active wars: ${this._wars.length}`,
      { fontSize: 11, hue: 0xffe0a0 },
    ), 12, 64);
    let y = 84;
    for (const w of this._wars.slice(0, 10)) {
      const since = w.since ? ` (since ${new Date(w.since).toLocaleDateString()})` : '';
      this.addContent(new Label(`⚔  vs ${w.enemy}${since}`, { fontSize: 11, hue: 0xff4040 }), 20, y);
      y += 16;
    }
    if (this._wars.length === 0) {
      this.addContent(new Label('No active wars.', { fontSize: 11, hue: 0xc0c0c0 }), 20, y);
    }
    this._addBottomActions(['Declare War', 'Cancel War', 'Close']);
  }

  _addBottomActions(labels) {
    let x = 12;
    const y = 310;
    for (const lab of labels) {
      const b = new Button({
        normalGumpId: 0x0481, pressedGumpId: 0x0482,
        width: 110, height: 22,
        label: lab, action: ButtonAction.Activate,
      });
      b.setPosition(x, y);
      b.onClick = () => this._handleAction(lab);
      this.add(b);
      x += 120;
    }
  }

  _handleAction(action) {
    switch (action) {
      case 'Chat':         this._sendCmd('guild say '); return;
      case 'Leave Guild':  this._sendCmd('guild leave'); this.close(); return;
      case 'Set Charter':  this._sendCmd('guild-charter'); return;
      case 'Declare War':  this._sendCmd('guildwar declare '); return;
      case 'Cancel War':   this._sendCmd('guildwar cancel '); return;
      case 'Close':        this.close(); return;
      default: /* */
    }
  }

  _switchMode(mode) {
    // Re-open with new mode; simplest approach for tabbed gump.
    const ui = this._ui ?? this.parent;
    this.close();
    const next = new GuildGump({
      net: this._net, mode,
      guild: this._guild, wars: this._wars,
    });
    if (ui?.add) ui.add(next);
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* */ }
    }
  }

  get type() { return 'guild'; }
}
