// FAZA DU — `[mark` and `[recall` rune system.
//
// ServUO `Spells/Magery/Sixth/Mark.cs` writes a destination into a
// blank rune item; `Spells/Magery/Fourth/Recall.cs` reads the rune
// and teleports the caster. We expose the rune as an item with a
// `runeDest` payload and ship two text commands that wire the same
// flow without forcing the player into the spell book.
//
// Mark: needs an Empty Rune (item id 0x1F14) in pack. Recall: needs
// a Marked Rune in pack and uses the player's adjacent target ring.

import { normalizeSkillValue } from '../../_rules.js';
import {
  findBlankRune,
  findMarkedRune,
  markRune,
  teleportToRune,
  checkRecallCast,
} from '../../spells/rune-helpers.js';

const SKILL_MAGERY = 26;
const RECALL_MIN_SKILL = 20;      // lightweight command shortcut; spell casting keeps stricter gates

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  api.commands.register({
    name: 'mark',
    help: '[mark — engrave a blank rune in your pack with your current location.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const skill = normalizeSkillValue(
        sender.skills?.[SKILL_MAGERY] ?? sender.skills?.[String(SKILL_MAGERY)] ?? 0,
      );
      if (skill < 60) {
        ctx.state.sendSystemMessage('Mark requires Magery 60+.');
        return;
      }
      const refuse = checkRecallCast(api, sender, ctx.state);
      if (refuse) {
        ctx.state.sendSystemMessage(refuse);
        return;
      }
      const blank = findBlankRune(api, sender);
      if (!blank) {
        ctx.state.sendSystemMessage('You need a blank recall rune.');
        return;
      }
      if (api.houses?.findHouseAt) {
        const house = api.houses.findHouseAt(sender.x, sender.y, sender.map);
        if (house && house.ownerSerial !== sender.serial && !house.coOwners?.includes?.(sender.serial)) {
          ctx.state.sendSystemMessage('You can not mark a rune here.');
          return;
        }
      }
      markRune(blank, sender);
      ctx.state.sendSystemMessage(`Rune marked: ${blank.runeDest.label}.`);
    },
  });

  api.commands.register({
    name: 'recall',
    help: '[recall — recall to the first marked rune in your pack.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const skill = normalizeSkillValue(
        sender.skills?.[SKILL_MAGERY] ?? sender.skills?.[String(SKILL_MAGERY)] ?? 0,
      );
      if (skill < RECALL_MIN_SKILL) {
        ctx.state.sendSystemMessage('Recall requires Magery 20+.');
        return;
      }
      const refuse = checkRecallCast(api, sender, ctx.state);
      if (refuse) {
        ctx.state.sendSystemMessage(refuse);
        return;
      }
      const rune = findMarkedRune(api, sender);
      if (!rune) {
        ctx.state.sendSystemMessage('You have no marked recall rune.');
        return;
      }
      const dest = rune.runeDest;
      // Sanity check distance — runes shouldn't ferry between maps
      // beyond the supported map ids.
      if (typeof dest.map !== 'number') {
        ctx.state.sendSystemMessage('The rune crumbles in your hand.');
        return;
      }
      const ok = teleportToRune(api, sender, dest);
      if (!ok) ctx.state.sendSystemMessage('The rune fizzles.');
      else ctx.state.sendSystemMessage(`Recall: ${dest.label ?? 'destination'}.`);
    },
  });

  return () => {
    api.commands.unregister('mark');
    api.commands.unregister('recall');
  };
}
