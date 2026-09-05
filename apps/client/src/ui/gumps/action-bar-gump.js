import { Graphics } from 'pixi.js';
import { WindowGump } from './window-gump.js';
import { Control } from '../control.js';
import { GumpPic } from '../controls/gump-pic.js';
import { Label } from '../controls/label.js';
import { Button } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { buildTextCommand, buildUseSkill } from '../../net/outgoing.js';
import { NodeUOCooldownMessage } from '@uo/nodeuo-protocol';
import { bus } from '../../core/event-bus.js';
import { tooltips } from '../../managers/tooltip-manager.js';
import { camera } from '../../renderer/camera.js';
import { profile } from '../../managers/profile-manager.js';
import { spellById, spellIconId } from './spell-data.js';
import {
  ACTION_BAR_SLOT_COUNT, ACTION_BAR_PAGE_COUNT, beginSpellShortcutDrag, clearActionBarSlot,
  beginSkillShortcutDrag, dropSpellShortcutOnActionBar, readActionBarActions,
  readActionBarPage, setActionBarPage,
} from './spell-shortcut-drag.js';

const SLOT = 48;
const SLOT_GAP = 4;
const COUNT = ACTION_BAR_SLOT_COUNT;

class ActionSlot extends Control {
  constructor(index, action) {
    super();
    this.index = index; this.action = action;
    this.spell = action?.type === 'spell' ? spellById(action.id) : null;
    this.actionBarSlotIndex = index;
    this.width = SLOT; this.height = SLOT; this.acceptMouseInput = true;
    this._frame = new Graphics(); this.node.addChild(this._frame);
    if (this.spell) {
      this._pic = new GumpPic(spellIconId(this.spell) || 0x08C0, { width: 36, height: 36 });
      this._pic.setPosition(6, 4); this._pic.acceptMouseInput = false; this.add(this._pic);
    } else if (action?.type === 'skill') {
      this._skillLabel = new Label((action.name || `Skill ${action.id}`).slice(0, 9), {
        fontSize: 11, hue: 0xbfe7ff, stroke: true, maxWidth: 38, wordWrap: true,
      });
      this._skillLabel.setPosition(5, 9);
      this.add(this._skillLabel);
    } else {
      this._empty = new Label('+', { fontSize: 19, hue: 0x8d846e, fontWeight: 400 });
      this._empty.setPosition(18, 10);
      this.add(this._empty);
    }
    const caption = this.spell?.name ?? action?.name ?? '';
    if (caption) {
      this._caption = new Label(caption.slice(0, 7), {
        fontSize: 9, hue: 0xf4e7c5, stroke: true, maxWidth: 40,
      });
      this._caption.setPosition(4, 34);
      this.add(this._caption);
    }
    this._key = new Label(index === 9 ? '0' : String(index + 1), {
      fontSize: 10, hue: 0xffdf8a, stroke: true, fontWeight: 700,
    });
    this._key.setPosition(4, 2); this.add(this._key);
    this._draw(false, 0);
  }
  _draw(hover, cooldown) {
    this._frame.clear();
    this._frame.roundRect(0, 0, SLOT, SLOT, 5)
      .fill({ color: hover ? 0x263850 : 0x0d141d, alpha: 0.97 })
      .stroke({ width: hover ? 2 : 1, color: hover ? 0xffd36a : 0x8a672e, alpha: 1 })
      .roundRect(3, 3, SLOT - 6, SLOT - 6, 3)
      .stroke({ width: 1, color: 0xffffff, alpha: hover ? 0.10 : 0.045 })
      .rect(2, SLOT - 14, SLOT - 4, 12)
      .fill({ color: 0x080b0f, alpha: 0.72 });
    if (cooldown > 0) this._frame.rect(1, 1, SLOT - 2, (SLOT - 2) * cooldown)
      .fill({ color: 0x101010, alpha: 0.62 });
  }
  setCooldown(ratio) { this._cooldown = ratio; this._draw(false, ratio); }
  onMouseEnter(e) {
    this._draw(true, this._cooldown ?? 0);
    tooltips.showText(e.global.x, e.global.y, this.spell
      ? `${this.spell.name}\nMana ${this.spell.mana ?? 0}\nKey ${this.index === 9 ? 0 : this.index + 1}` +
        '\nDrag to move/remove · RMB to clear'
      : this.action?.type === 'skill'
        ? `${this.action.name || 'Skill'}\nKey ${this.index === 9 ? 0 : this.index + 1}\nDrag to move/remove · RMB to clear`
        : 'Empty slot — drag a spell or active skill here.');
  }
  onMouseLeave() { this._draw(false, this._cooldown ?? 0); tooltips.hide(); }
  onClick(btn = 0) {
    if (btn === 2) { clearActionBarSlot(this.index); return; }
    if (btn !== 0) return;
    if (!this.action || this._cooldown > 0) return;
    try {
      if (this.action.type === 'skill') net.send(buildUseSkill(this.action.id));
      else net.send(buildTextCommand(0x56, String(this.action.id)));
    } catch { /* connection closed */ }
  }
  onDragStart(btn) {
    if (btn !== 0 || !this.action) return;
    if (this.action.type === 'skill') {
      beginSkillShortcutDrag(this.action, this.index);
    } else if (this.spell) beginSpellShortcutDrag(this.spell, this.index);
  }
  onDrop() { return dropSpellShortcutOnActionBar(this.index); }
}

export class ActionBarGump extends WindowGump {
  constructor() {
    const width = 16 + COUNT * (SLOT + SLOT_GAP);
    const height = 82;
    const uiScale = Math.max(0.75, Math.min(2, Number(profile.get?.('ui.scale')) || 1));
    // Dock below the centered world, in logical UI coordinates (UIManager
    // applies uiScale to its whole Pixi container). This avoids restoring the
    // legacy y=620 bar underneath the fixed chat strip at 1.25x UI scale.
    const screenX = camera.viewX + Math.max(0, (camera.viewW - width * uiScale) / 2);
    const preferredScreenY = camera.viewY + camera.viewH + 10;
    const maxScreenY = Math.max(8, (globalThis.innerHeight || 900) - 60 - height * uiScale - 8);
    super({
      title: 'Action Bar', width, height,
      x: Math.round(screenX / uiScale),
      y: Math.round(Math.min(preferredScreenY, maxScreenY) / uiScale),
    });
    this.canCloseWithRMB = false;
    this._toggleKey = 'actionbar'; this._cooldowns = new Map();
    this._pageLabel = new Label('', { fontSize: 11, hue: 0xffdf8a, fontWeight: 700 });
    this._pageLabel.setPosition(width - 116, 6); this.add(this._pageLabel);
    this._previousPage = new Button({ label: '‹', width: 20, height: 18, flat: true });
    this._previousPage.setPosition(width - 45, 3);
    this._previousPage.onClick = () => setActionBarPage((readActionBarPage() + ACTION_BAR_PAGE_COUNT - 1) % ACTION_BAR_PAGE_COUNT);
    this.add(this._previousPage);
    this._nextPage = new Button({ label: '›', width: 20, height: 18, flat: true });
    this._nextPage.setPosition(width - 23, 3);
    this._nextPage.onClick = () => setActionBarPage((readActionBarPage() + 1) % ACTION_BAR_PAGE_COUNT);
    this.add(this._nextPage);
    this._unsubs = [
      bus.on('actionbar:changed', () => this._rebuild()),
      bus.on('nodeuo:cooldown', (message) => this._cooldownMessage(message)),
    ];
    this._rebuild();
  }
  get type() { return 'actionbar'; }
  _entries() {
    return readActionBarActions();
  }
  _rebuild() {
    for (const slot of this._slots ?? []) { try { this.remove(slot); } catch {} slot.dispose?.(); }
    this._slots = [];
    const entries = this._entries();
    this._pageLabel.setText?.(`Set ${readActionBarPage() + 1}/${ACTION_BAR_PAGE_COUNT}`);
    for (let i = 0; i < COUNT; i++) {
      const slot = new ActionSlot(i, entries[i] ?? null);
      slot.setPosition(8 + i * (SLOT + SLOT_GAP), 25); this.add(slot); this._slots.push(slot);
    }
  }
  findAction(query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return null;
    for (let page = 0; page < ACTION_BAR_PAGE_COUNT; page++) {
      const slots = readActionBarActions(page);
      const index = slots.findIndex((action) => action && `${action.name ?? ''} ${action.type}:${action.id}`.toLowerCase().includes(q));
      if (index < 0) continue;
      setActionBarPage(page);
      return { page, index, action: slots[index] };
    }
    return null;
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
      const cooldown = slot.action?.type === 'spell' ? this._cooldowns.get(slot.spell?.id) : null;
      if (!cooldown) { slot.setCooldown(0); continue; }
      const ratio = Math.max(0, Math.min(1, 1 - (now - cooldown.start) / cooldown.duration));
      slot.setCooldown(ratio);
      if (ratio <= 0) this._cooldowns.delete(slot.spell?.id);
    }
  }
  dispose() { this._unsubs.forEach((fn) => fn?.()); super.dispose(); }
}
