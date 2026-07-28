// Item template registry.
//
// ServUO models typed items via subclasses (Torch extends BaseLight extends
// Item). In JavaScript we avoid deep class hierarchies and instead use
// *templates*: plain objects that describe default field values plus optional
// lifecycle hooks (`onCreate`, `onUse`). Scripts register templates at load
// time and then `spawn(world, 'torch', {x,y,z,map})` instantiates one.
//
// Templates are a thin layer on top of `createItem` — nothing stored on the
// Item itself requires the registry to round-trip, so persistence continues
// to work without migrations.

import { createItem, destroyItem } from './items.js';
import { getItem as contentItem } from '../content/items/index.js';
import { removeEntity as _removeEntityBuilder } from '@uo/protocol';
import { dispatchItemEvent } from './item-scripts.js';
import { consumeScroll, describeScrollEffect } from '../systems/power-scrolls.js';

/**
 * @typedef {Object} ItemTemplate
 * @property {string} [definitionId]   stable gameplay identity
 * @property {string} [id]             canonical alias of definitionId
 * @property {string} [name]           legacy registry key / canonical display name
 * @property {number} [artId]          canonical UO static-art graphic id
 * @property {number} [itemId]         legacy alias of artId
 * @property {number} [hue]
 * @property {number} [gumpId]         non-zero marks this as a container
 * @property {boolean} [movable]
 * @property {boolean} [stackable]
 * @property {number} [light]          light source radius (0 = none)
 * @property {string} [label]          short display name override
 * @property {(world: import('./world.js').World, item: import('./items.js').Item) => void} [onCreate]
 * @property {(world: import('./world.js').World, item: import('./items.js').Item, user: import('./world.js').Mobile) => void} [onUse]
 */

/** @type {Map<string, ItemTemplate>} */
const registry = new Map();
/** @type {Map<string, ItemTemplate>} */
const aliases = new Map();
/** @type {Map<string, Set<string>>} */
const aliasesByName = new Map();

const TEMPLATE_RUNTIME_KEYS = [
  'servuoClass', 'servuoClasses', 'servuoPath',
  'container', 'capacity', 'maxWeight', 'stackable', 'labelNumber',
  'weapon', 'shield', 'ar', 'strReq', 'twoHanded', 'skill', 'minDamage', 'maxDamage', 'speed', 'range', 'ammoId',
  'bandageHealingBonus',
  'firstAidBelt', 'firstAidMaxBandages', 'firstAidHealingBonus', 'firstAidWeightReduction',
  'fountainCharges', 'fountainMaxCharges', 'fountainNextRechargeAt',
  'boatDeed', 'boatPlank', 'boatKey',
  'addonName', 'addonNames',
  '_deedMulti', '_deedOffset', '_contestHouse', '_previewHouse',
  'secureLevel',
  'args', 'displayName', 'anniversaryChoice', '_timepiece', '_dailyRare', '_ancientWall',
  '_sphynxFortune',
];

/** Register (or replace) a template. Hot-reload friendly. */
export function registerTemplate(tmpl) {
  if (!tmpl || typeof tmpl !== 'object') throw new Error('template must be an object');
  const definitionId = String(tmpl.definitionId ?? tmpl.id ?? tmpl.name ?? '').trim();
  if (!definitionId) throw new Error('template must have definitionId (or legacy name)');
  const artId = Number(tmpl.artId ?? tmpl.itemId);
  if (!Number.isInteger(artId) || artId < 0 || artId > 0xFFFF) {
    throw new Error(`template ${definitionId} missing valid artId`);
  }
  // BH #12 B5 — `spawn()` lowercases name lookups; if a template
  // registered with capital letters (`'Torch'`) it became unreachable
  // (silent miss → `unknown item template` throw). Lowercase the
  // registry key here too.
  const key = definitionId.toLowerCase();
  unregisterTemplate(key);
  const canonical = tmpl.definitionId != null || tmpl.id != null || tmpl.artId != null;
  const normalized = {
    ...tmpl,
    id: definitionId,
    definitionId,
    artId,
    itemId: artId,
    // Internally `name` remains the spawn/template key. In canonical rows the
    // authored `name` is the display label instead of another hidden id.
    name: key,
    label: tmpl.label ?? (canonical ? tmpl.name : undefined),
  };
  registry.set(key, normalized);
  const templateAliases = new Set([
    normalized.servuoClass,
    ...(Array.isArray(normalized.servuoClasses) ? normalized.servuoClasses : []),
  ].filter(Boolean));
  for (const alias of templateAliases) {
    aliases.set(String(alias), normalized);
    aliases.set(String(alias).toLowerCase(), normalized);
  }
  aliasesByName.set(key, templateAliases);
  return normalized;
}

/** Remove a template by name (used by script disposers). */
export function unregisterTemplate(name) {
  const key = String(name ?? '').toLowerCase();
  const templateAliases = aliasesByName.get(key);
  if (templateAliases) {
    for (const alias of templateAliases) {
      aliases.delete(String(alias));
      aliases.delete(String(alias).toLowerCase());
    }
    aliasesByName.delete(key);
  }
  registry.delete(key);
}

/** Get a template by name or `undefined`. */
export function getTemplate(name) {
  const key = String(name ?? '');
  return registry.get(key.toLowerCase()) ?? aliases.get(key) ?? aliases.get(key.toLowerCase());
}

/** Find the FIRST registered template whose itemId matches. Returns
 *  undefined when nothing matches. Used by raw createItem callers
 *  (vendor onBuy, loot drops, scripted spawns) to back-fill the
 *  `script` field so a bread bought from a baker actually has its
 *  `food` onUse hook attached even though the buyer never ran it
 *  through the named-template path. */
export function getTemplateByItemId(itemId) {
  const want = itemId | 0;
  for (const t of registry.values()) {
    if ((t.itemId | 0) === want) return t;
  }
  return undefined;
}

/** List registered template names. */
export function templateNames() {
  return [...registry.keys()].sort();
}

/**
 * Spawn an item from a template.
 * `overrides` wins over template defaults; position is required.
 *
 * @param {import('./world.js').World} world
 * @param {string} name                      template name (case-insensitive)
 * @param {Partial<import('./items.js').Item> & {x:number,y:number,z:number}} overrides
 * @returns {import('./items.js').Item}
 */
export function spawn(world, name, overrides) {
  const t = getTemplate(name);
  if (!t) throw new Error(`unknown item template: ${name}`);
  const runtime = {};
  for (const key of TEMPLATE_RUNTIME_KEYS) {
    if (t[key] !== undefined && overrides[key] === undefined) runtime[key] = t[key];
  }
  const item = createItem(world, {
    definitionId: t.definitionId,
    artId: t.artId,
    hue: t.hue ?? 0,
    gumpId: t.gumpId ?? 0,
    movable: t.movable ?? true,
    ...runtime,
    ...overrides,
  });
  // Tag the template name so on-use lookup + persistence round-trips.
  // @ts-expect-error — augment Item with a runtime-only field.
  item.template = t.definitionId.toLowerCase();
  if (t.label) item.name = t.label;
  // FAZA BN: copy template-declared lifecycle hooks onto the item.
  //   `script`        — name registered in item-scripts registry
  //   `equipLayer`    — paperdoll layer for clothing/weapons
  //   `clothing`      — paperdoll picker eligibility
  //   `slot`          — clothing slot key (shirt/pants/feet/...)
  //   `defaultHue`    — auto-applied tint at spawn (only when overrides
  //                     don't provide one)
  if (t.script)        item.script        = t.script;
  if (t.equipLayer)    item.equipLayer    = t.equipLayer;
  if (t.clothing)      item.clothing      = t.clothing;
  if (t.spellbook)     item.spellbook     = true;
  if (t.slot)          item.slot          = t.slot;
  if (t.weight != null) item.weight       = t.weight;
  if (t.dyeHues)       item.dyeHues       = t.dyeHues;
  if (t.addonName)     item.addonName     = t.addonName;
  if (t.addonNames)    item.addonNames    = t.addonNames;
  if (t.training)      item.training      = t.training;
  // BUGFIX #30 (FAZA BN): only fall back to defaultHue when the caller
  // genuinely omitted the hue. Treating `hue: 0` as "no override" meant
  // callers couldn't suppress a template tint (e.g. spawning a colourless
  // copper-ingot variant) — the explicit zero was silently overwritten.
  if (t.defaultHue != null && overrides.hue == null) {
    item.hue = t.defaultHue;
  }
  if (t.onCreate) {
    try { t.onCreate(world, item); }
    catch (e) { console.error(`[items] ${t.name} onCreate threw:`, e); }
  }
  // Forward to the script's onCreate as well (so a script can patch
  // initial state — e.g. light-source burn timer).
  dispatchItemEvent(world, item, 'onCreate');
  return item;
}

/**
 * FAZA LA / BUGFIX #140: pre-template `useItem` hook chain. Scripts
 * like boat.js / door.js wanted to intercept double-clicks before
 * the canonical template lookup so they could route plank items into
 * board/leave logic. The previous attempt was `api.templates.useItem
 * = wrapper` — but ES module exports are read-only, so the assignment
 * threw "Cannot assign to read only property 'useItem' of object
 * '[object Module]'" at script init and the hook silently dropped.
 *
 * Use this `addUseItemHook(fn)` registration API instead. Hooks run
 * in registration order; the first to return truthy short-circuits
 * the dispatcher (template lookup is skipped).
 */
const _useItemHooks = [];
export function addUseItemHook(fn) { _useItemHooks.push(fn); }
export function clearUseItemHooks() { _useItemHooks.length = 0; }

/**
 * Invoke the template's `onUse` hook if present. Returns `true` if a hook ran.
 *
 * @param {import('./world.js').World} world
 * @param {import('./items.js').Item} item
 * @param {import('./world.js').Mobile} user
 */
export function useItem(world, item, user) {
  // Pre-template hook chain (FAZA LA). Scripts opt-in via
  // `api.templates.addUseItemHook(fn)` — see boat.js / door.js.
  for (const hook of _useItemHooks) {
    try {
      if (hook(world, item, user)) return true;
    } catch (e) {
      console.error('[templates] useItem hook threw:', e);
    }
  }
  // Migrate the broken week-7 reward already present in old saves. The
  // original factory used an unknown `deed` field, which createItem dropped,
  // leaving only this exact name/art pair and no onUse script.
  if (item.itemId === 0x14F0 && /^a small ankh deed$/i.test(String(item.name ?? '')) && !item.script) {
    item.script = 'addon-deed';
    item.addonName = 'stone-ankh';
  }

  // Path 0: canonical power/stat-scroll consumption. Both old `{amount}`
  // and new `{cap}` payloads are accepted; unrelated items sharing 0x14F0
  // (deeds and Scrolls of Transcendence) continue to their own scripts.
  const scrollEffect = describeScrollEffect(user, item);
  if (scrollEffect) {
    // FAZA BM: confirmation gump — port of CUO PowerScroll usage
    // dialog. Real shards always pop a "Yes / No" before consuming
    // because power-scrolls are tradable luxury items. Without the
    // confirm, mis-clicking deletes a 50-million-gold scroll. We
    // route through `user.client._gumpsHost` if a gump host accessor
    // exists; otherwise fall through to immediate apply (admin-test
    // path or non-client mob via [reload commands).
    const isSkill = scrollEffect.kind === 'skill';
    if (scrollEffect.target <= scrollEffect.current) {
      user.client?.sendSystemMessage?.(isSkill
        ? `Your skill cap is already ${scrollEffect.current}; this scroll cannot raise it.`
        : `Your stat cap is already ${scrollEffect.current}; this scroll cannot raise it.`);
      return true;
    }
    const apply = () => {
      if (!consumeScroll(user, item)) {
        user.client?.sendSystemMessage?.('This scroll can no longer improve your cap.');
        return;
      }
      user.client?.sendSystemMessage?.(isSkill
        ? `You absorb the power scroll. Skill cap raised to ${scrollEffect.target}.`
        : `You absorb the stat scroll. Stat cap raised to ${scrollEffect.target}.`);
      destroyItem(world, item.serial);
      if (user.client && _removeEntityBuilder) {
        try { user.client.send(_removeEntityBuilder(item.serial)); }
        catch { /* ignore */ }
      }
    };
    const gumps = user.client?.ctx?.handlers && user.client?.ctx?.handlers.gumps
      ? user.client.ctx.handlers.gumps
      : null;
    // Prefer the shared gump host on the ctx if exposed; otherwise apply
    // directly so the admin / test paths keep working unchanged.
    const sharedGumps = user.client?.ctx?.gumps ?? gumps;
    if (sharedGumps?.send) {
      const skillName = isSkill
        ? (user.client?.ctx?.skills?.byId?.get?.(scrollEffect.skillId)?.name ?? `skill ${scrollEffect.skillId}`)
        : null;
      sharedGumps.send(user.client, {
        gumpId: 0x50535C00 | (item.serial & 0xFFFF),
        x: 200, y: 150,
        layout: [
          '{ resizepic 0 0 5054 320 160 }',
          '{ text 30 14 1153 0 }',          // title
          '{ text 30 40 1152 1 }',          // body
          '{ button 60 110 4023 4024 1 0 1 }',  // Yes
          '{ text 95 112 1153 2 }',
          '{ button 200 110 4017 4018 1 0 0 }', // No
          '{ text 235 112 1153 3 }',
        ].join(''),
        texts: [
          isSkill ? 'Power Scroll' : 'Stat Scroll',
          isSkill
            ? `Raise ${skillName} cap from ${scrollEffect.current} to ${scrollEffect.target}?`
            : `Raise your stat cap from ${scrollEffect.current} to ${scrollEffect.target}?`,
          'Yes',
          'No',
        ],
      }, (r) => {
        if ((r.buttonId | 0) === 1) apply();
      });
      return true;
    }
    apply();
    return true;
  }

  // FAZA BN: lifecycle script onUse (per-item, declared in items.json
  // via the `script` field). Runs BEFORE template path so a script
  // override always wins; returning truthy means handled.
  if (dispatchItemEvent(world, item, 'onUse', user)) return true;

  // Path 1: template onUse (bespoke script per template).
  // @ts-expect-error — template tag stored at spawn time.
  const name = item.template;
  if (name) {
    const t = registry.get(name);
    if (t?.onUse) {
      try { t.onUse(world, item, user); return true; }
      catch (e) { console.error(`[items] template ${name} onUse threw:`, e); }
    }
  }
  // Path 2: content catalogue effect. Resolve by stable gameplay identity
  // first; art lookup is only a compatibility fallback for old saves. This
  // prevents two items sharing the same graphic from invoking each other's
  // effect/script.
  if (item.itemId) {
    const def = contentItem(item.definitionId ?? item.tagId ?? item.itemId);
    if (def?.effect) {
      try { def.effect(user, { world, item, def }); }
      catch (e) { console.error(`[items] content 0x${item.itemId.toString(16)} effect threw:`, e); }
      // Stack-aware consume: amount-1 if stackable, else remove. Effect
      // can opt out of consumption by setting `def._noConsume` (used by
      // scroll handlers that want to refund on fizzle / no-skill).
      if (item._noConsume) {
        item._noConsume = false;
      } else if ((item.amount ?? 1) > 1) {
        item.amount -= 1;
      } else {
        destroyItem(world, item.serial);
      }
      return true;
    }
  }
  return false;
}

/** Clear all templates (for test isolation). */
export function _resetTemplatesForTest() {
  registry.clear();
  aliases.clear();
  aliasesByName.clear();
}
