// VirtueGump — 8 virtues (Honesty, Compassion, Valor, Justice, Sacrifice,
// Honor, Spirituality, Humility) with progress sliders + invocation
// buttons. Mirrors ClassicUO `Game/UI/Gumps/VirtueGump.cs`.
//
// Each virtue has 4 ranks: Seeker → Follower → Knight → Avatar. Players
// build virtue rank by performing virtue-specific actions (Honor: bow
// before combat; Justice: kill murderers; etc.). Once Seeker is reached,
// the player can spend virtue charges via `[virtue invoke <name>` to
// trigger an effect (Honor: bonus damage; Sacrifice: heal party; etc.).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { Control } from '../control.js';
import { Graphics } from 'pixi.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { buildVirtueGumpResponse } from '../../net/outgoing.js';

// Map virtue id strings to the ClassicUO `VirtueId` enum (1..8) used by
// 0xB1 VirtueGumpResponse. Order matches CUO `VirtueGump.cs`.
const VIRTUE_NUMERIC_ID = {
  honesty: 1, compassion: 2, valor: 3, justice: 4,
  sacrifice: 5, honor: 6, spirituality: 7, humility: 8,
};

const VIRTUES = Object.freeze([
  { id: 'honesty',      name: 'Honesty',      hue: 0x40 },
  { id: 'compassion',   name: 'Compassion',   hue: 0x2D },
  { id: 'valor',        name: 'Valor',        hue: 0x35 },
  { id: 'justice',      name: 'Justice',      hue: 0x21 },
  { id: 'sacrifice',    name: 'Sacrifice',    hue: 0x59 },
  { id: 'honor',        name: 'Honor',        hue: 0xFB },
  { id: 'spirituality', name: 'Spirituality', hue: 0x4F },
  { id: 'humility',     name: 'Humility',     hue: 0x1A },
]);

const RANK_NAMES = ['—', 'Seeker', 'Follower', 'Knight', 'Avatar'];

class VirtueRow extends Control {
  constructor(virtue, state, onInvoke) {
    super();
    this.width = 220;
    this.height = 32;
    const g = new Graphics();
    g.rect(0, 0, 220, 32).fill({ color: 0x000000, alpha: 0.4 });
    this.node.addChild(g);

    this._lbl = new Label(virtue.name, { fontSize: 12, hue: virtue.hue });
    this._lbl.setPosition(8, 4);
    this.add(this._lbl);

    const rank = state?.rank ?? 0;
    this._rank = new Label(RANK_NAMES[rank] ?? '—',
                            { fontSize: 11, hue: 0xfff0c0 });
    this._rank.setPosition(80, 4);
    this.add(this._rank);

    // Progress bar.
    this._pb = new Graphics();
    const pct = Math.max(0, Math.min(1, (state?.progress ?? 0) / 100));
    this._pb.rect(80, 20, 80, 6).fill({ color: 0x404040 });
    this._pb.rect(80, 20, 80 * pct, 6).fill({ color: virtue.hue, alpha: 0.85 });
    this.node.addChild(this._pb);

    this._charges = new Label(`${state?.charges ?? 0}c`,
                              { fontSize: 10, hue: 0xa0a0a0 });
    this._charges.setPosition(166, 4);
    this.add(this._charges);

    // Invoke button — only enabled if rank ≥ Seeker AND charges > 0.
    const canInvoke = rank >= 1 && (state?.charges ?? 0) > 0;
    this._invoke = new Button({
      normalGumpId: 0x0FAB, pressedGumpId: 0x0FAD, buttonId: 0,
      action: ButtonAction.Activate, width: 36, height: 12,
      label: canInvoke ? 'Invoke' : '—',
    });
    this._invoke.setPosition(180, 16);
    this._invoke.onClick = () => {
      if (!canInvoke) return;
      // Audit rev.9 — send canonical 0xB1 packet so server applies the
      // virtue power. The legacy `virtue:invoke` event is kept for any
      // shard-side macros that still listen on the bus.
      try {
        const num = VIRTUE_NUMERIC_ID[virtue.id];
        if (num) net.send(buildVirtueGumpResponse(num));
      } catch { /* ignore */ }
      bus.emit('virtue:invoke', { id: virtue.id });
      onInvoke?.(virtue.id);
    };
    this.add(this._invoke);
  }
}

export class VirtueGump extends WindowGump {
  constructor(state = {}) {
    super({ title: 'Virtues', width: 250, height: 320, x: 220, y: 60 });
    this._state = state;
    let y = 30;
    for (const v of VIRTUES) {
      const row = new VirtueRow(v, state[v.id], (id) => {
        // Optimistic UI — server will push virtue:state with the new charges.
        this._state[id] = {
          ...this._state[id],
          charges: Math.max(0, (this._state[id]?.charges ?? 0) - 1),
        };
      });
      row.setPosition(15, y);
      this.add(row);
      y += 36;
    }
  }
}

export function installVirtueListener(uiManager) {
  bus.on('virtue:open', (state) => {
    const g = new VirtueGump(state ?? {});
    uiManager.add(g);
  });
}

export { VIRTUES };
