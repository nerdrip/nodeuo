// `[placemulti <id> [hue]` — stamp a canonical UO multi template at the
// player's feet. Reads from the extracted `multi.json` catalogue
// (apps/client/public/assets/multi.json), which holds every house +
// boat + custom-multi from `MultiCollection.uop` as a flat list of
// `{ id, x, y, z, visible }` tiles relative to the multi's origin.
//
// Examples:
//   [placemulti 0x6B           drop a Small Brick House (single-storey)
//   [placemulti 0x91 1147      Brass Lighthouse hued with 1147 (cyan)
//   [placemulti list           print the 20 most-used multi ids
//   [placemulti search wall    grep multi names for "wall"
//
// Each placement creates one canonical BaseMulti-style anchor sent to
// clients as a type-2 world item. Blueprint components remain server-side
// collision proxies; only hidden dynamic pieces (doors/signs) are also sent
// as ordinary items. Every part shares a unique `_multiInstance` so two
// houses built from the same template never share ACL or demolition state.
//
// ServUO equivalent: `Scripts/Multis/Deeds/HouseDeed.cs` placement.
// House multis are bridged into HouseRegistry immediately after stamping;
// boats and scenery remain plain canonical multis.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  getAcl, getAclLevel,
  addToRoster, removeFromRoster, lockdownItem, releaseItem,
  bumpVisit,
  ACL_OWNER, ACL_CO_OWNER, ACL_FRIEND, ACL_STRANGER, ACL_NONE,
  DECAY_DAYS,
} from '../../items/behaviors/house-acl.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createItem, destroyItemBySerial } from '../../_items.js';
import { findBackpack } from '../../_inventory.js';
import { allItems, allMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { isBoatMulti, isCustomHouseMulti, isHouseMulti, nameForMulti } from './multi-catalog.js';
import {
  ensureHouseForMulti, isHousingStaff, openHouseManagement, registerMultiHouse,
  neutralizeHouseMultiHues, syncMultiAclToRegistry, syncRegistryHouseToMulti,
} from './multi-house-bridge.js';

// Resolve relative to THIS file so the lookup works regardless of
// where the server was launched from. User report: "Multi 0xb not in
// catalogue (multi.json missing)" — the prior 2-candidate list missed
// when cwd != repo root (e.g. running from `apps/server/`).
const __PM_FILE = fileURLToPath(import.meta.url);
const __PM_DIR  = dirname(__PM_FILE);

let _multiCache = null;
let _multiMetadataCache = null;
let _multiCustomNames = new Map();
function loadMultis(api) {
  if (_multiCache) return _multiCache;
  // This file lives at `apps/scripts/src/commands/housing/placemulti.js`
  // (5 levels from repo root). Same depth-mismatch bug as multigump.js
  // — the 4-up walk lands at apps/apps/ when the file is actually
  // 5-up. Keep both 5-up (canonical) and 4-up (legacy) for future moves.
  const candidates = [
    join(process.cwd(), 'apps/client/public/assets/multi.json'),
    join(process.cwd(), 'public/assets/multi.json'),
    // 5 levels: housing → commands → src → scripts → apps → REPO_ROOT
    join(__PM_DIR, '../../../../../apps/client/public/assets/multi.json'),
    join(__PM_DIR, '../../../../../apps/client/dist/assets/multi.json'),
    // Legacy fallbacks (file moved out of `housing/` someday).
    join(__PM_DIR, '../../../../apps/client/public/assets/multi.json'),
    join(__PM_DIR, '../../../../apps/client/dist/assets/multi.json'),
    join(__PM_DIR, '../../../apps/client/public/assets/multi.json'),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      _multiCache = { ...(raw.multis ?? raw) };
      _multiCustomNames = new Map();
      try {
        const overrides = JSON.parse(readFileSync(join(dirname(path), 'asset-overrides.json'), 'utf8'));
        for (const [id, record] of Object.entries(overrides?.multi ?? {})) {
          if (!Array.isArray(record?.components)) continue;
          _multiCache[id] = record.components;
          if (record.name) _multiCustomNames.set(Number(id) | 0, String(record.name));
        }
      } catch { /* the persistent custom layer is optional */ }
      _multiMetadataCache = null;
      api.log?.(`[placemulti] loaded ${Object.keys(_multiCache).length} effective multis from ${path} (${_multiCustomNames.size} custom)`);
      return _multiCache;
    } catch (e) {
      api.log?.(`[placemulti] failed to parse ${path}: ${e.message}`);
    }
  }
  // Log every path we tried so the user can see what's wrong.
  api.log?.(`[placemulti] multi.json not found. Tried: ${candidates.join(' | ')}`);
  return null;
}

function parseId(s) {
  if (!s) return NaN;
  const t = String(s).trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t.slice(2), 16);
  return parseInt(t, 10);
}

function multiInstanceId(item) {
  return item?._multiInstance == null ? null : (item._multiInstance >>> 0);
}

function itemIsCarriedBy(api, item, mobileSerial) {
  let current = item;
  const owner = mobileSerial >>> 0;
  const seen = new Set();
  while (current?.parent != null) {
    const parent = current.parent >>> 0;
    if (parent === owner) return true;
    if (!parent || seen.has(parent)) return false;
    seen.add(parent);
    current = itemBySerial(api, parent);
  }
  return false;
}

/** Match one concrete placed structure. Older saves have no instance id,
 * so they retain the historical facet + template-id fallback. */
function sameMultiInstance(item, reference) {
  if (!item || !reference) return false;
  const instanceId = multiInstanceId(reference);
  if (instanceId != null) return multiInstanceId(item) === instanceId;
  return (item._multi | 0) === (reference._multi | 0)
    && (item.map ?? 1) === (reference.map ?? 1);
}

function matchesMultiRef(item, multiId, facet, instanceId = null) {
  if (!item || (item.map ?? 1) !== facet) return false;
  if (instanceId != null) {
    const wanted = Number(instanceId) >>> 0;
    return wanted !== 0 && multiInstanceId(item) === wanted;
  }
  // Never coerce an absent legacy brand to zero. `undefined | 0` and
  // `null | 0` both evaluate to 0, which used to make a malformed legacy
  // house record match every ordinary item on the facet during demolition.
  if (multiId == null || item._multi == null) return false;
  const wanted = Number(multiId);
  return Number.isInteger(wanted) && wanted >= 0 && (item._multi | 0) === (wanted | 0);
}

// House / vendor sign tile-id ranges. Classic UO ships sign graphics
// across several blocks: vendor signs at 0x0B95..0x0BAF, classic house
// hanging signs at 0x0BC8..0x0C26, with a smaller secondary block at
// 0x0BD0..0x0BD7 used by tower/keep templates (verified in multi.json
// — the hidden tile in 0x7A "Tower" is 0xBD0 at offset (4, 7)). Keep
// the test as a set of explicit ranges so future additions are obvious.
function isHouseSignGraphic(id) {
  const g = id | 0;
  return (g >= 0x0B95 && g <= 0x0BAF)
      || (g >= 0x0BC8 && g <= 0x0C26)
      || (g >= 0x0C40 && g <= 0x0C5A);   // shop signs (AOS+)
}

export default function register(api) {
  if (!api.commands || !api.items) return () => {};

  // One-time/idempotent migration for structures placed by the old deed
  // path. During hot-reload this also pushes corrected anchors to nearby
  // connected clients, so an already-purple house fixes itself immediately.
  const repairedHouseHues = neutralizeHouseMultiHues(api);
  if (repairedHouseHues > 0) {
    api.log?.(`[house-deed] neutralized legacy hue on ${repairedHouseHues} house multi item(s)`);
  }

  // User-report — clicking a house sign just spammed "you see nothing
  // special about that". Wire a real double-click hook: shows a tiny
  // placeholder gump (or a system message if gumps aren't available)
  // identifying which multi this belongs to. Real BaseHouse menu
  // (lockdowns, friends, decay timer, transfer) is a separate feature;
  // this at least makes the sign feel alive and tells the GM which
  // structure they're inspecting.
  const signHook = (world, item, user) => {
    // Fire ONLY when BOTH conditions hold:
    //   • item carries our `_multi` brand (placed by [placemulti)
    //   • item's graphic IS a canonical house-sign tile
    // The earlier rule used `_multi != null` alone, which made every
    // wall / door / roof / floor of a placed multi route through the
    // sign dialog — visible bug: double-clicking the front DOOR of a
    // house opened the sign info gump (with Demolish button) instead
    // of toggling the door open. This made houses inaccessible because a
    // door click opened the sign gump. With both gates, doors fall through to doorHook,
    // walls/floors/roofs to the default "you see nothing special"
    // message, and only the actual sign tile (graphic 0xBC8..0xC26
    // range etc.) brings up the house menu.
    if (item._multi == null) return false;
    if (!isHouseSignGraphic(item.itemId)) return false;
    api.log?.(`[sign] hook fired serial=0x${item.serial.toString(16)} graphic=0x${item.itemId.toString(16)} multi=0x${item._multi.toString(16)}`);
    const dist = Math.max(Math.abs(item.x - user.x), Math.abs(item.y - user.y));
    if (dist > 3) {
      user.client?.sendSystemMessage?.('That is too far away.');
      return true;
    }
    openHouseSignGump(api, world, item, user);
    return true;
  };
  const removeSignHook = api.templates?.addUseItemHook?.(signHook) ?? (() => {});
  const removeAssetListener = api.world?.events?.on?.('assets:changed', (change) => {
    if (change?.kind === 'multi') { _multiCache = null; _multiMetadataCache = null; _multiCustomNames = new Map(); }
  }) ?? (() => {});

  // `[signinfo` — target any item and dump its tile id + flags so we
  // can confirm whether the sign-hook range covers it. The user
  // reported "still 'you see nothing special'" on the sign — could
  // mean the graphic is outside our range, or the hook never ran
  // because the script reload didn't pick up. Running [signinfo on
  // the same sign shows the actual graphic and the hook's range
  // check result, so we can adjust the range or debug the load.
  api.commands.register({
    name: 'signinfo',
    help: '[signinfo — target an item to inspect its tile id, flags, and sign-hook coverage.',
    access: 'GM',
    hidden: true,
    run(ctx) {
      ctx.state.sendSystemMessage('Target the item to inspect.');
      api.targeting?.request(ctx.state, (picked) => {
        if (!picked?.serial) { ctx.state.sendSystemMessage('Cancelled.'); return; }
        const it = itemBySerial(api, picked.serial >>> 0);
        if (!it) { ctx.state.sendSystemMessage('No item at that serial.'); return; }
        const td = api.tileData?.table?.();
        const tdRow = td?.statics?.[it.itemId | 0];
        const flags = tdRow?.flags | 0;
        const isSign = isHouseSignGraphic(it.itemId);
        const FLAG_DOOR = 1 << 29;
        const FLAG_IMPASSABLE = 1 << 6;
        const lines = [
          `serial=0x${it.serial.toString(16)} graphic=0x${(it.itemId | 0).toString(16)}`,
          `pos=(${it.x},${it.y},${it.z}) movable=${it.movable} solid=${!!it.solid}`,
          `flags=0x${flags.toString(16)} (impassable=${!!(flags & FLAG_IMPASSABLE)} door=${!!(flags & FLAG_DOOR)})`,
          `multi=${it._multi != null ? '0x' + it._multi.toString(16) : '(none)'}`,
          `sign-hook range: ${isSign ? 'YES — will fire on double-click' : 'NO — outside 0x0B95..0x0C5A'}`,
        ];
        for (const ln of lines) ctx.state.sendSystemMessage(ln);
        api.log?.(`[signinfo] ${lines.join(' | ')}`);
      }, { kind: 0 });
    },
  });

  api.commands.register({
    name: 'placemulti',
    help: '[placemulti <id|list|search NAME> [hue] — stamp a UO multi template.',
    access: 'GM',
    hidden: true,
    run(ctx) {
      const sub = (ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      const multis = loadMultis(api);
      if (!multis) {
        ctx.state.sendSystemMessage('multi.json missing — run the extractor first.');
        return;
      }

      if (sub === 'list' || sub === '') {
        const sample = Object.keys(multis).slice(0, 25);
        const lines = sample.map((k) => {
          const tiles = multis[k]?.length ?? 0;
          return `  0x${(+k).toString(16).padStart(4, '0')}  (${tiles} tiles)`;
        });
        ctx.state.sendSystemMessage(`Multis (showing ${sample.length} of ${Object.keys(multis).length}):`);
        for (const l of lines) ctx.state.sendSystemMessage(l);
        ctx.state.sendSystemMessage('Usage: [placemulti <id> [hue]  — id is decimal or 0xHEX.');
        return;
      }

      if (sub === 'search') {
        // We don't ship multi-name strings yet; match against the
        // numeric id pattern. Useful for "what's around 0x100".
        const needle = (ctx.args[1] ?? '').toLowerCase();
        const matches = Object.keys(multis)
          .filter((k) => k.includes(needle) || (+k).toString(16).includes(needle))
          .slice(0, 25);
        if (matches.length === 0) {
          ctx.state.sendSystemMessage(`No multis matched "${needle}".`);
          return;
        }
        for (const k of matches) {
          const tiles = multis[k]?.length ?? 0;
          ctx.state.sendSystemMessage(`  0x${(+k).toString(16)}  (${tiles} tiles)`);
        }
        return;
      }

      const id  = parseId(ctx.args[0]);
      const hue = parseId(ctx.args[1]) || 0;
      if (!Number.isFinite(id)) {
        ctx.state.sendSystemMessage('Usage: [placemulti <id|list|search NAME> [hue]');
        return;
      }
      const tiles = multis[id] ?? multis[String(id)];
      if (!tiles || !Array.isArray(tiles) || tiles.length === 0) {
        ctx.state.sendSystemMessage(`Multi 0x${id.toString(16)} not found in catalogue.`);
        return;
      }
      // Send a 0x99 multi-placement request so the client renders a
      // ghost preview of the multi snapped to the tile under the
      // cursor. The user can then drag around the world looking at
      // exactly where the building will sit and click to confirm.
      // Mirrors ServUO `HouseDeed.OnDoubleClick → BeginPlace`.
      placeMultiInteractive(api, ctx.state, mob, id, hue, tiles);
    },
  });

  // Re-entry point — `multigump` (the GM gump browser) fires this
  // event when the user clicks Place on a row. The handler enters
  // multi-targeting mode with the same ghost preview the chat
  // `[placemulti <id>` path uses.
  let off = null;
  if (api.events?.on) {
    off = api.events.on('placemulti:request', ({ state, multiId, hue }) => {
      const m = state?.mobile;
      const cat = loadMultis(api);
      const t = cat?.[multiId] ?? cat?.[String(multiId)];
      if (!m) {
        api.log?.(`[placemulti] event refused: no state.mobile`);
        return;
      }
      if (!t) {
        state?.sendSystemMessage?.(`Multi 0x${(multiId | 0).toString(16)} not in catalogue (${cat ? Object.keys(cat).length + ' loaded' : 'multi.json missing'}).`);
        return;
      }
      placeMultiInteractive(api, state, m, multiId, hue | 0, t);
    });
  } else {
    api.log?.('[placemulti] api.events missing — multigump Place button will be dead');
  }

  // `[fixmultis` — retroactively flag every non-movable static-ish item
  // in the world with the current solid / door / height payload. Used
  // for multis placed BEFORE the `_multi` brand survived `createItem`
  // (the previous wrapper dropped any non-allowlisted fields, including
  // `_multi`, so the tag-keyed scan returned 0). We now widen the scan
  // to ANY immovable item whose tileId is Impassable (wall, roof, deco)
  // or Door — that covers both the orphaned earlier placements and
  // statics dropped by other tools. The scan is idempotent; running it
  // twice is a no-op.
  api.commands.register({
    name: 'fixmultis',
    help: '[fixmultis — retro-patch placed multi/static items with solid/door flags.',
    access: 'GM',
    hidden: true,
    run(ctx) {
      const player = ctx.sender;
      const sub = (ctx.args[0] ?? '').toLowerCase();
      // Optional "near" sub: only items within 30 tiles of the caller.
      // Default — entire world (admin tools should be explicit).
      const limitNear = sub === 'near';
      const RANGE = 30;
      let touched = 0, walls = 0, doors = 0, scanned = 0;
      for (const it of allItems(api)) {
        scanned++;
        if (it.movable !== false) continue;       // skip movable inventory
        if (it.parent != null) continue;          // skip container items
        if (limitNear) {
          if (it.map !== (player.map ?? 1)) continue;
          if (Math.abs((it.x | 0) - (player.x | 0)) > RANGE) continue;
          if (Math.abs((it.y | 0) - (player.y | 0)) > RANGE) continue;
        }
        let changed = false;
        const solid = isTileSolid(api, it.itemId | 0);
        if (solid && !it.solid) {
          it.solid  = true;
          it.height = it.height || (tileHeight(api, it.itemId | 0) || 20);
          walls++;
          changed = true;
        }
        if (!it.door && bindDoorTile(api, it)) {
          doors++;
          changed = true;
        }
        if (changed) touched++;
      }
      const scope = limitNear ? `within ${RANGE} tiles` : 'world-wide';
      ctx.state.sendSystemMessage(`Fix scan (${scope}, ${scanned} items checked): ${touched} touched — ${walls} walls flagged solid, ${doors} doors pre-bound.`);
      api.log?.(`[fixmultis] ${scope}: ${scanned} scanned, ${touched} touched (${walls} solid, ${doors} doors)`);
    },
  });

  // House-deed item script. Mirrors ServUO's `HousePlacementTool` /
  // per-multi deed items (`SmallBrickHouseDeed`, `LogCabinDeed`, …).
  // A deed is a regular packable item with `_deedMulti` stamped to a
  // multi id; double-click triggers placeMultiInteractive at the
  // current owner so they target a tile in the world. On successful
  // placement the deed is consumed, preserving the expected deed workflow.
  api.itemScripts?.register?.({
    name: 'house-deed',
    onUse(world, item, user) {
      if (!user?.client) return false;
      const multiId = (item._deedMulti | 0) || 0;
      if (!multiId) {
        user.client.sendSystemMessage?.('This deed is missing its multi id.');
        return true;
      }
      if (!isHouseMulti(multiId)) {
        user.client.sendSystemMessage?.('This deed does not reference a house foundation.');
        return true;
      }
      if (!isHousingStaff(user) && (api.houses?.housesOf?.(user.serial) ?? []).length > 0) {
        user.client.sendSystemMessage?.('You already own a house.');
        return true;
      }
      const multis = loadMultis(api);
      const tiles = multis?.[multiId];
      if (!tiles) {
        user.client.sendSystemMessage?.(`Unknown multi 0x${multiId.toString(16)} — deed is broken.`);
        return true;
      }
      // Stash the deed serial so the placement callback can consume it
      // after stamping succeeds. We don't pre-consume in case the
      // operator cancels the targeting.
      const deedSerial = item.serial >>> 0;
      const hue = houseDeedPlacementHue(item);
      // Re-use placeMultiInteractive but wrap its target callback so we
      // can destroy the deed after the multi lands.
      const state = user.client;
      const proto = api.protocol;
      if (!proto?.multiPlacementRequest) {
        user.client.sendSystemMessage?.('Multi placement protocol unavailable.');
        return true;
      }
      if (!state.targetCallbacks) state.targetCallbacks = new Map();
      const cursorId = ((state._nextTargetId = (state._nextTargetId ?? 1) + 1) | 0);
      state.targetCallbacks.set(cursorId, (picked) => {
        if (!picked) { user.client.sendSystemMessage?.('House placement cancelled.'); return; }
        const ox = picked.x | 0, oy = picked.y | 0, oz = picked.z | 0;
        const liveDeed = itemBySerial(api, deedSerial);
        if (!liveDeed || liveDeed !== item || liveDeed._housePlacementPending
            || (liveDeed._deedMulti | 0) !== multiId
            || !itemIsCarriedBy(api, liveDeed, user.serial)) {
          user.client.sendSystemMessage?.('The house deed is no longer in your possession.');
          return;
        }
        if (Math.max(Math.abs(ox - (user.x | 0)), Math.abs(oy - (user.y | 0))) > 18) {
          user.client.sendSystemMessage?.('That location is too far away.');
          return;
        }
        if (!isHousingStaff(user) && (api.houses?.housesOf?.(user.serial) ?? []).length > 0) {
          user.client.sendSystemMessage?.('You already own a house.');
          return;
        }
        const placement = canPlaceMultiAt(api, tiles, ox, oy, oz, user.map ?? 1, {
          house: true,
          allowRestrictedRegions: isHousingStaff(user),
        });
        if (!placement.ok) {
          user.client.sendSystemMessage?.(`Placement blocked: ${placement.reason}.`);
          return;
        }
        liveDeed._housePlacementPending = true;
        let result = null;
        let house = null;
        try {
          result = stampMultiAt(api, multiId, hue, tiles, ox, oy, oz, user.map ?? 1, { broadcast: false });
          house = registerMultiHouse(api, result.anchor, user, {
            source: 'house-deed', title: item.name ?? nameForMulti(multiId),
          });
          if (!house) throw new Error('house registry rejected the structure');
          if (!consumePlacedHouseDeed(api, state, deedSerial)) throw new Error('deed could not be consumed');
          broadcastPlacedMulti(api, result.visibleItems, user.map ?? 1);
          user.client.sendSystemMessage?.(
            `You place a multi 0x${multiId.toString(16)} (${result.placed} components).`,
          );
          user.client.sendSystemMessage?.(
            `You are now the owner. Use the house sign to manage friends, co-owners, and lockdowns.`,
          );
          api.log?.(`[house-deed] ${user.name ?? 'admin'} placed 0x${multiId.toString(16)} at (${ox},${oy},${oz})`);
        } catch (error) {
          if (house) api.houses?.remove?.(house.id);
          if (result?.instanceId != null) {
            destroyMultiByBrandDetailed(api, multiId, user.map ?? 1, result.instanceId, {
              extraSerials: result.items?.map((created) => created.serial) ?? [],
              removeRegistry: true,
              registryId: house?.id ?? null,
            });
          }
          api.log?.(`[house-deed] placement transaction rolled back: ${error.message}`);
          user.client.sendSystemMessage?.('House placement failed safely; the deed remains in your pack.');
        } finally {
          if (itemBySerial(api, deedSerial) === liveDeed) delete liveDeed._housePlacementPending;
        }
      });
      try {
        state.send?.(proto.multiPlacementRequest({
          id: cursorId, multiId, hue, offsetX: 0, offsetY: 0, offsetZ: 0, allowGround: true,
        }));
        user.client.sendSystemMessage?.('Target a clear tile to place the house.');
      } catch (e) {
        api.log?.(`[house-deed] 0x99 send failed: ${e.message}`);
        state.targetCallbacks.delete(cursorId);
      }
      return true;
    },
  });

  // `[housedeed [multiId] [name]` — spawn a house deed.
  //   • no args            → opens a gump-driven catalogue picker
  //   • <multiId> [name]   → spawns the deed directly (terminal mode,
  //                          handy for scripts / repeat invocations).
  api.commands.register({
    name: 'housedeed',
    help: '[housedeed [multiId] [name] — spawn a multi deed in your pack. No args opens a picker gump.',
    access: 'GM',
    run(ctx) {
      const mob = ctx.sender;
      if (!ctx.args.length) {
        openHousedeedPicker(api, ctx.state, mob, 0, '');
        return;
      }
      const arg = String(ctx.args[0] ?? '').trim();
      const multiId = /^0x/i.test(arg) ? parseInt(arg.slice(2), 16) : parseInt(arg, 10);
      if (!Number.isFinite(multiId) || multiId <= 0) {
        ctx.state.sendSystemMessage('Usage: [housedeed [multiId|0xHEX] [name] (omit args to open the picker)');
        return;
      }
      if (!isHouseMulti(multiId)) {
        ctx.state.sendSystemMessage('That multi is not a house. Use [multigump for boats and scenery.');
        return;
      }
      const multis = loadMultis(api);
      if (!multis?.[multiId]) {
        ctx.state.sendSystemMessage(`Unknown multi 0x${multiId.toString(16)}.`);
        return;
      }
      const name = ctx.args.slice(1).join(' ').trim() || `deed to a building`;
      spawnHousedeedIntoPack(api, ctx.state, mob, multiId, name);
    },
  });

  function requestDestroyMulti(ctx, commandName = 'destroymulti') {
    ctx.state.sendSystemMessage('Target a tile of the multi to demolish.');
    api.targeting?.request(ctx.state, (picked) => {
      if (!picked?.serial) { ctx.state.sendSystemMessage('Cancelled.'); return; }
      const it = itemBySerial(api, picked.serial >>> 0);
      if (!it) { ctx.state.sendSystemMessage('No item at that serial.'); return; }
      if (it._multi == null) {
        ctx.state.sendSystemMessage('That tile is not part of a placed multi.');
        return;
      }
      const result = destroyMultiByBrandDetailed(
        api, it._multi, it.map ?? 1, multiInstanceId(it), { removeRegistry: true },
      );
      if (result.failed.length) {
        ctx.state.sendSystemMessage(`Demolition incomplete: ${result.removed}/${result.expected} structure items removed. The housing registry was preserved.`);
      } else {
        ctx.state.sendSystemMessage(`Demolished multi 0x${(it._multi|0).toString(16)} — ${result.removed} tiles removed${result.registryRemoved ? ' and housing record cleared' : ''}.`);
      }
      api.log?.(`[${commandName}] ${ctx.sender?.name ?? 'admin'} demolished 0x${(it._multi|0).toString(16)} on facet ${it.map}: ${result.removed}/${result.expected} tiles; registry=${result.registryRemoved}`);
    }, { kind: 0 });
  }

  // `[destroymulti` / `[removemulti` — target any tile of a placed multi and remove every
  // tile sharing that `_multi` brand. Equivalent to ServUO's "Demolish"
  // option in the House menu, allowing a placed structure to be demolished.
  // Idempotent (running on an already-destroyed multi reports 0 removed).
  api.commands.register({
    name: 'destroymulti',
    help: '[destroymulti — target any tile of a placed multi to demolish the whole structure.',
    access: 'GM',
    hidden: true,
    run(ctx) { requestDestroyMulti(ctx, 'destroymulti'); },
  });
  api.commands.register({
    name: 'removemulti',
    help: '[removemulti — alias for [destroymulti.',
    access: 'GM',
    hidden: true,
    run(ctx) { requestDestroyMulti(ctx, 'removemulti'); },
  });

  // HouseRegistry owns the single decay clock. This handler couples removal
  // of the physical structure to removal of its registry row: the latter is
  // committed only when every known structural item was removed.
  const decayHandler = (house) => {
    const extraSerials = [...(house.spawnedItems ?? []), ...(house.customItemSerials ?? [])];
    const result = destroyMultiByBrandDetailed(
      api, house.multiId, house.map, house.multiInstance, { extraSerials },
    );
    const complete = result.expected > 0 && result.removed === result.expected && result.failed.length === 0;
    if (!complete) {
      api.log?.(`[house-decay] house #${house.id} teardown incomplete (${result.removed}/${result.expected})`);
      return false;
    }
    const ownerMob = mobileBySerial(api, house.ownerSerial >>> 0);
    ownerMob?.client?.sendSystemMessage?.('Your house has decayed and collapsed.');
    api.log?.(`[house-decay] house #${house.id} (${house.ownerName ?? 'unknown'}) collapsed; ${result.removed} structural items removed`);
    return true;
  };
  api.houses?.setDecayHandler?.(decayHandler);

  // `[housedecay` — admin override to force a decay sweep immediately
  // (testing) or to print the current decay state per house. Useful
  // when stress-testing the decay path without waiting 30 min.
  api.commands.register({
    name: 'housedecay',
    help: '[housedecay [status|force] — inspect or force the house decay sweeper.',
    access: 'GM',
    hidden: true,
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'status').toLowerCase();
      if (sub === 'force') {
        const expired = api.houses?.sweepDecay?.(Number.MAX_SAFE_INTEGER) ?? [];
        ctx.state.sendSystemMessage(`Forced decay swept ${expired.length} houses.`);
        return;
      }
      // status — print per-multi remaining days.
      const seen = new Set();
      const out = [];
      for (const it of allItems(api)) {
        const acl = it._multiAcl;
        if (!acl) continue;
        const key = multiInstanceId(it) == null
          ? `legacy:${it.map ?? 1}:${it._multi | 0}`
          : `instance:${multiInstanceId(it)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const remaining = ((acl.lastVisitAt + (DECAY_DAYS * 86_400_000)) - Date.now()) / 86_400_000;
        out.push(`0x${(it._multi|0).toString(16)} facet ${it.map ?? 1} — ${remaining.toFixed(1)}d remaining (owner: ${acl.owner?.name ?? '?'})`);
      }
      ctx.state.sendSystemMessage(`Tracked houses: ${out.length}`);
      for (const ln of out.slice(0, 20)) ctx.state.sendSystemMessage('  ' + ln);
      if (out.length > 20) ctx.state.sendSystemMessage(`  ... ${out.length - 20} more`);
    },
  });

  // Typed admin-editor bridge. The ISO editor uses the same catalogue,
  // collision validation, compact anchor representation and HouseRegistry
  // registration as deeds/[placemulti; it never duplicates multi placement
  // rules in an HTTP route.
  api.systems ??= {};
  const previousMultiEditor = api.systems.multiEditor;
  api.systems.multiEditor = {
    invalidate() {
      _multiCache = null;
      _multiMetadataCache = null;
      _multiCustomNames = new Map();
    },
    catalog() {
      if (_multiMetadataCache) return _multiMetadataCache;
      const catalogue = loadMultis(api) ?? {};
      _multiMetadataCache = Object.entries(catalogue).map(([id, tiles]) => {
        const multiId = Number(id) | 0;
        let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
        for (const tile of tiles ?? []) {
          x1 = Math.min(x1, tile.x | 0); y1 = Math.min(y1, tile.y | 0);
          x2 = Math.max(x2, tile.x | 0); y2 = Math.max(y2, tile.y | 0);
        }
        return { id: multiId, name: _multiCustomNames.get(multiId) || nameForMulti(multiId) || `Multi 0x${multiId.toString(16)}`,
          kind: isHouseMulti(multiId) ? 'house' : isBoatMulti(multiId) ? 'boat' : 'other',
          tileCount: tiles?.length ?? 0, bounds: [x1, y1, x2, y2] };
      });
      return _multiMetadataCache;
    },
    preview(multiId) {
      const tiles = loadMultis(api)?.[Number(multiId) | 0] ?? null;
      if (!tiles) return null;
      return tiles.slice(0, 16_384).map((tile) => ({ id: Number(tile.id ?? tile.itemId) | 0,
        x: tile.x | 0, y: tile.y | 0, z: tile.z | 0, visible: tile.visible !== false }));
    },
    place(owner, { multiId, hue = 0, x, y, z = 0, map = 1 } = {}) {
      if (!owner?.serial) return { ok: false, error: 'An online owner character is required.' };
      const id = Number(multiId) | 0;
      const tiles = loadMultis(api)?.[id];
      if (!tiles) return { ok: false, error: `Unknown multi 0x${id.toString(16)}.` };
      if (isBoatMulti(id)) {
        if (!api.boats?.placeCanonical) return { ok: false, error: 'The authoritative boat placement service is unavailable.' };
        try {
          const boat = api.boats.placeCanonical(api, { multiId: id, x: x | 0, y: y | 0,
            z: z | 0, map: map | 0, ownerSerial: owner.serial >>> 0, name: nameForMulti(id) });
          boat.hue = hue | 0;
          const attachments = [...(boat.boat?.cannons ?? []), ...(boat.boat?.planks ?? [])]
            .map((serial) => itemBySerial(api, serial)).filter(Boolean);
          broadcastPlacedMulti(api, [boat, ...attachments], map | 0);
          return { ok: true, multiId: boat.multiId | 0, requestedMultiId: id,
            placed: tiles.length, serial: boat.serial >>> 0, houseId: null, kind: 'boat' };
        } catch (error) {
          return { ok: false, error: `Boat placement failed safely: ${error?.message ?? error}` };
        }
      }
      const placement = canPlaceMultiAt(api, tiles, x | 0, y | 0, z | 0, map | 0, { house: isHouseMulti(id) });
      if (!placement.ok) return { ok: false, error: placement.reason };
      let result = null;
      try {
        result = stampMultiAt(api, id, hue | 0, tiles, x | 0, y | 0, z | 0, map | 0);
        const house = isHouseMulti(id)
          ? registerMultiHouse(api, result.anchor, owner, { source: 'iso-editor' })
          : null;
        if (isHouseMulti(id) && !house) {
          throw new Error('The house registry rejected the new structure.');
        }
        return { ok: true, multiId: id, placed: result.placed,
          serial: result.anchor.serial >>> 0, houseId: house?.id ?? null };
      } catch (error) {
        // stampMultiAt is atomic internally.  Registration happens after the
        // stamp, however, so roll the exact instance back if HouseRegistry
        // rejects or throws.  This also sends normal removal packets for a
        // structure that may already have been broadcast to nearby clients.
        let rollback = null;
        if (result?.instanceId) {
          rollback = destroyMultiByBrandDetailed(api, id, map | 0, result.instanceId, {
            extraSerials: result.items?.map((item) => item.serial) ?? [],
            removeRegistry: isHouseMulti(id),
          });
        }
        return { ok: false,
          error: `Multi placement rolled back: ${error?.message ?? error}`,
          rollback };
      }
    },
    remove({ multiId, map = 1, instanceId, houseId = null } = {}) {
      const placed = itemBySerial(api, Number(instanceId) >>> 0);
      if (placed?.boat) {
        const result = api.boats?.removeEditorBoat?.(placed.serial)
          ?? { ok: false, error: 'The authoritative boat removal service is unavailable.', expected: 0, removed: 0, failed: [] };
        return { ...result, reason: result.error, notificationErrors: 0,
          registryFound: false, registryRemoved: false };
      }
      return destroyMultiByBrandDetailed(api, Number(multiId) | 0, Number(map) | 0,
        Number(instanceId) >>> 0 || null, { removeRegistry: true, registryId: houseId });
    },
  };

  return () => {
    // Without unsubscribing, hot-reload piled up old listeners that
    // re-fired `placeMultiInteractive` 2×/3×/… and stale targetCallbacks
    // leaked on the state. `world.events.on` returns the unsubscribe fn.
    try { off?.(); } catch { /* ignore */ }
    try { removeSignHook(); } catch { /* ignore */ }
    try { removeAssetListener(); } catch { /* ignore */ }
    if (api.houses?._decayHandler === decayHandler) api.houses.setDecayHandler(null);
    api.commands.unregister('placemulti');
    api.commands.unregister('fixmultis');
    api.commands.unregister('signinfo');
    api.commands.unregister('destroymulti');
    api.commands.unregister('removemulti');
    api.commands.unregister('housedeed');
    api.commands.unregister('housedecay');
    try { api.itemScripts?.unregister?.('house-deed'); } catch { /* ignore */ }
    if (previousMultiEditor) api.systems.multiEditor = previousMultiEditor;
    else delete api.systems.multiEditor;
  };
}

/** The deed icon may be dyed, but canonical house components are not. */
export function houseDeedPlacementHue(_deed) {
  return 0;
}

/** Consume a successfully used house deed and immediately invalidate its
 * client-side container entry. Removing only the authoritative world object
 * leaves an already-open backpack rendering the stale deed until its next
 * full contents snapshot. */
export function consumePlacedHouseDeed(api, state, deedSerial) {
  const serial = Number(deedSerial) >>> 0;
  if (!serial) return false;
  const removed = destroyItemBySerial(api, serial);
  if (!removed) return false;
  if (api.protocol?.removeEntity) {
    try { state?.send?.(api.protocol.removeEntity(serial)); }
    catch (error) {
      api.log?.(`[house-deed] remove notification failed for 0x${serial.toString(16)}: ${error.message}`);
    }
  }
  return true;
}

/** Resolve the cached `multi.json` once. Same structure `placemulti` /
 *  `housedeed` already pull from — we expose the picker helper here so
 *  both share the on-disk catalogue without re-fetching. */
function getMultiCatalogueKeys(api) {
  const multis = loadMultis(api);
  if (!multis) return [];
  return Object.keys(multis)
    .map((k) => +k)
    .filter((k) => Number.isFinite(k) && k > 0 && isHouseMulti(k))
    .sort((a, b) => a - b);
}

/** Create a house-deed item in the player's backpack pre-stamped with
 *  the chosen multi id. Shared by the terminal-mode [housedeed call
 *  and the picker gump so the broadcast / response shape stays in
 *  lockstep with the rest of placemulti's contract. */
export function spawnHousedeedIntoPack(
  api, state, mob, multiId, name = 'deed to a building',
  { notify = true, announce = true } = {},
) {
  const deed = api.game?.mobile?.giveItem?.(mob, {
    itemId: 0x14F0,             // HousePlacementTool icon
    hue: 1153,                   // gold tint — matches ServUO
    name,
    movable: true,
    script: 'house-deed',
  }, { randomGrid: true, notify });
  if (!deed) {
    if (announce) state?.sendSystemMessage?.('You have no backpack.');
    return null;
  }
  deed._deedMulti = multiId | 0;
  if (announce) state?.sendSystemMessage?.(`Spawned a deed for multi 0x${multiId.toString(16)} in your backpack.`);
  return deed;
}

/** Demolish one exact multi instance and return its deed without ever exposing
 * a duplicate deed for a structure that still exists. The deed is staged in
 * the backpack without a client update, all authoritative item removals run,
 * and only a fully successful result reveals it. A failed removal destroys the
 * staged deed again, so retrying cannot duplicate placement deeds. */
export function demolishMultiWithDeed(api, state, mob, {
  multiId,
  facet,
  instanceId = null,
  name = 'deed to a building',
  extraSerials = [],
} = {}) {
  const pack = findBackpack(api, mob);
  if (!pack) return { ok: false, reason: 'no-backpack', expected: 0, removed: 0, failed: [] };

  const deed = spawnHousedeedIntoPack(api, state, mob, multiId, name, {
    notify: false,
    announce: false,
  });
  if (!deed) return { ok: false, reason: 'deed-create-failed', expected: 0, removed: 0, failed: [] };

  const result = destroyMultiByBrandDetailed(api, multiId, facet, instanceId, { extraSerials });
  if (result.expected === 0 || result.failed.length > 0 || result.removed !== result.expected) {
    try { destroyItemBySerial(api, deed.serial); } catch { /* best-effort rollback of an unseen deed */ }
    return {
      ok: false,
      reason: result.expected === 0 ? 'structure-missing' : 'incomplete-removal',
      ...result,
    };
  }

  // The container update is deliberately after the authoritative deletion.
  // A stale/broken socket may miss this visual refresh, but can no longer
  // interrupt demolition; reopening the backpack will still show the deed.
  try {
    const packet = api.protocol?.containerContentUpdate?.(deed, pack.serial);
    if (packet) state?.send?.(packet);
  } catch (error) {
    api.log?.(`[house-demolish] deed reveal failed for 0x${deed.serial.toString(16)}: ${error.message}`);
  }
  return { ok: true, deed, ...result };
}

/** Pop the deed-picker gump. Mirrors the structure of [createworld
 *  gump]: header + filter input + paginated row list + action buttons.
 *  A gump is considerably safer than typing hex IDs for the 680 multis
 *  catalogued in multi.json.
 *
 *  Button ids:
 *    0        Cancel / close
 *    1        Apply filter (re-open with the typed string)
 *    50/51    Previous / Next page
 *    100+i    Spawn deed for the i-th row on the current page
 */
function openHousedeedPicker(api, state, mob, page = 0, filter = '') {
  if (!api.gumps?.send) {
    state.sendSystemMessage('Gump runtime unavailable — use `[housedeed <id>` instead.');
    return;
  }
  const keys = getMultiCatalogueKeys(api);
  const needle = String(filter ?? '').trim().toLowerCase();
  const filtered = needle
    ? keys.filter((k) => {
        const hex = '0x' + k.toString(16);
        const name = nameForMulti(k).toLowerCase();
        return hex.includes(needle) || k.toString(10).includes(needle) || name.includes(needle);
      })
    : keys;
  const PAGE_SIZE = 12;
  const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const cur = Math.max(0, Math.min(maxPage, page | 0));
  const slice = filtered.slice(cur * PAGE_SIZE, cur * PAGE_SIZE + PAGE_SIZE);
  const multis = loadMultis(api);

  const W = 570;
  const headerH = 56;
  const rowH = 22;
  const footerH = 56;
  const H = headerH + slice.length * rowH + footerH;
  const lines = [`{ resizepic 0 0 5054 ${W} ${H} }`];
  const texts = [];

  // Title + counter
  texts.push('── House deed catalogue ──');
  lines.push(`{ text 20 12 1153 ${texts.length - 1} }`);
  texts.push(
    filtered.length === keys.length
      ? `${keys.length} multis · page ${cur + 1}/${maxPage + 1}`
      : `${filtered.length} of ${keys.length} match · page ${cur + 1}/${maxPage + 1}`,
  );
  lines.push(`{ text 20 30 70 ${texts.length - 1} }`);

  // Filter text entry (entryId 0). Pre-fills with current filter so
  // the operator can refine. Button 1 (Apply) re-opens with the typed
  // value as the new filter; clearing it shows the full catalogue.
  texts.push(filter);
  lines.push(`{ textentry 260 14 130 18 1153 0 ${texts.length - 1} }`);
  lines.push(`{ button 395 14 4023 4024 1 0 1 }`);
  texts.push('Filter');
  lines.push(`{ text 405 14 1153 ${texts.length - 1} }`);

  // Per-row buttons include the canonical house name and make custom
  // foundations discoverable without memorising the 0x13EC range.
  slice.forEach((id, idx) => {
    const y = headerH + idx * rowH;
    const tileCount = multis?.[id]?.length ?? 0;
    lines.push(`{ button 20 ${y} 4023 4024 1 0 ${100 + idx} }`);
    const kind = isCustomHouseMulti(id) ? 'CUSTOM' : 'CLASSIC';
    texts.push(`0x${id.toString(16).padStart(4, '0')}  [${kind}]  ${nameForMulti(id)}  (${tileCount} tiles)`);
    lines.push(`{ text 52 ${y + 4} 70 ${texts.length - 1} }`);
  });

  // Pagination footer
  const footerY = headerH + slice.length * rowH + 12;
  if (cur > 0) {
    lines.push(`{ button 20 ${footerY} 4014 4015 1 0 50 }`);
    texts.push('Prev');
    lines.push(`{ text 50 ${footerY + 4} 1153 ${texts.length - 1} }`);
  }
  if (cur < maxPage) {
    lines.push(`{ button 130 ${footerY} 4005 4006 1 0 51 }`);
    texts.push('Next');
    lines.push(`{ text 160 ${footerY + 4} 1153 ${texts.length - 1} }`);
  }
  lines.push(`{ button ${W - 90} ${footerY} 4017 4018 1 0 0 }`);
  texts.push('Cancel');
  lines.push(`{ text ${W - 58} ${footerY + 4} 1153 ${texts.length - 1} }`);

  api.gumps.send(state, { definitionId: 'server:commands-housing-placemulti:open-housedeed-picker-1', x: 80, y: 80, layout: lines.join(''), texts }, (resp) => {
    const btn = resp.buttonId | 0;
    if (btn === 0) return;
    const typed = (resp.textEntries ?? []).find((e) => e.entryId === 0)?.text ?? filter;
    if (btn === 1) {
      // Apply the new filter — re-open at page 0 of the filtered view.
      openHousedeedPicker(api, state, mob, 0, typed);
      return;
    }
    if (btn === 50) { openHousedeedPicker(api, state, mob, cur - 1, typed); return; }
    if (btn === 51) { openHousedeedPicker(api, state, mob, cur + 1, typed); return; }
    if (btn >= 100 && btn < 100 + slice.length) {
      const picked = slice[btn - 100];
      if (Number.isFinite(picked)) {
        spawnHousedeedIntoPack(api, state, mob, picked);
        // Re-open the picker so the operator can spawn another deed
        // in one session — common workflow when stocking a vendor.
        openHousedeedPicker(api, state, mob, cur, typed);
      }
    }
  });
}

/** House-sign gump. Identifies the multi + offers a Demolish button so
 *  the GM doesn't have to type `[destroymulti` and re-target — clicking
 *  the sign IS the target. Demolish wipes every tile branded with the
 *  same `_multi` value on the same facet (idempotent, broadcasts the
 *  per-tile entity:removed so client tile-renderer drops each sprite). */
/** ServUO `BaseHouse` sign menu. Mirrors the most-used options from
 *  `Items/Multis/Houses/Houses/HouseSign.cs` + the right-click context
 *  menu on real shards. Buttons map to button-id ranges:
 *    100..199 — destructive / authority actions (Demolish, Transfer)
 *    200..299 — visual / metadata (Re-colour, Change sign hue, Rename)
 *    300..399 — informational (Owner / Coords / Tile count)
 *  Cancel (0) just closes. */
function openHouseSignGump(api, world, signItem, user) {
  const registeredHouse = ensureHouseForMulti(api, signItem, user);
  if (registeredHouse && openHouseManagement(api, user.client, user, registeredHouse)) return;
  const multiId = signItem._multi | 0;
  const map = signItem.map ?? 1;
  const acl = getAcl(signItem);
  const access = user?.client?.account?.accessLevel ?? 'Player';
  const tier = getAclLevel(user, acl, access);
  const customName = signItem._multiName ?? `House 0x${multiId.toString(16)}`;
  const tileCount = countMultiTiles(api, multiId, map, multiInstanceId(signItem));
  const ownerName = acl?.owner?.name ?? signItem._multiOwner?.name ?? null;
  // Bump the owner's last-visit timestamp — the decay timer resets
  // every time the owner physically interacts with the sign. Mirrors
  // ServUO `BaseHouse.RefreshHouseOneDay`.
  if (acl && tier === ACL_OWNER) bumpVisit(acl);
  const headerLines = [
    `── ${customName} ──`,
    `Multi 0x${multiId.toString(16)} at (${signItem.x},${signItem.y},${signItem.z}) · facet ${map}`,
    `Tiles on this facet: ${tileCount}`,
    ownerName
      ? `Owner: ${ownerName}`
      : 'Owner: (none — staff-placed)',
    acl
      ? `Friends: ${acl.friends.length} · Co-owners: ${acl.coOwners.length} · Lockdowns: ${acl.lockedDown.length}/${acl.lockdownCap}`
      : 'ACL: (legacy multi — no permissions)',
    `Your access: ${acl ? (ACL_LABELS[tier] ?? 'Unknown') : 'Unowned'}`,
  ];
  if (!api.gumps?.send) {
    for (const ln of headerLines) user.client?.sendSystemMessage?.(ln);
    user.client?.sendSystemMessage?.('Use [destroymulti to demolish via terminal.');
    return;
  }
  // Build the action list gated by ACL tier. STRANGER sees a slim
  // info-only gump; FRIEND can lock/release; CO-OWNER manages friends;
  // OWNER does everything including transfer + demolish.
  const actions = [];
  if (tier >= ACL_STRANGER) {
    actions.push({ id: 300, label: 'Show multi info',     art: [4023, 4024], hue: 1153 });
    actions.push({ id: 301, label: 'Highlight tiles',     art: [4023, 4024], hue: 1153 });
  }
  if (tier >= ACL_CO_OWNER) {
    actions.push({ id: 400, label: 'Lock down item',      art: [4023, 4024], hue: 1153 });
    actions.push({ id: 401, label: 'Release locked item', art: [4023, 4024], hue: 1153 });
  }
  if (tier >= ACL_CO_OWNER) {
    actions.push({ id: 410, label: 'Add friend',          art: [4023, 4024], hue: 1153 });
    actions.push({ id: 411, label: 'Remove friend',       art: [4023, 4024], hue: 1153 });
    actions.push({ id: 420, label: 'Ban from house',      art: [4023, 4024], hue: 1153 });
    actions.push({ id: 421, label: 'Lift ban',            art: [4023, 4024], hue: 1153 });
  }
  if (tier >= ACL_OWNER) {
    if (registeredHouse?.customizable) {
      actions.push({ id: 202, label: 'Customize foundation', art: [4023, 4024], hue: 1153 });
    }
    actions.push({ id: 412, label: 'Add co-owner',        art: [4023, 4024], hue: 1153 });
    actions.push({ id: 413, label: 'Remove co-owner',     art: [4023, 4024], hue: 1153 });
    actions.push({ id: 200, label: 'Re-colour walls',     art: [4023, 4024], hue: 1153 });
    actions.push({ id: 201, label: 'Rename house',        art: [4023, 4024], hue: 1153 });
    actions.push({ id: 101, label: 'Transfer ownership',  art: [4023, 4024], hue: 1153 });
    actions.push({ id: 100, label: 'Demolish',            art: [4017, 4018], hue:   33 });
  }
  const W = 480;
  const colW = 230;
  const rowH = 28;
  const baseY = headerLines.length * 18 + 26;
  const rows = Math.ceil(actions.length / 2);
  const H = baseY + rows * rowH + 24;
  const parts = [`{ resizepic 0 0 5054 ${W} ${H} }`];
  const texts = [];
  headerLines.forEach((ln, i) => {
    texts.push(ln);
    parts.push(`{ text 20 ${12 + i * 18} ${i === 0 ? 1153 : 70} ${texts.length - 1} }`);
  });
  actions.forEach((a, i) => {
    const col = i & 1;
    const row = i >> 1;
    const bx = 20 + col * colW;
    const by = baseY + row * rowH;
    parts.push(`{ button ${bx} ${by} ${a.art[0]} ${a.art[1]} 1 0 ${a.id} }`);
    texts.push(a.label);
    parts.push(`{ text ${bx + 32} ${by + 4} ${a.hue} ${texts.length - 1} }`);
  });
  parts.push(`{ button ${W - 32} 8 4017 4018 1 0 0 }`);
  api.gumps.send(user.client, { definitionId: 'server:commands-housing-placemulti:open-house-sign-gump-2', x: 100, y: 100, layout: parts.join(''), texts }, (resp) => {
    handleHouseSignButton(api, world, signItem, user, resp);
  });
}

const ACL_LABELS = {
  [ACL_OWNER]:    'Owner',
  [ACL_CO_OWNER]: 'Co-owner',
  [ACL_FRIEND]:   'Friend',
  [ACL_STRANGER]: 'Stranger',
  [ACL_NONE]:     'Banned / no access',
};

function hasSignTier(signItem, user, minimum) {
  return getAclLevel(
    user, getAcl(signItem), user?.client?.account?.accessLevel ?? 'Player',
  ) >= minimum;
}

/** Dispatch a button click from the house-sign gump. Each branch is
 *  intentionally narrow + idempotent so re-clicks don't cascade. */
function handleHouseSignButton(api, world, signItem, user, resp) {
  const btn = resp.buttonId | 0;
  if (btn === 0) return;                                // cancel / close
  const multiId = signItem._multi | 0;
  const map = signItem.map ?? 1;
  const acl = getAcl(signItem);
  const tier = getAclLevel(user, acl, user?.client?.account?.accessLevel ?? 'Player');
  const requiredTier = btn >= 100 && btn < 300
    ? ACL_OWNER
    : ([412, 413].includes(btn) ? ACL_OWNER
      : ([410, 411, 420, 421].includes(btn) ? ACL_CO_OWNER
        : ([400, 401].includes(btn) ? ACL_CO_OWNER : ACL_STRANGER)));
  if (tier < requiredTier) {
    user.client?.sendSystemMessage?.('You no longer have permission to perform that house action.');
    return;
  }
  switch (btn) {
    case 100: {     // Demolish
      const house = api.houses?.houseByMultiInstance?.(multiInstanceId(signItem));
      const demolition = demolishMultiWithDeed(api, user.client, user, {
        multiId,
        facet: map,
        instanceId: multiInstanceId(signItem),
        name: `deed to ${house?.sign?.title ?? nameForMulti(multiId) ?? 'a building'}`,
        extraSerials: house
          ? [...(house.spawnedItems ?? []), ...(house.customItemSerials ?? [])]
          : [],
      });
      if (!demolition.ok) {
        user.client?.sendSystemMessage?.(
          `Demolition stopped (${demolition.reason}). No placement deed was returned; you may retry safely.`,
        );
        return;
      }
      if (house) api.houses.remove(house.id);
      user.client?.sendSystemMessage?.(
        `House demolished — ${demolition.removed} parts removed and its placement deed returned.`,
      );
      api.log?.(`[sign] ${user.name ?? 'admin'} demolished 0x${multiId.toString(16)}: ${demolition.removed} tiles`);
      return;
    }
    case 101: {     // Transfer ownership
      user.client?.sendSystemMessage?.('Target the new owner.');
      api.targeting?.request(user.client, (picked) => {
        if (!hasSignTier(signItem, user, ACL_OWNER)) {
          user.client?.sendSystemMessage?.('House ownership changed; transfer cancelled.'); return;
        }
        if (!picked?.serial) { user.client?.sendSystemMessage?.('Cancelled.'); return; }
        const newOwner = mobileBySerial(api, picked.serial >>> 0);
        if (!newOwner) { user.client?.sendSystemMessage?.('Not a mobile.'); return; }
        const ownerRef = { serial: newOwner.serial >>> 0, name: newOwner.name };
        // Update both legacy `_multiOwner` AND the canonical `_multiAcl.owner`
        // — readers still check the legacy field for header rendering
        // but the ACL is what gates all permission checks.
        const liveAcl = getAcl(signItem);
        if (liveAcl) liveAcl.owner = ownerRef;
        for (const it of allItems(api)) {
          if (sameMultiInstance(it, signItem)) {
            it._multiOwner = ownerRef;
          }
        }
        const house = syncMultiAclToRegistry(api, signItem);
        house?.coowners?.delete?.(newOwner.serial >>> 0);
        house?.friends?.delete?.(newOwner.serial >>> 0);
        house?.bans?.delete?.(newOwner.serial >>> 0);
        if (house) syncRegistryHouseToMulti(api, house);
        user.client?.sendSystemMessage?.(`Ownership transferred to ${ownerRef.name ?? 'mobile'}.`);
        api.log?.(`[sign] ${user.name ?? 'admin'} transferred 0x${multiId.toString(16)} → ${ownerRef.name}`);
      }, { kind: 1 });
      return;
    }
    // ACL roster management — each pair (add / remove) targets a mob.
    case 410: aclAddTarget(api, signItem, user, 'friends',  'friend'); return;
    case 411: aclRemoveTarget(api, signItem, user, 'friends', 'friend'); return;
    case 412: aclAddTarget(api, signItem, user, 'coOwners', 'co-owner'); return;
    case 413: aclRemoveTarget(api, signItem, user, 'coOwners', 'co-owner'); return;
    case 420: aclAddTarget(api, signItem, user, 'bans',     'banned mob'); return;
    case 421: aclRemoveTarget(api, signItem, user, 'bans',  'banned mob'); return;
    // Lockdown / release — pick an item already on the floor of the
    // house. Lockdown pins it (movable=false + flag) so only FRIEND+
    // can release it via this command. Cap is enforced by the helper.
    case 400: aclLockdownTarget(api, signItem, user); return;
    case 401: aclReleaseTarget(api, signItem, user); return;
    case 200: {     // Re-colour walls — open hue picker
      const sendHuePicker = api.huePicker?.send;
      if (!sendHuePicker) {
        user.client?.sendSystemMessage?.('Hue picker unavailable.');
        return;
      }
      sendHuePicker(user.client, { start: 0, count: 1000 }, (hue) => {
        if (!hasSignTier(signItem, user, ACL_OWNER)) return;
        if (hue == null) return;
        let blueprintComponents = 0;
        let dynamicComponents = 0;
        const changedVisible = [];
        for (const it of allItems(api)) {
          if (!sameMultiInstance(it, signItem)) continue;
          if (it.hue === hue) continue;
          it.hue = hue;
          if (it._multiAnchor) blueprintComponents = Math.max(1, it._multiComponentCount | 0);
          else dynamicComponents++;
          // Collision proxies are not client entities; broadcasting them
          // here would recreate the duplicate sprites the anchor replaced.
          if (it._multiAnchor || it.visible !== false) changedVisible.push(it);
        }
        for (const it of changedVisible) {
          for (const m of allMobiles(api)) {
            if (!m.client || (m.map ?? 1) !== map) continue;
            if (Math.abs(m.x - it.x) > 24 || Math.abs(m.y - it.y) > 24) continue;
            if (typeof m.client.sendItem === 'function') {
              m.client.sendItem(it);
            } else if (api.protocol?.worldItemSA) {
              m.client.send(api.protocol.worldItemSA({
                serial: it.serial,
                itemId: it._multiAnchor ? (it.multiId | 0) : it.itemId,
                hue: it.hue, amount: 1, x: it.x, y: it.y, z: it.z,
                flags: 0x00, dataType: it._multiAnchor ? 2 : 0,
              }));
            }
          }
        }
        const touched = blueprintComponents || dynamicComponents;
        user.client?.sendSystemMessage?.(`Re-hued ${touched} tile${touched === 1 ? '' : 's'} to 0x${hue.toString(16)}.`);
      });
      return;
    }
    case 201: {     // Rename
      const applyName = (newName) => {
        if (!hasSignTier(signItem, user, ACL_OWNER)) return;
        if (newName == null) return;
        const trimmed = String(newName).slice(0, 60);
        for (const it of allItems(api)) {
          if (sameMultiInstance(it, signItem)) {
            it._multiName = trimmed;
          }
        }
        const house = api.houses?.houseByMultiInstance?.(multiInstanceId(signItem));
        if (house) house.sign = { ...(house.sign ?? {}), title: trimmed };
        user.client?.sendSystemMessage?.(`House renamed to "${trimmed}".`);
      };
      if (api.gumps?.sendTextEntry) {
        api.gumps.sendTextEntry(user.client, {
          title: 'House name',
          prompt: 'New name:',
          initial: signItem._multiName ?? '',
        }, applyName);
      } else if (api.prompts?.ask) {
        api.prompts.ask(user.client, { text: 'New house name:' }, (reply) => {
          if (!reply?.cancelled) applyName(reply?.text);
        });
      } else {
        user.client?.sendSystemMessage?.('Text input is unavailable on this server configuration.');
      }
      return;
    }
    case 202: {     // Enter classic 0xBF/0x20 customization mode
      const house = api.houses?.houseByMultiInstance?.(multiInstanceId(signItem));
      if (!house?.customizable || !api.houses.beginEditing?.(house, user)) {
        user.client?.sendSystemMessage?.('This foundation cannot enter design mode.');
        return;
      }
      user.client._activeHouseId = house.id;
      const serial = house.multiSerial ?? signItem.serial;
      const packet = api.protocol?.extHouseCustomization?.({
        serial, type: 4, x: -1, y: -1, z: -1,
      });
      if (packet) user.client.send?.(packet);
      const revision = api.protocol?.extHouseRevision?.({
        serial, revision: house.revision | 0,
      });
      if (revision) user.client.send?.(revision);
      return;
    }
    case 300: {     // Show multi info — re-dump headers to chat
      user.client?.sendSystemMessage?.(`Multi 0x${multiId.toString(16)} · ${countMultiTiles(api, multiId, map, multiInstanceId(signItem))} components on facet ${map}`);
      return;
    }
    case 301: {     // Highlight tiles — temporary effect at each tile
      let n = 0;
      for (const it of allItems(api)) {
        if (!sameMultiInstance(it, signItem)) continue;
        if (it._multiAnchor) continue;
        try {
          api.protocol?.locationEffect && user.client?.send?.(
            api.protocol.locationEffect({
              x: it.x, y: it.y, z: it.z,
              hue: 1153, blendMode: 0, graphic: 0x376A, duration: 12, speed: 8,
            }),
          );
        } catch { /* effects optional */ }
        n++;
      }
      user.client?.sendSystemMessage?.(`Highlighted ${n} tiles.`);
      return;
    }
  }
}

// ---- ACL roster helpers (shared by sign-gump buttons 400..421) -----

/** Add a target mob to a roster (friends / coOwners / bans). */
function aclAddTarget(api, signItem, user, rosterName, label) {
  const acl = getAcl(signItem);
  if (!acl) { user.client?.sendSystemMessage?.('This house has no ACL.'); return; }
  user.client?.sendSystemMessage?.(`Target the ${label} to add.`);
  api.targeting?.request(user.client, (picked) => {
    const needed = rosterName === 'coOwners' ? ACL_OWNER : ACL_CO_OWNER;
    if (!hasSignTier(signItem, user, needed)) return;
    if (!picked?.serial) return;
    const target = mobileBySerial(api, picked.serial >>> 0);
    if (!target) { user.client?.sendSystemMessage?.('Not a mobile.'); return; }
    if ((target.serial >>> 0) === (acl.owner?.serial >>> 0)) {
      user.client?.sendSystemMessage?.(`The owner is implicitly above ${label}.`);
      return;
    }
    if (addToRoster(acl, rosterName, target)) {
      syncMultiAclToRegistry(api, signItem);
      user.client?.sendSystemMessage?.(`${target.name} added as ${label}.`);
      api.log?.(`[house-acl] +${rosterName} ${target.name} → 0x${(signItem._multi|0).toString(16)}`);
    } else {
      user.client?.sendSystemMessage?.(`${target.name} is already a ${label}.`);
    }
  }, { kind: 1 });
}

function aclRemoveTarget(api, signItem, user, rosterName, label) {
  const acl = getAcl(signItem);
  if (!acl) { user.client?.sendSystemMessage?.('This house has no ACL.'); return; }
  user.client?.sendSystemMessage?.(`Target the ${label} to remove.`);
  api.targeting?.request(user.client, (picked) => {
    const needed = rosterName === 'coOwners' ? ACL_OWNER : ACL_CO_OWNER;
    if (!hasSignTier(signItem, user, needed)) return;
    if (!picked?.serial) return;
    if (removeFromRoster(acl, rosterName, picked.serial)) {
      syncMultiAclToRegistry(api, signItem);
      const target = mobileBySerial(api, picked.serial >>> 0);
      user.client?.sendSystemMessage?.(`${target?.name ?? 'Mob'} removed from ${label} list.`);
      api.log?.(`[house-acl] -${rosterName} 0x${(picked.serial>>>0).toString(16)} ← 0x${(signItem._multi|0).toString(16)}`);
    } else {
      user.client?.sendSystemMessage?.(`Not on the ${label} list.`);
    }
  }, { kind: 1 });
}

/** Target an item inside the house footprint to lock it down. Cap is
 *  enforced inside `lockdownItem`. Items must already be on the floor
 *  (not in a backpack) — i.e. `parent == null`. */
function multiBoundsFor(api, reference) {
  const anchor = reference?._multiAnchor
    ? reference
    : [...allItems(api)].find((item) => sameMultiInstance(item, reference) && item._multiAnchor);
  if (anchor && Array.isArray(anchor._multiBounds) && anchor._multiBounds.length >= 4) {
    return {
      minX: (anchor.x | 0) + (anchor._multiBounds[0] | 0),
      minY: (anchor.y | 0) + (anchor._multiBounds[1] | 0),
      maxX: (anchor.x | 0) + (anchor._multiBounds[2] | 0),
      maxY: (anchor.y | 0) + (anchor._multiBounds[3] | 0),
    };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of allItems(api)) {
    if (!sameMultiInstance(it, reference) || it._multiAnchor) continue;
    minX = Math.min(minX, it.x | 0); maxX = Math.max(maxX, it.x | 0);
    minY = Math.min(minY, it.y | 0); maxY = Math.max(maxY, it.y | 0);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function aclLockdownTarget(api, signItem, user) {
  const acl = getAcl(signItem);
  if (!acl) { user.client?.sendSystemMessage?.('This house has no ACL.'); return; }
  if (acl.lockedDown.length >= acl.lockdownCap) {
    user.client?.sendSystemMessage?.(
      `Lockdown cap reached (${acl.lockedDown.length}/${acl.lockdownCap}). Release an item first.`,
    );
    return;
  }
  user.client?.sendSystemMessage?.('Target an item to lock down.');
  api.targeting?.request(user.client, (picked) => {
    if (!hasSignTier(signItem, user, ACL_CO_OWNER)) return;
    if (!picked?.serial) return;
    const item = itemBySerial(api, picked.serial >>> 0);
    if (!item) { user.client?.sendSystemMessage?.('Not an item.'); return; }
    if (item.parent != null) { user.client?.sendSystemMessage?.('Cannot lock items inside containers.'); return; }
    if (sameMultiInstance(item, signItem)) {
      user.client?.sendSystemMessage?.('Items belonging to the house structure cannot be locked down.');
      return;
    }
    const bounds = multiBoundsFor(api, signItem);
    if (!bounds || (item.map ?? 1) !== (signItem.map ?? 1)
        || (item.x | 0) < bounds.minX || (item.x | 0) > bounds.maxX
        || (item.y | 0) < bounds.minY || (item.y | 0) > bounds.maxY) {
      user.client?.sendSystemMessage?.('That item is outside this house.');
      return;
    }
    if (lockdownItem(acl, item)) {
      syncMultiAclToRegistry(api, signItem);
      user.client?.sendSystemMessage?.(
        `Locked down (${acl.lockedDown.length}/${acl.lockdownCap}).`,
      );
    } else {
      user.client?.sendSystemMessage?.('Already locked down or cap reached.');
    }
  }, { kind: 0 });
}

function aclReleaseTarget(api, signItem, user) {
  const acl = getAcl(signItem);
  if (!acl) { user.client?.sendSystemMessage?.('This house has no ACL.'); return; }
  user.client?.sendSystemMessage?.('Target a locked-down item to release.');
  api.targeting?.request(user.client, (picked) => {
    if (!hasSignTier(signItem, user, ACL_CO_OWNER)) return;
    if (!picked?.serial) return;
    const item = itemBySerial(api, picked.serial >>> 0);
    if (!item) { user.client?.sendSystemMessage?.('Not an item.'); return; }
    if (releaseItem(acl, item)) {
      syncMultiAclToRegistry(api, signItem);
      user.client?.sendSystemMessage?.(
        `Released (${acl.lockedDown.length}/${acl.lockdownCap}).`,
      );
    } else {
      user.client?.sendSystemMessage?.('That item was not locked down.');
    }
  }, { kind: 0 });
}

/** Count placed tiles for a given multi brand on a facet. Used by the
 *  sign gump for the "Tiles on this facet" line so the GM can sanity-
 *  check whether they're about to nuke a real structure vs an orphaned
 *  marker tile that's the only survivor of a half-failed placement. */
function countMultiTiles(api, multiId, facet, instanceId = null) {
  let n = 0;
  for (const it of allItems(api)) {
    if (!matchesMultiRef(it, multiId, facet, instanceId)) continue;
    if (it._multiAnchor && Number.isInteger(it._multiComponentCount)) {
      return it._multiComponentCount;
    }
    if (it._multiAnchor) continue;
    n++;
  }
  return n;
}

/** Walk world.items, collect every tile whose `_multi` matches `multiId`
 *  on the given facet, broadcast entity:removed per tile, then call
 *  `destroyItem` to drop them from world / sectors / persistence. Each
 *  tile is broadcast individually so the client's tile-renderer drops
 *  the sprite via the `entity:removed` listener (mirrors the per-tile
 *  worldItemSA fan-out the placement path uses). */
export function destroyMultiByBrandDetailed(
  api, multiId, facet, instanceId = null,
  { extraSerials = [], removeRegistry = false, registryId = null } = {},
) {
  const victims = [];
  const seen = new Set();
  for (const it of allItems(api)) {
    if (!matchesMultiRef(it, multiId, facet, instanceId)) continue;
    seen.add(it.serial >>> 0);
    victims.push(it);
  }
  for (const serialValue of extraSerials ?? []) {
    const serial = Number(serialValue) >>> 0;
    if (!serial || seen.has(serial)) continue;
    const item = itemBySerial(api, serial);
    if (!item) continue;
    seen.add(serial);
    victims.push(item);
  }
  const house = removeRegistry
    ? (registryId != null ? api.houses?.get?.(registryId) : null)
      ?? (instanceId != null ? api.houses?.houseByMultiInstance?.(Number(instanceId) >>> 0) : null)
      ?? victims.map((item) => api.houses?.houseByMultiSerial?.(item.serial)).find(Boolean)
      ?? null
    : null;
  if (!victims.length) return { expected: 0, removed: 0, failed: [], notificationErrors: 0,
    registryFound: Boolean(house), registryRemoved: false };
  // Bounding box for the broadcast range filter — cheaper than a full
  // world.mobiles walk per tile. House footprints are tiny vs. the world
  // so a 24-tile pad around the bbox covers every client that could
  // have the structure on-screen.
  const minX = victims.reduce((m, it) => Math.min(m, it.x | 0),  Infinity);
  const maxX = victims.reduce((m, it) => Math.max(m, it.x | 0), -Infinity);
  const minY = victims.reduce((m, it) => Math.min(m, it.y | 0),  Infinity);
  const maxY = victims.reduce((m, it) => Math.max(m, it.y | 0), -Infinity);
  const cx = (minX + maxX) >> 1;
  const cy = (minY + maxY) >> 1;
  const halfBox = Math.max((maxX - minX) >> 1, (maxY - minY) >> 1) + 24;
  const nearClients = [];
  for (const m of allMobiles(api)) {
    if (!m.client || m.map !== facet) continue;
    if (Math.abs((m.x | 0) - cx) > halfBox) continue;
    if (Math.abs((m.y | 0) - cy) > halfBox) continue;
    nearClients.push(m.client);
  }
  let removed = 0;
  let notificationErrors = 0;
  const failed = [];
  for (const it of victims) {
    // Door cleanup: clear any pending auto-close timer to avoid the
    // setTimeout firing on an already-destroyed item.
    if (it.door?._closeTimer) {
      try { clearTimeout(it.door._closeTimer); } catch { /* ignore */ }
    }
    let didRemove = false;
    try {
      didRemove = destroyItemBySerial(api, it.serial);
      if (didRemove) removed++;
      else failed.push(it.serial >>> 0);
    } catch (e) {
      failed.push(it.serial >>> 0);
      api.log?.(`[destroymulti] destroyItem failed for 0x${it.serial.toString(16)}: ${e.message}`);
    }
    if (!didRemove) continue;
    if (!api.protocol?.removeEntity) continue;
    try {
      const packet = api.protocol.removeEntity(it.serial);
      for (const client of nearClients) {
        try { client.send(packet); }
        catch (error) {
          notificationErrors++;
          api.log?.(`[destroymulti] client removal notification failed: ${error.message}`);
        }
      }
    } catch (error) {
      notificationErrors++;
      api.log?.(`[destroymulti] remove packet failed for 0x${it.serial.toString(16)}: ${error.message}`);
    }
  }
  const registryRemoved = Boolean(house && failed.length === 0 && removed === victims.length
    && api.houses?.remove?.(house.id));
  return { expected: victims.length, removed, failed, notificationErrors,
    registryFound: Boolean(house), registryRemoved };
}

export function destroyMultiByBrand(api, multiId, facet, instanceId = null) {
  return destroyMultiByBrandDetailed(api, multiId, facet, instanceId).removed;
}

function placeStaffMulti(api, owner, multiId, hue, tiles, x, y, z, map) {
  if (isBoatMulti(multiId)) {
    if (!api.boats?.placeCanonical) return { ok: false, error: 'The authoritative boat placement service is unavailable.' };
    try {
      const boat = api.boats.placeCanonical(api, { multiId, x, y, z, map,
        ownerSerial: owner.serial >>> 0, name: nameForMulti(multiId) });
      boat.hue = hue | 0;
      const attachments = [...(boat.boat?.cannons ?? []), ...(boat.boat?.planks ?? [])]
        .map((serial) => itemBySerial(api, serial)).filter(Boolean);
      broadcastPlacedMulti(api, [boat, ...attachments], map);
      return { ok: true, placed: tiles.length, serial: boat.serial >>> 0, kind: 'boat' };
    } catch (error) { return { ok: false, error: error?.message ?? String(error) }; }
  }
  const placement = canPlaceMultiAt(api, tiles, x, y, z, map, {
    house: isHouseMulti(multiId), allowRestrictedRegions: true,
  });
  if (!placement.ok) return { ok: false, error: placement.reason };
  let result = null;
  let house = null;
  try {
    result = stampMultiAt(api, multiId, hue, tiles, x, y, z, map, { broadcast: false });
    if (isHouseMulti(multiId)) {
      house = registerMultiHouse(api, result.anchor, owner, { source: 'staff-placement' });
      if (!house) throw new Error('house registry rejected the structure');
    }
    broadcastPlacedMulti(api, result.visibleItems, map);
    return { ok: true, placed: result.placed, serial: result.instanceId, houseId: house?.id ?? null };
  } catch (error) {
    if (result?.instanceId) destroyMultiByBrandDetailed(api, multiId, map, result.instanceId, {
      extraSerials: result.items?.map((item) => item.serial) ?? [],
      removeRegistry: isHouseMulti(multiId), registryId: house?.id ?? null,
    });
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** Open the multi-targeting cursor on the user's client and stamp the
 *  template at the picked tile. Sends 0x99 (multi placement request);
 *  the client responds with a 0x6C target reply whose (x, y, z) is the
 *  tile under the ghost when the user clicks. */
function placeMultiInteractive(api, state, mob, multiId, hue, tiles) {
  const proto = api.protocol;
  if (!proto?.multiPlacementRequest) {
    // Protocol builder missing — fall back to stamping at the player's
    // feet, no ghost preview. Still useful when running headless.
    const result = placeStaffMulti(api, mob, multiId, hue, tiles,
      mob.x | 0, mob.y | 0, mob.z | 0, mob.map ?? 1);
    if (!result.ok) { state?.sendSystemMessage?.(`Placement blocked: ${result.error}.`); return; }
    state?.sendSystemMessage?.(
      `Multi placed at your feet (${result.placed} components, no preview).`,
    );
    return;
  }
  // Register a target callback first so the 0x6C reply has a
  // listener; the client's 0x99 multi-mode path uses the SAME 0x6C
  // packet for the reply (with cursorType=Multi and the picked tile).
  if (!state.targetCallbacks) state.targetCallbacks = new Map();
  const cursorId = ((state._nextTargetId = (state._nextTargetId ?? 1) + 1) | 0);
  state.targetCallbacks.set(cursorId, (picked) => {
    if (!picked) {
      state?.sendSystemMessage?.('Cancelled.');
      return;
    }
    const x = picked.x | 0, y = picked.y | 0, z = picked.z | 0;
    const map = mob.map ?? 1;
    const result = placeStaffMulti(api, mob, multiId, hue, tiles, x, y, z, map);
    if (!result.ok) { state?.sendSystemMessage?.(`Placement blocked: ${result.error}.`); return; }
    state?.sendSystemMessage?.(`Placed ${result.placed}/${tiles.length} components of multi 0x${multiId.toString(16)} at (${x},${y},${z}).`);
    api.log?.(`[placemulti] ${mob.name} stamped 0x${multiId.toString(16)} at (${x},${y},${z})  hue=${hue}`);
  });
  // Push 0x99 to put the client in multi-placement mode (ghost preview
  // mounted by `apps/client/src/renderer/multi-ghost.js`). The client
  // replies with 0x6C carrying our cursorId + the picked tile.
  try {
    state.send?.(proto.multiPlacementRequest({
      id: cursorId, multiId, hue, offsetX: 0, offsetY: 0, offsetZ: 0, allowGround: true,
    }));
    state?.sendSystemMessage?.(`Click a tile to place multi 0x${multiId.toString(16)}.`);
  } catch (e) {
    api.log?.(`[placemulti] 0x99 send failed: ${e.message}`);
    state.targetCallbacks.delete(cursorId);
  }
}

// CUO TileDataLoader.cs:404 — bits we care about for static tiles.
const FLAG_IMPASSABLE = 1 <<  6; // 0x40 — blocks walking
const FLAG_WET        = 1 <<  7;
const FLAG_SURFACE    = 1 <<  9; // 0x200 — walkable top
const FLAG_BRIDGE     = 1 << 10;
const FLAG_DOOR       = 1 << 29;

/** Whether a static tile id should physically block a walker. Walls,
 *  roofs and most decoration are Impassable without Surface. Floors are
 *  Surface (and walkable). Doors get their own runtime door-state flag
 *  on the item; we leave `solid` off for them. */
function isTileSolid(api, tileId) {
  const td = api.tileData?.table?.();
  const e  = td?.statics?.[tileId | 0];
  if (!e) return false;
  const flags = e.flags | 0;
  if (flags & FLAG_DOOR) return false;        // door state controls block
  return (flags & FLAG_IMPASSABLE) !== 0 && (flags & FLAG_SURFACE) === 0;
}
function tileHeight(api, tileId) {
  const td = api.tileData?.table?.();
  return (td?.statics?.[tileId | 0]?.height) | 0;
}

/** Pre-bind a door payload so a multi-placed door blocks movement
 *  (closed) and can be opened by double-click without relying on
 *  `autoBindDoor` to lazy-fire on the first use. */
function bindDoorTile(api, item) {
  const td = api.tileData?.table?.();
  const flags = td?.statics?.[item.itemId | 0]?.flags | 0;
  if (!(flags & FLAG_DOOR)) return null;
  // Prefer housedata's `doorPiece` lookup. The extractor's door list
  // stores the 8 CLOSED facings/hinges; the matching open art is the
  // next graphic (`closedId + 1`) just like ServUO BaseDoor. Never infer
  // open/closed from piece parity: darkwood starts at odd 0x06A5 and is
  // still a closed door.
  const info = api.housedata?.doorPiece?.(item.itemId);
  let closedId, openId, isOpenInitially, facing;
  if (info) {
    const pieceIdx = info.pieceIdx | 0;
    isOpenInitially = false;
    closedId = item.itemId;
    openId   = closedId + 1;
    facing   = ['south', 'east', 'north', 'west'][pieceIdx >> 1] ?? null;
  } else {
    // Fallback: assume the multi blob shipped the closed sprite.
    // Sufficient for doors not catalogued in housedata.json.
    closedId = item.itemId;
    openId   = item.itemId + 1;
    isOpenInitially = false;
    facing = null;
  }
  item.door = { closedId, openId, isOpen: isOpenInitially, facing };
  return item.door;
}

function tileFootprint(api, tileId) {
  const h = tileHeight(api, tileId);
  return Math.max(1, h || 1);
}

function zRangesOverlap(aZ, aH, bZ, bH) {
  return aZ < bZ + bH && bZ < aZ + aH;
}

export function canPlaceMultiAt(api, tiles, ox, oy, oz, map, options = {}) {
  if (!Array.isArray(tiles) || tiles.length === 0) return { ok: false, reason: 'multi has no components' };
  if (!Number.isInteger(ox) || !Number.isInteger(oy) || !Number.isInteger(oz)) {
    return { ok: false, reason: 'invalid placement coordinates' };
  }
  const checks = [];
  const footprint = new Set();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tiles) {
    if (!t || (!t.id && !t.itemId)) continue;
    const tileId = (t.id ?? t.itemId) | 0;
    const x = ox + (t.x | 0);
    const y = oy + (t.y | 0);
    const z = oz + (t.z | 0);
    if (x < 0 || x > 7167 || y < 0 || y > 4095 || z < -128 || z > 127) {
      return { ok: false, reason: `component falls outside map bounds at (${x},${y},${z})` };
    }
    footprint.add(`${x}:${y}`);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    const solid = isTileSolid(api, tileId);
    const door = !!(api.tileData?.table?.()?.statics?.[tileId | 0]?.flags & FLAG_DOOR);
    if (!solid && !door) continue;
    const h = tileFootprint(api, tileId);
    checks.push({ x, y, z, h, tileId });
  }
  if (!footprint.size) return { ok: false, reason: 'multi has no drawable footprint' };

  const landTable = api.tileData?.table?.()?.land;
  const staticsTable = api.tileData?.table?.()?.statics;
  if (api.landProvider) {
    for (const key of footprint) {
      const [x, y] = key.split(':').map(Number);
      const land = api.landProvider.landAt?.(map, x, y);
      const statics = api.landProvider.staticsAt?.(map, x, y) ?? [];
      if (!land && statics.length === 0) return { ok: false, reason: `map data unavailable at (${x},${y})` };
      if (land) {
        const flags = landTable?.[land.tileId | 0]?.flags | 0;
        if (options.house && (flags & (FLAG_WET | FLAG_IMPASSABLE))) {
          return { ok: false, reason: `foundation cannot be placed on wet or impassable land at (${x},${y})` };
        }
        if (options.house && Math.abs((land.z | 0) - oz) > 12) {
          return { ok: false, reason: `terrain is too uneven at (${x},${y})` };
        }
      }
      if (options.house) {
        for (const s of statics) {
          const info = staticsTable?.[s.tileId | 0];
          const flags = info?.flags | 0;
          const height = Math.max(1, info?.height | 0);
          if ((flags & (FLAG_IMPASSABLE | FLAG_SURFACE))
              && zRangesOverlap(oz, 20, s.z | 0, height)) {
            return { ok: false, reason: `map static 0x${(s.tileId | 0).toString(16)} blocks (${x},${y})` };
          }
        }
      }
      if (options.house && !options.allowRestrictedRegions) {
        const restricted = (api.regions?.at?.(map, x, y) ?? []).find((region) =>
          region.noHousing === true || region.guarded === true
          || region.type === 'town' || region.type === 'dungeon');
        if (restricted) return { ok: false, reason: `housing is not permitted in ${restricted.name ?? 'this region'}` };
      }
      if (options.house && api.houses?.houseAt?.(x, y, map)) {
        return { ok: false, reason: `another house occupies (${x},${y})` };
      }
    }
  } else if (options.house) {
    // Isolated unit-test/script hosts may omit map data. Runtime servers
    // always provide it; do not make the generic stamping helper unusable.
    for (const key of footprint) {
      const [x, y] = key.split(':').map(Number);
      if (api.houses?.houseAt?.(x, y, map)) return { ok: false, reason: `another house occupies (${x},${y})` };
    }
  }

  const byCell = new Map();
  for (const c of checks) {
    const key = `${c.x}:${c.y}`;
    let arr = byCell.get(key);
    if (!arr) { arr = []; byCell.set(key, arr); }
    arr.push(c);
  }

  const candidateItems = new Map();
  if (api.world?.sectors?.itemSerialsAt) {
    for (const key of footprint) {
      const [x, y] = key.split(':').map(Number);
      for (const serial of api.world.sectors.itemSerialsAt(map, x, y)) {
        const item = itemBySerial(api, serial);
        if (item) candidateItems.set(item.serial >>> 0, item);
      }
    }
  } else {
    for (const item of allItems(api)) candidateItems.set(item.serial >>> 0, item);
  }
  for (const it of candidateItems.values()) {
    if (!it || it.parent != null || (it.map ?? 1) !== map) continue;
    const x = it.x | 0, y = it.y | 0;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const arr = byCell.get(`${x}:${y}`);
    if (options.house && footprint.has(`${x}:${y}`)) {
      return {
        ok: false,
        reason: `item 0x${(it.serial >>> 0).toString(16)} occupies the foundation at (${x},${y})`,
      };
    }
    if (!arr) continue;
    const existingBlocks = !it._multiAnchor && (it.solid || it.door || it._multi != null);
    if (!existingBlocks) continue;
    const eh = Math.max(1, it.height || tileHeight(api, it.itemId | 0) || 1);
    const ez = it.z | 0;
    for (const c of arr) {
      if (zRangesOverlap(c.z, c.h, ez, eh)) {
        return {
          ok: false,
          reason: `tile 0x${c.tileId.toString(16)} collides with item 0x${(it.serial >>> 0).toString(16)} at (${x},${y},${ez})`,
        };
      }
    }
  }

  for (const c of checks) {
    for (const blocker of api.world?.multiSpatial?.blockersAt?.(map, c.x, c.y) ?? []) {
      if (zRangesOverlap(c.z, c.h, blocker.z | 0, Math.max(1, blocker.height | 0))) {
        return { ok: false, reason: `another multi blocks (${c.x},${c.y},${blocker.z | 0})` };
      }
    }
  }

  const candidateMobiles = new Map();
  if (api.world?.sectors?.mobileSerialsNear) {
    const cx = (minX + maxX) >> 1, cy = (minY + maxY) >> 1;
    const range = Math.max(maxX - minX, maxY - minY) + 1;
    for (const serial of api.world.sectors.mobileSerialsNear(map, cx, cy, range)) {
      const mobile = mobileBySerial(api, serial);
      if (mobile) candidateMobiles.set(mobile.serial >>> 0, mobile);
    }
  } else {
    for (const mobile of allMobiles(api)) candidateMobiles.set(mobile.serial >>> 0, mobile);
  }
  for (const mob of candidateMobiles.values()) {
    if (!mob || (mob.map ?? 1) !== map || (mob.hp ?? 0) <= 0 || mob.ghost) continue;
    const x = mob.x | 0, y = mob.y | 0;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const arr = byCell.get(`${x}:${y}`);
    if (options.house && footprint.has(`${x}:${y}`)) {
      return { ok: false, reason: `${mob.name ?? 'a mobile'} is standing at (${x},${y},${mob.z | 0})` };
    }
    if (!arr) continue;
    const mz = mob.z | 0;
    for (const c of arr) {
      if (Math.abs(mz - c.z) <= 16) {
        return {
          ok: false,
          reason: `${mob.name ?? 'a mobile'} is standing at (${x},${y},${mz})`,
        };
      }
    }
  }

  return { ok: true, footprint };
}

export function stampMultiAt(api, multiId, hue, tiles, ox, oy, oz, map, options = {}) {
  // A real UO multi is a single world entity whose graphic is an index into
  // multi.mul/MultiCollection.uop. The client expands that index locally.
  // Keep component items only as collision/interaction proxies so placement
  // remains authoritative without sending thousands of duplicate sprites.
  const anchor = createItem(api, api.world, {
    itemId: multiId | 0,
    multiId: multiId | 0,
    x: ox | 0, y: oy | 0, z: oz | 0, map,
    hue: hue | 0,
    movable: false,
    visible: true,
    _multi: multiId | 0,
    _multiAnchor: true,
    isDecoration: false,
  });
  if (!anchor) throw new Error(`Unable to create anchor for multi 0x${(multiId | 0).toString(16)}`);

  const instanceId = anchor.serial >>> 0;
  // Preserve these explicitly for compatibility with older/custom item
  // factories that still copy only their historical fixed field list.
  anchor.multiId = multiId | 0;
  anchor._multi = multiId | 0;
  anchor._multiInstance = instanceId;
  anchor._multiAnchor = true;
  // Runtime decorations are deliberately omitted from world saves because
  // `[createworld` recreates them. Player/staff multis are persistent state,
  // so they must never carry that marker.
  anchor.isDecoration = false;
  anchor._noDecay = true;
  anchor.movable = false;
  anchor.visible = true;

  let placed = 0;
  const createdItems = [anchor];
  const clientVisibleItems = [anchor];
  const statics = api.tileData?.table?.()?.statics;
  const collision = [];
  const surfaces = [];
  const footprintKeys = new Set();
  let relX1 = Infinity, relY1 = Infinity, relX2 = -Infinity, relY2 = -Infinity;
  try {
    for (const t of tiles) {
      if (!t || (t.id == null && t.itemId == null)) continue;
      const x = ox + (t.x | 0);
      const y = oy + (t.y | 0);
      const z = oz + (t.z | 0);
      const tileId = (t.id ?? t.itemId) | 0;
      const tileName = String(statics?.[tileId]?.name ?? '').trim();
      // Multi data commonly carries hidden 0x0001 "No Draw" markers. They
      // are implementation metadata, not dynamic world entities.
      if (tileId === 0x0001 || /\bno\s*draw\b/i.test(tileName)) continue;

      const solid  = isTileSolid(api, tileId);
      const flags = statics?.[tileId]?.flags | 0;
      const height = Math.max(0, tileHeight(api, tileId));
      const isDoor = (flags & FLAG_DOOR) !== 0;
      const isSurface = (flags & FLAG_SURFACE) !== 0 && (flags & FLAG_IMPASSABLE) === 0;
      const dx = t.x | 0, dy = t.y | 0, dz = t.z | 0;
      footprintKeys.add(`${dx}:${dy}`);
      relX1 = Math.min(relX1, dx); relY1 = Math.min(relY1, dy);
      relX2 = Math.max(relX2, dx); relY2 = Math.max(relY2, dy);
      const clientVisible = t.visible === false;

      // Immutable visible blueprint geometry is represented compactly on the
      // anchor and indexed by cell. Only interactive/dynamic pieces become
      // full world Items.
      if (solid && !clientVisible) collision.push([dx, dy, dz, Math.max(1, height || 20)]);
      if (isSurface && !clientVisible) surfaces.push([dx, dy, dz, height, (flags & FLAG_BRIDGE) ? 1 : 0]);
      placed++;
      if (!clientVisible && !isDoor) continue;

      // Visible blueprint parts are already drawn by the multi anchor and
      // therefore stay invisible on the wire. Hidden components represent
      // doors/signs/holds/planks and must remain regular interactive items.
      const it = createItem(api, api.world, {
        itemId: tileId, x, y, z, map,
        hue: hue | 0,
        movable: false,
        visible: clientVisible,
        _multi: multiId | 0,
        _multiInstance: instanceId,
        _multiAnchor: false,
        isDecoration: false,
      });
      if (!it) throw new Error('item factory returned no item');
      it._multi       = multiId | 0;
      it._multiInstance = instanceId;
      it._multiAnchor = false;
      it.isDecoration = false;
      it._noDecay = true;
      it.visible      = clientVisible;
      it.movable      = false;
      if (solid) {
        it.solid  = true;
        it.height = height || 20;
      }
      if (isSurface) {
        it.surface = true;
        it.bridge = (flags & FLAG_BRIDGE) !== 0;
        it.height = height;
      }
      // Pre-bind door payload so the tile blocks while closed and the
      // double-click toggle works without waiting for `autoBindDoor` to
      // fire on first use. Skipped for non-door tiles (returns null).
      bindDoorTile(api, it);
      createdItems.push(it);
      if (clientVisible) clientVisibleItems.push(it);
    }
    anchor._multiCollision = collision;
    anchor._multiSurfaces = surfaces;
    anchor._multiFootprint = [...footprintKeys].map((key) => key.split(':').map(Number));
    anchor._multiBounds = Number.isFinite(relX1) ? [relX1, relY1, relX2, relY2] : [0, 0, 0, 0];
    anchor._multiComponentCount = placed;
    anchor._multiBlueprintHash = createHash('sha256')
      .update(JSON.stringify(tiles.map((tile) => [tile.id ?? tile.itemId, tile.x, tile.y, tile.z, tile.visible])))
      .digest('hex').slice(0, 24);
    api.world?.multiSpatial?.register?.(anchor);
  } catch (error) {
    for (let i = createdItems.length - 1; i >= 0; i--) {
      try { destroyItemBySerial(api, createdItems[i].serial); } catch { /* best effort */ }
    }
    throw new Error(`Multi placement rolled back: ${error.message}`, { cause: error });
  }

  // One anchor plus a handful of interactive pieces replaces the old
  // component-per-packet fan-out. Compute the range once per structure.
  if (options.broadcast !== false) broadcastPlacedMulti(api, clientVisibleItems, map);
  return { placed, anchor, instanceId, items: createdItems, visibleItems: clientVisibleItems };
}

export function broadcastPlacedMulti(api, clientVisibleItems, map) {
  if (clientVisibleItems?.length) {
    const RANGE = 24;
    const anchor = clientVisibleItems.find((item) => item?._multiAnchor);
    const bounds = anchor?._multiBounds;
    const minX = Math.min(
      clientVisibleItems.reduce((m, it) => Math.min(m, it.x | 0), Infinity),
      bounds ? (anchor.x | 0) + (bounds[0] | 0) : Infinity,
    );
    const maxX = Math.max(
      clientVisibleItems.reduce((m, it) => Math.max(m, it.x | 0), -Infinity),
      bounds ? (anchor.x | 0) + (bounds[2] | 0) : -Infinity,
    );
    const minY = Math.min(
      clientVisibleItems.reduce((m, it) => Math.min(m, it.y | 0), Infinity),
      bounds ? (anchor.y | 0) + (bounds[1] | 0) : Infinity,
    );
    const maxY = Math.max(
      clientVisibleItems.reduce((m, it) => Math.max(m, it.y | 0), -Infinity),
      bounds ? (anchor.y | 0) + (bounds[3] | 0) : -Infinity,
    );
    const cx = (minX + maxX) >> 1;
    const cy = (minY + maxY) >> 1;
    const halfBox = Math.max((maxX - minX) >> 1, (maxY - minY) >> 1) + RANGE;
    const nearClients = [];
    for (const m of allMobiles(api)) {
      if (!m.client || m.map !== map) continue;
      if (Math.abs((m.x | 0) - cx) > halfBox) continue;
      if (Math.abs((m.y | 0) - cy) > halfBox) continue;
      nearClients.push(m.client);
    }
    for (const it of clientVisibleItems) {
      for (const cl of nearClients) {
        try {
          if (typeof cl.sendItem === 'function') {
            if (cl.sendItem(it) !== false) cl._visibleItems?.add?.(it.serial >>> 0);
            continue;
          }
          if (!api.protocol?.worldItemSA) continue;
          cl.send(api.protocol.worldItemSA({
            serial: it.serial,
            itemId: it._multiAnchor ? (it.multiId | 0) : it.itemId,
            amount: it.amount ?? 1, hue: it.hue ?? 0,
            x: it.x, y: it.y, z: it.z, direction: 0,
            flags: 0, dataType: it._multiAnchor ? 2 : 0, graphicInc: 0,
          }));
          cl._visibleItems?.add?.(it.serial >>> 0);
        } catch { /* socket gone */ }
      }
    }
  }
  return clientVisibleItems?.length ?? 0;
}
