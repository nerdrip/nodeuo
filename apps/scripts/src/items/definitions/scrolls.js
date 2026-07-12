// Spell scrolls — auto-generated catalog from the spell registry.
// Mirrors ServUO `Scripts/Items/Skill Items/Magical/Scrolls/`. Each
// scroll is a stackable consumable that, when double-clicked, casts the
// associated spell with no mana cost (the scroll itself is the cost).
//
// Art-id ranges (canonical UO):
//   Magery     0x1F2D + (id-1)         id 1..64   (Clumsy = 1)
//   Necromancy 0x2260 + (id-101)       id 101..117
//   Chivalry   doesn't have scrolls in OSI; included as a stub for
//              parity with ServUO `ChivalryScroll` (drops only from
//              specific encounters; we use art 0x2D9E onward).
//   Mysticism  0x2D9E + (id-678)       id 678..693
//   Bushido / Ninjitsu / Spellweaving — no scroll variants in OSI.
//
// Cast semantics: scroll cast skips the mana check (delegated to
// `castSpell` via `noManaCost` flag). The reagent gate also skips
// (scrolls bypass reagents). LOS / skill / target rules still apply.

import { normalizeSkillValue } from '../../_rules.js';

// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];
let _spells = null;


const MAGERY_BASE   = 0x1F2D;
const NECRO_BASE    = 0x2260;
const MYSTIC_BASE   = 0x2D9E;

function scrollEffect(user, scope) {
  const def = scope?.def;
  if (!def?.spellId) return;
  const spell = _spells?.getSpell?.(def.spellId);
  if (!spell) return;
  const world = scope?.world ?? user?.client?.ctx?.world;
  if (!world) return;
  // Default target = self for non-targeted / can't-resolve cases. The
  // dispatcher checks LOS/range and bails with sendSystemMessage if the
  // caster doesn't have skill — that's the right user-facing feedback
  // for "you fail to invoke the scroll." We pre-validate skill here so
  // we can refund (skip consume) when the caster doesn't qualify.
  const rawSkill = user.skills?.[spell.skillId] ?? user.skills?.[String(spell.skillId)] ?? 0;
  const skill = normalizeSkillValue(rawSkill);
  // ServUO `SpellScroll.cs::Cast` uses `RequiredSkillScroll = minSkill - 200`
  // (translated here to -20 skill points). A 5th-circle scroll
  // requires 45 instead of 65 skill — the whole point of scrolls is
  // letting low-magery characters cast above their level. Without
  // this discount scrolls were identical to memorised spells and
  // entirely pointless.
  const required = Math.max(0, (spell.minSkill | 0) - 20);
  if (skill < required) {
    user.client?.sendSystemMessage?.('You do not have the skills to use this scroll.');
    if (scope?.item) scope.item._noConsume = true;
    return;
  }
  try {
    _spells.castSpell({
      caster: user,
      spellId: def.spellId,
      world,
      target: user, // self-target fallback. Offensive spells without a
                    // proper target will fizzle harmlessly — the price
                    // of the no-cursor convenience.
      // Scroll cast bypasses mana + reagents (scroll itself is the
      // cost). The dispatcher reads ctx.scroll = true and skips both.
      scroll: true,
      // Tell the dispatcher to short-circuit the cast bar — scrolls
      // are instant in OSI (Spell.OnScrollCast in ServUO).
      instant: true,
    });
  } catch (e) {
    console.error(`[scroll] cast ${def.name} failed:`, e);
  }
}

function registerScroll(id, name, spellId, school) {
  __PENDING__.push({
    kind: 'consumable',
    category: 'scroll',
    school,
    id,
    name,
    spellId,
    stackable: true,
    weight: 1,
    effect: scrollEffect,
  });
}

// ---- Auto-generate from the spell registry ---------------------------
// Wait until the spell registry has been populated. The spell index file
// imports each school for side effects, so by the time this module is
// imported (after `content/items/index.js` triggers the chain), every
// canonical spell is in the registry.
let _registered = false;
function generateAll(spells) {
  if (_registered) return;
  _registered = true;
  for (const sp of spells.allSpells()) {
    if (sp.school === 'magery' && sp.id >= 1 && sp.id <= 64) {
      registerScroll(MAGERY_BASE + (sp.id - 1), `Scroll of ${sp.name}`, sp.id, 'magery');
    } else if (sp.school === 'necromancy' && sp.id >= 101 && sp.id <= 117) {
      registerScroll(NECRO_BASE + (sp.id - 101), `Necromancy Scroll: ${sp.name}`, sp.id, 'necromancy');
    } else if (sp.school === 'mysticism' && sp.id >= 678 && sp.id <= 693) {
      registerScroll(MYSTIC_BASE + (sp.id - 678), `Mysticism Scroll: ${sp.name}`, sp.id, 'mysticism');
    }
    // Chivalry / Bushido / Ninjitsu / Spellweaving: no spell-scroll variants
    // in canonical UO. Scrolls of Transcendence are registered by the
    // functional decorative-addons catalogue as `scroll-of-transcendence`.
  }
}

// Blank scroll — used by Inscription crafting. Stackable; no effect on
// double-click (skill book is required to write).
__PENDING__.push({
  kind: 'reagent',
  category: 'blank-scroll',
  id: 0x0E34,
  name: 'Blank Scroll',
  stackable: true,
  weight: 1,
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  _spells = api.systems?.spells;
  if (!_spells?.allSpells || !_spells?.castSpell || !_spells?.getSpell) {
    api.log?.('scrolls: spells system missing, skipping');
    return () => { _spells = null; };
  }
  generateAll(_spells);
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('scrolls: registerItem missing, skipping'); return () => { _spells = null; }; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('scrolls: ' + e.message); } }
  api.log?.('scrolls: registered ' + count + ' items');
  return () => { _spells = null; };
}
