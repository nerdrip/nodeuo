// MahjongGump — the game-of-Mahjong table UI. Mirrors CUO
// `Game/UI/Gumps/MahjongGame/MahjongGameGump.cs` at MVP scope:
// renders the 4 rows of tile slots, lets a player drag tiles around,
// and submits state changes to the server via 0xDA MahjongPacket
// sub-commands. Server-side dispatch lives in
// `apps/server/src/systems/mahjong.js` (skeleton).
//
// We don't try to implement the full ruleset — Mahjong in UO is a
// multi-player social diversion; the server merely keeps the canonical
// table state and rebroadcasts moves to seated players.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Graphics } from 'pixi.js';
import { Control } from '../control.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { PacketWriter } from '@uo/protocol';

const TABLE_W = 480, TABLE_H = 360;
const TILE_W = 24,  TILE_H = 32;

function build0xDA(sub, gameSerial, payload = []) {
  const total = 1 + 2 + 1 + 4 + payload.length;
  const w = new PacketWriter(total);
  w.writeU8(0xDA); w.writeU16(total);
  w.writeU8(sub & 0xff);
  w.writeU32(gameSerial >>> 0);
  for (const b of payload) w.writeU8(b & 0xff);
  return w.bytes();
}

class TileControl extends Control {
  constructor(value) {
    super();
    this.value = value | 0;
    this.acceptMouseInput = true;
    this.width = TILE_W; this.height = TILE_H;
    this._g = new Graphics();
    this.node.addChild(this._g);
    this._draw(false);
  }
  _draw(highlight) {
    this._g.clear();
    this._g.rect(0, 0, TILE_W, TILE_H)
      .fill({ color: highlight ? 0x6e5520 : 0xeae4cf, alpha: 1 })
      .stroke({ width: 1, color: 0x3a2a10, alpha: 1 });
    // Faint label for the tile id (visual debug — replaces art).
    if (!this._lbl) {
      this._lbl = new Label(String(this.value), { fontSize: 10, hue: 0x3a2a10 });
      this._lbl.setPosition(2, 2);
      this.add(this._lbl);
    }
  }
  setValue(v) { this.value = v | 0; this._lbl?.setText(String(this.value)); }
  onMouseEnter() { this._draw(true); }
  onMouseLeave() { this._draw(false); }
}

export class MahjongGump extends WindowGump {
  constructor(gameSerial) {
    super({ title: 'Mahjong', width: TABLE_W + 24, height: TABLE_H + 60, x: 200, y: 100 });
    this.gameSerial = gameSerial >>> 0;

    this._board = new Graphics();
    this._board.rect(0, 0, TABLE_W, TABLE_H)
      .fill({ color: 0x163818, alpha: 1 })
      .stroke({ width: 2, color: 0x88663a, alpha: 1 });
    this.addContent(this._board, 12, 30);

    /** @type {TileControl[]} */
    this._tiles = [];

    // Buttons.
    const draw = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22, label: 'Draw', action: ButtonAction.Activate,
    });
    draw.setPosition(12, TABLE_H + 36);
    draw.onClick = () => net.send(build0xDA(0x01, this.gameSerial));
    this.add(draw);

    const reset = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22, label: 'Reset', action: ButtonAction.Activate,
    });
    reset.setPosition(80, TABLE_H + 36);
    reset.onClick = () => net.send(build0xDA(0x06, this.gameSerial));
    this.add(reset);

    this._unsubs = [
      bus.on('mahjong:state', (info) => { if (info.gameSerial === this.gameSerial) this._renderTiles(info.tiles); }),
    ];
  }

  get type() { return `mahjong:${this.gameSerial}`; }
  get positionKey() { return 'mahjong'; }

  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  _renderTiles(tiles = []) {
    for (const t of this._tiles) t.dispose?.();
    this._tiles = [];
    let i = 0;
    for (const t of tiles) {
      const ctrl = new TileControl(t.value ?? i);
      const x = 16 + (t.x ?? (i * (TILE_W + 2)) % TABLE_W);
      const y = 30 + (t.y ?? Math.floor(i * (TILE_W + 2) / TABLE_W) * (TILE_H + 2));
      ctrl.setPosition(x, y);
      this.add(ctrl);
      this._tiles.push(ctrl);
      i++;
    }
  }
}
