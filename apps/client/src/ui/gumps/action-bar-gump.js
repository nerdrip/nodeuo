import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Control } from '../control.js';
import { GumpPic } from '../controls/gump-pic.js';
import { Label } from '../controls/label.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand } from '../../net/outgoing.js';
import { NodeUOCooldownMessage } from '@uo/protocol';
import { bus } from '../../core/event-bus.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { spellById, spellIconId } from './spell-data.js';
import {
  ACTION_BAR_SLOT_COUNT, beginSpellShortcutDrag, clearActionBarSlot,
  dropSpellShortcutOnActionBar, readActionBarSlots,
} from './spell-shortcut-drag.js';

const SLOT = 42;
const COUNT = ACTION_BAR_SLOT_COUNT;

class ActionSlot extends Control {
  constructor(index, spell) {
    super();
    this.index = index; this.spell = spell;
    this.actionBarSlotIndex = index;
    this.width = SLOT; this.height = SLOT; this.acceptMouseInput = true;
    this._frame = new Graphics(); this.node.addChild(this._frame);
    if (spell) {
      this._pic = new GumpPic(spellIconId(spell) || 0x08C0, { width: 34, height: 34 });
      this._pic.setPosition(4, 4); this._pic.acceptMouseInput = false; this.add(this._pic);
    }
    this._key = new Label(index === 9 ? '0' : String(index + 1), { fontSize: 10, hue: 0xffd36a });
    this._key.setPosition(3, 26); this.add(this._key);
    this._draw(false, 0);
  }
  _draw(hover, cooldown) {
    this._frame.clear();
    this._frame.roundRect(0, 0, SLOT, SLOT, 4)
      .fill({ color: hover ? 0x2c3d59 : 0x101722, alpha: 0.94 })
      .stroke({ width: 1, color: hover ? 0xffd36a : 0x765525, alpha: 1 });
    if (cooldown > 0) this._frame.rect(1, 1, SLOT - 2, (SLOT - 2) * cooldown)
      .fill({ color: 0x101010, alpha: 0.62 });
  }
  setCooldown(ratio) { this._cooldown = ratio; this._draw(false, ratio); }
  onMouseEnter(e) {
    this._draw(true, this._cooldown ?? 0);
    tooltips.showText(e.global.x, e.global.y, this.spell
      ? `${this.spell.name}\nMana ${this.spell.mana ?? 0}\nKey ${this.index === 9 ? 0 : this.index + 1}` +
        '\nDrag to move/remove · RMB to clear'
      : 'Empty slot — drag a spell out of the spellbook to add it.');
  }
  onMouseLeave() { this._draw(false, this._cooldown ?? 0); tooltips.hide(); }
  onClick(btn = 0) {
    if (btn === 2) { clearActionBarSlot(this.index); return; }
    if (btn !== 0) return;
    if (!this.spell || this._cooldown > 0) return;
    try { net.send(buildTextCommand(0x56, String(this.spell.id))); } catch { /* connection closed */ }
  }
  onDragStart(btn) {
    if (btn === 0 && this.spell) beginSpellShortcutDrag(this.spell, this.index);
  }
  onDrop() { return dropSpellShortcutOnActionBar(this.index); }
}

export class ActionBarGump extends WindowGump {
  constructor() {
    super({ title: 'Action Bar', width: 18 + COUNT * (SLOT + 3), height: 72, x: 410, y: 620 });
    this.canCloseWithRMB = false;
    this._toggleKey = 'actionbar'; this._cooldowns = new Map();
    this._unsubs = [
      bus.on('actionbar:changed', () => this._rebuild()),
      bus.on('nodeuo:cooldown', (message) => this._cooldownMessage(message)),
    ];
    this._rebuild();
  }
  get type() { return 'actionbar'; }
  _entries() {
    return readActionBarSlots().map((id) => id ? spellById(id) : null);
  }
  _rebuild() {
    for (const slot of this._slots ?? []) { try { this.remove(slot); } catch {} slot.dispose?.(); }
    this._slots = [];
    const entries = this._entries();
    for (let i = 0; i < COUNT; i++) {
      const slot = new ActionSlot(i, entries[i] ?? null);
      slot.setPosition(8 + i * (SLOT + 3), 24); this.add(slot); this._slots.push(slot);
    }
  }
  _cooldown(payload) {
    if (!payload?.id || !String(payload.id).startsWith('spell:')) return;
    this._cooldowns.set(Number(String(payload.id).slice(6)), {
      start: performance.now(), duration: Math.max(1, payload.durationMs | 0),
    });
  }
  _cooldownMessage({ kind, payload } = {}) {
    if (kind === NodeUOCooldownMessage.Remove) {
      const id = String(payload?.id ?? '');
      if (id.startsWith('spell:')) this._cooldowns.delete(Number(id.slice(6)));
      return;
    }
    if (Array.isArray(payload?.cooldowns)) {
      for (const cooldown of payload.cooldowns) this._cooldown(cooldown);
      return;
    }
    this._cooldown(payload);
  }
  activate(index) { this._slots?.[index]?.onClick?.(); }
  tick(_dt, now = performance.now()) {
    for (const slot of this._slots ?? []) {
      const cooldown = this._cooldowns.get(slot.spell?.id);
      if (!cooldown) { slot.setCooldown(0); continue; }
      const ratio = Math.max(0, Math.min(1, 1 - (now - cooldown.start) / cooldown.duration));
      slot.setCooldown(ratio);
      if (ratio <= 0) this._cooldowns.delete(slot.spell?.id);
    }
  }
  dispose() { this._unsubs.forEach((fn) => fn?.()); super.dispose(); }
}
