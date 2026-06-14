// Runebook — 16-slot recall-rune container. ServUO
// `Items/Resource/Runebook.cs`. Holds up to 16 marked runes plus a
// `defaultIndex` field for the recall macro hotkey. Use opens an
// inline list; choosing a slot recalls (or gates) to that rune's
// destination via the rune-helpers module shared with the spells.

import { teleportToRune, spawnGatePair } from '../../../spells/rune-helpers.js';
import { findInPack } from '../../../_inventory.js';
import { destroyItemBySerial } from '../../../_items.js';

const MAX_SLOTS = 16;

export default function buildRunebookScript(api) {
  return {
    name: 'runebook',
    onCreate(world, item) {
      if (!item.runes) item.runes = [];
      if (item.charges == null) item.charges = 5;
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      const lines = [`Runebook (${item.runes?.length ?? 0}/${MAX_SLOTS} runes, ${item.charges ?? 0} charges)`];
      const runes = item.runes ?? [];
      if (runes.length === 0) lines.push('  (empty — drop a marked rune onto this book)');
      else for (let i = 0; i < runes.length; i++) {
        lines.push(`  ${i + 1}. ${runes[i].label ?? '(unnamed)'}`);
      }
      lines.push('To recall: [book recall <slot>   |   to gate: [book gate <slot>');
      for (const l of lines) user.client.sendSystemMessage(l);
      return true;
    },
    // ServUO drops a marked rune ONTO the book to add it. Hook
    // onDrop — when an item with a runeDest is dropped onto the
    // book, transfer the destination into a free slot and destroy
    // the rune item itself.
    onDrop(world, book, dropped, dropper) {
      if (!dropped?.runeDest) return false;
      if ((book.runes?.length ?? 0) >= MAX_SLOTS) {
        dropper?.client?.sendSystemMessage?.('The runebook is full.');
        return false;
      }
      book.runes = book.runes ?? [];
      book.runes.push({ ...dropped.runeDest });
      destroyItemBySerial(api, dropped.serial);
      dropper?.client?.sendSystemMessage?.(`Added ${dropped.runeDest.label ?? 'rune'} to the runebook.`);
      return true;
    },
  };
}

/** Register the `[book` text command for slot-based recall/gate. */
export function registerBookCommand(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'book',
    help: '[book recall <slot>  |  [book gate <slot> — travel via a runebook in your pack.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const args = ctx.args ?? [];
      const mode = (args[0] ?? '').toLowerCase();
      const slot = (args[1] | 0) - 1;
      if (mode !== 'recall' && mode !== 'gate') {
        ctx.state.sendSystemMessage('Usage: [book recall <slot>   or   [book gate <slot>');
        return;
      }
      const book = findInPack(api, sender, (it) => it.template === 'runebook' || it.script === 'runebook');
      if (!book) { ctx.state.sendSystemMessage('You have no runebook in your pack.'); return; }
      const dest = book.runes?.[slot];
      if (!dest) { ctx.state.sendSystemMessage(`No rune in slot ${slot + 1}.`); return; }
      if ((book.charges | 0) <= 0) {
        ctx.state.sendSystemMessage('The runebook has no charges left.');
        return;
      }
      if ((sender._inCombatUntil ?? 0) > Date.now()) {
        ctx.state.sendSystemMessage('You cannot travel while in combat.');
        return;
      }
      book.charges -= 1;
      if (mode === 'recall') {
        const ok = teleportToRune(api, sender, dest);
        if (!ok) ctx.state.sendSystemMessage('That destination cannot be reached.');
        else ctx.state.sendSystemMessage(`Recall: ${dest.label ?? '?'}`);
      } else {
        const ok = spawnGatePair(api, sender, dest);
        if (!ok) ctx.state.sendSystemMessage('The gate fails to open.');
        else ctx.state.sendSystemMessage(`A gate opens to ${dest.label ?? '?'}`);
      }
    },
  });
  return () => api.commands.unregister('book');
}
