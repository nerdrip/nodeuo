// Spellbook item — a container whose contents are spell slots rather than
// real items. Double-click fires 0xBF 0x1B (NewSpellbookContent) so the
// classic client renders the spell icons it knows, then opens the book gump
// via the normal container flow.
//
// `[spellbook [all]` admin command spawns one at your feet; with "all" every
// magery spell (1..64) is pre-learned.

import { isInPack } from '../../_inventory.js';
import { allItems, sendToClientsNear } from '../../_spatial.js';
import { createItem } from '../../_items.js';
export default function register(api) {
  const { commands, world, spellbooks, protocol } = api;
  if (!spellbooks) return () => {};

  // Register a template so spellbooks survive save/load like any other item
  // (the spellbook registry itself is populated below at onCreate time).
  if (api.templates) {
    api.templates.registerTemplate({
      name: 'spellbook',
      itemId: 0x0EFA,
      gumpId: 0x00CA,
      label: 'a spellbook',
      movable: true,
      onCreate(w, item) {
        // Default: empty book; content is toggled via [teach.
        spellbooks.register({ serial: item.serial, offset: 1, content: 0n });
      },
    });
  }

  commands.register({
    name: 'spellbook',
    help: '[spellbook [all]  — spawn a spellbook; "all" grants every magery spell',
    run(ctx, args) {
      const state = ctx.state;
      if (!state?.mobile) return;
      const item = createItem(api, world, {
        itemId: 0x0EFA,
        gumpId: 0x00CA,
        hue: 0, amount: 1,
        x: state.mobile.x, y: state.mobile.y, z: state.mobile.z,
        map: state.mobile.map, name: 'a spellbook',
        movable: true,
      });
      const content = args[0]?.toLowerCase() === 'all' ? 0xFFFFFFFFFFFFFFFFn : 0n;
      spellbooks.register({ serial: item.serial, offset: 1, content });
      sendToClientsNear(api, item, protocol.worldItemSA({
        serial: item.serial, itemId: item.itemId, amount: item.amount,
        x: item.x, y: item.y, z: item.z,
        hue: item.hue, flags: 0x20,
      }));
      state.sendSystemMessage(`Spawned a spellbook (serial 0x${item.serial.toString(16)}).`);
    },
  });

  // [teach <spellId>  — learn (or forget with --forget) a single spell on
  // whatever spellbook is open. We resolve "the spellbook" by scanning for
  // the most recently opened container serial that's in the registry.
  commands.register({
    name: 'teach',
    help: '[teach <spellId>  — learn a magery spell (1..64) on your first spellbook',
    run(ctx, args) {
      const id = parseInt(args[0] ?? '', 10);
      if (!Number.isFinite(id) || id < 1 || id > 64) {
        ctx.state.sendSystemMessage('Usage: [teach <1..64>');
        return;
      }
      // Find any spellbook on the ground whose position matches the player.
      let found = null;
      for (const it of allItems({ world })) {
        if (spellbooks.get(it.serial)) {
          if (isInPack(api, it, ctx.sender) || it.parent == null) {
            found = it;
            break;
          }
        }
      }
      if (!found) {
        ctx.state.sendSystemMessage('No spellbook found in your inventory or at your feet.');
        return;
      }
      spellbooks.learn(found.serial, id, true);
      spellbooks.sendContent(ctx.state, found.serial);
      ctx.state.sendSystemMessage(`Learned spell ${id} in 0x${found.serial.toString(16)}.`);
    },
  });

  return () => {
    commands.unregister('spellbook');
    commands.unregister('teach');
    if (api.templates) api.templates.unregisterTemplate('spellbook');
  };
}
