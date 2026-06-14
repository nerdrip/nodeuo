// VvV extra gumps — the 5 panels missing from `vvv-battle-gump.js`
// to reach full parity with ServUO `Services/ViceVsVirtue/Gumps/`:
//
//   • VvVMemberListGump      — roster of active members per side
//   • VvVStatisticsGump      — personal/team stats (kills, deaths, points)
//   • VvVRewardStoreGump     — purchase items with battle points
//   • VvVMissionBoardGump    — active missions (capture city, hold sigil)
//   • VvVBattleStandardGump  — sigil-stone interaction (capture / contest)
//
// Faza G #10.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

// ============================================================
//  Member List
// ============================================================
export class VvVMemberListGump extends WindowGump {
  /**
   * @param {{ net?: any, side?: 'virtue'|'vice', members?: Array<{name:string,kills?:number,deaths?:number,points?:number}> }} opts
   */
  constructor(opts = {}) {
    const side = opts.side ?? 'virtue';
    super({ title: `VvV — ${side === 'virtue' ? 'Virtue' : 'Vice'} Members`, width: 420, height: 360, x: 220, y: 110 });
    this._net = opts.net;
    const members = opts.members ?? [];
    this.addContent(new Label(`${members.length} members`, { fontSize: 11, hue: 0xffe0a0 }), 14, 30);
    this.addContent(new Label('Name', { fontSize: 10, hue: 0xc0c0c0 }), 24, 52);
    this.addContent(new Label('K', { fontSize: 10, hue: 0xc0c0c0 }), 220, 52);
    this.addContent(new Label('D', { fontSize: 10, hue: 0xc0c0c0 }), 260, 52);
    this.addContent(new Label('Pts', { fontSize: 10, hue: 0xc0c0c0 }), 300, 52);
    let y = 72;
    for (const m of members.slice(0, 14)) {
      this.addContent(new Label(m.name, { fontSize: 11, hue: 0xffffff }), 24, y);
      this.addContent(new Label(String(m.kills ?? 0), { fontSize: 11, hue: 0xa0ffa0 }), 220, y);
      this.addContent(new Label(String(m.deaths ?? 0), { fontSize: 11, hue: 0xffa0a0 }), 260, y);
      this.addContent(new Label(String(m.points ?? 0), { fontSize: 11, hue: 0xffe080 }), 300, y);
      y += 16;
    }
    const close = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel });
    close.setPosition(320, 320); close.onClick = () => this.close();
    this.add(close);
  }
  get type() { return 'vvv-members'; }
}

// ============================================================
//  Personal Statistics
// ============================================================
export class VvVStatisticsGump extends WindowGump {
  /** @param {{ net?: any, stats?: any }} opts */
  constructor(opts = {}) {
    super({ title: 'VvV — Your Statistics', width: 360, height: 240, x: 240, y: 140 });
    this._net = opts.net;
    const s = opts.stats ?? {};
    const row = (label, value, y, hue = 0xffffff) => {
      this.addContent(new Label(label,         { fontSize: 11, hue: 0xffe0a0 }), 20, y);
      this.addContent(new Label(String(value), { fontSize: 11, hue }),           200, y);
    };
    row('Battles Joined',  s.battles      ?? 0,  40);
    row('Battles Won',     s.wins         ?? 0,  60, 0xa0ffa0);
    row('Kills',           s.kills        ?? 0,  80);
    row('Deaths',          s.deaths       ?? 0, 100, 0xffa0a0);
    row('Capture Time',    `${(s.captureSeconds ?? 0) | 0}s`, 120);
    row('Battle Points',   s.points       ?? 0, 140, 0xffe080);
    row('Lifetime Rank',   s.rank         ?? 'Initiate', 160);
    const close = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel });
    close.setPosition(260, 200); close.onClick = () => this.close();
    this.add(close);
  }
  get type() { return 'vvv-stats'; }
}

// ============================================================
//  Reward Store
// ============================================================
const REWARD_CATALOG = [
  { tag: 'vvv-crimson-cincture',  name: 'Crimson Cincture',          cost: 800 },
  { tag: 'vvv-banner-virtue',     name: 'Virtue Banner',              cost: 300 },
  { tag: 'vvv-banner-vice',       name: 'Vice Banner',                cost: 300 },
  { tag: 'vvv-trap-kit',          name: 'Trap Kit',                   cost: 500 },
  { tag: 'vvv-vendor-search-deed',name: 'Vendor Search Deed',         cost: 400 },
  { tag: 'vvv-battle-standard',   name: 'Battle Standard',            cost: 1200 },
  { tag: 'vvv-brazier',           name: 'Eternal Flame Brazier',      cost: 600 },
  { tag: 'vvv-silver-net',        name: 'Silver Net',                 cost: 250 },
  { tag: 'vvv-throne-of-victory', name: 'Throne of Victory',          cost: 1500 },
  { tag: 'vvv-war-horse-token',   name: 'War Horse Token',            cost: 700 },
];

export class VvVRewardStoreGump extends WindowGump {
  /** @param {{ net?: any, points?: number }} opts */
  constructor(opts = {}) {
    super({ title: 'VvV — Reward Store', width: 400, height: 420, x: 220, y: 100 });
    this._net = opts.net;
    const points = opts.points ?? 0;
    this.addContent(new Label(`Your Battle Points: ${points}`, { fontSize: 12, hue: 0xffe080 }), 14, 30);
    let y = 64;
    for (const r of REWARD_CATALOG) {
      const affordable = points >= r.cost;
      this.addContent(new Label(r.name, { fontSize: 11, hue: 0xffffff }), 14, y + 4);
      this.addContent(new Label(`${r.cost} pts`, { fontSize: 10, hue: affordable ? 0xa0ffa0 : 0xff8080 }), 220, y + 4);
      const b = new Button({
        normalGumpId: affordable ? 0x0481 : 0x0480,
        pressedGumpId: 0x0482, width: 90, height: 20,
        label: affordable ? 'Buy' : 'Need pts', action: ButtonAction.Activate,
      });
      b.setPosition(300, y);
      b.onClick = () => { if (affordable) this._sendCmd(`vvv buy ${r.tag}`); };
      this.add(b);
      y += 28;
    }
    const close = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel });
    close.setPosition(300, 380); close.onClick = () => this.close();
    this.add(close);
  }
  _sendCmd(cmd) { if (this._net?.sendCommand) { try { this._net.sendCommand(cmd); } catch { /* */ } } }
  get type() { return 'vvv-store'; }
}

// ============================================================
//  Mission Board
// ============================================================
export class VvVMissionBoardGump extends WindowGump {
  /** @param {{ net?: any, missions?: Array<{title:string,goal:string,reward:string,active?:boolean}> }} opts */
  constructor(opts = {}) {
    super({ title: 'VvV — Mission Board', width: 420, height: 360, x: 220, y: 110 });
    this._net = opts.net;
    const ms = opts.missions ?? [
      { title: 'Capture Britain Stronghold', goal: 'Hold sigil for 5 min',      reward: '200 battle points', active: true },
      { title: 'Slay 3 enemy guards',        goal: 'Eliminate enemy NPC guards', reward: '50 battle points',  active: true },
      { title: 'Defend the Banner',          goal: 'Repel 2 attacks',            reward: '100 battle points', active: false },
    ];
    let y = 40;
    for (const m of ms) {
      const hue = m.active ? 0xffffff : 0x808080;
      this.addContent(new Label(m.title,                       { fontSize: 12, hue }), 14, y);
      this.addContent(new Label(`Goal: ${m.goal}`,             { fontSize: 10, hue: 0xc0c0c0 }), 26, y + 16);
      this.addContent(new Label(`Reward: ${m.reward}`,         { fontSize: 10, hue: 0xffe080 }), 26, y + 30);
      if (m.active) {
        const accept = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 20, label: 'Accept', action: ButtonAction.Activate });
        accept.setPosition(310, y + 18);
        accept.onClick = () => this._sendCmd(`vvv mission accept ${m.title.toLowerCase().replace(/\s+/g, '-')}`);
        this.add(accept);
      }
      y += 60;
    }
    const close = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel });
    close.setPosition(320, 320); close.onClick = () => this.close();
    this.add(close);
  }
  _sendCmd(cmd) { if (this._net?.sendCommand) { try { this._net.sendCommand(cmd); } catch { /* */ } } }
  get type() { return 'vvv-missions'; }
}

// ============================================================
//  Battle Standard / Sigil Stone Interaction
// ============================================================
export class VvVBattleStandardGump extends WindowGump {
  /** @param {{ net?: any, sigil?: {city:string,owner:string,captureProgress:number,contestedBy?:string} }} opts */
  constructor(opts = {}) {
    super({ title: 'Battle Standard', width: 340, height: 240, x: 240, y: 140 });
    this._net = opts.net;
    const sg = opts.sigil ?? {};
    this.addContent(new Label(`City: ${sg.city ?? '(unknown)'}`,     { fontSize: 12, hue: 0xffe080 }), 14, 30);
    this.addContent(new Label(`Owner: ${sg.owner ?? '(none)'}`,      { fontSize: 11, hue: 0xffffff }), 14, 56);
    this.addContent(new Label(`Capture: ${(sg.captureProgress ?? 0) | 0}%`, { fontSize: 11, hue: 0xa0ffa0 }), 14, 76);
    if (sg.contestedBy) {
      this.addContent(new Label(`Contested by ${sg.contestedBy}!`,   { fontSize: 11, hue: 0xff8080 }), 14, 96);
    }
    const claim = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 120, height: 22, label: 'Begin Capture', action: ButtonAction.Activate });
    claim.setPosition(14, 140); claim.onClick = () => { this._sendCmd('vvv capture'); this.close(); };
    this.add(claim);
    const contest = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 120, height: 22, label: 'Contest', action: ButtonAction.Activate });
    contest.setPosition(150, 140); contest.onClick = () => { this._sendCmd('vvv contest'); this.close(); };
    this.add(contest);
    const close = new Button({ normalGumpId: 0x0481, pressedGumpId: 0x0482, width: 80, height: 22, label: 'Close', action: ButtonAction.Cancel });
    close.setPosition(240, 200); close.onClick = () => this.close();
    this.add(close);
  }
  _sendCmd(cmd) { if (this._net?.sendCommand) { try { this._net.sendCommand(cmd); } catch { /* */ } } }
  get type() { return 'vvv-standard'; }
}
