import { broadcastSound } from '../../_helpers.js';
import { markRune, checkRecallCast, isItemInPack } from '../../rune-helpers.js';
import { itemBySerial } from '../../../_entities.js';

const RUNE_BLANK_ID  = 0x1F14;
const RUNE_MARKED_ID = 0x1F14;

export default {
  name: 'mark',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    // Audit #40 P1 #6 — ServUO `Mark.cs:30-44` opens a target cursor
    // and requires the player to pick a specific rune in their pack.
    // Was: auto-marked the first blank rune (player could not choose
    // which one); also skipped CheckTravel / CheckMulti, so Mark
    // inside a foreign house overwrote a rune with house coords.
    const refuse = checkRecallCast(api, caster, ctx.state);
    if (refuse) { ctx.state.sendSystemMessage(refuse); return; }
    if (!picked?.serial) { ctx.state.sendSystemMessage('Target a recall rune in your pack.'); return; }
    const rune = itemBySerial(api, picked.serial >>> 0);
    if (!rune || !isItemInPack(api, rune, caster)) {
      ctx.state.sendSystemMessage('That rune must be in your pack.');
      return;
    }
    if (rune.itemId !== RUNE_BLANK_ID && rune.itemId !== RUNE_MARKED_ID) {
      ctx.state.sendSystemMessage('That is not a rune.');
      return;
    }
    if (api.houses?.findHouseAt) {
      const house = api.houses.findHouseAt(caster.x, caster.y, caster.map);
      if (house && house.ownerSerial !== caster.serial && !house.coOwners?.includes?.(caster.serial)) {
        ctx.state.sendSystemMessage('You can not mark a rune here.');
        return;
      }
    }
    api.combat.animate(api.world, caster, 0x10);
    broadcastSound(api, api.world, caster, 0x1FA);
    markRune(rune, caster);
    ctx.state.sendSystemMessage(`Rune marked: ${rune.runeDest.label}.`);
  },
};
