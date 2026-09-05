// InspectorGump — port of ClassicUO `Game/UI/Gumps/InspectorGump.cs`.
// A floating debug panel showing the live state of whatever entity is
// under the cursor. Updates ~5 Hz from world.mobiles / world.items.
//
// Use cases: confirm a mob's notoriety/hp, eyeball an item's hue+itemId
// before reporting a render bug, peek a serial in the journal output.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { world } from '../../world/world.js';
import { bus } from '../../core/event-bus.js';
import { net } from '../../net/net-client.js';
import { requestNodeUOAiInspection } from '../../net/nodeuo-services.js';

export class InspectorGump extends WindowGump {
  constructor() {
    super({ title: 'Inspector', width: 360, height: 324, x: 180, y: 180 });
    this._lines = [];
    for (let i = 0; i < 17; i++) {
      const lbl = new Label('-', { fontSize: 11, hue: i === 0 ? 0x9fdcff : 0xfff0c0 });
      lbl.setPosition(12, 28 + i * 16);
      this.add(lbl);
      this._lines.push(lbl);
    }
    this._aiDetails = null;
    this._aiSerial = 0;
    this._aiRequestedAt = 0;
    this._aiInFlight = false;
    this._lastRefreshAt = 0;
    this._unsubFrame = bus.on('frame:tick', (now) => {
      if (now - this._lastRefreshAt >= 200) this._refresh(now);
    });
    this._refresh(performance.now());
  }
  get type() { return 'inspector'; }

  destroy() {
    this._unsubFrame?.();
    this._unsubFrame = null;
    super.destroy?.();
  }
  dispose() {
    this._unsubFrame?.();
    this._unsubFrame = null;
    super.dispose?.();
  }

  _refresh(now = performance.now()) {
    this._lastRefreshAt = now;
    const sel = world.hover ?? world.lastHover ?? null;
    const set = (i, s) => this._lines[i]?.setText?.(s);
    if (!sel) {
      for (let i = 0; i < this._lines.length; i++) set(i, i === 0 ? 'Hover an entity…' : '');
      return;
    }
    const isMob = !!sel.notoriety || sel.hpMax != null;
    const serial = sel.serial >>> 0;
    if (isMob && serial !== (world.player?.serial >>> 0) && net.supportsNodeUO?.('ai.inspector')
        && !this._aiInFlight && (serial !== this._aiSerial || now - this._aiRequestedAt >= 1000)) {
      this._aiSerial = serial;
      this._aiRequestedAt = now;
      this._aiInFlight = true;
      requestNodeUOAiInspection(net, serial).then((result) => {
        this._aiDetails = result?.ok ? result.npc : null;
      }).catch(() => { this._aiDetails = null; }).finally(() => { this._aiInFlight = false; });
    } else if (!isMob || serial !== this._aiSerial) this._aiDetails = null;
    let i = 0;
    set(i++, `Type: ${isMob ? 'Mobile' : 'Item'}`);
    set(i++, `Serial: 0x${(sel.serial >>> 0).toString(16).padStart(8, '0')}`);
    set(i++, `Name: ${sel.name ?? '-'}`);
    if (isMob) {
      set(i++, `Body: 0x${(sel.body | 0).toString(16)}  Dir: ${sel.direction ?? '?'}`);
      set(i++, `HP: ${sel.hp ?? 0}/${sel.hpMax ?? 0}  Mana: ${sel.mana ?? 0}/${sel.manaMax ?? 0}`);
      set(i++, `Stam: ${sel.stam ?? 0}/${sel.stamMax ?? 0}`);
      set(i++, `Notoriety: ${sel.notoriety ?? '-'}  Flags: 0x${(sel.flags ?? 0).toString(16)}`);
      set(i++, `Pos: (${sel.x},${sel.y},${sel.z})  Map: ${sel.map ?? 0}`);
      if (this._aiDetails?.serial === serial) {
        const ai = this._aiDetails;
        set(i++, `AI: ${String(ai.ai ?? '-').slice(0, 42)}`);
        set(i++, `AI state: ${String(ai.state ?? '-').slice(0, 36)}`);
        set(i++, `Target: ${ai.target ? `0x${(ai.target >>> 0).toString(16)}` : '-'}`);
        set(i++, `Path: ${ai.path?.length ?? 0}  next: ${ai.nextThinkAt ?? '-'}`);
      }
    } else {
      set(i++, `ItemId: 0x${(sel.itemId | 0).toString(16)}  Hue: 0x${(sel.hue ?? 0).toString(16)}`);
      set(i++, `Amount: ${sel.amount ?? 1}  Layer: ${sel.layer ?? '-'}`);
      set(i++, `Pos: (${sel.x},${sel.y},${sel.z})  Map: ${sel.map ?? 0}`);
      set(i++, `Parent: ${sel.parent ? '0x' + (sel.parent >>> 0).toString(16) : '-'}`);
    }
    while (i < this._lines.length) set(i++, '');
  }
}
