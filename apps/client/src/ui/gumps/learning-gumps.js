// QuestLogGump + MasteryLearningGump + AchievementsGump — three Pixi
// panels driven by chat command echoes. They share the CommandPanel
// base from system-status-gumps.js (we re-implement a tiny variant
// here so this file stays standalone and importable independently).

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { Control } from '../control.js';
import { net } from '../../net/net-client.js';
import { bus } from '../../core/event-bus.js';
import { NodeUOChannel, NodeUOFeature } from '@uo/nodeuo-protocol';

function buildSpeechCmd(text) {
  const enc = new TextEncoder();
  const body = enc.encode(text + '\0');
  const buf = new Uint8Array(12 + body.length);
  let o = 0;
  buf[o++] = 0xAD;
  buf[o++] = 0x00; buf[o++] = (12 + body.length) & 0xff;
  buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0; buf[o++] = 0;
  buf[o++] = 0x45; buf[o++] = 0x4E; buf[o++] = 0x55; buf[o++] = 0;
  buf.set(body, o);
  return buf;
}

class CommandPanel extends WindowGump {
  constructor({ title, width = 460, height = 380 }) {
    super({ title, width, height, x: 130, y: 130 });
    this._scroll = new ScrollArea({ width: width - 24, height: height - 110 });
    this.addContent(this._scroll, 12, 30);
    this._lines = [];
    this._actions = new Control();
    this._actions.width = width; this._actions.height = 30;
    this.addContent(this._actions, 0, height - 64);
    this._unsub = bus.on('chat:system', (m) => this._appendLine(m?.text ?? String(m)));
  }
  dispose() { this._unsub?.(); super.dispose?.(); }
  _appendLine(text) {
    if (!text) return;
    const lbl = new Label(String(text), { fontSize: 11, hue: 0xfff0c0 });
    lbl.setPosition(0, this._lines.length * 14);
    this._scroll.add?.(lbl);
    this._lines.push(lbl);
    this._scroll.setContentHeight?.(this._lines.length * 14);
  }
  _clearLines() {
    while (this._lines.length) this._lines.pop()?.dispose?.();
    this._scroll.setContentHeight?.(0);
  }
  _issue(line) { try { net.send?.(buildSpeechCmd(line)); } catch { /* ignore */ } }
}

// =====================================================================
//  Quest log
// =====================================================================
export class QuestLogGump extends CommandPanel {
  constructor() {
    super({ title: 'Quest Log' });
    const refresh = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Refresh', action: ButtonAction.Activate,
    });
    refresh.setPosition(12, 4);
    refresh.onClick = () => this._refresh();
    this._actions.add(refresh);

    const abandon = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Abandon', action: ButtonAction.Activate,
    });
    abandon.setPosition(98, 4);
    abandon.onClick = () => {

      const id = (typeof window !== 'undefined' ? window.prompt('Quest id to abandon:') : '');
      if (!id) return;
      this._issue(`[quest abandon ${id.trim()}`);
    };
    this._actions.add(abandon);

    this._questUnsub = bus.on('nodeuo:quest-journal', (snapshot) => this._renderQuests(snapshot));
    this._refresh();
  }
  dispose() { this._questUnsub?.(); super.dispose(); }
  _renderQuests(snapshot) {
    this._clearLines();
    const quests = snapshot?.quests ?? [];
    if (!quests.length) { this._appendLine('No active quests.'); return; }
    for (const quest of quests) {
      this._appendLine(`${quest.title || quest.id} · stage ${quest.stage ?? 0}`);
      for (const objective of quest.objectives ?? []) this._appendLine(`  • ${objective.text ?? objective.name ?? objective.kind ?? JSON.stringify(objective)}`);
    }
  }
  async _refresh() {
    this._clearLines();
    if (!net.supportsNodeUO?.(NodeUOFeature.QuestJournal)) { this._issue('[quest list'); return; }
    try {
      const snapshot = await net.sendNodeUORequest({
        channel: NodeUOChannel.Quest, namespace: 'nodeuo.quest',
        capability: NodeUOFeature.QuestJournal,
      });
      this._renderQuests(snapshot);
    } catch (error) { this._appendLine(`Quest refresh failed: ${error.message}`); }
  }
  get type() { return 'quest-log'; }
}

// =====================================================================
//  Mastery learning
// =====================================================================
export class MasteryLearningGump extends CommandPanel {
  constructor() {
    super({ title: 'Mastery' });
    // The schools available — clicking a button sets the chosen
    // mastery via the existing skill-mastery engine.
    let x = 12;
    for (const s of ['bard', 'melee', 'caster', 'ranged', 'tame']) {
      const btn = new Button({
        normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
        width: 76, height: 22, label: s, action: ButtonAction.Activate,
      });
      btn.setPosition(x, 4);
      btn.onClick = () => { this._clearLines(); this._issue(`[mastery list ${s}`); };
      this._actions.add(btn);
      x += 84;
    }
    this._issue('[mastery list bard');
  }
  get type() { return 'mastery'; }
}

// =====================================================================
//  Achievements browse
// =====================================================================
export class AchievementsGump extends CommandPanel {
  constructor() {
    super({ title: 'Achievements & Titles' });
    const list = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'List', action: ButtonAction.Activate,
    });
    list.setPosition(12, 4);
    list.onClick = () => { this._clearLines(); this._issue('[achievements list'); };
    this._actions.add(list);

    const titles = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Titles', action: ButtonAction.Activate,
    });
    titles.setPosition(98, 4);
    titles.onClick = () => { this._clearLines(); this._issue('[achievements titles'); };
    this._actions.add(titles);

    const equip = new Button({
      normalGumpId: 0x0FA8, pressedGumpId: 0x0FAA,
      width: 80, height: 22, label: 'Equip', action: ButtonAction.Activate,
    });
    equip.setPosition(184, 4);
    equip.onClick = () => {

      const id = (typeof window !== 'undefined' ? window.prompt('Title id to equip:') : '');
      if (!id) return;
      this._issue(`[achievements equip ${id.trim()}`);
    };
    this._actions.add(equip);

    this._issue('[achievements list');
  }
  get type() { return 'achievements'; }
}

export const questLogGump      = new QuestLogGump();
export const masteryLearnGump  = new MasteryLearningGump();
export const achievementsGump  = new AchievementsGump();
