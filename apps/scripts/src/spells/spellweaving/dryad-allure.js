import { aura, broadcastEffect, broadcastSound, skillValue } from '../_helpers.js';
import { destroyItemBySerial } from '../../_items.js';
import { childrenOf } from '../../_inventory.js';

// Audit #37 P1 #3 — Dryad Allure full gate set. ServUO
// `DryadAllure.cs:39-50, 67-122`:
//   (a) target must be Repond-group humanoid (ogre/troll/orc/lizardman/
//       ratman/satyr/centaur/cyclops/titan/etc.)
//   (b) chance = (skill/150) + (focusLevel/50)
//   (c) Caster.Followers + 3 ≤ FollowersMax
//   (d) on failure target enrages and attacks caster
//   (e) on success target's pack is wiped, ControlSlots = 3
// Was: charmed any NPC unconditionally, no roll, no cap.
const REPOND_KINDS = new Set([
  'ogre', 'troll', 'orc', 'orc-warrior', 'orc-captain', 'orc-mage',
  'lizardman', 'ratman', 'ratman-warrior', 'satyr', 'centaur',
  'cyclops', 'titan', 'minotaur', 'frost-troll',
]);
const DRYAD_ALLURE_SLOTS = 3;

export default {
  name: 'dryad-allure', school: 'spellweaving', circle: 4, mana: 40,
  cast(api, ctx, target) {
    if (!target?.serial) return ctx.state.sendSystemMessage('Cannot charm that.');
    if (target.client)   return ctx.state.sendSystemMessage('You cannot charm a player.');
    const caster = ctx.sender;
    const kind = String(target.kind ?? '').toLowerCase();
    if (!REPOND_KINDS.has(kind)) {
      ctx.state.sendSystemMessage('That creature cannot be allured.');
      return;
    }
    // FollowersMax cap — same shape as summon helpers (#31).
    const followersMax = caster.followersMax ?? 5;
    if (((caster.followers | 0) + DRYAD_ALLURE_SLOTS) > followersMax) {
      ctx.state.sendSystemMessage('You have too many followers to allure that creature.');
      return;
    }
    // Chance roll: skill/150 + focusLevel/50.
    const skill = skillValue(caster, 55);
    const focus = (caster._arcaneFocusLevel | 0) || (caster._arcaneFocus | 0);
    const chance = (skill / 150) + (focus / 50);
    if (Math.random() >= chance) {
      // Enrage on failure — target attacks the caster.
      ctx.state.sendSystemMessage('The creature resists your allure and turns on you!');
      target._provokedTarget = caster.serial >>> 0;
      target._provokedUntil  = Date.now() + 30_000;
      target.combatant = caster.serial >>> 0;
      broadcastSound(api, api.world, target, 0x5C2);
      return;
    }
    // Success — wipe target's pack (drop everything to ground).
    for (const it of childrenOf(api, target)) {
      if (!it || it.layer !== 21) continue;        // backpack only
      for (const sub of [...childrenOf(api, it)]) {
        try { destroyItemBySerial(api, sub.serial); }
        catch { /* already gone */ }
      }
    }
    target.controlMaster = caster.serial >>> 0;
    target.notoriety = 1;
    target._followerCost = DRYAD_ALLURE_SLOTS;
    caster.followers = (caster.followers | 0) + DRYAD_ALLURE_SLOTS;
    api.ai?.attach?.(target, 'pet', { command: 'follow', targetSerial: 0 });
    broadcastEffect(api, api.world, target, aura(api, target, { itemId: 0x373A, hue: 0x47 }));
    broadcastSound(api, api.world, target, 0x5C2);
    ctx.state.sendSystemMessage(`${target.name ?? 'The creature'} is enthralled.`);
  },
};
