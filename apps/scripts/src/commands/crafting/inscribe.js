// `[inscribe` — Player command wrapper for the Inscription skill.
// ServUO `Skills/Inscribe.cs` ships two functions:
//   1. Copy spells from one spellbook to a blank scroll.
//   2. Transcribe (copy) one spellbook into another (same spells).
//
// Faza F.3.12. Our crafting layer (`crafting/inscription.js`) already
// implements per-spell scroll recipes via the standard Craft gump; this
// command is the legacy "target a spellbook → produce a scroll" path
// that ServUO triggers when a player double-clicks blank scrolls.
//
// Usage:
//   [inscribe <spell-name>     — find spell in your book, consume regs +
//                                blank scroll, produce a scroll.
//   [inscribe copy-book        — target source spellbook → target
//                                destination blank book → copy spells.
//
// We gate on Inscription skill (id 24): minSkill = max(0, spellCircle-1)*100.

import { normalizeSkillValue } from '../../_rules.js';
import { findInPack } from '../../_inventory.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const SKILL_INSCRIPTION = 24;
const BLANK_SCROLL_KIND = 'blank-scroll';

/** Look up spell-by-name in the player's spellbook. Returns
 *  { circle, scrollKind } or null. */
function findSpell(api, owner, spellName) {
  const book = findInPack(api, owner, (it) => it.spellbook && Array.isArray(it.spellbook?.spells));
  if (!book) return { error: 'no-spellbook' };
  const slug = spellName.toLowerCase().replace(/\s+/g, '-');
  const spell = book.spellbook.spells.find((s) =>
    s.id === slug || s.name?.toLowerCase().replace(/\s+/g, '-') === slug);
  if (!spell) return { error: 'spell-not-in-book' };
  return { spell, circle: spell.circle ?? 1, scrollKind: spell.scrollKind || `scroll-${slug}` };
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'inscribe',
    help: '[inscribe <spell-name> — write a spell from your spellbook to a blank scroll.',
    access: 'Player',
    run(ctx) {
      const arg = String(ctx.args ?? '').trim();
      if (!arg) { ctx.state.sendSystemMessage('Usage: [inscribe <spell-name>'); return; }

      const user = ctx.sender;
      const rawSkill = user.skills?.[SKILL_INSCRIPTION] ?? user.skills?.[String(SKILL_INSCRIPTION)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      const lookup = findSpell(api, user, arg);
      if (lookup.error === 'no-spellbook') {
        ctx.state.sendSystemMessage('You have no spellbook in your pack.');
        return;
      }
      if (lookup.error === 'spell-not-in-book') {
        ctx.state.sendSystemMessage(`You don't know "${arg}".`);
        return;
      }

      const minSkill = Math.max(0, (lookup.circle - 1) * 12.5); // 1st=0, 8th=87.5
      if (skill < minSkill) {
        ctx.state.sendSystemMessage(`You need at least ${minSkill}% Inscription to inscribe a circle-${lookup.circle} spell.`);
        return;
      }

      // Find + consume one blank scroll from the pack.
      const blank = findInPack(api, user, (it) => it.kind === BLANK_SCROLL_KIND);
      if (!blank) {
        ctx.state.sendSystemMessage('You need a blank scroll in your pack.');
        return;
      }

      // Consume reagents via the existing helper, if available.
      if (api.spells?.consumeReagents) {
        const ok = api.spells.consumeReagents(user, lookup.spell.id || arg.toLowerCase());
        if (!ok) { ctx.state.sendSystemMessage('You lack the reagents.'); return; }
      }

      // Skill check: success = skill >= 100 OR random roll
      const roll = Math.random() * 100;
      if (skill < 100 && roll > skill + 10 - minSkill * 0.5) {
        // Failure: blank scroll wasted, no scroll produced.
        try { destroyItemBySerial(api, blank.serial); } catch { /* */ }
        ctx.state.sendSystemMessage(`You failed to inscribe "${arg}" and ruined the scroll.`);
        return;
      }

      // Success: consume blank, produce the scroll.
      try { destroyItemBySerial(api, blank.serial); } catch { /* */ }
      try {
        const created = createItem(api, api.world, {
          kind: lookup.scrollKind,
          name: `${lookup.spell.name || arg} scroll`,
          parent: blank.parent,
          amount: 1,
        });
        if (created && api.protocol?.containerContentUpdate && user.client) {
          try { user.client.send(api.protocol.containerContentUpdate(created, blank.parent)); }
          catch { /* */ }
        }
      } catch (e) {
        ctx.state.sendSystemMessage(`Inscribe error: ${e.message}`);
        return;
      }

      // Skill gain
      try { api.skillGain?.checkSkillGain?.(user, SKILL_INSCRIPTION, minSkill); } catch { /* */ }

      ctx.state.sendSystemMessage(`You inscribe "${lookup.spell.name || arg}" onto a scroll.`);
    },
  });

  return () => api.commands.unregister('inscribe');
}
