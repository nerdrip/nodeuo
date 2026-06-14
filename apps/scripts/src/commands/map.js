// `[map` — blank-map pin editor commands.
//
//   [map                 → emit MapPinEditorGump sentinel for a blank
//                          map item in your pack (or spawns one if absent)
//   [map pins            → same as above (alias)
//   [map pin add <x> <y> <label>  — append a pin (called by client gump)
//   [map pin del <idx>            — remove a pin by 0-indexed position
//   [map pin clear                — wipe all pins
//
// Pins live as `item._mapPins = [{ x, y, label }]` (max 50). Persisted
// via the normal item save loop.

const MAP_ITEM_ID = 0x14EB;       // blank-map graphic.
const MAX_PINS = 50;
const CANVAS_W = 320;
const CANVAS_H = 320;

import { childrenOf, findBackpack } from '../_inventory.js';

function findBlankMap(api, sender) {
  const pack = findBackpack(api, sender);
  if (!pack) return null;
  for (const it of childrenOf(api, pack)) {
    if (it && (it.itemId | 0) === MAP_ITEM_ID) return it;
  }
  return null;
}

function spawnBlankMap(api, sender) {
  return api.game?.mobile?.giveItem?.(sender, {
    itemId: MAP_ITEM_ID,
    name: 'a blank map',
  }, { randomGrid: true });
}

function emitGump(ctx, item) {
  const pins = (item._mapPins ?? []).slice(0, MAX_PINS);
  const rows = pins.map((p) =>
    `${p.x | 0}|${p.y | 0}|${(p.label ?? '').replace(/[|;]/g, '_')}`,
  ).join(';');
  const payload = [
    (item.serial >>> 0).toString(16),
    CANVAS_W, CANVAS_H, rows,
  ].join('||');
  ctx.state.sendSystemMessage?.(`@@OPEN_MAPPINS_GUMP@@${payload}`);
}

export default function register(api) {
  if (!api.commands || !api.game?.mobile?.giveItem) return () => {};

  api.commands.register({
    name: 'map',
    help: '[map [pins | pin add <x> <y> <label> | pin del <idx> | pin clear]',
    access: 'Player',
    run(ctx, args) {
      const sender = ctx.sender;
      if (!sender) return;
      const sub = String(args?.[0] ?? '').toLowerCase();

      // Bare `[map` or `[map pins` opens the editor.
      if (sub === '' || sub === 'pins' || sub === 'gump') {
        let item = findBlankMap(api, sender);
        if (!item) item = spawnBlankMap(api, sender);
        if (!item) {
          ctx.state.sendSystemMessage?.('Failed to spawn a blank map.');
          return;
        }
        emitGump(ctx, item);
        return;
      }

      if (sub === 'pin') {
        const op = String(args[1] ?? '').toLowerCase();
        const item = findBlankMap(api, sender);
        if (!item) {
          ctx.state.sendSystemMessage?.('No blank map in your pack.');
          return;
        }
        item._mapPins ??= [];
        if (op === 'add') {
          if (item._mapPins.length >= MAX_PINS) {
            ctx.state.sendSystemMessage?.('Map is full.');
            return;
          }
          const x = parseInt(args[2], 10);
          const y = parseInt(args[3], 10);
          const label = args.slice(4).join(' ').trim() || `Pin ${item._mapPins.length + 1}`;
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            ctx.state.sendSystemMessage?.('Usage: [map pin add <x> <y> <label>');
            return;
          }
          item._mapPins.push({ x, y, label });
          return;
        }
        if (op === 'del') {
          const idx = parseInt(args[2], 10);
          if (!Number.isFinite(idx) || idx < 0 || idx >= item._mapPins.length) {
            ctx.state.sendSystemMessage?.('Bad pin index.');
            return;
          }
          item._mapPins.splice(idx, 1);
          return;
        }
        if (op === 'clear') {
          item._mapPins = [];
          return;
        }
      }
    },
  });

  return () => api.commands.unregister('map');
}
