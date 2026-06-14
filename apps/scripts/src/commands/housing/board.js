import { allItems } from '../../_spatial.js';
import { createItem } from '../../_items.js';
// `[board` — Bulletin Board admin/player command.
//
//   [board place           — (GM) place a new board at caller's tile
//   [board post <body>     — post a message on the nearest board (≤4 tiles)
//   [board list            — list posts on the nearest board
//   [board seed            — (GM) reset + seed default community posts on
//                            every existing board
//
// Boards live as items with kind='bulletin'. The 0x71 packet pipeline
// (parsing in handlers.js, builders in systems/bulletin-board.js) does
// the real work; this command exists so players can interact without
// the legacy CUO bulletin gump being wired.

const NEAREST_RANGE = 4;

function findNearestBoard(api, mob) {
  let best = null, bestD = Infinity;
  for (const it of allItems(api)) {
    if (it.kind !== 'bulletin' && !it._bulletinBoard) continue;
    if (it.map !== mob.map) continue;
    const dx = it.x - mob.x, dy = it.y - mob.y;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    if (d < bestD) { bestD = d; best = it; }
  }
  return bestD <= NEAREST_RANGE ? best : null;
}

const SEED_POSTS = [
  { subject: 'Welcome, Adventurer', body: 'These boards are for community news, trade offers, and event coordination. Use [board post <text> to leave a message.' },
  { subject: 'Champion Defeated',   body: 'A champion has fallen near the Tomb of Kings. Power scrolls may have been won — see your local town cryer for confirmation.' },
  { subject: 'Vendor Search',       body: 'Looking for a specific item? Type [vmarket <query> to search every player vendor on the shard with a clickable teleport gump.' },
  { subject: 'Housing Notice',      body: 'Houses decay after 15 days of no owner visits. Friends/co-owners visiting also refresh decay. [housedecay shows ETA on a targeted house.' },
];

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const boards = api.systems?.bulletinBoard;
  if (!boards) {
    api.log?.('board: bulletin board system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'board',
    help: '[board place|post|list|seed — community bulletin board controls.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'place') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin' && access !== 'Seer') {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        const it = createItem(api, api.world, {
          itemId: 0x1E5E,                // wooden bulletin board
          name: 'a bulletin board',
          x: mob.x, y: mob.y, z: mob.z, map: mob.map ?? 1,
          movable: false,
          kind: 'bulletin',
        });
        if (it) {
          it._bulletinBoard = true;
          boards.getBoard(it.serial);            // initialise empty board
          ctx.state.sendSystemMessage?.(`Board placed (serial 0x${it.serial.toString(16)}).`);
        } else {
          ctx.state.sendSystemMessage?.('Board placement failed.');
        }
        return;
      }

      if (sub === 'post') {
        const body = ctx.args.slice(1).join(' ').trim();
        if (!body) { ctx.state.sendSystemMessage?.('Usage: [board post <message>'); return; }
        const board = findNearestBoard(api, mob);
        if (!board) {
          ctx.state.sendSystemMessage?.(`No bulletin board within ${NEAREST_RANGE} tiles.`);
          return;
        }
        const post = boards.createPost(board.serial, {
          subject: body.slice(0, 60),
          body,
          author: mob.name ?? 'anonymous',
        });
        ctx.state.sendSystemMessage?.(`Posted as #${post.serial}.`);
        return;
      }

      if (sub === 'list') {
        const board = findNearestBoard(api, mob);
        if (!board) {
          ctx.state.sendSystemMessage?.(`No bulletin board within ${NEAREST_RANGE} tiles.`);
          return;
        }
        const b = boards.getBoard(board.serial);
        if (b.posts.length === 0) { ctx.state.sendSystemMessage?.('The board is empty.'); return; }
        ctx.state.sendSystemMessage?.(`Board "${board.name}" — ${b.posts.length} posts:`);
        for (const p of b.posts.slice(0, 15)) {
          const ageH = ((Date.now() - p.createdAt) / 3600_000) | 0;
          ctx.state.sendSystemMessage?.(
            `  #${p.serial} (${ageH}h) ${p.author}: ${p.subject}`,
          );
        }
        if (b.posts.length > 15) {
          ctx.state.sendSystemMessage?.(`  …${b.posts.length - 15} more.`);
        }
        return;
      }

      if (sub === 'seed') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        let touched = 0;
        for (const it of allItems(api)) {
          if (it.kind !== 'bulletin' && !it._bulletinBoard) continue;
          boards.deleteBoard(it.serial);
          for (const p of SEED_POSTS) {
            boards.createPost(it.serial, { ...p, author: 'Town Cryer' });
          }
          touched++;
        }
        ctx.state.sendSystemMessage?.(`Re-seeded ${touched} bulletin board(s).`);
        return;
      }

      ctx.state.sendSystemMessage?.('Usage: [board place|post <body>|list|seed');
    },
  });

  return () => api.commands.unregister('board');
}
