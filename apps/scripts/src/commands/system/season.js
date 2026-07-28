// `[season <0..4>` — broadcast a SeasonChange packet to everyone.
// 0 Spring, 1 Summer, 2 Fall, 3 Winter, 4 Desolation.
// Region-driven season overrides (set via `region.season` and applied
// in main.js's region transition broadcaster) still fire on the next
// region entry — this command is for shard-wide cosmetic events
// (Halloween → Desolation, Christmas → Winter, etc).
//
// Mirrors ServUO `Commands/Generic/Season.cs`.

import { sendToOnline } from '../../_spatial.js';

const NAMES = ['Spring', 'Summer', 'Fall', 'Winter', 'Desolation'];
const DESCRIPTIONS = [
  'Fresh foliage and the spring land/static remap.',
  'Classic green summer palette (default).',
  'Autumn leaves and fall vegetation mappings.',
  'Snow/winter mappings for supported terrain and statics.',
  'Dead vegetation and the ghost-world desolation palette.',
];

function sendSeason(api, state, season) {
  const packet = api.protocol?.seasonChange?.(season, 1);
  if (!packet) return false;
  state?.send?.(packet);
  return true;
}

function applySeason(api, state, season) {
  if (api.dayNight) api.dayNight.season = season;
  const packet = api.protocol?.seasonChange?.(season, 1);
  const sent = packet ? sendToOnline(api, packet) : 0;
  state?.sendSystemMessage?.(`Season → ${NAMES[season]} (broadcast to ${sent} client(s)).`);
  return sent;
}

function openSeasonGump(api, ctx) {
  if (!api.gumps?.send) {
    ctx.state?.sendSystemMessage?.('Usage: [season <0..4>');
    return;
  }
  const current = Math.max(0, Math.min(4, Number(api.dayNight?.season ?? 1) | 0));
  const W = 590, H = 382;
  const texts = [
    'Season laboratory',
    `Shard season: ${NAMES[current]}`,
    'Preview changes only your client. Apply broadcasts and persists for new logins.',
    'Season', 'Preview', 'Apply shard',
  ];
  const layout = [
    '{ page 0 }', `{ resizepic 0 0 5054 ${W} ${H} }`,
    '{ text 22 14 1153 0 }', '{ text 22 38 70 1 }',
    `{ button ${W - 34} 10 4017 4018 1 0 0 }`,
    '{ croppedtext 22 62 540 34 70 2 }',
    '{ text 22 104 1153 3 }', '{ text 426 104 1153 4 }', '{ text 492 104 1153 5 }',
  ];
  for (let season = 0; season < NAMES.length; season++) {
    const y = 132 + season * 46;
    const marker = season === current ? '● ' : '○ ';
    texts.push(`${marker}${season}. ${NAMES[season]}`);
    layout.push(`{ text 22 ${y} ${season === current ? 1153 : 70} ${texts.length - 1} }`);
    texts.push(DESCRIPTIONS[season]);
    layout.push(`{ croppedtext 145 ${y} 270 36 70 ${texts.length - 1} }`);
    layout.push(`{ button 438 ${y + 2} 4005 4007 1 0 ${100 + season} }`);
    layout.push(`{ button 514 ${y + 2} 4005 4007 1 0 ${200 + season} }`);
  }
  texts.push('Tip: keep this window open while looking at trees, grass and shorelines.');
  layout.push(`{ croppedtext 22 ${H - 30} 540 20 70 ${texts.length - 1} }`);

  api.gumps.send(ctx.state, {
    x: 90, y: 70, gumpId: 0x53454153, layout: layout.join(''), texts,
  }, (response) => {
    const button = response?.buttonId | 0;
    if (button >= 100 && button < 105) {
      const season = button - 100;
      if (sendSeason(api, ctx.state, season)) {
        ctx.state?.sendSystemMessage?.(`Season preview → ${NAMES[season]} (only you).`);
      }
      openSeasonGump(api, ctx);
      return;
    }
    if (button >= 200 && button < 205) {
      applySeason(api, ctx.state, button - 200);
      openSeasonGump(api, ctx);
    }
  });
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'season',
    help: 'season <0..4> — set the visual season (0 spring … 4 desolation)',
    access: 'GM',
    run(ctx) {
      const args = Array.isArray(ctx.args)
        ? ctx.args.map(String).filter(Boolean)
        : String(ctx.args ?? '').trim().split(/\s+/).filter(Boolean);
      if (!args.length) {
        return openSeasonGump(api, ctx);
      }
      const parsed = Number(args[0]);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 4) {
        ctx.state.sendSystemMessage('Usage: [season <0..4> (or [season for the visual picker)');
        return;
      }
      const v = parsed | 0;
      // Persist shard-wide season in the authoritative atmosphere state so
      // clients logging in after this broadcast receive the same season.
      applySeason(api, ctx.state, v);
    },
  });

  return () => api.commands.unregister('season');
}
