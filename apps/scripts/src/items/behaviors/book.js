// [book — spawn a sample writable book at the player's feet.
//
// The book's content is held server-side in the books registry. Double-click
// it to open; edits from the client update the pages in place.

import { sendToClientsNear } from '../../_spatial.js';
import { createItem } from '../../_items.js';

export default function (api) {
  const { commands, world, books, protocol } = api;
  if (!books) return;

  commands.register({
    name: 'book',
    help: 'Spawn a readable/writable book.',
    run: (ctx) => {
      const state = ctx.state;
      if (!state?.mobile) return;
      const item = createItem(api, world, {
        itemId: 0x0FF2, // brown bound book graphic
        hue: 0, amount: 1,
        x: state.mobile.x, y: state.mobile.y, z: state.mobile.z,
        map: state.mobile.map, name: 'a book',
      });
      books.register(item.serial, {
        title: 'A Humble Treatise',
        author: state.mobile.name ?? 'Anonymous',
        writable: true,
        pages: [
          ['In the beginning,', 'there was a shard,', 'and it was silent.'],
          ['Then came the first', 'player, and with them,', 'the first bug report.'],
          ['', '', '', '', '', '', '', 'The End.'],
        ],
      });
      // Broadcast to nearby clients so the book appears on the ground.
      sendToClientsNear(api, item, protocol.worldItemSA({
        serial: item.serial, itemId: item.itemId, amount: item.amount,
        x: item.x, y: item.y, z: item.z, direction: 0,
        hue: item.hue, flags: 0,
      }));
    },
  });

  return () => commands.unregister('book');
}
