import { itemBySerial, mobileBySerial } from '../_entities.js';
// Default tooltip provider. Returns the item/mobile name as a single
// cliloc entry (1042971 = "~1_NOTHING~", used as a free-form arg
// passthrough in CUO).
//
// Wave 10 follow-up: percent-aware formatting. UO/AOS attributes split
// cleanly into "percent" and "flat" categories. Below we encode the
// most common ones; anything not listed defaults to flat (no '%').

// Substrings that match a percent-typed attribute name.
const PERCENT_ATTR_PATTERNS = [
  'Chance', 'Damage', 'Cast', 'Reagent', 'Mana', 'Defense',
  'Reflect', 'Increase', 'Reduction', 'Lower', 'Eater', 'Resonance',
  'Soul', 'Hit', 'Resist', 'Absorption',
];
// Explicitly NOT percent (overrides PERCENT_ATTR_PATTERNS substring hit).
const FLAT_ATTR_NAMES = new Set([
  'BonusStr', 'BonusDex', 'BonusInt', 'BonusHits', 'BonusStam', 'BonusMana',
  'RegenHits', 'RegenStam', 'RegenMana',
  'NightSight', 'WeaponSpeed', 'WeaponDamage', 'AttackChance',
  'CastSpeed', 'CastRecovery', 'Luck',
  // 'BonusHitsRegen' etc. — fold into RegenHits via prefix match below.
]);

function isPercentAttribute(name) {
  if (!name) return false;
  if (FLAT_ATTR_NAMES.has(name)) return false;
  for (const sub of PERCENT_ATTR_PATTERNS) {
    if (name.includes(sub)) return true;
  }
  return false;
}

function formatIntensity(p) {
  const n = p?.intensity ?? 0;
  // Boolean-flag (binary) attribs render as the bare attribute name —
  // "Battle Lust", "Bone Breaker" — without a number.
  if (p?.isFlag) return '';
  const sign = n >= 0 ? '+' : '';
  if (isPercentAttribute(p?.attribute)) return `${sign}${n}%`;
  return `${sign}${n}`;
}
//
// Wave 8: when an item carries `_magicProps[]` (rolled by loot.js or
// stamped from an artifact profile), we append one entry per affix.
// The cliloc id stored on each property comes from the ServUO
// ItemPropertyInfo table — the client already knows how to render
// "~1_val~" placeholders, so we pass `args = String(intensity)`.
//
// `_artifact` (string name) emits a leading "[Artifact]" tag plus the
// artifact's English name. Resists go through the same name-only path
// — UO's resists already render as separate clilocs but our hueless
// fallback uses 1061686-class lines.

export default function (api) {
  const { properties, world, ctx } = api;
  if (!properties || !ctx) return;

  properties.setProvider(ctx, (serial /* , state */) => {
    const it = itemBySerial({ world }, serial);
    if (it) {
      const name = it.name ?? `item${it.itemId}`;
      const amountPrefix = (it.amount ?? 1) > 1 ? `${it.amount} ` : '';
      /** @type {Array<{cliloc:number, args?:string}>} */
      const entries = [{ cliloc: 1042971, args: `${amountPrefix}${name}` }];

      if (it._artifact) {
        entries.push({ cliloc: 1042971, args: `[${it._artifact}]` });
        // 1063341 = "Artifact" — pass empty args so the localised label
        // renders without prefix concatenation.
        entries.push({ cliloc: 1063341, args: '' });
      }

      // Wave 12: unidentified magic items hide their props until
      // ItemIdentification (skill 4) succeeds. The teaser line lets
      // the player know there's something to find.
      if (it._unidentified && Array.isArray(it._magicProps) && it._magicProps.length > 0) {
        entries.push({ cliloc: 1042971, args: '(Unidentified)' });
        return { entries };
      }

      const props = it._magicProps;
      if (Array.isArray(props)) {
        for (const p of props) {
          // Skill bonuses: cliloc 1060451-class isn't in the extracted
          // table, so we emit a free-form line like "+5.0 Animal Lore".
          if (p.kind === 'skill') {
            entries.push({
              cliloc: 1042971,
              args: `+${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}`,
            });
            continue;
          }
          // Wave 10: percent-aware intensity formatting.
          // Boolean-flag attribs (BattleLust, BoneBreaker) render as
          // the bare attribute name with no number; the cliloc itself
          // already names them. Percent attribs append '%'.
          const intensityArg = formatIntensity(p);
          // Attribute / weapon / armor with proper cliloc.
          if (p.cliloc) {
            entries.push({
              cliloc: p.cliloc | 0,
              args: intensityArg,
            });
            continue;
          }
          // Fallback: stamp a free-form line so the player still sees
          // SOMETHING. Uses 1042971 with "+N% Attribute" formatting.
          if (p.attribute !== undefined) {
            const labelArg = intensityArg
              ? `${intensityArg} ${p.attribute}`
              : p.attribute;
            entries.push({ cliloc: 1042971, args: labelArg });
          }
        }
      }

      const resists = it._magicResists;
      if (resists && typeof resists === 'object') {
        // Compact: "Resists 12/8/5/0/3" (phys/fire/cold/poison/energy).
        const order = ['physical', 'fire', 'cold', 'poison', 'energy'];
        const parts = order.map((k) => String(resists[k] ?? 0));
        entries.push({ cliloc: 1042971, args: `Resists ${parts.join('/')}` });
      }

      // Wave 29: lock badge — emit a small "(Locked)" line so the
      // player sees the item is GM-protected against imbue/disenchant.
      // Only emitted when the lock flag is set; the audit fields
      // (`_imbueLockedBy`, `_imbueLockedAt`) stay server-side.
      if (it._imbueLocked) {
        entries.push({ cliloc: 1042971, args: '(Locked)' });
      }

      // Wave 21: imbue budget readout. Show how much weight the
      // current properties consume vs the per-item budget so players
      // know how much room they have for further imbues. Only
      // emitted on items that already have magic props (clean items
      // don't need the noise) OR carry an explicit `_imbueBudget`
      // override (boss drops with custom caps).
      if (Array.isArray(it._magicProps) && it._magicProps.length > 0) {
        const allMagic = api.systems?.loot?.allMagicProperties?.()
                      ?? api.loot?.allMagicProperties?.()
                      ?? [];
        let used = 0;
        for (const p of it._magicProps) {
          if (p.kind !== 'attr') continue;
          const def = allMagic.find((a) => a.attribute === p.attribute);
          if (!def) continue;
          const scale = def.scale ?? 1;
          used += Math.max(1, Math.round((p.intensity ?? 0) * (scale || 1)));
        }
        const cap = Number.isFinite(it._imbueBudget) ? it._imbueBudget : 500;
        entries.push({ cliloc: 1042971, args: `Imbue Weight: ${used} / ${cap}` });
      }

      // Wave 15: showcase display case — when the case carries
      // `display:{itemSerial}`, append the pinned item's full entry
      // list so the tooltip reveals what's behind the glass without
      // requiring the player to single-click the smaller pinned item.
      if (it.display?.itemSerial) {
        const pinned = itemBySerial({ world }, it.display.itemSerial);
        if (pinned) {
          entries.push({ cliloc: 1042971, args: '— displaying —' });
          if (pinned._artifact) {
            entries.push({ cliloc: 1042971, args: `[${pinned._artifact}]` });
            entries.push({ cliloc: 1063341, args: '' });
          } else {
            entries.push({ cliloc: 1042971, args: pinned.name ?? `item${pinned.itemId}` });
          }
          if (Array.isArray(pinned._magicProps)) {
            for (const p of pinned._magicProps) {
              if (p.kind === 'skill') {
                entries.push({ cliloc: 1042971, args: `+${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}` });
                continue;
              }
              const intensityArg = formatIntensity(p);
              if (p.cliloc) {
                entries.push({ cliloc: p.cliloc | 0, args: intensityArg });
              } else if (p.attribute !== undefined) {
                const labelArg = intensityArg ? `${intensityArg} ${p.attribute}` : p.attribute;
                entries.push({ cliloc: 1042971, args: labelArg });
              }
            }
          }
          if (pinned._magicResists && typeof pinned._magicResists === 'object') {
            const order = ['physical','fire','cold','poison','energy'];
            const parts = order.map((k) => String(pinned._magicResists[k] ?? 0));
            entries.push({ cliloc: 1042971, args: `Resists ${parts.join('/')}` });
          }
        }
      }

      return { entries };
    }
    const mob = mobileBySerial({ world }, serial);
    if (mob) {
      // Wave 14: render vendor honorific when present ("Gareth, the
      // Master Smith"). The title is set/cleared by vendor.js
      // refreshVendorTitle and persists across restarts.
      const name = mob.name ?? 'a creature';
      const label = mob.title ? `${name}, ${mob.title}` : name;
      return { entries: [{ cliloc: 1042971, args: label }] };
    }
    return null;
  });

  return () => { ctx.propertyProvider = null; };
}
