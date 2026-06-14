// `[pages` — GM tooling for the help-queue (port of ServUO PageQueue.cs).
//
// Commands:
//   [pages          — list every unresolved help page
//   [page <id>      — show one page's details
//   [claim <id>     — claim a page (sets claimedBy = caller's name)
//   [resolve <id>   — resolve + drop a page from the queue
//
// Uses the in-memory queue from server/src/help-queue.js. The server
// pushes a page on 0x9B HelpRequest from clients; staff (GM/Admin) call
// these to triage.

export default function register(api) {
  const { commands } = api;
  const helpQueue = api.helpQueue;
  if (!helpQueue) {
    api.log?.('[pages] helpQueue not exposed via api — skipping registration');
    return;
  }

  commands.register({
    name: 'pages',
    help: '[pages — list open help pages (GM).',
    access: 'GM',
    run: (cctx) => {
      const list = helpQueue.listOpen();
      if (list.length === 0) {
        cctx.state.sendSystemMessage('Help queue is empty.');
        return;
      }
      cctx.state.sendSystemMessage(`Open pages: ${list.length}`);
      for (const e of list) {
        const age = Math.floor((Date.now() - e.when) / 1000);
        const claim = e.claimedBy ? ` [claimed by ${e.claimedBy}]` : '';
        const cat = helpQueue.categoryName(e.category);
        cctx.state.sendSystemMessage(
          `  #${e.id} ${e.sender} (${cat}, ${age}s)${claim}: ${e.text.slice(0, 80)}`,
        );
      }
    },
  });

  commands.register({
    name: 'page',
    help: '[page <id> — show one help page in detail (GM).',
    access: 'GM',
    run: (cctx, id) => {
      if (!id) { cctx.state.sendSystemMessage('Usage: [page <id>'); return; }
      const e = helpQueue.get(parseInt(id, 10));
      if (!e) { cctx.state.sendSystemMessage('No such page.'); return; }
      cctx.state.sendSystemMessage(
        `#${e.id} from ${e.sender} (serial 0x${(e.senderSerial >>> 0).toString(16)}) ` +
        `category=${helpQueue.categoryName(e.category)} ` +
        `at=${new Date(e.when).toISOString()}` +
        (e.claimedBy ? ` claimedBy=${e.claimedBy}` : ''),
      );
      cctx.state.sendSystemMessage(`text: ${e.text}`);
    },
  });

  commands.register({
    name: 'claim',
    help: '[claim <id> — mark a page as your responsibility (GM).',
    access: 'GM',
    run: (cctx, id) => {
      if (!id) { cctx.state.sendSystemMessage('Usage: [claim <id>'); return; }
      const claimer = cctx.sender?.name ?? cctx.state.accountName ?? 'GM';
      const e = helpQueue.claim(parseInt(id, 10), claimer);
      if (!e) { cctx.state.sendSystemMessage('No such page (or already resolved).'); return; }
      cctx.state.sendSystemMessage(`Claimed page #${e.id} from ${e.sender}.`);
    },
  });

  commands.register({
    name: 'resolve',
    help: '[resolve <id> — close a help page (GM).',
    access: 'GM',
    run: (cctx, id) => {
      if (!id) { cctx.state.sendSystemMessage('Usage: [resolve <id>'); return; }
      if (helpQueue.resolve(parseInt(id, 10))) {
        cctx.state.sendSystemMessage(`Page #${id} resolved.`);
      } else {
        cctx.state.sendSystemMessage('No such page.');
      }
    },
  });
}
