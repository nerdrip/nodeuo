// QuestionGump — generic Yes/No confirmation dialog. Programmatically
// constructed by client code (e.g. "Drop your insured shield to ground?"
// or "Are you sure you want to delete macro X?"). Not directly server-
// driven — the closest CUO equivalent is `MessageBoxGump` / generic
// confirmation prompts inside content scripts.
//
// Usage:
//   QuestionGump.confirm({
//     title: 'Confirm',
//     prompt: 'Delete this macro?',
//     onYes: () => macroManager.remove(macroId),
//     onNo: () => {},
//   });

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';

export class QuestionGump extends WindowGump {
  /**
   * @param {{title?:string, prompt:string, onYes?:()=>void, onNo?:()=>void,
   *          yesLabel?:string, noLabel?:string}} opts
   */
  constructor(opts) {
    super({ title: opts.title || 'Confirm', width: 300, height: 130, x: 220, y: 180 });
    this._onYes = opts.onYes ?? (() => {});
    this._onNo  = opts.onNo  ?? (() => {});

    // Multi-line prompt (split on \n; render each as its own Label).
    const lines = String(opts.prompt ?? '').split(/\n/);
    let y = 30;
    for (const line of lines) {
      const lbl = new Label(line, { fontSize: 11, hue: 0xfff0c0 });
      this.addContent(lbl, 12, y);
      y += 16;
    }

    const yes = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22,
      label: opts.yesLabel || 'Yes', action: ButtonAction.Activate,
    });
    yes.setPosition(70, 90);
    yes.onClick = () => { try { this._onYes(); } finally { this.close(); } };
    this.add(yes);

    const no = new Button({
      normalGumpId: 0x0483, pressedGumpId: 0x0484,
      width: 60, height: 22,
      label: opts.noLabel || 'No', action: ButtonAction.Activate,
    });
    no.setPosition(170, 90);
    no.onClick = () => { try { this._onNo(); } finally { this.close(); } };
    this.add(no);
  }

  get type() { return 'question'; }

  /** Convenience factory: creates AND shows a question gump via the
   *  caller's UIManager. Pass `ui` from a Scene context. */
  static confirm(ui, opts) {
    const g = new QuestionGump(opts);
    ui.addGump(g);
    try { ui.setModal?.(g); } catch { /* ignore */ }
    const origDispose = g.dispose?.bind(g);
    g.dispose = function (...a) {
      try { ui.clearModal?.(g); } catch { /* ignore */ }
      return origDispose?.(...a);
    };
    return g;
  }
}
