import { itemBySerial } from '../../_entities.js';
// `[engrave` — Spellbook / weapon engraving. ServUO
// `Engines/Engraving/`. Target an item in your pack and supply a
// name (max 32 chars). Stamps `item._engravedName` which the property
// list (OPL) renders as a second tooltip line.
//
// Lightweight v1: no engraving-deed item — admin-style direct stamp.
// Reusable on the same item (overwrite). Per ServUO, only certain
// item classes can be engraved (spellbooks, weapons) — we gate by
// item flags so a random sandwich can't be branded "Excalibur".

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'engrave',
    help: '[engrave <name> — engrave a spellbook / weapon in your pack with the given name.',
    access: 'Player',
    run(ctx) {
      const text = String(ctx.args ?? '').trim().slice(0, 32);
      if (!text) {
        ctx.state.sendSystemMessage('Usage: [engrave <name>');
        return;
      }
      ctx.state.sendSystemMessage('Target the item to engrave.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('Not an item.'); return; }
        if (item.parent !== ctx.sender.serial && item.parent !== itemBySerial(api, ctx.sender._packSerial)?.serial) {
          ctx.state.sendSystemMessage('Engrave only items you carry.');
          return;
        }
        // Allow engraving on: spellbook, weapon (has `weapon`), shield,
        // armor, talisman. Skip: gold, regs, food.
        if (!(item.spellbook || item.weapon || item.shield || item.armor || item.talisman)) {
          ctx.state.sendSystemMessage('You cannot engrave that.');
          return;
        }
        item._engravedName = text;
        // Server parity #13 #6 — track who engraved. Crafter engraving
        // their own work surfaces a different OPL line than a buyer.
        item._engravedBy = ctx.sender.serial >>> 0;
        ctx.state.sendSystemMessage(`Engraved "${text}".`);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('engrave');
}
