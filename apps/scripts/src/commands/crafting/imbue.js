// `[imbue <itemSerial> <attribute> <intensity>` — apply a magic
// property to a weapon/armor at the cost of essence + Imbuing skill.
// Inspired by ServUO's `Skills/Imbuing/`. We keep the heavy parts
// (per-property resource cost trees, weapon-vs-armor slot rules,
// recipe-prerequisite items) deliberately out of scope; the goal is
// a working flow players can use to build characters.
//
// Mechanic:
//   - target item must be in pack and either have `_magicProps` (extend)
//     or be a fresh weapon/armor (start a property list)
//   - skill 30+ to attempt; success chance is `(skill - 30) / 80`
//     clamped to [0.10, 0.95]
//   - intensity 1..15 — essence cost per intensity:
//        1..5  → 1× MagicEssence per intensity
//        6..10 → 1× EnchantedEssence per intensity (above 5)
//        11+   → 1× RelicFragment per intensity (above 10)
//   - essence is consumed before the skill check; failure forfeits
//     the materials (matches ServUO's "imbue can fail" behaviour)
//   - duplicate attributes overwrite the previous intensity (raise/lower)
//   - cap: max 5 properties on an item (engine-driven, ServUO uses a
//     budget but flat cap is good enough for our scope)
//
// Attribute name is matched case-insensitively against the magic
// properties table (loaded by loot.js) to make sure the player gets a
// real cliloc-bearing entry. `[imbueattrs` lists candidates.

import { normalizeSkillValue } from '../../_rules.js';
import { findBackpack, isInPack, packItems } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';
import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';

const SKILL_IMBUING = 57;
const COOLDOWN_MS = 4_000;
const COOLDOWN_FAST_MS = 1_000;
const MAX_PROPS = 5;

// Wave 20: per-item weight budget. ServUO's `Imbuing` system gates
// every property roll against a "weight" budget (≈500 for non-medable
// armor, slightly more for weapons + jewelry). We use a flat 500 per
// item; overrides via `entry.imbueBudget` in loot tables for boss
// drops or quest-specific items.
const DEFAULT_IMBUE_BUDGET = 500;

/** Cost in budget units = intensity × scale (server-canonical). */
function budgetCostFor(target, intensity) {
  const scale = target.scale ?? 1;
  return Math.max(1, Math.round((intensity | 0) * (scale || 1)));
}

function getItemBudget(item) {
  if (Number.isFinite(item._imbueBudget)) return item._imbueBudget;
  return DEFAULT_IMBUE_BUDGET;
}

/** Sum the budget already consumed by `_magicProps`. */
function usedBudget(item, allProps) {
  if (!Array.isArray(item._magicProps)) return 0;
  let used = 0;
  for (const p of item._magicProps) {
    if (p.kind !== 'attr') continue;
    const def = allProps?.find?.((a) => a.attribute === p.attribute);
    if (!def) continue;
    used += budgetCostFor(def, p.intensity ?? 0);
  }
  return used;
}

/**
 * Wave 19: skill-scaled imbue cooldown.
 *   skill 30  → 4000 ms (baseline)
 *   skill 100 → 1000 ms (mastered)
 * Linear interpolation in between; <30 reuses baseline (gate already
 * blocks the cast). Returns ms.
 */
function cooldownForSkill(skill) {
  if (skill >= 100) return COOLDOWN_FAST_MS;
  if (skill <= 30)  return COOLDOWN_MS;
  const t = (skill - 30) / 70;     // 0..1
  return Math.round(COOLDOWN_MS - (COOLDOWN_MS - COOLDOWN_FAST_MS) * t);
}

const ESSENCE_TYPES = {
  magic:     { type: 'MagicEssence',     fallback: 0x1F19, hue: 0x47E },
  enchanted: { type: 'EnchantedEssence', fallback: 0x4079, hue: 0x481 },
  relic:     { type: 'RelicFragment',    fallback: 0x1EA7, hue: 0x44E },
};

function effectiveSkill(mob) {
  const raw = mob.skills?.[SKILL_IMBUING] ?? mob.skills?.['57'] ?? 0;
  return normalizeSkillValue(raw);
}

/** Compute essence cost broken into the three tiers. */
function essenceCost(intensity) {
  const i = Math.max(1, Math.min(15, intensity | 0));
  let magic = Math.min(i, 5);
  let enchanted = Math.max(0, Math.min(i, 10) - 5);
  let relic = Math.max(0, i - 10);
  return { magic, enchanted, relic };
}

/**
 * Find essence stacks in the player's pack matching `targetTypeName`
 * via the type-name resolver. Returns array of {itemRef, available}.
 */
function findEssenceStacks(api, mob, targetItemId) {
  const out = [];
  for (const it of packItems(api, mob)) {
    if (it.itemId !== targetItemId) continue;
    out.push({ item: it, available: it.amount | 0 });
  }
  return out;
}

function consumeEssence(api, mob, itemId, count, state) {
  if (count <= 0) return true;
  const pack = findBackpack(api, mob);
  const stacks = findEssenceStacks(api, mob, itemId);
  let need = count;
  for (const { item } of stacks) {
    if (need <= 0) break;
    const take = Math.min(need, item.amount | 0);
    item.amount -= take;
    need -= take;
    if (item.amount <= 0) {
      destroyItemBySerial(api, item.serial);
      state?.send?.(api.protocol?.removeEntity?.(item.serial));
    } else if (api.protocol?.containerContentUpdate) {
      state?.send?.(api.protocol.containerContentUpdate(item, pack?.serial ?? item.parent));
    }
  }
  return need === 0;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};
  const cooldowns = new Map();

  commands.register({
    name: 'imbueattrs',
    help: '[imbueattrs [filter] — list imbuing-eligible attributes (substring filter optional).',
    access: 'Player',
    run(ctx) {
      const props = api.systems?.loot?.allMagicProperties?.()
                 ?? api.loot?.allMagicProperties?.();
      if (!Array.isArray(props)) {
        ctx.state.sendSystemMessage('Magic properties catalog not loaded.');
        return;
      }
      // `[imbueattrs gump` is the client-driven form — emit one
      // IMBUE_ATTR line per attribute so the ImbuingGump can populate
      // its row list. Hard cap at 60 entries to keep the chat stream
      // bounded.
      if (String(ctx.args[0] ?? '').toLowerCase() === 'gump') {
        for (const p of props.slice(0, 60)) {
          ctx.state.sendSystemMessage(`IMBUE_ATTR ${p.attribute} ${p.maxIntensity}`);
        }
        return;
      }
      const filter = ctx.args[0]?.toLowerCase();
      const matches = filter
        ? props.filter((p) => p.attribute.toLowerCase().includes(filter))
        : props.slice(0, 30);
      const lines = [`Imbuing attributes (${matches.length}/${props.length}):`];
      for (const p of matches.slice(0, 30)) {
        lines.push(`  ${p.attribute.padEnd(28)} max=${p.maxIntensity}`);
      }
      if (matches.length > 30) lines.push(`  … ${matches.length - 30} more.`);
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  commands.register({
    name: 'imbue',
    help: '[imbue <serial> <attribute> <intensity> | [imbue undo [N|all] — apply or rollback recent (Imbuing 30+).',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 16: `[imbue undo` rollback. Refunds essence and restores
      // prior property intensity (or removes if the imbue added a new
      // one). 30s window so undo is a true "I made a mistake" recovery
      // not a long-tail save state.
      // Wave 18: `[imbue undo all` rolls back the entire undo queue
      // (up to 5 most-recent imbues), `[imbue undo N` rolls back the
      // newest N. Bare `[imbue undo` keeps the original 1-step path.
      if (String(ctx.args[0] ?? '').toLowerCase() === 'undo') {
        const arg2 = String(ctx.args[1] ?? '').toLowerCase();
        const isAll = arg2 === 'all';
        const numericArg = parseInt(arg2, 10);
        const wantN = isAll
          ? (mob._imbueUndoQueue?.length ?? 0)
          : (Number.isFinite(numericArg) && numericArg > 0 ? numericArg : 1);
        if (wantN > 1) {
          const queue = mob._imbueUndoQueue ?? [];
          if (queue.length === 0) {
            ctx.state.sendSystemMessage('No imbues to undo.');
            return;
          }
          const slice = queue.slice(-Math.min(wantN, queue.length));
          let rolledBack = 0;
          // Roll back newest-first so a property added then bumped
          // unwinds in the right order.
          for (let i = slice.length - 1; i >= 0; i--) {
            const s = slice[i];
            if (Date.now() - s.ts > 30_000) continue;
            const target = itemBySerial({ world }, s.itemSerial);
            if (!target) continue;
            const targetPack = findBackpack(api, mob);
            if (!targetPack || !isInPack(api, target, mob)) continue;
            const list = target._magicProps ?? [];
            const idx = list.findIndex((p) => p.attribute === s.attribute);
            if (idx >= 0) {
              if (s.prevIntensity == null) list.splice(idx, 1);
              else list[idx] = { ...list[idx], intensity: s.prevIntensity, isFlag: s.prevWasFlag };
              target._magicProps = list;
            }
            if (s.wasUnidentified) target._unidentified = true;
            // Refund essence.
            const idMagic     = api.itemTypes?.resolve?.(ESSENCE_TYPES.magic.type)?.itemId     ?? ESSENCE_TYPES.magic.fallback;
            const idEnchanted = api.itemTypes?.resolve?.(ESSENCE_TYPES.enchanted.type)?.itemId ?? ESSENCE_TYPES.enchanted.fallback;
            const idRelic     = api.itemTypes?.resolve?.(ESSENCE_TYPES.relic.type)?.itemId     ?? ESSENCE_TYPES.relic.fallback;
            for (const r of [
              { itemId: idMagic,     hue: ESSENCE_TYPES.magic.hue,     amount: s.cost.magic },
              { itemId: idEnchanted, hue: ESSENCE_TYPES.enchanted.hue, amount: s.cost.enchanted },
              { itemId: idRelic,     hue: ESSENCE_TYPES.relic.hue,     amount: s.cost.relic },
            ]) {
              if (r.amount <= 0) continue;
              api.game?.mobile?.giveItem?.(mob, {
                itemId: r.itemId,
                hue: r.hue,
                amount: r.amount,
              }, { randomGrid: true });
            }
            rolledBack++;
          }
          // Drop the rolled-back tail from the queue.
          mob._imbueUndoQueue = queue.slice(0, queue.length - slice.length);
          if (mob._imbueUndoQueue.length === 0) delete mob._lastImbueSession;
          else mob._lastImbueSession = mob._imbueUndoQueue[mob._imbueUndoQueue.length - 1];
          ctx.state.sendSystemMessage(
            `Undone ${rolledBack} of ${slice.length} imbue${slice.length === 1 ? '' : 's'}.`,
          );
          return;
        }
        // Single-step undo (existing behaviour).
        const sess = mob._lastImbueSession;
        if (!sess) {
          ctx.state.sendSystemMessage('No recent imbue to undo.');
          return;
        }
        if (Date.now() - sess.ts > 30_000) {
          ctx.state.sendSystemMessage('That imbue is too old to undo (30s window).');
          delete mob._lastImbueSession;
          return;
        }
        const target = itemBySerial({ world }, sess.itemSerial);
        if (!target) {
          ctx.state.sendSystemMessage('The imbued item is gone — cannot undo.');
          delete mob._lastImbueSession;
          return;
        }
        const targetPack = findBackpack(api, mob);
        if (!targetPack || !isInPack(api, target, mob)) {
          ctx.state.sendSystemMessage('You no longer carry that item.');
          delete mob._lastImbueSession;
          return;
        }
        // Rollback the property.
        const list = target._magicProps ?? [];
        const idx = list.findIndex((p) => p.attribute === sess.attribute);
        if (idx >= 0) {
          if (sess.prevIntensity == null) {
            // We added a brand-new prop; remove it.
            list.splice(idx, 1);
          } else {
            list[idx] = { ...list[idx], intensity: sess.prevIntensity, isFlag: sess.prevWasFlag };
          }
          target._magicProps = list;
        }
        if (sess.wasUnidentified) target._unidentified = true;
        // Refund essence into pack. Stack-merge if a stack already exists.
        const refundMagicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.magic.type)?.itemId     ?? ESSENCE_TYPES.magic.fallback;
        const refundEnchantedId = api.itemTypes?.resolve?.(ESSENCE_TYPES.enchanted.type)?.itemId ?? ESSENCE_TYPES.enchanted.fallback;
        const refundRelicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.relic.type)?.itemId     ?? ESSENCE_TYPES.relic.fallback;
        const refunds = [
          { itemId: refundMagicId,     hue: ESSENCE_TYPES.magic.hue,     amount: sess.cost.magic     },
          { itemId: refundEnchantedId, hue: ESSENCE_TYPES.enchanted.hue, amount: sess.cost.enchanted },
          { itemId: refundRelicId,     hue: ESSENCE_TYPES.relic.hue,     amount: sess.cost.relic     },
        ];
        for (const r of refunds) {
          if (r.amount <= 0) continue;
          api.game?.mobile?.giveItem?.(mob, {
            itemId: r.itemId,
            hue: r.hue,
            amount: r.amount,
          }, { randomGrid: true });
        }
        // Wave 18: also pop from the undo queue if our pointer matches.
        if (mob._imbueUndoQueue?.length
            && mob._imbueUndoQueue[mob._imbueUndoQueue.length - 1] === sess) {
          mob._imbueUndoQueue.pop();
        }
        delete mob._lastImbueSession;
        if (mob._imbueUndoQueue?.length) {
          mob._lastImbueSession = mob._imbueUndoQueue[mob._imbueUndoQueue.length - 1];
        }
        ctx.state.sendSystemMessage(`Imbue rolled back. Essence refunded.`);
        // Refresh tooltip on the now-rolled-back item.
        const provider = ctx.state?.ctx?.propertyProvider;
        if (provider && api.properties?.nudge && api.properties?.computeHash) {
          const r = provider(target.serial, ctx.state);
          if (r?.entries) api.properties.nudge(ctx.state, target.serial, api.properties.computeHash(r.entries));
        }
        return;
      }
      const [serialArg, attrArg, intArg] = ctx.args;
      if (!serialArg || !attrArg || !intArg) {
        ctx.state.sendSystemMessage('Usage: [imbue <serial> <attribute> <intensity 1..15>  |  [imbue undo');
        return;
      }
      // Server parity #8 #1 — Soulforge proximity. ServUO refuses imbue
      // unless `from.InRange(SoulforgeLocation, 2)`. We look for any
      // item flagged `_soulforge` (or whose itemId is in the Soulforge
      // graphic range 0x4278..0x427F / 0x4290..0x4297) within 2 tiles.
      const nearSoulforge = (() => {
        const sectors = api.world.sectors;
        const range = 2;
        const probe = (it) => {
          if (!it || it.map !== mob.map) return false;
          if (Math.max(Math.abs(it.x - mob.x), Math.abs(it.y - mob.y)) > range) return false;
          if (it._soulforge) return true;
          const id = it.itemId | 0;
          return (id >= 0x4278 && id <= 0x427F) || (id >= 0x4290 && id <= 0x4297);
        };
        if (sectors?.itemSerialsNear) {
          for (const s of sectors.itemSerialsNear(mob.map, mob.x, mob.y, range)) {
            const it = itemBySerial(api, s);
            if (probe(it)) return true;
          }
        } else {
          for (const it of allItems(api)) if (probe(it)) return true;
        }
        return false;
      })();
      const staff = mob.client?.account?.accessLevel === 'GM'
                 || mob.client?.account?.accessLevel === 'Admin';
      if (!nearSoulforge && !staff) {
        ctx.state.sendSystemMessage('You must stand within 2 tiles of a Soulforge.');
        return;
      }
      const serial = (/^0x/i.test(serialArg) ? parseInt(serialArg, 16) : parseInt(serialArg, 10)) >>> 0;
      const item = itemBySerial({ world }, serial);
      if (!item) { ctx.state.sendSystemMessage('No such item.'); return; }
      const pack = findBackpack(api, mob);
      if (!pack || !isInPack(api, item, mob)) {
        ctx.state.sendSystemMessage('You can only imbue items you carry.');
        return;
      }
      // Wave 27: locked items reject imbue (GM-only unlock via gump).
      if (item._imbueLocked) {
        ctx.state.sendSystemMessage('That item is locked and cannot be imbued.');
        return;
      }
      // Cooldown.
      const now = Date.now();
      const cd = cooldowns.get(mob.serial) ?? 0;
      if (now < cd) {
        ctx.state.sendSystemMessage(`Steady. Wait ${Math.ceil((cd - now)/1000)}s.`);
        return;
      }
      // Skill gate.
      const skill = effectiveSkill(mob);
      if (skill < 30) {
        ctx.state.sendSystemMessage('Imbuing skill 30+ required.');
        return;
      }
      // Lookup attribute.
      const allProps = api.systems?.loot?.allMagicProperties?.()
                    ?? api.loot?.allMagicProperties?.();
      if (!Array.isArray(allProps)) {
        ctx.state.sendSystemMessage('Magic properties catalog not loaded.');
        return;
      }
      const target = allProps.find((p) => p.attribute.toLowerCase() === attrArg.toLowerCase())
                  ?? allProps.find((p) => p.attribute.toLowerCase().includes(attrArg.toLowerCase()));
      if (!target) {
        ctx.state.sendSystemMessage(`Unknown attribute "${attrArg}". Try [imbueattrs ${attrArg}.`);
        return;
      }
      const intensity = Math.max(1, Math.min(15, parseInt(intArg, 10) || 0));
      if (intensity > target.maxIntensity) {
        ctx.state.sendSystemMessage(
          `${target.attribute} caps at intensity ${target.maxIntensity}.`,
        );
        return;
      }
      // Property list cap.
      const props = item._magicProps ?? [];
      const dup = props.findIndex((p) => p.attribute === target.attribute);
      if (dup < 0 && props.length >= MAX_PROPS) {
        ctx.state.sendSystemMessage(`Item already carries ${MAX_PROPS} properties (cap).`);
        return;
      }
      // Wave 20: budget gate. Replacing an existing prop refunds its
      // current cost into the available pool. New prop must fit
      // remaining budget. Prevents stacking 5× max-intensity attribs
      // beyond what ServUO would allow.
      const budgetCap = getItemBudget(item);
      const used = usedBudget(item, allProps);
      const oldCost = dup >= 0
        ? budgetCostFor(target, props[dup].intensity ?? 0)
        : 0;
      const wantCost = budgetCostFor(target, intensity);
      if (used - oldCost + wantCost > budgetCap) {
        const remaining = budgetCap - (used - oldCost);
        ctx.state.sendSystemMessage(
          `Imbue weight ${wantCost} exceeds remaining budget ${remaining}/${budgetCap}.`,
        );
        return;
      }
      // Essence cost.
      const cost = essenceCost(intensity);
      const magicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.magic.type)?.itemId     ?? ESSENCE_TYPES.magic.fallback;
      const enchantedId = api.itemTypes?.resolve?.(ESSENCE_TYPES.enchanted.type)?.itemId ?? ESSENCE_TYPES.enchanted.fallback;
      const relicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.relic.type)?.itemId     ?? ESSENCE_TYPES.relic.fallback;
      const have = (id) => findEssenceStacks(api, mob, id).reduce((s, x) => s + x.available, 0);
      if (have(magicId) < cost.magic
       || have(enchantedId) < cost.enchanted
       || have(relicId) < cost.relic) {
        ctx.state.sendSystemMessage(
          `You need ${cost.magic} MagicEssence, ${cost.enchanted} EnchantedEssence, ${cost.relic} RelicFragment.`,
        );
        return;
      }
      // Consume essence (debited unconditionally — ServUO behaviour).
      consumeEssence(api, mob, magicId,     cost.magic,     ctx.state);
      consumeEssence(api, mob, enchantedId, cost.enchanted, ctx.state);
      consumeEssence(api, mob, relicId,     cost.relic,     ctx.state);
      cooldowns.set(mob.serial, now + cooldownForSkill(skill));
      // Skill use → small gain pulse.
      api.skillGain?.tick?.(mob, SKILL_IMBUING);
      // Skill check.
      const successChance = Math.max(0.10, Math.min(0.95, (skill - 30) / 80));
      if (Math.random() > successChance) {
        ctx.state.sendSystemMessage(
          `Your imbuing fails — the essence dissipates uselessly.`,
        );
        return;
      }
      // Apply / overwrite the property.
      const newProp = {
        kind: 'attr',
        attribute: target.attribute,
        group: target.group,
        intensity,
        cliloc: target.cliloc,
        isFlag: target.start === 1 && target.maxIntensity === 1,
      };
      // Wave 16: stash undo snapshot BEFORE mutating so [imbue undo
      // can rollback the property AND refund the essence cost. We
      // persist the snapshot on the player mob (not on item) so a
      // second imbue on a different item doesn't blow the buffer.
      // Wave 18: maintain a stash of up to 5 sessions (FIFO eviction)
      // so [imbue undo all rolls back recent batch independently.
      const sess = {
        itemSerial: item.serial,
        attribute: target.attribute,
        prevIntensity: dup >= 0 ? props[dup].intensity : null,
        prevWasFlag:   dup >= 0 ? !!props[dup].isFlag : false,
        cost: { ...cost },
        wasUnidentified: !!item._unidentified,
        ts: now,
      };
      mob._lastImbueSession = sess;
      mob._imbueUndoQueue ??= [];
      mob._imbueUndoQueue.push(sess);
      if (mob._imbueUndoQueue.length > 5) mob._imbueUndoQueue.shift();
      if (dup >= 0) props[dup] = newProp;
      else props.push(newProp);
      item._magicProps = props;
      item._unidentified = false;     // imbued items are identified by definition
      ctx.state.sendSystemMessage(
        `${item.name ?? 'The item'} now carries ${target.attribute} at ${intensity}.`,
      );
      // Refresh tooltip.
      const provider = ctx.state?.ctx?.propertyProvider;
      if (provider && api.properties?.nudge && api.properties?.computeHash) {
        const r = provider(item.serial, ctx.state);
        if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
      }
    },
  });

  // Wave 17: `[imbuequeue <serial> <a1> <i1> <a2> <i2> ...` —
  // atomic batch imbue. Validate every (attribute, intensity) pair
  // BEFORE any state change, including aggregate essence cost. If
  // anything fails, the call is a no-op (no skill check rolled, no
  // essence consumed, no cooldown touched). On success, apply each
  // pair in sequence; a single skill-check roll covers the whole
  // batch (all-or-nothing). Property cap still respected — if the
  // batch would push the item over MAX_PROPS, reject up front.
  commands.register({
    name: 'imbuequeue',
    help: '[imbuequeue <serial> <attr1> <int1> <attr2> <int2>… — atomic batch imbue.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const args = ctx.args;
      if (args.length < 3 || (args.length - 1) % 2 !== 0) {
        ctx.state.sendSystemMessage('Usage: [imbuequeue <serial> <attr1> <int1> <attr2> <int2>…');
        return;
      }
      const serial = (/^0x/i.test(args[0]) ? parseInt(args[0], 16) : parseInt(args[0], 10)) >>> 0;
      const item = itemBySerial({ world }, serial);
      if (!item) { ctx.state.sendSystemMessage('No such item.'); return; }
      const pack = findBackpack(api, mob);
      if (!pack || !isInPack(api, item, mob)) {
        ctx.state.sendSystemMessage('You can only imbue items you carry.');
        return;
      }
      // Wave 27: locked items reject batch imbue too.
      if (item._imbueLocked) {
        ctx.state.sendSystemMessage('That item is locked and cannot be imbued.');
        return;
      }
      const skill = effectiveSkill(mob);
      if (skill < 30) {
        ctx.state.sendSystemMessage('Imbuing skill 30+ required.');
        return;
      }
      const allProps = api.systems?.loot?.allMagicProperties?.()
                    ?? api.loot?.allMagicProperties?.();
      if (!Array.isArray(allProps)) {
        ctx.state.sendSystemMessage('Magic properties catalog not loaded.');
        return;
      }

      // Validate every pair AND tally aggregate cost.
      const pairs = [];
      const totalCost = { magic: 0, enchanted: 0, relic: 0 };
      const liveProps = [...(item._magicProps ?? [])];
      // Wave 20: track budget usage as we walk pairs. Pre-load the
      // current usage so an overwriting pair refunds prior cost into
      // the running pool just like single-imbue does.
      const queueBudgetCap = getItemBudget(item);
      let queueUsedBudget = usedBudget(item, allProps);
      for (let i = 1; i < args.length; i += 2) {
        const attrArg = args[i];
        const intArg = args[i + 1];
        const target = allProps.find((p) => p.attribute.toLowerCase() === attrArg.toLowerCase())
                    ?? allProps.find((p) => p.attribute.toLowerCase().includes(attrArg.toLowerCase()));
        if (!target) {
          ctx.state.sendSystemMessage(`Unknown attribute "${attrArg}".`);
          return;
        }
        const intensity = Math.max(1, Math.min(15, parseInt(intArg, 10) || 0));
        if (intensity > target.maxIntensity) {
          ctx.state.sendSystemMessage(
            `${target.attribute} caps at intensity ${target.maxIntensity}.`,
          );
          return;
        }
        const dup = liveProps.findIndex((p) => p.attribute === target.attribute);
        if (dup < 0 && liveProps.length >= MAX_PROPS) {
          ctx.state.sendSystemMessage(
            `Batch would exceed item property cap of ${MAX_PROPS}.`,
          );
          return;
        }
        // Wave 20: budget bookkeeping. Replacing dup refunds its
        // current weight; new pair adds wantCost. Reject the whole
        // batch if any single step pushes over the cap.
        const oldCost = dup >= 0
          ? budgetCostFor(target, liveProps[dup].intensity ?? 0)
          : 0;
        const wantCost = budgetCostFor(target, intensity);
        if (queueUsedBudget - oldCost + wantCost > queueBudgetCap) {
          const remaining = queueBudgetCap - (queueUsedBudget - oldCost);
          ctx.state.sendSystemMessage(
            `Batch step "${target.attribute}@${intensity}" weighs ${wantCost}, only ${remaining} of ${queueBudgetCap} left.`,
          );
          return;
        }
        queueUsedBudget = queueUsedBudget - oldCost + wantCost;
        // Simulate adding/replacing so subsequent pairs see updated count + budget.
        if (dup < 0) liveProps.push({ attribute: target.attribute, intensity });
        else liveProps[dup] = { ...liveProps[dup], attribute: target.attribute, intensity };
        const c = essenceCost(intensity);
        totalCost.magic += c.magic;
        totalCost.enchanted += c.enchanted;
        totalCost.relic += c.relic;
        pairs.push({ target, intensity, cost: c });
      }

      // Aggregate essence availability check.
      const magicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.magic.type)?.itemId     ?? ESSENCE_TYPES.magic.fallback;
      const enchantedId = api.itemTypes?.resolve?.(ESSENCE_TYPES.enchanted.type)?.itemId ?? ESSENCE_TYPES.enchanted.fallback;
      const relicId     = api.itemTypes?.resolve?.(ESSENCE_TYPES.relic.type)?.itemId     ?? ESSENCE_TYPES.relic.fallback;
      const have = (id) => findEssenceStacks(api, mob, id).reduce((s, x) => s + x.available, 0);
      if (have(magicId) < totalCost.magic
       || have(enchantedId) < totalCost.enchanted
       || have(relicId) < totalCost.relic) {
        ctx.state.sendSystemMessage(
          `Batch needs ${totalCost.magic} magic, ${totalCost.enchanted} enchanted, ${totalCost.relic} relic essence total.`,
        );
        return;
      }

      // Single skill check governs the entire batch (atomic).
      const successChance = Math.max(0.10, Math.min(0.95, (skill - 30) / 80));
      consumeEssence(api, mob, magicId,     totalCost.magic,     ctx.state);
      consumeEssence(api, mob, enchantedId, totalCost.enchanted, ctx.state);
      consumeEssence(api, mob, relicId,     totalCost.relic,     ctx.state);
      api.skillGain?.tick?.(mob, SKILL_IMBUING);
      cooldowns.set(mob.serial, Date.now() + cooldownForSkill(skill));
      if (Math.random() > successChance) {
        ctx.state.sendSystemMessage(
          `Your batch imbue fails — all ${pairs.length} essences scattered.`,
        );
        return;
      }
      // Apply each pair in order.
      const props = item._magicProps ?? [];
      for (const { target, intensity } of pairs) {
        const dup = props.findIndex((p) => p.attribute === target.attribute);
        const newProp = {
          kind: 'attr',
          attribute: target.attribute,
          group: target.group,
          intensity,
          cliloc: target.cliloc,
          isFlag: target.start === 1 && target.maxIntensity === 1,
        };
        if (dup >= 0) props[dup] = newProp;
        else props.push(newProp);
      }
      item._magicProps = props;
      item._unidentified = false;
      // Note: no _lastImbueSession — undo for batches deferred (refund
      // would be ambiguous if the item was modified between calls).
      delete mob._lastImbueSession;
      ctx.state.sendSystemMessage(
        `Batch success — ${pairs.length} properties imbued onto ${item.name ?? 'the item'}.`,
      );
      const provider = ctx.state?.ctx?.propertyProvider;
      if (provider && api.properties?.nudge && api.properties?.computeHash) {
        const r = provider(item.serial, ctx.state);
        if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
      }
    },
  });

  return () => {
    commands.unregister('imbue');
    commands.unregister('imbueattrs');
    commands.unregister('imbuequeue');
  };
}
