// HuntmasterTrophyGump — weekly target + leaderboard display.
// Phase H.4.
//
// Triggered by `[hunt gump`. Server emits sentinel:
//   @@OPEN_HUNTMASTER_GUMP@@<targetKind>||<targetName>||<tier>||<rows>
// where rows are `;`-joined `rank|name|score`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';

export class HuntmasterTrophyGump extends WindowGump {
  /** @param {{ net?: any, target?: string, targetName?: string, tier?: number, board?: Array<{rank,name,score}> }} opts */
  constructor(opts = {}) {
    const board = opts.board ?? [];
    const height = 110 + board.length * 22;
    super({ title: 'Huntmaster Challenge', width: 400, height, x: 220, y: 130 });

    this.addContent(new Label(`Quarry: ${opts.targetName ?? 'Hunt'}`,
      { fontSize: 13, hue: 0xffd070 }), 14, 30);
    this.addContent(new Label(`(${opts.target ?? '?'}, tier ${opts.tier ?? 0})`,
      { fontSize: 10, hue: 0xa0a0a0 }), 14, 50);

    this.addContent(new Label('Leaderboard:', { fontSize: 11, hue: 0xffe0a0 }), 14, 76);
    if (board.length === 0) {
      this.addContent(new Label('(no entries yet)', { fontSize: 10, hue: 0x808080 }), 28, 100);
    } else {
      board.forEach((e, i) => {
        const y = 100 + i * 22;
        this.addContent(new Label(`${(e.rank | 0).toString().padStart(2)}.  ${e.name ?? '?'}`,
          { fontSize: 11, hue: i === 0 ? 0xffd070 : 0xffffff }), 28, y);
        this.addContent(new Label(`${(e.score | 0)} pts`,
          { fontSize: 11, hue: 0xa0c0ff }), 280, y);
      });
    }
  }

  get type() { return 'huntmaster-trophy'; }
}

export function parseHuntmasterPayload(raw) {
  if (!raw || typeof raw !== 'string') return { target: '?', targetName: '?', tier: 0, board: [] };
  const [target, targetName, tier, rowsRaw] = raw.split('||');
  const board = (rowsRaw ?? '').split(';').filter(Boolean).map((row) => {
    const [rank, name, score] = row.split('|');
    return { rank: rank | 0, name, score: score | 0 };
  });
  return { target, targetName, tier: tier | 0, board };
}
