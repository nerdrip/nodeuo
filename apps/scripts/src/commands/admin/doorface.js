import { allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
// `[doorface <S|E|N|W>` — flip a door's facing in-place.
//
// UO ships every door class as 8 consecutive art ids: four pairs of
// (closed, open) for the four cardinal facings (S=0..1, E=2..3,
// N=4..5, W=6..7). Changing facing means swapping the door's
// `closedId / openId` to the chosen pair AND updating `item.itemId`
// to whichever side (closed or open) the door is currently in.
//
// We resolve the door's 8-piece array via `api.housedata.doors` —
// the same table the door spawn auto-bind already uses. Doors that
// don't sit in the housedata catalogue (rare — exotic dungeon gates,
// custom-spawned items) report a friendly error rather than guessing.
//
// The mutation is broadcast as `0x1A WorldItemSA` so observers see the
// new sprite without a relog (matches the broadcast pattern used by
// `[door spawn` and `[edititem`).

const FACING_INPUT = {
  S: { name: 'south', closedSlot: 0 },
  E: { name: 'east',  closedSlot: 2 },
  N: { name: 'north', closedSlot: 4 },
  W: { name: 'west',  closedSlot: 6 },
};

/**
 * Locate the door's 8-piece style array — the *specific* style that
 * contains the targeted graphic. A category typically holds several
 * styles (light wood / dark wood / metal etc.); flipping must stay in
 * the same style or we'd silently change the door's material.
 */
function findDoorStyle(housedata, graphicId) {
  let id = graphicId | 0;
  let info = housedata.doorPiece?.(id);
  let isOpenGraphic = false;
  if (!info) {
    info = housedata.doorPiece?.(id - 1);
    if (!info) return null;
    id -= 1;
    isOpenGraphic = true;
  }
  const cat = housedata.raw?.doors?.find?.((c) => c.category === info.category);
  if (!cat) return null;
  for (const style of cat.styles ?? []) {
    const pieces = style.pieces ?? [];
    const idx = pieces.indexOf(id);
    if (idx >= 0) return { pieces, pieceIdx: idx, isOpenGraphic };
  }
  return null;
}

function broadcastItemRefresh(api, world, item) {
  if (!api.protocol?.worldItemSA) return;
  const pkt = api.protocol.worldItemSA({
    serial: item.serial, itemId: item.itemId, hue: item.hue ?? 0,
    amount: item.amount ?? 1,
    x: item.x | 0, y: item.y | 0, z: item.z | 0,
    flags: (item.movable ?? true) ? 0x20 : 0x00,
  });
  for (const m of allMobiles({ world })) {
    if (!m.client || m.map !== item.map) continue;
    if (Math.abs((m.x | 0) - (item.x | 0)) > 18) continue;
    if (Math.abs((m.y | 0) - (item.y | 0)) > 18) continue;
    m.client.send(pkt);
  }
}

export default function register(api) {
  if (!api.commands || !api.targeting || !api.world) return () => {};

  api.commands.register({
    name: 'doorface',
    help: '[doorface <S|E|N|W> — target a door to flip its facing in-place.',
    access: 'GM',
    run(ctx) {
      const arg = String(ctx.args[0] ?? '').toUpperCase();
      const facing = FACING_INPUT[arg];
      if (!facing) {
        ctx.state.sendSystemMessage('Usage: [doorface <S|E|N|W>');
        return;
      }
      if (!api.housedata?.doorPiece) {
        ctx.state.sendSystemMessage('housedata not loaded — door catalogue unavailable.');
        return;
      }
      ctx.state.sendSystemMessage('Target the door to flip…');
      api.targeting.request(ctx.state, (sel) => {
        if (!sel?.serial) { ctx.state.sendSystemMessage('Cancelled.'); return; }
        const item = itemBySerial(api, sel.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('Bad target — not an item.'); return; }
        // Identify the door's 8-piece style (same material/category).
        const style = findDoorStyle(api.housedata, item.itemId);
        if (!style) {
          ctx.state.sendSystemMessage(
            `Item 0x${item.itemId.toString(16)} is not in the housedata door catalogue. ` +
            `Try [set itemId <id> for manual override.`,
          );
          return;
        }
        const closedId = style.pieces[facing.closedSlot];
        const openId   = closedId + 1;
        if (!closedId) {
          ctx.state.sendSystemMessage(
            `Style is missing piece ${facing.closedSlot} — cannot flip.`,
          );
          return;
        }
        // Preserve the currently-open/closed state. If the targeted
        // graphic was not in housedata but graphic-1 was, it is open.
        const wasOpen = item.door?.isOpen ?? style.isOpenGraphic;
        item.itemId = wasOpen ? openId : closedId;
        item.door = {
          ...(item.door ?? {}),
          closedId, openId,
          isOpen: wasOpen,
          facing: facing.name,
        };
        broadcastItemRefresh(api, api.world, item);
        ctx.state.sendSystemMessage(
          `Door flipped to ${facing.name} ` +
          `(closed=0x${closedId.toString(16)}, open=0x${openId.toString(16)}, state=${wasOpen ? 'open' : 'closed'}).`,
        );
        api.log?.(`[doorface] ${ctx.sender.name}: 0x${item.serial.toString(16)} → ${facing.name}`);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('doorface');
}

export const _findDoorStyleForTest = findDoorStyle;
