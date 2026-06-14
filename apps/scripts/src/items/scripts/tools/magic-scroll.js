// Magic scroll — single-use cast of the spell encoded in `item.spellId`
// or legacy `item.spellSlug`. Re-uses the spell pipeline where possible
// so scroll casts bypass mana/reagents but keep LOS and skill checks.
//
// A scroll without a spellSlug crumbles to flavour text.

import { consumeOne } from '../_shared/consume.js';

export default function buildMagicScrollScript(api) {
  return {
    name: 'magic-scroll',
    onUse(world, item, user) {
      const spellId = item.spellId | 0;
      const slug = item.spellSlug;
      if (spellId && api.systems?.spells?.castSpell) {
        try {
          api.systems.spells.castSpell({
            caster: user,
            spellId,
            world,
            target: user,
            scroll: true,
            instant: true,
          });
          consumeOne(api, world, item, user);
          return true;
        } catch (e) {
          user?.client?.sendSystemMessage?.('The scroll fizzles.');
          console.error(`[magic-scroll] spell ${spellId} failed:`, e);
          return true;
        }
      }
      if (!slug) {
        user?.client?.sendSystemMessage?.('The scroll crumbles to dust.');
        return true;
      }
      user?.client?.send?.(api.protocol.unicodeMessage?.({ text: `[cast ${slug}` }));
      consumeOne(api, world, item, user);
      return true;
    },
  };
}
