// Artifact-tier tools — Forged Metal of Artifacts, Amelia's Toolbox (Multi-Tool).
//
// ServUO `Items/Special/ForgedMetalOfArtifacts.cs` — on use, prompts for
// a magical-property item and re-rolls its property set using the
// runic-reforging engine at the equivalent of a Valorite-tool tier.
// Consumes 1 charge per use.
//
// ServUO `Items/Special/AmeliasToolbox.cs` (Tinker's Toolbox + carpentry
// + fletching + tailoring kit all in one) — on use, opens a menu of
// crafting sub-skills. We expose the same as a routing wrapper that
// triggers `[craft` with the picked discipline preset.

import { findBackpack, isInPack } from '../../../_inventory.js';
import { itemBySerial } from '../../../_entities.js';

export function buildRerollArtifact(api) {
  return {
    name: 'reroll-artifact',
    onUse(world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The Forged Metal has crumbled to dust.');
        return true;
      }
      if (!api.targeting?.request) {
        state.sendSystemMessage?.('Targeting unavailable.');
        return true;
      }
      state.sendSystemMessage?.('Target the magic item to re-forge.');
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) return;
        const target = itemBySerial({ world }, picked.serial >>> 0);
        if (!target) { state.sendSystemMessage?.('Invalid target.'); return; }
        // Must be in the user's backpack (no targeting equipped items
        // or world drops — matches ServUO `IsChildOf(from.Backpack)`).
        const pack = findBackpack(api, user);
        if (!pack || !isInPack(api, target, user)) {
          state.sendSystemMessage?.('That item must be in your pack.');
          return;
        }
        // ServUO refuses to act on items that ALREADY have full mods
        // (5 props for a weapon). We rely on the reforging engine's
        // `already-magical` gate to reject, then strip + retry.
        if (Array.isArray(target._magicProps) && target._magicProps.length > 0) {
          // Strip first so the re-roll runs against a clean slate.
          target._magicProps = [];
          delete target._itemPower;
        }
        const r = api.systems?.runicReforging?.reforge?.(user, target, 'valorite hammer', 'powerful')
          ?? { ok: false, reason: 'reforging unavailable' };
        if (!r.ok) {
          state.sendSystemMessage?.(`The Forged Metal hisses: ${r.reason ?? 'cannot reforge'}.`);
          return;
        }
        item.charges = Math.max(0, (item.charges | 0) - 1);
        state.sendSystemMessage?.(
          `The item glows — ${r.prefix ?? 'reforged'} ${r.power ?? ''}. (${item.charges} charges remaining.)`,
        );
      });
      return true;
    },
  };
}

// ──────────────── Amelia's Toolbox (multi-tool) ────────────────

const TOOLBOX_SKILLS = [
  { name: 'Tinkering',    cmd: 'tinker'   },
  { name: 'Carpentry',    cmd: 'carpentry'},
  { name: 'Fletching',    cmd: 'fletch'   },
  { name: 'Tailoring',    cmd: 'tailor'   },
  { name: 'Blacksmithy',  cmd: 'smith'    },
];

export function buildMultiTool(_api) {
  return {
    name: 'multi-tool',
    onCreate(_world, item) {
      item.charges = item.charges ?? 50;
    },
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state) return true;
      if ((item.charges | 0) <= 0) {
        state.sendSystemMessage?.('The toolbox is empty.');
        return true;
      }
      // ServUO opens a 5-radio gump; we surface the same options as
      // text — `[craft <discipline>` is the canonical entry across the
      // crafting system. Each invocation consumes 1 charge.
      state.sendSystemMessage?.('Amelia\'s Toolbox — pick a craft:');
      for (const s of TOOLBOX_SKILLS) {
        state.sendSystemMessage?.(`  [craft ${s.cmd}  → ${s.name}`);
      }
      state.sendSystemMessage?.(`(Toolbox: ${item.charges} uses remaining.)`);
      // Note: charge decrement happens when the user actually invokes
      // [craft inside the script-side wiring (TBD). For now: the
      // toolbox advertises and the player crafts manually. ServUO uses
      // the same "consume on Craft.OnEndCraft" hook we don't replicate
      // here — keeping the change scope tight.
      return true;
    },
  };
}
