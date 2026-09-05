import { allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { createItem, destroyItemBySerial } from '../../_items.js';
// `[build <graphicId>` + `[buildmenu` — in-game static placement tool.
//
// Mirrors ServUO's `[Add` + `Tile()` admin gump but with a chained
// targeting cursor so a single command places many tiles in one
// session: pick a graphic, click tile → place, click another tile →
// place again, right-click to cancel.
//
// This provides a chained-target placement loop with a curated palette
// for building houses and decorations from static artwork.
//
// Storage: placed statics go into `world.items` as regular item
// entries with `isDecoration: true` + `movable: false` (matches
// `[decorate` semantics). They round-trip through persistence so a
// builder's session survives restarts. `[del` removes them.
//
//   - Save selection as a multi/.json export

const SAFE_GRAPHIC_RANGE = [0x0001, 0x4000];

// Curated palette — most-used building blocks. Each entry is a
// `{name, ids[]}` where `ids[]` is the contiguous run of related
// graphics in art.mul (e.g. all 8 facings of an iron door).
const BUILD_PALETTE = [
  { name: 'Floors',      ids: [0x0494, 0x0495, 0x0496, 0x0497, 0x05B5, 0x05B6, 0x05BD, 0x0517] },
  { name: 'Wood walls',  ids: [0x0006, 0x0008, 0x000A, 0x000C, 0x000E, 0x0010, 0x0012, 0x0014] },
  { name: 'Stone walls', ids: [0x0080, 0x0082, 0x0086, 0x008A, 0x008E, 0x0092, 0x0096, 0x009A] },
  { name: 'Brick walls', ids: [0x009E, 0x00A2, 0x00A6, 0x00AA, 0x00AE, 0x00B2, 0x00B6, 0x00BA] },
  { name: 'Roofs',       ids: [0x0518, 0x051A, 0x051C, 0x051E, 0x0520, 0x0522, 0x0524, 0x0526] },
  { name: 'Doors',       ids: [0x0675, 0x0676, 0x0824, 0x0825, 0x086E, 0x086F, 0x080B, 0x080C] },
  { name: 'Windows',     ids: [0x002A, 0x0058, 0x005C, 0x00A8] },
  { name: 'Fences',      ids: [0x0833, 0x0834, 0x0835, 0x0836, 0x082C, 0x082D, 0x082E, 0x082F] },
  { name: 'Stairs',      ids: [0x0747, 0x0748, 0x0749, 0x074A, 0x074B, 0x074C, 0x074D, 0x074E] },
  { name: 'Furniture',   ids: [0x0B2C, 0x0B2D, 0x0B47, 0x0B48, 0x0B7A, 0x0B7B, 0x0E76, 0x0E77] },
  { name: 'Lights',      ids: [0x0A0F, 0x0A12, 0x0A15, 0x0A18, 0x0B1A, 0x0B1B, 0x0B26, 0x0B27] },
  { name: 'Decoration',  ids: [0x0C2B, 0x0C2C, 0x0C2D, 0x0C2E, 0x0E2F, 0x0E30, 0x14F0, 0x14EB] },
];

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  /** Arm a chained-target cursor for `state` that places `itemId` at
   *  every clicked tile until the operator right-clicks or runs
   *  `[buildoff`. Uses the primitive `targeting.request` with cursor
   *  kind=1 (location) — the standard 0x6C tile picker. */
  function armBuildCursor(state, itemId, hue = 0) {
    const req = api.targeting?.request ?? api.ctx?.handlers?.targeting?.request;
    if (!req) {
      state.sendSystemMessage?.('Build cursor unavailable on this shard.');
      return;
    }
    state.sendSystemMessage?.(`Build mode: 0x${itemId.toString(16)}. Click tiles to place. Right-click to cancel.`);
    // Push a typed preview hint so the NodeUO target cursor renders a ghost.
    try {
      const previewCap = api.nodeUO?.features?.WorldEditing;
      if (state.supportsNodeUO?.(previewCap)) {
        api.nodeUO?.send?.(state, {
          feature: previewCap, namespace: 'nodeuo.world-editing',
          payload: { operation: 'preview', itemId, hue },
        });
      }
    } catch { /* preview hint is non-fatal */ }
    req(state, (picked) => {
      if (!picked) {
        state.sendSystemMessage?.('Build mode cancelled.');
        return;
      }
      const tx = picked.x | 0, ty = picked.y | 0, tz = picked.z | 0;
      const item = createItem(api, api.world, {
        itemId, hue,
        x: tx, y: ty, z: tz, map: state.mobile?.map ?? 1,
        movable: false,
      });
      item.isDecoration = true;
      item.script = 'static';
      const proto = api.protocol;
      if (proto?.worldItemSA) {
        const wi = proto.worldItemSA({
          serial: item.serial, itemId: item.itemId, hue: item.hue, amount: 1,
          x: item.x, y: item.y, z: item.z, flags: 0x00,
        });
        for (const m of allMobiles(api)) {
          if (!m.client || m.map !== item.map) continue;
          if (Math.abs(m.x - item.x) > 18 || Math.abs(m.y - item.y) > 18) continue;
          m.client.send(wi);
        }
      }
      state.sendSystemMessage?.(`Placed 0x${itemId.toString(16)} at (${item.x},${item.y},${item.z}). Click again or right-click to stop.`);
      armBuildCursor(state, itemId, hue);
    }, { kind: 1 });   // 1 = location/tile cursor
  }

  api.commands.register({
    name: 'build',
    help: '[build <graphicId>[,hue] — chained static placement. Click tiles to place. Right-click to cancel.',
    access: 'Admin',
    run(ctx, args) {
      if (!args.length) {
        ctx.state.sendSystemMessage('Usage: [build <graphicId>[,hue]   |   [buildmenu for palette');
        return;
      }
      const [graphic, hueStr] = args[0].split(',');
      const itemId = parseInt(graphic, 0);
      if (!Number.isFinite(itemId) || itemId < SAFE_GRAPHIC_RANGE[0] || itemId > SAFE_GRAPHIC_RANGE[1]) {
        ctx.state.sendSystemMessage(`Graphic out of range (${SAFE_GRAPHIC_RANGE[0]}..${SAFE_GRAPHIC_RANGE[1]}): ${args[0]}`);
        return;
      }
      const hue = hueStr ? parseInt(hueStr, 0) & 0xFFFF : 0;
      armBuildCursor(ctx.state, itemId, hue);
    },
  });

  api.commands.register({
    name: 'buildmenu',
    help: '[buildmenu — open the static palette gump. Pick a graphic, then click tiles to place.',
    access: 'Admin',
    run(ctx) {
      if (!api.gumps?.send) {
        ctx.state.sendSystemMessage('Build menu unavailable (no gump host).');
        return;
      }
      renderBuildMenu(ctx, 0);
    },
  });

  api.commands.register({
    name: 'unbuild',
    help: '[unbuild — chained-target cursor. Click a placed static (a runtime item with isDecoration=true) to delete it. Right-click to cancel. Map-statics (fixed in chunk data) cannot be removed.',
    access: 'Admin',
    run(ctx) {
      armEraseCursor(ctx.state);
    },
  });

  function armEraseCursor(state) {
    const req = api.targeting?.request ?? api.ctx?.handlers?.targeting?.request;
    if (!req) {
      state.sendSystemMessage?.('Erase cursor unavailable on this shard.');
      return;
    }
    state.sendSystemMessage?.('Erase mode: click a placed static to delete. Right-click to cancel.');
    req(state, (picked) => {
      if (!picked) {
        state.sendSystemMessage?.('Erase cancelled.');
        return;
      }
      // 0x6C with kind=0 returns either a Mobile (skip), an Item by
      // serial, or a tile click with no serial (skip — we can't
      // delete fixed map statics here).
      const serial = (picked.serial >>> 0);
      if (!serial) {
        state.sendSystemMessage?.('Empty tile / fixed map static — nothing to erase.');
        armEraseCursor(state);
        return;
      }
      const item = itemBySerial(api, serial);
      if (!item) {
        state.sendSystemMessage?.(`No runtime item at 0x${serial.toString(16)}.`);
        armEraseCursor(state);
        return;
      }
      // Refuse to delete worn / contained items via this tool — only
      // ground statics belong here. Use [del for held inventory.
      if (item.parent != null) {
        state.sendSystemMessage?.('That item is in a container — use [del.');
        armEraseCursor(state);
        return;
      }
      const x = item.x, y = item.y, facet = item.map;
      try { destroyItemBySerial(api, serial); }
      catch (e) {
        state.sendSystemMessage?.(`Erase failed: ${e.message}`);
        return;
      }
      // Broadcast removeEntity to nearby players so the sprite vanishes
      // without waiting for a relog / [resync.
      const proto = api.protocol;
      if (proto?.removeEntity) {
        const rm = proto.removeEntity(serial);
        for (const m of allMobiles(api)) {
          if (!m.client || m.map !== facet) continue;
          if (Math.abs(m.x - x) > 18 || Math.abs(m.y - y) > 18) continue;
          m.client.send(rm);
        }
      }
      state.sendSystemMessage?.(`Erased 0x${serial.toString(16)} at (${x},${y}). Click again or right-click to stop.`);
      armEraseCursor(state);     // chain like [build does
    }, { kind: 0 });
  }

  function renderBuildMenu(ctx, pageIdx) {
    const PAGE_SIZE = 6;          // 6 categories per gump page
    const totalPages = Math.max(1, Math.ceil(BUILD_PALETTE.length / PAGE_SIZE));
    const slice = BUILD_PALETTE.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);
    const W = 540;
    const H = 60 + slice.length * 56 + 40;
    const parts = [];
    const texts = [];
    parts.push('{ page 0 }');
    parts.push(`{ resizepic 0 0 5054 ${W} ${H} }`);
    texts.push(`Build menu (page ${pageIdx + 1}/${totalPages}) — pick a graphic`);
    parts.push(`{ text 18 12 1153 ${texts.length - 1} }`);
    let buttonId = 100;
    /** @type {{btnId:number, itemId:number}[]} */
    const buttons = [];
    slice.forEach((cat, ci) => {
      const y = 40 + ci * 56;
      texts.push(cat.name);
      parts.push(`{ text 18 ${y + 4} 32 ${texts.length - 1} }`);
      cat.ids.forEach((id, i) => {
        const x = 110 + i * 50;
        parts.push(`{ tilepic ${x} ${y} ${id} }`);
        parts.push(`{ button ${x + 14} ${y + 38} 0x0FA5 0x0FA7 1 0 ${buttonId} }`);
        buttons.push({ btnId: buttonId, itemId: id });
        buttonId++;
      });
    });
    if (pageIdx > 0) {
      parts.push(`{ button 18 ${H - 28} 4014 4015 1 0 2000 }`);
      texts.push('< Prev');
      parts.push(`{ text 46 ${H - 26} 1153 ${texts.length - 1} }`);
    }
    if (pageIdx < totalPages - 1) {
      parts.push(`{ button ${W - 80} ${H - 28} 4005 4006 1 0 2001 }`);
      texts.push('Next >');
      parts.push(`{ text ${W - 52} ${H - 26} 1153 ${texts.length - 1} }`);
    }
    parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);  // close
    api.gumps.send(ctx.state, {
      definitionId: 'server:commands-admin-build:render-build-menu',
      x: 80, y: 60,
      layout: parts.join(''),
      texts,
    }, (resp) => {
      const b = resp.buttonId;
      if (b === 0) return;
      if (b === 2000) { renderBuildMenu(ctx, pageIdx - 1); return; }
      if (b === 2001) { renderBuildMenu(ctx, pageIdx + 1); return; }
      const pick = buttons.find((x) => x.btnId === b);
      if (pick) {
        armBuildCursor(ctx.state, pick.itemId, 0);
      }
    });
  }

  return () => {
    api.commands.unregister?.('build');
    api.commands.unregister?.('buildmenu');
  };
}
