// Entry point. Starts a plain HTTP server (for health checks) with a
// WebSocket upgrade path at `/game`. Each upgraded socket gets a NetState.

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import { WebSocketServer } from 'ws';
import { config, validateConfig } from './config.js';
import { resolveSaveDir } from './save-dir.js';
import { World } from './world/world.js';
import { createWorldQueryApi } from './world/query-api.js';
import { createWorldOpsApi } from './world/ops-api.js';
import { createScriptGameApi } from './script-game-api.js';
import { NetState } from './net/net-state.js';
import { startTcpListener } from './net/tcp-listener.js';
import { TcpAdapter } from './net/tcp-adapter.js';
import { AuthKeyRegistry } from './net/auth.js';
import { buildHandlers, targeting, gumps, contextMenus, vendors, books, spellbooks, combat, buildScriptCombatApi, prompts, trade, properties, effects, quest, refreshSurroundings, dispatchCastFromMacro } from './net/handlers.js';
import { CommandRegistry } from './net/commands.js';
import { AccountDB } from './net/accounts.js';
import * as items from './world/items.js';
import * as itemScriptRegistry from './world/item-scripts.js';
import { pickNameForMob, pickMonsterName } from './world/npc-names.js';
import { tickAllMobileScripts, rebuildTickingMobileIndex } from './world/mobile-scripts.js';
import * as templates from './world/templates.js';
import { setRuntimeSolidAt, staticHeightFor, tileDataTable, preloadTileData } from './world/movement.js';
import { setStaticHeightResolver, invalidateLosCache } from './world/los.js';
import { AIScheduler, wanderBehavior } from './world/ai.js';
import { loadScripts } from './scripts.js';
import {
  saveWorldSync, saveWorldAsync, loadWorldSync, requestSave, awaitInFlightSaves, persistenceDiagnostics,
  saveHousesSync, saveHousesAsync, loadHousesSync,
  saveBazaarSync, saveBazaarAsync, loadBazaarSync,
  saveWorldStateAsync, loadWorldStateSync,
} from './world/persistence.js';
import * as boatsSystem from './systems/boats.js';
import {
  serializeStalls as _bazaarSerialize,
  deserializeStalls as _bazaarDeserialize,
} from './systems/economy/magincia-bazaar.js';
import * as maginciaBazaarSystem from './systems/economy/magincia-bazaar.js';
import * as dailyLoginSystem from './systems/rewards/daily-login.js';
import * as anniversarySystem from './systems/events/anniversary.js';
import * as giftGivingSystem from './systems/events/gift-giving.js';
import * as revampedDungeonsSystem from './systems/bosses/revamped-dungeons.js';
import * as seasonalEventsSystem from './systems/events/seasonal-events.js';
import * as termurContentSystem from './systems/bosses/termur-content.js';
import * as maginciaDistillationSystem from './systems/economy/magincia-distillation.js';
import * as campsSystem from './systems/housing/camps.js';
// Server-driven gump LAYOUTS live in scripts/src/gumps/server-gumps.js
// and install themselves under api.systems.serverGumps at script-load.
// The engine only owns the gump dispatcher (state.activeGumps + 0xB0/0xDD).
import * as addonsSystem from './systems/housing/addons.js';
import * as damageableItemsSystem from './systems/housing/damageable-items.js';
import * as storeInventorySystem from './systems/economy/store-inventory.js';
import * as regionOnEnter from './systems/region-onenter.js';
import { serializeBoards, deserializeBoards } from './systems/bulletin-board.js';
import { promises as fsp } from 'node:fs';
import { landProvider } from './world/land-provider.js';
import { resolveItemType, allItemTypes, knownItemTypeCount } from './world/item-types.js';
import { PartyRegistry } from './party.js';
import { GuildRegistry } from './guild.js';
import { DayNightCycle } from './day-night.js';
import { RegionRegistry } from './regions.js';
import { Spawner } from './spawner.js';
import { LootRegistry, artifactUniqueness, allArtifacts, allMagicProperties, pickArtifact, rollMagicProperties, setArtifactDiscoveryHook } from './world/loot.js';
// Loot pack tiers (Filthy → SuperBoss) loaded by the script runtime
// from apps/scripts/src/items/loot-packs.js (+ data/config/loot-packs.json).
import { MonsterRegistry } from './world/monsters.js';
import { NpcRegistry } from './world/npcs.js';
import { SkillRegistry } from './world/skills.js';
import { HouseRegistry } from './systems/housing/houses.js';
import * as corpse from './corpse.js';
import * as poison from './poison.js';
import * as helpQueue from './help-queue.js';
import * as chatChannels from './chat-channels.js';
import * as regen from './regen.js';
import * as skillGain from './skill-gain.js';
import * as skillMods from './world/skill-mods.js';
import * as attributes from './world/attributes.js';
import { extendTargeting } from './world/targeting.js';
import * as statusEffects from './status-effects.js';
import * as protocol from '@uo/protocol';
import { tickPetHunger, sweepBondingPromotions } from './systems/pets/pet-hunger.js';
import { tickSummons, registerSummon } from './systems/pets/summon-expire.js';
import { worldBosses } from './systems/bosses/world-boss.js';
import * as notoriety from './notoriety.js';
// Content catalogues — registry façade only. Actual item + mobile
// definitions are loaded by the script runtime from
// `apps/scripts/src/items/*.js` and `apps/scripts/src/npcs/*.js`.
// At engine-import time the registries are empty; they fill up during
// the `loadScripts(scriptsDir)` call below.
import * as itemCatalog from './content/items/index.js';
// Systems — spell + crafting engines. Exposed to scripts so gameplay
// commands (`[cast`, `[craft`) can invoke the dispatchers.
import * as spellSystem from './systems/spells/index.js';
import { SpellComposerService } from './systems/spells/composer.js';
import * as craftSystem from './systems/crafting/index.js';
import { runtimeGovernor } from './systems/runtime-governor.js';
import * as paragonSystem from './systems/paragons.js';
import * as virtueSystem from './systems/rewards/virtues.js';
import * as refinementSystem from './systems/refinement.js';
import * as peerlessSystem from './systems/bosses/peerless.js';
import * as petTrainingSystem from './systems/pets/pet-training.js';
import * as mountAbilitiesSystem from './systems/pets/mount-abilities.js';
import * as insuranceSystem from './systems/economy/insurance.js';
import * as slayerSystem from './systems/slayers.js';
import * as sigilSystem from './systems/pvp/sigils.js';
import { tickLightDecay } from './systems/light-decay.js';
import { tickAttachments as tickXmlAttachments } from './systems/world/xml-attachments.js';
import * as xmlSpawnerSystem from './systems/xml-spawner.js';
import * as worldBossSystem from './systems/bosses/world-bosses.js';
import * as powerScrollsSystem from './systems/power-scrolls.js';
import * as treasureMapsSystem from './systems/treasure-maps.js';
import * as harvestSystem from './systems/economy/harvest.js';
import * as plantsSystem from './systems/housing/plants.js';
import * as veteranRewardsSystem from './systems/rewards/veteran-rewards.js';
import * as doomGauntletSystem from './systems/bosses/doom-gauntlet.js';
import * as championSkullsSystem from './systems/bosses/champion-skulls.js';
import * as peerlessBossesSystem from './systems/bosses/peerless-bosses.js';
import * as skillMasteriesSystem from './systems/skill-masteries.js';
import * as specializationsSystem from './systems/specializations.js';
import { AIBehaviorGraphRegistry } from './world/ai-graphs.js';
// Mastery abilities (30+ active spells/moves) — side-effect import wires
// each into the special-moves registry under the `mastery:<Name>` key.
// Scripts and the [cast command resolve through `mastery.invokeMastery`.
import * as masteryAbilitiesSystem from './systems/mastery-abilities.js';
import * as playerVendorSystem from './systems/economy/player-vendor.js';
import * as runebookSystem from './systems/runebook.js';
import * as cleanupSystem from './systems/economy/cleanup-britannia.js';
import * as bardSkillsSystem from './systems/bards/bard-skills.js';
import * as huntmasterSystem from './systems/bosses/huntmaster-challenge.js';
import * as questConversationSystem from './systems/quests/quest-conversation.js';
import * as petCustomizationSystem from './systems/pets/pet-customization.js';
import * as achievementsSystem from './systems/rewards/achievements.js';
import { startRegionTracker } from './systems/region-tracker.js';
import * as shardEventsSystem from './systems/shard-events.js';
import * as townCryerSystem from './systems/town-cryer.js';
import * as petStableSystem from './systems/pets/pet-stable.js';
import * as auctionHouseSystem from './systems/economy/auction-house.js';
import { broadcastSystemCliloc } from './cliloc-broadcast.js';
import { CLILOC } from './cliloc-constants.js';
import * as talismansSystem from './systems/talismans.js';
import * as etherealMountsSystem from './systems/pets/ethereal-mounts.js';
import * as vvvSystem from './systems/pvp/vvv.js';
import * as khaldunSystem from './systems/bosses/khaldun-puzzles.js';
import * as cannonsSystem from './systems/cannons.js';
import * as runicReforgingSystem from './systems/runic-reforging.js';
import * as cityLoyaltySystem from './systems/city-loyalty.js';
import * as ethicsSystem from './systems/pvp/ethics.js';
import * as mlQuestsSystem from './systems/quests/mlquests.js';
import * as questSystem from './systems/quests/quests.js';
import * as bodsSystem from './systems/economy/bods.js';
import * as krampusEventSystem from './systems/events/krampus-event.js';
import * as shrineSystem from './systems/shrines.js';
import * as treasuresOfTokunoSystem from './systems/treasures-of-tokuno.js';
import * as itemRegistrySystem from './content/items/registry.js';
import * as miniChampionSystem from './systems/bosses/mini-champion.js';
import * as factionCaptureSystem from './systems/pvp/faction-capture.js';
import * as factionStrongholdsSystem from './systems/pvp/faction-strongholds.js';
import * as doomLeverPuzzleSystem from './systems/bosses/doom-lever-puzzle.js';
import * as championSystem from './systems/bosses/champion.js';
import * as lightDecaySystem from './systems/light-decay.js';
import * as communityCollectionsSystem from './systems/community-collections.js';
import * as raceSystem from './systems/race.js';
import * as christmasSystem from './systems/events/christmas.js';
import * as halloweenSystem from './systems/events/halloween.js';
import * as easterSystem from './systems/events/easter.js';
import * as astronomySystem from './systems/astronomy.js';
import * as shadowguardSystem from './systems/bosses/shadowguard.js';
import * as myrmidexInvasionSystem from './systems/bosses/myrmidex-invasion.js';
import * as basketWeavingSystem from './systems/housing/basket-weaving.js';
import * as maginciaPlantsSystem from './systems/housing/magincia-plants.js';
import * as bulletinBoardSystem from './systems/bulletin-board.js';
import * as vendorSearchSystem from './systems/economy/vendor-search.js';
import * as ultimaStoreSystem from './systems/economy/ultima-store.js';
import * as pointsSystems from './systems/economy/points-systems.js';
import * as personalBlessSystem from './systems/personal-bless.js';
import * as pvpArenaSystem from './systems/pvp/pvp-arena.js';
import * as factionsSystem from './systems/pvp/factions.js';
import * as reportsSystem from './systems/reports.js';
import * as itemHistorySystem from './systems/item-history.js';
import * as traceSystem from './trace.js';
import * as operational from './systems/operational-diagnostics.js';
import * as fireCasinoSystem from './systems/economy/fire-casino.js';
import * as housingLottoSystem from './systems/housing/housing-lotto.js';
import * as harvestQuotasSystem from './systems/economy/harvest-quotas.js';
import * as spellReagentsSystem from './systems/spells/reagents.js';
import { registerCoreWorldEvents } from './content/world-event-registry.js';
// Canonical registrations are data-driven and reusable by tests/admin tools.
// Shard scripts can still add or override entries after the runtime loads.
registerCoreWorldEvents({ worldBosses: worldBossSystem, sigils: sigilSystem });

const configValidation = validateConfig(config);
if (!configValidation.ok) throw new Error(`Invalid server configuration: ${configValidation.errors.join('; ')}`);
for (const warning of configValidation.warnings) console.warn(`[config] ${warning}`);
await runtimeGovernor.startup.measureAsync('tiledata', () => preloadTileData());

const world = new World();
world.enableOnlineMobileIndex?.();
const query = createWorldQueryApi(world);
const ops = createWorldOpsApi(world);
world._scriptQuery = query;
world._scriptOps = ops;

// FAZA AY: wire the movement layer's runtime-solid resolver. Closed
// doors (and any future explicitly-solid item) block movement at their
// tile. The simple O(N) scan over world.items is fine for the small
// item counts we ship; if it becomes hot, replace with a tile-indexed
// Map<`${map}|${x}|${y}`, Item[]>. Generator yields lazily so a callee
// can early-out on the first blocker.
setRuntimeSolidAt(function* runtimeSolidAt(facet, x, y) {
  // Use the sector index for the same-tile scan instead of walking
  // every item. Pre-sector profile: hot path was 30% of CPU time when
  // 50+ players walked simultaneously through a 5k-item zone (every
  // step → full item Map iteration). With sectors it's O(bucket size)
  // — typically 0–5 items.
  for (const serial of world.sectors.itemSerialsAt(facet, x, y)) {
    const it = world.items.get(serial);
    if (!it) continue;
    if (it.x !== x || it.y !== y) continue;     // sector tile imprecision
    if (it.door || it.solid) yield it;
  }
});
// LOS reads the same tiledata table movement.js loaded — share the
// height resolver so we don't re-parse the JSON.
setStaticHeightResolver(staticHeightFor);
// Wire the template-by-itemId resolver for createItem's auto script
// inference. Avoids the items.js → templates.js → items.js circular
// import that would break module initialisation.
{
  const { setTemplateByItemIdResolver } = await import('./world/items.js');
  setTemplateByItemIdResolver(templates.getTemplateByItemId);
}
const authKeys = new AuthKeyRegistry();
const handlers = buildHandlers();
// Expose the resync helper on the handlers bag so scripts (notably the
// `[go` command + admin teleport) can re-stream nearby NPCs/items to a
// player after an instant teleport — otherwise dest snaps but viewport
// looks empty until the player walks one step.
handlers.refreshSurroundings = refreshSurroundings;
// One authoritative cast lifecycle for spellbook clicks, action-bar macros
// and the `[cast` convenience command. Scripts call this hook instead of
// maintaining a second mana/reagent/target/timing implementation.
handlers.dispatchCast = dispatchCastFromMacro;
// Bug-hunt #8 #1 — `_onClose` cleanup walked `ctx.handlers.trade` looking
// for the trade API, but the opcode-keyed dispatch table never carried
// the `trade` (or `combat` / `vendors`) ref → escrowed items on a
// disconnected trade leaked into a phantom container with map=0 (0,0)
// and the next save dumped them in items.json as orphans. Patch them
// onto the table so `_onClose` and any future cleanup hook finds them.
handlers.trade = trade;
handlers.combat = combat;
handlers.vendors = vendors;
handlers.books = books;
handlers.spellbooks = spellbooks;

const game = createScriptGameApi({ world, query, ops, protocol, handlers, items });
world._scriptGame = game;
const itemScriptsApi = Object.freeze({
  register: itemScriptRegistry.registerItemScript,
  registerItemScript: itemScriptRegistry.registerItemScript,
  unregister: itemScriptRegistry.unregisterItemScript,
  unregisterItemScript: itemScriptRegistry.unregisterItemScript,
  get: itemScriptRegistry.getItemScript,
  all: itemScriptRegistry.allItemScripts,
  dispatch: itemScriptRegistry.dispatchItemEvent,
  dispatchItemEvent: itemScriptRegistry.dispatchItemEvent,
  rebuildTickingItemIndex: itemScriptRegistry.rebuildTickingItemIndex,
});
const namesApi = Object.freeze({
  pickForMob: pickNameForMob,
  pickNameForMob,
  pickMonster: pickMonsterName,
  pickMonsterName,
});

// Hang the combat namespace on world so subsystems (special-moves,
// mastery-abilities, AI helpers) can damage mobs without re-importing
// from net/handlers.js. This was previously implicit — `world._combat`
// was read by `special-moves.js` but never assigned, making every
// special-move damage hook a silent no-op.
world._combat = combat;
world._peerlessBossesSystem = peerlessBossesSystem;
const scriptCombat = buildScriptCombatApi(world, combat);
// Expose the protocol namespace too — subsystems (aggression, status-
// effects buff push, etc.) build packets without re-importing.
world._protocol = protocol;

// Extend the bare 0x6C `targeting.request` exposed by handlers.js with the
// rich Promise-based wrappers (beneficial / harmful / neutral / multi /
// stream). Scripts then use `api.targeting.harmful(state, { range: 12 })`
// instead of CPS callbacks. Captures `world` once so callers don't have
// to re-thread it.
extendTargeting(targeting, { world });

// AI scheduler: drives NPC mobiles (those without a `client`). Uses protocol
// packet builders to broadcast movement and overhead speech. The
// `mobileMovingPacketFor(mob, viewer)` form lets the AI scheduler use
// per-viewer notoriety colours so a tamer's pet shows green to the
// tamer and orange to a faction enemy at the same instant.
const ai = new AIScheduler(world, {
  // A persisted shard can contain 10k+ NPCs. Do not simulate them before a
  // player is present; in particular, don't let their 500 ms ticks starve
  // startup while gameplay scripts are still being imported.
  pauseWhenNoPlayers: true,
  mobileMovingPacket: (m) => protocol.mobileMoving({
    serial: m.serial, body: m.body, x: m.x, y: m.y, z: m.z,
    direction: m.direction, hue: m.hue, flags: m.flags, notoriety: m.notoriety,
  }),
  mobileMovingPacketFor: (m, viewer) => {
    const v = viewer?.mobile ?? viewer;
    // Pass `world` so the pet-inheritance branch in viewerNotoriety can
    // resolve `controlMaster` → master mobile without reading a phantom
    // `.world` field (BUGFIX #1).
    const noto = notoriety.viewerNotoriety(m, v, world);
    return protocol.mobileMoving({
      serial: m.serial, body: m.body, x: m.x, y: m.y, z: m.z,
      direction: m.direction, hue: m.hue, flags: m.flags, notoriety: noto,
    });
  },
  // Audit 2026-05-19 #9 — when an AI mob walks INTO a stationary
  // player's visibility window, `_broadcastMove` previously sent only
  // 0x77 mobileMoving. The client auto-creates a mobile from 0x77 but
  // never gets the equipment list (renders naked) and never gets the
  // initial `healthUpdate` (no overhead HP bar). The seeder below
  // mirrors `streamVisibilityDelta`'s mobileIncoming + healthUpdate
  // pair on the mob-movement side.
  mobileIncomingPacketFor: (m, viewer) => {
    const v = viewer?.mobile ?? viewer;
    const noto = notoriety.viewerNotoriety(m, v, world);
    // Equipment payload — same as the streamVisibilityDelta path. We
    // skip the `buildEquipByOwner` precompute since this is a single
    // mob, not a bulk pass.
    const equipment = [];
    const children = world._childrenByParent?.get?.(m.serial);
    if (children) {
      for (const serial of children) {
        const it = world.items.get(serial);
        if (!it?.layer) continue;
        equipment.push({
          serial: it.serial, itemId: it.itemId,
          layer: it.layer, hue: it.hue ?? 0,
        });
      }
    } else {
      // Compatibility fallback for tests/legacy loaders that bypassed the
      // parent index. Runtime worlds use the O(equipment) branch above.
      for (const it of world.items.values()) {
        if (it.parent !== m.serial || !it.layer) continue;
        equipment.push({
          serial: it.serial, itemId: it.itemId,
          layer: it.layer, hue: it.hue ?? 0,
        });
      }
    }
    return protocol.mobileIncoming({
      serial: m.serial, body: m.body, x: m.x, y: m.y, z: m.z,
      direction: m.direction, hue: m.hue,
      flags: m.flags, notoriety: noto, equipment,
    });
  },
  healthUpdatePacket: (m) => protocol.healthUpdate({
    serial: m.serial,
    current: m.hp ?? m.hpMax ?? 1,
    max: m.hpMax ?? m.hp ?? 1,
  }),
  removeEntityPacket: (serial) => protocol.removeEntity?.(serial),
  unicodeSpeechPacket: (m, text, hue) => protocol.unicodeMessage({
    serial: m.serial, graphic: m.body, type: 0, hue, font: 3,
    language: 'ENU', name: m.name, text,
  }),
});
ai.registerBehavior(wanderBehavior);
// Hang the AI scheduler on world so combat.damage can wake an attacked
// mob's AI (set its target to the attacker, reset attack timers). Without
// this hook a player casting from > aggroRange (typical spells: 8-10
// tiles) drained the orc's HP while the AI never registered the threat —
// orc just stood there until killed. ServUO `BaseCreature.OnDamage`
// triggers the same wake-up.
world._ai = ai;
const commands = new CommandRegistry();

// Load previous world state from disk, if present.
const here = path.dirname(url.fileURLToPath(import.meta.url));
const saveDir = resolveSaveDir({ here });
const spellComposer = new SpellComposerService(saveDir);
const aiGraphs = new AIBehaviorGraphRegistry(ai, saveDir);
try {
  const count = aiGraphs.load();
  if (count) console.log(`[uo-node] loaded ${count} visual AI behavior graph(s)`);
} catch (error) {
  console.error(`[uo-node] failed to load AI graphs: ${error?.message ?? error}`);
}
try {
  if (loadWorldSync(world, saveDir)) {
    console.log(`[uo-node] restored world from ${saveDir}/world.json  (mobiles=${world.mobiles.size}, items=${world.items.size})`);
    // Wave 8: rebuild the artifact-uniqueness set from the loaded
    // world so a server restart doesn't reopen the gate (existing
    // unique artifacts must still block re-rolls).
    artifactUniqueness.rebuildFromWorld(world);
    console.log(`[uo-node] artifact uniqueness restored: ${artifactUniqueness.size()} unique artifact name(s) tracked`);
    // Server audit #28 P1 #3 — poison status flag survives JSON, but
    // the per-tick damage closure doesn't. Rebuild every poisoned
    // mobile's ticker from `_poisonExpiresAt` so a player who logged
    // out under Deadly poison keeps taking damage on restart.
    try {
      const { reapplyPoisonAfterRestore } = await import('./poison.js');
      const n = reapplyPoisonAfterRestore(world);
      if (n > 0) console.log(`[uo-node] re-attached poison tickers on ${n} mobile(s).`);
    } catch (e) { console.warn(`[uo-node] poison restore skipped: ${e.message}`); }
    try {
      const n = playerVendorSystem.rebuildVendorIndex?.(world) ?? 0;
      if (n > 0) console.log(`[uo-node] player-vendor index restored: ${n} vendor(s).`);
    } catch (e) { console.warn(`[uo-node] player-vendor index restore skipped: ${e.message}`); }
  }
} catch (e) {
  console.error(`[uo-node] failed to load save: ${e.message}`);
}

// Restore admin map-editor overlay (per-tile tileId/z overrides).
// Survives server restarts so a session of painting in the admin
// panel sticks. File is small (sparse JSON, one entry per edited
// tile) so a sync read at boot is fine.
try {
  const r = landProvider.loadEditsSync(path.join(saveDir, 'map-edits.json'));
  if (r.loaded > 0) console.log(`[uo-node] restored ${r.loaded} map-tile edit(s)`);
} catch (e) { console.error(`[uo-node] map-edits load failed: ${e.message}`); }

// Ambient wanderers — ensure a freshly-started shard has a few living NPCs
// around the default spawn so the world doesn't feel empty. Skip when the
// save already holds NPCs; we don't want to keep piling them on every boot.
(() => {
  const hasNpcs = [...world.mobiles.values()].some((m) => !m.client);
  if (hasNpcs) return;
  const baseX = 1496, baseY = 1625, baseZ = 10, facet = 1;
  const npcs = [
    { name: 'Wanderer',   body: 0x0190, hue: 0x83EA, dx: -3, dy:  0 },
    { name: 'Farmer',     body: 0x0190, hue: 0x0391, dx:  3, dy:  1 },
    { name: 'Guard',      body: 0x0190, hue: 0x0000, dx:  0, dy:  3 },
    { name: 'Milkmaid',   body: 0x0191, hue: 0x0396, dx:  0, dy: -3 },
    { name: 'Hermit',     body: 0x0190, hue: 0x0455, dx:  5, dy:  4 },
    { name: 'Beggar',     body: 0x0190, hue: 0x0385, dx: -5, dy: -2 },
  ];
  for (const n of npcs) {
    const mob = world.createMobile({
      name: n.name, body: n.body, hue: n.hue,
      x: baseX + n.dx, y: baseY + n.dy, z: baseZ, map: facet, notoriety: 1,
    });
    ai.attach(mob, 'wander');
  }
  console.log(`[uo-node] spawned ${npcs.length} ambient NPCs near (${baseX},${baseY})`);
})();

const accounts = new AccountDB(saveDir);
try {
  accounts.load();
  console.log(`[uo-node] loaded ${accounts.accounts.size} account(s)`);
} catch (e) {
  console.error(`[uo-node] failed to load accounts: ${e.message}`);
}

// Shared per-server context. Every NetState holds a reference, and scripts
// can hang handlers off of it (e.g. contextMenuProvider).
const partyRegistry = new PartyRegistry(world);
const guildRegistry = new GuildRegistry(world);

// Drop stale serials from guild + party lists when a mobile is
// destroyed (admin [del, corpse decay sweep, summon-expire). Without
// this hook the lists grew monotonically across long-running shards
// and `guild.chat()` would iterate dead serials. Bug-hunt #4 A6.
world.onMobileDestroyed?.((serial) => {
  try { guildRegistry.leave?.(serial); } catch { /* advisory */ }
  try { partyRegistry.leave?.(serial); } catch { /* advisory */ }
});
// Server parity #7 — wire submitTrophy into the kill path (corpse.js
// reads `world._huntmasterSubmit` and calls it for every player kill).
world._huntmasterSubmit = huntmasterSystem.submitTrophy;

// Bug-hunt #11 #4 — hourly house decay sweep. `houses.sweepDecay()`
// was defined but never scheduled, so the 150-day IDOC ladder was
// dead code. Idempotent.
const houseDecayTimer = setInterval(() => {
  try {
    const removed = houses.sweepDecay?.();
    if (removed?.length) {
      console.log(`[uo-node] house decay collapsed ${removed.length} house(s)`);
    }
  } catch (e) { console.error('[uo-node] house decay sweep:', e); }
}, 60 * 60 * 1000);   // hourly
houseDecayTimer.unref?.();

// Bulletin board persistence — server parity #9 #10. Was wiped on
// every restart. Load on boot.
try {
  const bbPath = path.join(saveDir, 'bulletin-boards.json');
  const raw = await fsp.readFile(bbPath, 'utf8').catch(() => null);
  if (raw) {
    const n = deserializeBoards(JSON.parse(raw));
    if (n > 0) console.log(`[uo-node] restored ${n} bulletin board(s) from ${bbPath}`);
  }
} catch (e) { console.error('[uo-node] bulletin load failed:', e.message); }
const dayNight = new DayNightCycle(world);
// Bug-hunt #8 #11: restore time-of-day + weather across restart. The
// snapshot lives in `world-state.json` next to the world buckets.
try {
  const ws = loadWorldStateSync(saveDir);
  if (ws?.dayNight) dayNight.deserialize(ws.dayNight);
} catch (e) { console.error('[uo-node] world-state load failed:', e.message); }
// Wire the weather broadcaster so day-night.js can rotate
// rain/snow/storm patterns every 5 min and have everyone see it.
dayNight.setWeatherBroadcaster?.((kind, intensity, temperature) => {
  const pkt = protocol.weather({ kind, intensity, temperature });
  for (const m of world.subscribedMobiles?.('weather') ?? query.onlineMobiles()) {
    if (m.client.sendCosmetic) m.client.sendCosmetic(pkt, 'weather');
    else m.client.send(pkt);
  }
});
// Start only after persistence restore and broadcaster wiring, then push
// the initial state. Previously the cycle existed but never ticked.
dayNight.start();
dayNight.tick();
const regions = new RegionRegistry();
// Stamp on world so spell castSpell() can call `regions.allowSpellcast`
// without threading a separate dep through every helper. Bug-hunt #4 A3.
world.regions = regions;
const loot = new LootRegistry();
// Loot pack tiers register via the script runtime, see:
//   apps/scripts/src/items/loot-packs.js (+ data/config/loot-packs.json)
// Wave 8: expose artifact + magic-prop catalogs on the loot facade so
// scripts (admin commands, custom scripts) can list/spawn them without
// re-importing the module.
loot.allArtifacts = allArtifacts;
loot.allMagicProperties = allMagicProperties;
loot.pickArtifact = pickArtifact;
loot.rollMagicProperties = rollMagicProperties;
const monsters = new MonsterRegistry();
const npcs = new NpcRegistry();
const skills = new SkillRegistry();
corpse.setLootRegistry(loot);
// Late-bind the corpse module onto `world` so `combat.damage` (which
// only receives `world` + `mob` + `amount` + `attacker`, no script
// ctx) can fire the death cascade when HP hits zero. Without this
// hook every damage path that didn't manually call `killMobile` —
// AI spell casts, DoTs, mastery procs, etc. — left victims at 0 HP
// alive forever (user report 2026-05-19, screenshot Toby/Dennys).
world._corpse = corpse;
// FAZA CX: expose the monster registry so corpse.killMobile can read
// `valor` / hp from the slain creature's config when awarding virtue.
corpse.setMonstersGetter?.((kind) => monsters.get(kind));
// Wire achievements so killMobile can bump kill counters + check
// per-mob unlocks. Late-bind to avoid a top-level circular import.
corpse.setAchievementsModule?.(achievementsSystem);
craftSystem.setAchievementsModule?.(achievementsSystem);
// Wire item-history advisory log so create/destroy ticks land in
// the per-serial ring buffer for `[itemhistory <hex>` admin queries.
import('./systems/item-history.js').then((m) => items.setItemHistoryModule?.(m))
  .catch(() => { /* engine optional */ });
// Wire item-scripts predicate so createItem can index ticking items
// into world._tickingItems on the fly. Synchronous import — module is
// already loaded at the top of this file via tickAllItemScripts.
import('./world/item-scripts.js').then((m) => items.setItemScriptsModule?.(m))
  .catch(() => { /* perf optional — falls back to full walk */ });
const spawner = new Spawner(world, (w, kind, pos) => {
  const factory = sharedCtx.spawnFactory;
  if (!factory) return null;
  return factory(w, kind, pos);
});
const houses = new HouseRegistry();
houses.attachWorld(world);
try {
  const restored = loadHousesSync(houses, saveDir);
  if (restored > 0) {
    console.log(`[uo-node] restored ${restored} house(s) from ${saveDir}/houses.json`);
  }
} catch (e) {
  console.error(`[uo-node] failed to load houses: ${e.message}`);
}
// Magincia Bazaar — restore stall auctions from disk. Module-level
// state lives in systems/economy/magincia-bazaar.js; we just hand it the
// snapshot. Bug-hunt #5 A5.
try {
  const stallSnap = loadBazaarSync(saveDir);
  if (stallSnap.length > 0) {
    const n = _bazaarDeserialize(stallSnap);
    if (n > 0) console.log(`[uo-node] restored ${n} bazaar stall(s) from ${saveDir}/bazaar.json`);
  }
} catch (e) {
  console.error(`[uo-node] failed to load bazaar: ${e.message}`);
}
const cityLoyalty = new cityLoyaltySystem.CityLoyaltyRegistry();
// One shared systems registry for NetState handlers and gameplay scripts.
// Keeping two hand-maintained object literals caused imported engines such as
// veteran rewards, camps, addons and revamped dungeons to exist in memory but
// be invisible to scripts; script-installed dispatchers (serverGumps and the
// ServUO parity bridges) were likewise invisible to packet handlers.
const engineSystems = {
  spells: spellSystem, crafting: craftSystem,
  notoriety, poison, regen,
  paragons: paragonSystem, virtues: virtueSystem, refinement: refinementSystem,
  peerless: peerlessSystem, petTraining: petTrainingSystem, mountAbilities: mountAbilitiesSystem,
  insurance: insuranceSystem, slayers: slayerSystem,
  sigils: sigilSystem, worldBosses: worldBossSystem,
  powerScrolls: powerScrollsSystem, treasureMaps: treasureMapsSystem,
  harvest: harvestSystem, plants: plantsSystem,
  veteranRewards: veteranRewardsSystem, doomGauntlet: doomGauntletSystem,
  championSkulls: championSkullsSystem, peerlessBosses: peerlessBossesSystem,
  skillMasteries: skillMasteriesSystem, masteryAbilities: masteryAbilitiesSystem,
  specializations: specializationsSystem,
  talismans: talismansSystem, etherealMounts: etherealMountsSystem,
  vvv: vvvSystem, khaldun: khaldunSystem, cannons: cannonsSystem,
  runicReforging: runicReforgingSystem,
  dailyLogin: dailyLoginSystem, anniversary: anniversarySystem,
  giftGiving: giftGivingSystem, revampedDungeons: revampedDungeonsSystem,
  seasonalEvents: seasonalEventsSystem, termurContent: termurContentSystem,
  maginciaDistillation: maginciaDistillationSystem, camps: campsSystem,
  xmlSpawner: xmlSpawnerSystem, addons: addonsSystem,
  damageableItems: damageableItemsSystem, storeInventory: storeInventorySystem,
  petStable: petStableSystem, summons: { registerSummon },
  playerVendor: playerVendorSystem, runebook: runebookSystem,
  cleanup: cleanupSystem, bardSkills: bardSkillsSystem,
  questConversation: questConversationSystem, petCustomization: petCustomizationSystem,
  achievements: achievementsSystem, shardEvents: shardEventsSystem,
  auctionHouse: auctionHouseSystem, quests: questSystem, bods: bodsSystem,
  regionOnEnter, krampusEvent: krampusEventSystem, boats: boatsSystem,
  cityLoyalty: cityLoyaltySystem, shrines: shrineSystem,
  treasuresOfTokuno: treasuresOfTokunoSystem, itemRegistry: itemRegistrySystem,
  miniChampion: miniChampionSystem, factionCapture: factionCaptureSystem,
  factionStrongholds: factionStrongholdsSystem, doomLeverPuzzle: doomLeverPuzzleSystem,
  champion: championSystem, lightDecay: lightDecaySystem,
  communityCollections: communityCollectionsSystem, race: raceSystem,
  christmas: christmasSystem, halloween: halloweenSystem, easter: easterSystem,
  astronomy: astronomySystem, townCryer: townCryerSystem,
  huntmaster: huntmasterSystem, maginciaBazaar: maginciaBazaarSystem,
  shadowguard: shadowguardSystem,
  myrmidexInvasion: myrmidexInvasionSystem, basketWeaving: basketWeavingSystem,
  maginciaPlants: maginciaPlantsSystem, bulletinBoard: bulletinBoardSystem,
  vendorSearch: vendorSearchSystem, ultimaStore: ultimaStoreSystem,
  points: pointsSystems, personalBless: personalBlessSystem,
  pvpArena: pvpArenaSystem, factions: factionsSystem, ethics: ethicsSystem,
  reports: reportsSystem, itemHistory: itemHistorySystem, trace: traceSystem,
  fireCasino: fireCasinoSystem, housingLotto: housingLottoSystem,
  harvestQuotas: harvestQuotasSystem, spellReagents: spellReagentsSystem,
  itemScripts: itemScriptsApi,
  // Mutable namespaces populated by parity scripts. Keeping stable fallback
  // objects also makes hot-reload teardown restore a valid capability rather
  // than deleting a service that packet handlers may be reading concurrently.
  serverGumps: {},
  servuoSpells: {},
  servuoMultis: {},
  servuoP1Services: {},
  servuoContextMenus: {},
  servuoP2Admin: {},
};
const sharedCtx = {
  world, authKeys, accounts, config, handlers, commands, ai, aiGraphs, partyRegistry,
  guildRegistry, dayNight, regions, corpse, spawner, loot, monsters,
  cityLoyalty, protocol, items, spellComposer, specializations: specializationsSystem,
  vendors, quests: questSystem, questConversation: questConversationSystem,
  npcs, skills, houses, attributes, query, ops, game,
  // Server parity audit #7 P1: region OnEnter/OnLeave dispatcher
  // (callable from net/handlers handleMovementReq). Without ctx.regionOnEnter
  // the updateRegion call was a no-op.
  regionOnEnter,
  // FAZA DC: net handlers can reach into systems for ad-hoc pushes
  // (e.g. login-time virtue snapshot, paragon broadcast).
  systems: engineSystems,
  connections: new Set(),
};

// Default tooltip / property-list provider. Scripts can replace this via
// `properties.setProvider(ctx, fn)` for richer (affix/charges/magic) data;
// until they do, every item and mobile still gets a minimal one-line
// tooltip so the client UI has something to show. We use cliloc 1042971
// (~1_NOTHING~) — a generic "plain string" template — so the client just
// renders the `args` text verbatim.
properties.setProvider(sharedCtx, (serial) => {
  const mob = world.mobiles.get(serial);
  if (mob) {
    const entries = [{ cliloc: 1042971, args: mob.name || 'a creature' }];
    return { entries };
  }
  const item = world.items.get(serial);
  if (!item) return null;
  const name = item.name || `item 0x${item.itemId.toString(16)}`;
  const label = item.amount > 1 ? `${name} : ${item.amount}` : name;
  return { entries: [{ cliloc: 1042971, args: label }] };
});

// Load gameplay scripts from apps/scripts/src (best-effort; missing dir is fine).
const scriptsDir = path.resolve(here, '../../scripts/src');
// Boats subsystem — continuous-sail tick that walks any boat with a
// non-stop sail-state across water tiles. Independent of the AI loop
// because boats need a finer cadence and pilot semantics. Exposed to
// scripts under `api.boats` so the `[boat` command can queue sails.
const boats = boatsSystem.startBoatSystem({
  world, items, protocol, landProvider,
});

// Wave 13: world-wide announcement on greater/lesser artifact drops.
// Throttled to 5s per call so a champion spawn that drops two unique
// artifacts in the same tick won't double-announce. The line is sent
// as a system message to every logged-in client.
let _lastDiscoveryAt = 0;
setArtifactDiscoveryHook((profile) => {
  const now = Date.now();
  if (now - _lastDiscoveryAt < 5000) return;
  _lastDiscoveryAt = now;
  const tier = profile.tier === 'greater' ? 'legendary' : 'rare';
  const line = `An adventurer has discovered the ${tier} artifact: ${profile.name}!`;
  // Refactored: build the localized 0xC1 packet ONCE and fan-out to
  // every connected client via the cliloc-broadcast helper. ServUO
  // ARTIFACT_DISCOVERED cliloc carries `<player>\t<artifact>` args,
  // we embed only the artifact name (player name comes from the loot
  // path eventually). Falls back to plain ASCII for clients without
  // cliloc data.
  try {
    broadcastSystemCliloc(world, CLILOC.ARTIFACT_DISCOVERED, `\t${profile.name}`);
  } catch { /* helper missing in some test setups */ }
  // Backward-compat ASCII fan-out for clients that don't render cliloc.
  for (const m of query.onlineMobiles()) {
    m.client.sendSystemMessage?.(line);
  }
  // Append to the shard event log for `[events recent` + the
  // NewsBoardGump consumers.
  try {
    shardEventsSystem.emit('artifact-discovered', line, {
      name: profile.name, tier: profile.tier,
    });
  } catch { /* shard-events optional */ }
  console.log(`[uo-node] artifact discovered: ${profile.name} (${profile.tier})`);
});

// Town Cryer auto-news — subscribe to shard events and post matching
// headlines (champion defeats, world boss kills, artifact drops, etc.)
// so any nearby Town Cryer NPC pulses them as overhead speech and
// `[news` lists them.
try {
  townCryerSystem.wireAutoNews(shardEventsSystem);
  // Pulse the latest headline through every Town Cryer NPC once every
  // 5 minutes. `tickHeadlinePulse` walks `world.mobiles` for
  // `_townCryer === true` and broadcasts overhead.
  const cryerInterval = setInterval(() => {
    try {
      townCryerSystem.tickHeadlinePulse(world, (npc, msg) => {
        for (const m of query.clientsNear(npc, 12)) {
          m.client.sendSystemMessage?.(msg);
        }
      });
    } catch (e) { console.warn('[town-cryer] pulse threw:', e?.message); }
  }, 5 * 60 * 1000);
  cryerInterval.unref?.();
} catch (e) {
  console.warn('[town-cryer] auto-wire failed:', e?.message);
}

const scriptTemplates = Object.freeze({ ...templates, get: templates.getTemplate });
const scriptItems = Object.freeze({
  ...items,
  invalidateProps(serial) {
    const key = serial >>> 0;
    let nudged = 0;
    for (const mobile of world.mobiles.values()) {
      const state = mobile.client;
      if (!state?.ctx?.propertyProvider) continue;
      try {
        const result = state.ctx.propertyProvider(key, state);
        if (!result?.entries) continue;
        properties.nudge(state, key, properties.computeHash(result.entries));
        nudged++;
      } catch { /* one stale observer must not block the mutation */ }
    }
    return nudged;
  },
});
const scriptQuests = Object.freeze({
  ...questSystem,
  register: questSystem.registerQuest,
  has: (id) => !!questSystem.getQuest(id),
});
const scriptRuntime = await loadScripts(scriptsDir, {
  world, commands, items: scriptItems, templates: scriptTemplates, ai, aiGraphs, targeting, protocol,
  // [multigump → placemulti chain emits `api.events.emit('placemulti:request',…)`
  // and placemulti.js subscribes via `api.events.on(...)`. Was: `api.events`
  // was undefined → optional chaining silently no-op'd, so clicking
  // Place in the multi browser did nothing. Forward `world.events`
  // (the canonical pub-sub bus from `world.js`) under the api alias.
  events: world.events,
  gumps, contextMenus, vendors, books, spellbooks, combat: scriptCombat, prompts, trade,
  properties, effects, quest, quests: scriptQuests,
  party: partyRegistry, guilds: guildRegistry, dayNight,
  regions, corpse, spawner, loot, monsters, npcs, skills, houses, query, ops, game,
  itemScripts: itemScriptsApi,
  names: namesApi,
  skillGain, skillMods, attributes,
  statusEffects,
  spellComposer,
  specializations: specializationsSystem,
  // Scripts call `api.los.invalidate()` after door toggle / map edit /
  // static add+remove to drop the 100 ms LOS cache. Without this the
  // cached "can't see target" answer lingers for one frame after the
  // door opens, producing a "you cannot see that target" false-positive
  // on a spell cast through a freshly-opened doorway.
  los: { invalidate: invalidateLosCache },
  boats,
  landProvider,
  // Expose the parsed tiledata table so scripts (placemulti, GM tools)
  // can query static tile flags without re-loading the JSON. Used by
  // multi placement to mark walls/roofs/decoration as `solid` so the
  // movement system actually blocks the player from walking through.
  tileData: { table: tileDataTable, staticHeight: staticHeightFor },
  itemTypes: { resolve: resolveItemType, all: allItemTypes, count: knownItemTypeCount },
  artifactUniqueness,
  persistence: { saveWorldSync, saveWorldAsync, loadWorldSync, saveDir, requestSave, diagnostics: persistenceDiagnostics },
  ctx: sharedCtx,
  // Catalogues + systems from the new structure. Scripts reach item
  // definitions via `api.catalog.items.itemsOfKind('weapon')` and cast
  // spells via `api.systems.spells.castSpell({ caster, spellId, … })`.
  catalog: { items: itemCatalog },
  helpQueue, chatChannels, poison, notoriety, regen, cityLoyalty,
  ethics: ethicsSystem, mlQuests: mlQuestsSystem,
  systems: engineSystems,
  log: (msg) => console.log(`[scripts] ${msg}`),
});
try {
  const hydrated = items.rehydrateWorldItemDefinitions(world);
  if (hydrated.fields > 0) {
    console.log(`[uo-node] item definitions rehydrated: ${hydrated.items} item(s), ${hydrated.fields} field(s), ${hydrated.scripts} script tag(s)`);
  }
} catch (e) {
  console.warn('[uo-node] item definition rehydrate failed:', e?.message);
}
try {
  const n = itemScriptRegistry.rebuildTickingItemIndex(world);
  if (n > 0) console.log(`[uo-node] ticking item index rebuilt: ${n} item(s)`);
} catch (e) {
  console.warn(`[uo-node] ticking item index rebuild failed: ${e.message}`);
}
try {
  const n = rebuildTickingMobileIndex(world);
  if (n > 0) console.log(`[uo-node] ticking mobile index rebuilt: ${n} mobile(s)`);
} catch (e) {
  console.warn(`[uo-node] ticking mobile index rebuild failed: ${e.message}`);
}
const scriptWatchEnabled = /^(1|true|yes)$/i.test(String(process.env.UO_SCRIPT_WATCH ?? ''));
if (scriptWatchEnabled) {
  scriptRuntime.watch();
} else {
  console.log('[scripts] file watch disabled (set UO_SCRIPT_WATCH=1 to enable hot reload).');
}
// Start AI only after scripts have registered every behavior and restored
// binding. Previously the timer started before world restore; on a 10k-NPC
// save it began consuming the event loop halfway through script loading and
// delayed the listening socket by minutes.
ai.start();

// After every script reload, push the refreshed command catalogue to
// all connected clients. Was: the right-edge `CommandPanel` showed
// stale commands (or "— no commands —") after hot-reload because the
// only push site lived in `LoginComplete`.
world.events?.on?.('scripts:reloaded', () => {
  try { items.rehydrateWorldItemDefinitions(world); }
  catch (e) { console.warn('[item-script] definition rehydrate failed:', e?.message); }
  try { itemScriptRegistry.rebuildTickingItemIndex(world); }
  catch (e) { console.warn('[item-script] tick index rebuild failed:', e?.message); }
  try { rebuildTickingMobileIndex(world); }
  catch (e) { console.warn('[mobile-script] tick index rebuild failed:', e?.message); }
  import('./net/handlers.js').then(({ pushCommandCatalogueToAll }) => {
    try { pushCommandCatalogueToAll(world); }
    catch (e) { console.warn('[cmd-catalog] reload push failed:', e?.message); }
  }).catch(() => { /* module unavailable */ });
});

// Admin command: force a script reload without restarting the server.
//
//   [reload                — reload ALL scripts
//   [reload <rel/path.js>  — reload only that one (faster + isolated;
//                            disposes only the matching entry)
commands.register({
  name: 'reload',
  help: '[reload [path/to/script.js] — reload all gameplay scripts, or one specific file.',
  access: 'Admin',
  run: (ctx) => {
    const arg = (ctx.args ?? [])[0];
    if (arg) {
      console.log(`[scripts] manual reloadOne via [reload ${arg}`);
      scriptRuntime.reloadOne(arg)
        .then((r) => {
          if (r.ok) {
            ctx.state?.sendSystemMessage?.(`Reloaded: ${r.rel}`);
          } else {
            ctx.state?.sendSystemMessage?.(`Reload failed: ${r.error}`);
          }
        })
        .catch((e) => {
          console.error('[scripts] reloadOne failed', e);
          ctx.state?.sendSystemMessage?.(`Reload failed: ${e.message}`);
        });
      return;
    }
    console.log('[scripts] manual reload via [reload');
    scriptRuntime.load({ reason: 'admin-command', emitEvent: true })
      .then(() => {
        ctx.state?.sendSystemMessage?.(`Reloaded all scripts (${scriptRuntime.loaded?.length ?? 0}).`);
      })
      .catch((e) => {
        console.error('[scripts] reload failed', e);
        ctx.state?.sendSystemMessage?.(`Reload failed: ${e.message}`);
      });
  },
});

// Capture timer handles so `shutdown()` can clear them. `.unref()` keeps
// them from holding the event loop open on normal exit, but we still want
// to stop firing ticks *before* wss.close() runs — otherwise a combat or
// spawner tick can mutate the world after the final save is written.
const authSweepTimer = setInterval(() => authKeys.sweep(), 10_000);
authSweepTimer.unref();

// Combat scheduler: process auto-attack swings at 10Hz. `corpse.killMobile`
// handles the death broadcast + corpse spawn when HP hits 0. The third
// arg (killer) lets the corpse module run notoriety bookkeeping —
// counting murders of innocents toward the red-name flag.
const stopRuntimeMonitor = operational.startRuntimeMonitor();
const combatTimer = setInterval(() => operational.measureTick('combat', () => {
  combat.tick(world, (w, victim, killer) => corpse.killMobile(w, victim, killer));
}), 100);
combatTimer.unref();

// Corpse decay sweeper — removes corpses older than 5 minutes.
const corpseTimer = setInterval(() => corpse.sweepDecayedCorpses(world), 30_000);
corpseTimer.unref();

// Aggression / Heat-of-Battle sweep — drops the buff icon when the
// 2-min combat window lapses. Fields stay zeroed afterwards so the
// sweep is cheap.
const { sweepExpired: sweepAggression } = await import('./aggression.js');
const aggressionTimer = setInterval(() => sweepAggression(world), 5_000);
aggressionTimer.unref();

// Quest "visit" objective bridge — when a tracked player crosses into
// a new region, fire `kind: 'visit'` on every active quest so the
// `quest-chains.json` definitions that include
// `{ kind: 'visit', region: <name> }` actually advance.
regionOnEnter.onAnyEnter((mob, ctx) => {
  if (!mob?.activeQuests || !ctx.next) return;
  try { questSystem.notifyEvent(mob, { kind: 'visit', target: ctx.next }); }
  catch { /* advisory */ }
});

// Aquarium daily-tick sweep — runs every 30 min (real time); the
// helper itself gates on the 24-hour-since-last-tick stamp so the
// cadence is naturally daily without setTimezone-style wall-clock
// drift. Aquarium fish lose 1 food+water per fish per tick; starved
// aquariums flip 'overdue' → 'dead' after a second consecutive
// neglected tick.
const { tickAquariums } = await import('../../scripts/src/items/scripts/functional/aquarium.js');
const aquariumTimer = setInterval(() => {
  try { tickAquariums(world); }
  catch (e) { console.error('[aquarium] tick:', e); }
}, 30 * 60_000);
aquariumTimer.unref();

// Item decay sweeper — UO 1-hour timeout on movable ground items. See
// `world/decay.js` for opt-out flags (`movable=false`, `isDecoration`,
// `_noDecay`). Timer survives saves via persistence ITEM_EXT_KEYS.
const { startDecaySweeper } = await import('./world/decay.js');
const decayTimer = startDecaySweeper(world, {
  intervalMs: 1000,
  maxPerTick: 512,
  onTick: ({ stamped, expired }) => {
    if (expired > 0) console.log(`[decay] expired ${expired} ground item${expired === 1 ? '' : 's'} (stamped ${stamped} fresh)`);
  },
});

// Spawner tick — scripts register spawn groups via api.spawner.add().
const spawnerTimer = setInterval(() => operational.measureTick('spawner', () => spawner.tick()), 10_000);
spawnerTimer.unref();

// XmlSpawner attachments — expiration and timed-effect hooks. This is the
// Node-native equivalent of XmlAttachment timers in ServUO.
const xmlAttachmentTimer = setInterval(() => {
  try { tickXmlAttachments(world, Date.now()); }
  catch (e) { console.error('[xml-attachments]', e.message); }
}, 1000);
xmlAttachmentTimer.unref();

// Resource regen — HP/Mana/Stam slowly tick back up. The 1Hz cadence is
// fine-grained enough that fractional rates round nicely and coarse enough
// that the wire isn't flooded with status packets when 200 mobs all gain
// 1 HP at the same instant.
const REGEN_INTERVAL_MS = 1000;
let lastRegenAt = Date.now();
const regenTimer = setInterval(() => {
  operational.measureTick('regen', () => {
    const now = Date.now();
    const pass = regen.regenTickBudgeted(world, now - lastRegenAt, 1024);
    if (pass.remaining) runtimeGovernor.watchdog.skip('regen-deferred', Math.max(0, world.mobiles.size - pass.processed));
    lastRegenAt = now;
  });
}, REGEN_INTERVAL_MS);
regenTimer.unref();

const regionTimer = startRegionTracker({ world, regions, achievementsSystem, protocol });

// Timed status effects (poison DoT, bless/curse, etc). 500ms is frequent
// enough for a 2s poison tick to feel responsive and still cheap even
// with hundreds of mobs (most have zero effects).
const statusEffectsTimer = setInterval(() => {
  statusEffects.tickAll(world, Date.now());
}, 500);
statusEffectsTimer.unref();

// Pet hunger + loyalty drift (1Hz, fractional accumulation).
const petHungerTimer = setInterval(() => {
  try { tickPetHunger(world, 1.0); }
  catch (e) { console.error('[pet-hunger]', e.message); }
}, 1000);
petHungerTimer.unref();

// Pet bonding promotion sweep — promotes any tamed creature past the
// 7-day BondingDelay to `bonded = true`. Cadence is 1 h: precision is
// fine for a multi-day window and the sweep walks just `world._pets`.
// Ocean encounters — every 5 min, each boat with riders rolls for a
// sea-serpent / kraken / undead-pirate / water-elemental spawn. Cheap:
// walks `world.items` once for boats; spawn factory does the rest.
import('./systems/ocean-encounters.js').then(({ tickOceanEncounters }) => {
  const t = setInterval(() => {
    try {
      const n = tickOceanEncounters(world, {
        spawnFactory: sharedCtx.spawnFactory,
        landProvider,
        broadcastNear: (w, center, range, text) => {
          const pkt = protocol.unicodeMessage?.({
            text, hue: 0x35, font: 3, name: 'The Sea',
          });
          if (!pkt) return;
          const sectors = w.sectors;
          if (sectors?.mobileSerialsNear) {
            for (const s of sectors.mobileSerialsNear(center.map, center.x, center.y, range)) {
              const m = w.mobiles.get(s);
              if (m?.client) m.client.send(pkt);
            }
          }
        },
      });
      if (n > 0) console.log(`[ocean-enc] ${n} encounter(s) triggered`);
    } catch (e) { console.error('[ocean-enc]', e.message); }
  }, 5 * 60 * 1000);
  t.unref();
}).catch(() => { /* optional module */ });

const petBondTimer = setInterval(() => {
  try {
    const promoted = sweepBondingPromotions(world, Date.now());
    if (promoted > 0) console.log(`[pet-bond] auto-bonded ${promoted} pet(s)`);
  } catch (e) { console.error('[pet-bond]', e.message); }
}, 60 * 60 * 1000);
petBondTimer.unref();

// Player-vendor charges + abandon-grace sweep (1 minute is plenty —
// the engine accumulates fractions per real hour internally).
const playerVendorTimer = setInterval(() => {
  try { playerVendorSystem.tickPlayerVendors(world, 60); }
  catch (e) { console.error('[player-vendor]', e.message); }
}, 60_000);
playerVendorTimer.unref();

// Item + Mobile script tick — content registers `hasTick:true` to opt
// in. Cheap O(items+mobiles) walk; most entries skip immediately.
const scriptTickTimer = setInterval(() => {
  operational.measureTick('scripts', () => {
    try { itemScriptRegistry.tickAllItemScripts(world, 1.0); }
    catch (e) { console.error('[item-script tick]', e.message); }
    try { tickAllMobileScripts(world, 1.0); }
    catch (e) { console.error('[mobile-script tick]', e.message); }
  });
}, 1000);
scriptTickTimer.unref();

// Faction sigil corruption tick — each sigil "corrupts" its town to
// the carrier's faction after 10 minutes of uninterrupted carry.
// Without this loop the timer started but never advanced (the function
// existed in `systems/pvp/sigils.js` but no caller wired it). 30s cadence
// is plenty given the 10-min ramp; cheaper than walking world.mobiles.
const sigilTimer = setInterval(() => {
  try {
    sigilSystem.tickCorruption?.(Date.now(), (mob) => mob?.faction ?? null);
  } catch (e) { console.error('[sigils]', e.message); }
}, 30_000);
sigilTimer.unref();

// Magincia distilled-potion buff sweeper — 60s. Expires per-stat 10-min
// buffs cleanly so str/dex/int don't accumulate over multiple drinks.
const distillationTimer = setInterval(() => {
  try { maginciaDistillationSystem.tickDistilledBuffs(world); }
  catch (e) { console.error('[distillation]', e.message); }
}, 60_000);
distillationTimer.unref();

// Camps restock sweep — 60s. Restocks dead NPCs across all placed
// camps with their original kind, re-rolls chest loot on next loot.
const campsTimer = setInterval(() => {
  try { campsSystem.tick(world, spawner); }
  catch (e) { console.error('[camps]', e.message); }
}, 60_000);
campsTimer.unref();

// Seasonal events scheduler — 60s cadence, detects window open/close edges.
const seasonalTimer = setInterval(() => {
  try { seasonalEventsSystem.tick(world); }
  catch (e) { console.error('[seasonal-events]', e.message); }
}, 60_000);
seasonalTimer.unref();

// Light-source burn-out sweep (60s). Walks ONLY lit torches/candles
// registered in the active set; cheap regardless of world size.
const lightDecayTimer = setInterval(() => {
  try { tickLightDecay(Date.now()); }
  catch (e) { console.error('[light-decay]', e.message); }
}, 60_000);
lightDecayTimer.unref();

// Murder-count decay sweep. ServUO's per-player kill counter drops one
// count every 8 hours of being crime-free; we approximate by running the
// check every 10 min and decrementing one count from any eligible
// player. Walking the mob map at 10-min cadence costs effectively
// nothing even on a populated shard.
const murderDecayTimer = setInterval(() => {
  try {
    const changed = notoriety.decayMurders(world, Date.now());
    if (changed > 0) console.log(`[notoriety] murder decay applied to ${changed} player(s)`);
  } catch (e) { console.error('[murder-decay]', e.message); }
}, 10 * 60 * 1000);
murderDecayTimer.unref();

// Stat-loss expiry sweep — 1 min cadence catches the 8 min timer with
// enough granularity. corpse.sweepStatLoss walks online players only;
// cost is trivial.
const statLossTimer = setInterval(() => {
  try {
    const restored = corpse.sweepStatLoss(world, Date.now());
    if (restored > 0) console.log(`[stat-loss] restored stats for ${restored} player(s)`);
  } catch (e) { console.error('[stat-loss]', e.message); }
}, 60 * 1000);
statLossTimer.unref();

// Summoned-creature auto-dismiss sweep (1Hz). Uses the summon index so
// normal NPC/player populations are not walked every second. Effects are
// best-effort.
const summonExpireTimer = setInterval(() => {
  try {
    tickSummons(world, {
      huedEffect: protocol.huedEffect,
      EffectKind: protocol.EffectKind,
      // Sector-aware fan-out: walk only buckets within the 18-tile
      // proximity window. On a populated shard the old full-walk fired
      // a Map iteration per dismissed summon; the typical neighbourhood
      // is 1-5 sectors so this drops the per-event cost ~1000×.
      broadcast: (w, m, pkt) => {
        const sectors = w.sectors;
        if (sectors?.mobileSerialsNear) {
          for (const serial of sectors.mobileSerialsNear(m.map, m.x, m.y, 18)) {
            const o = w.mobiles.get(serial);
            if (!o?.client || o.map !== m.map) continue;
            if (Math.abs(o.x - m.x) > 18 || Math.abs(o.y - m.y) > 18) continue;
            o.client.send(pkt);
          }
          return;
        }
        for (const o of w.mobiles.values()) {
          if (o.client && o.map === m.map &&
              Math.abs(o.x - m.x) <= 18 && Math.abs(o.y - m.y) <= 18) o.client.send(pkt);
        }
      },
    });
  } catch (e) { console.error('[summon-expire]', e.message); }
}, 1000);
summonExpireTimer.unref();

// Wire poison damage delivery — port of ServUO PoisonImpl.OnTick. Route
// through the central combat path so poison ticks share attribution,
// heat-of-battle, damage metadata, HP broadcast and death handling with
// every other harmful event.
poison.setDamageHook((target, amount, attacker) => {
  if (!target) return;
  combat.damage(world, target, amount, { attacker, damageType: { poison: 100 } });
});

// World-boss respawn checker (60s — bosses respawn on the order of
// hours, no need to poll faster).
const worldBossTimer = setInterval(() => {
  try { worldBosses.tick(world); }
  catch (e) { console.error('[world-boss]', e.message); }
}, 60_000);
worldBossTimer.unref();

// Peerless-boss mechanics tick (250ms — phases advance fast enough that
// players notice within a couple of seconds; cheap loop over mobiles).
function randomNearBoss(boss) {
  return {
    x: boss.x + Math.floor(Math.random() * 5) - 2,
    y: boss.y + Math.floor(Math.random() * 5) - 2,
    z: boss.z,
    map: boss.map,
  };
}

function broadcastSpawnedBossAdd(mob) {
  const equipment = [];
  const incoming = protocol.mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction, hue: mob.hue, flags: mob.flags,
    notoriety: mob.notoriety, equipment,
  });
  const healthPkt = protocol.healthUpdate?.({
    serial: mob.serial,
    current: mob.hp ?? mob.hpMax ?? 1,
    max: mob.hpMax ?? mob.hp ?? 1,
  });
  for (const other of query.clientsNear(mob, 18)) {
    other.client.send(incoming);
    if (healthPkt) other.client.send(healthPkt);
  }
}

function spawnPeerlessAddNear(boss, spec) {
  const pos = randomNearBoss(boss);
  if (typeof spec === 'string') {
    return sharedCtx.spawnFactory?.(world, spec, pos) ?? null;
  }
  if (!spec || typeof spec !== 'object') return null;
  const cfg = spec.kind ? monsters.get(spec.kind) : null;
  const mob = world.createMobile({
    name: spec.name ?? cfg?.name ?? 'a summoned creature',
    body: spec.body ?? cfg?.body ?? 0x0190,
    hue: spec.hue ?? cfg?.hue ?? 0,
    x: pos.x, y: pos.y, z: pos.z, map: pos.map,
    notoriety: spec.notoriety ?? cfg?.notoriety ?? 6,
    hp: spec.hp ?? cfg?.hp ?? 50,
    hpMax: spec.hpMax ?? spec.hp ?? cfg?.hp ?? 50,
    str: spec.str ?? cfg?.str ?? 50,
    dex: spec.dex ?? cfg?.dex ?? 50,
    int: spec.int ?? cfg?.int ?? 50,
    mana: spec.mana ?? cfg?.mana ?? cfg?.manaMax ?? 50,
    manaMax: spec.manaMax ?? cfg?.manaMax ?? spec.mana ?? 50,
  });
  Object.assign(mob, spec);
  mob.x = pos.x; mob.y = pos.y; mob.z = pos.z; mob.map = pos.map;
  if (spec.kind) mob.kind = spec.kind;
  mob.homeX = pos.x; mob.homeY = pos.y;
  const desiredAi = spec.ai ?? cfg?.ai ?? 'aggressive';
  const aiBehavior = ai.behaviors.has(desiredAi) ? desiredAi : (ai.behaviors.has('aggressive') ? 'aggressive' : null);
  if (aiBehavior) {
    mob.aiBehavior = aiBehavior;
    try {
      ai.attach(mob, aiBehavior, {
        targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
        home: { x: mob.x, y: mob.y },
        kind: mob.kind,
      });
    } catch { /* advisory */ }
  }
  broadcastSpawnedBossAdd(mob);
  return mob;
}

let _lastPeerlessAt = Date.now();
const peerlessBossTimer = setInterval(() => {
  const now = Date.now();
  const dt = now - _lastPeerlessAt;
  _lastPeerlessAt = now;
  try {
    peerlessBossesSystem.tickBosses(world, dt, {
      findTargetsInRange: (boss, range) => {
        const out = [];
        for (const m of query.clientsNear(boss, range)) {
          if ((m.hp ?? 0) <= 0) continue;
          out.push(m);
        }
        return out;
      },
      findTargetsInCone: (boss, range, halfAngle) => {
        const out = [];
        const facing = boss.direction ?? 0;
        // Direction byte → unit vector.
        const dirVec = [
          { x:  0, y: -1 }, { x:  1, y: -1 }, { x:  1, y:  0 }, { x:  1, y:  1 },
          { x:  0, y:  1 }, { x: -1, y:  1 }, { x: -1, y:  0 }, { x: -1, y: -1 },
        ];
        const fv = dirVec[(facing & 7)] ?? dirVec[0];
        for (const m of query.clientsNear(boss, range)) {
          const dx = m.x - boss.x, dy = m.y - boss.y;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (d > range || d === 0) continue;
          // Dot-product against facing → cone test.
          const norm = Math.hypot(dx, dy) || 1;
          const dot = (dx * fv.x + dy * fv.y) / norm;
          if (Math.acos(Math.max(-1, Math.min(1, dot))) <= halfAngle) out.push(m);
        }
        return out;
      },
      applyDamage: (target, amount, dmgType, attacker) => {
        if (!target) return;
        target.hp = Math.max(0, (target.hp | 0) - amount);
        if ((target.hp ?? 0) <= 0 && typeof corpse?.killMobile === 'function') {
          corpse.killMobile(world, target, attacker);
        }
      },
      applyEffect: (target, name, durationMs) => {
        statusEffects.add?.(target, { name, durationMs, expiresAt: Date.now() + durationMs });
      },
      applyHealOverTime: (target, total, durationMs) => {
        const ticks = 5;
        const each = Math.floor(total / ticks);
        const interval = Math.floor(durationMs / ticks);
        for (let i = 1; i <= ticks; i++) {
          setTimeout(() => {
            target.hp = Math.min(target.hpMax ?? target.hp, target.hp + each);
          }, i * interval);
        }
      },
      broadcastSpeech: (mob, text) => {
        for (const o of query.clientsNear(mob, 18)) {
          o.client.send(protocol.unicodeMessage({
            serial: mob.serial, graphic: mob.body, type: 0,
            hue: 0x35, font: 3, language: 'ENU',
            name: mob.name, text,
          }));
        }
      },
      spawnNearby: (boss, kind) => spawnPeerlessAddNear(boss, kind),
      spawnNear: (boss, spec) => spawnPeerlessAddNear(boss, spec),
      findNearbyByKind: (boss, kind, range) => {
        for (const m of query.mobilesNear(boss, range, boss)) {
          if (m.kind !== kind || m.map !== boss.map) continue;
          return m;
        }
        return null;
      },
      dropOnGround: (boss, payload) => {
        try {
          world.createItem({
            itemId: 0x14F0, name: payload.artifact ?? 'artifact',
            x: boss.x, y: boss.y, z: boss.z, map: boss.map,
            artifactDrop: payload,
          });
        } catch { /* ignore */ }
      },
    });
  } catch (e) { console.error('[peerless-tick]', e.message); }
}, 250);
peerlessBossTimer.unref();

// Unique boss encounter tick — drives per-boss specials (Medusa stone
// gaze, Stygian Dragon breath cone, Harrower curse, etc.). 1Hz cadence
// matches the per-boss internal cooldowns (most are 6-15s).
const bossEncountersModule = await import('./systems/bosses/boss-encounters.js');
const bossEncountersTimer = setInterval(() => {
  try {
    bossEncountersModule.tickBossEncounters(world, {
      applyDamage: (target, amount, _type, attacker) => {
        target.hp = Math.max(0, (target.hp | 0) - amount);
        if ((target.hp ?? 0) <= 0 && typeof corpse?.killMobile === 'function') {
          corpse.killMobile(world, target, attacker);
        }
      },
      broadcastSpeech: (mob, text) => {
        for (const o of query.clientsNear(mob, 18)) {
          o.client.send(protocol.unicodeMessage({
            serial: mob.serial, graphic: mob.body, type: 0,
            hue: 0x35, font: 3, language: 'ENU', name: mob.name, text,
          }));
        }
      },
      spawnNearby: (boss, kind) => {
        const factory = sharedCtx.spawnFactory;
        if (!factory) return null;
        return factory(world, kind, {
          x: boss.x + Math.floor(Math.random() * 5) - 2,
          y: boss.y + Math.floor(Math.random() * 5) - 2,
          z: boss.z, map: boss.map,
        });
      },
    });
  } catch (e) { console.error('[boss-encounter-tick]', e.message); }
}, 1000);
bossEncountersTimer.unref();

// Auction house sweeper — settles expired lots once a minute. Lots
// rarely live shorter than 24h so polling more often would burn CPU.
const auctionTimer = setInterval(() => {
  try { auctionHouseSystem.tickAuctions(world); }
  catch (e) { console.error('[auction-tick]', e.message); }
}, 60_000);
auctionTimer.unref();

// VvV siege rotation tick (1h — sieges open every 3 days; cheap check).
const vvvTimer = setInterval(() => {
  try { vvvSystem.tick(); }
  catch (e) { console.error('[vvv-tick]', e.message); }
}, 60 * 60 * 1000);
vvvTimer.unref();

// Plant lifecycle tick (1h cadence; the system internally gates on
// 24h per plant lastTickAt so this is just a "check often enough").
const plantsTimer = setInterval(() => {
  try { plantsSystem.tickPlants(world); }
  catch (e) { console.error('[plants-tick]', e.message); }
}, 60 * 60 * 1000);
plantsTimer.unref();

// Push buff/debuff gain + loss to the affected player's client so their
// HUD can render active-effect badges. NPC mobs (no `.client`) are skipped —
// nothing's watching their effect list yet. Classifying a few effects as
// debuffs is a thin table here rather than a field on the effect itself
// because scripts just push `{ name, durationMs, ... }` and don't think
// about UI taxonomy.
const DEBUFF_NAMES = new Set(['poison', 'curse', 'paralyze', 'weaken', 'clumsy', 'feeblemind']);
// FAZA CP — flag-bit mappings for canon UO mood overheads. Bit 0x01
// = paralyze (frozen), 0x04 = poisoned, 0x40 = warmode. The client
// reads these from 0x77 / 0x78 and paints icon overlays on the
// mobile sprite (anim-tint plus a small status icon overhead).
const FLAG_BIT = { paralyze: 0x01, poison: 0x04 };
// Reverse index of mobs that currently hold at least one status effect.
// statusEffects.tickAll() walks this Set instead of world.mobiles.values()
// (~11.7k entries) — the 1-Hz iteration cost drops from ~24k function
// calls/s to typically <100/s on a quiet shard.
world._mobsWithEffects ??= new Set();
for (const mob of world.mobiles.values()) {
  if (Array.isArray(mob.effects) && mob.effects.length > 0) world._mobsWithEffects.add(mob.serial);
}
statusEffects.setListener((mob, action, eff) => {
  if (action === 'add') {
    world._mobsWithEffects.add(mob.serial);
  } else if (action === 'remove') {
    // Drop the entry only when this was the last effect on the mob;
    // statusEffects.remove() has already mutated mob.effects by now.
    if (!mob.effects || mob.effects.length === 0) {
      world._mobsWithEffects.delete(mob.serial);
    }
  }
  // FAZA CP: maintain mob.flags for status icons + broadcast a 0x77
  // mobileMoving so all observers re-paint the mood overhead.
  const bit = FLAG_BIT[eff.name] | 0;
  if (bit) {
    // 0x17 HealthbarColor — distinct from the flag overhead. The flag
    // bit drives mood icons; the healthbar overlay drives the green/yellow
    // bar tint over the mobile sprite. Both must fire, otherwise the
    // poisoned target shows the icon but a white healthbar.
    if (eff.name === 'poison') {
      const lvl = action === 'add' ? ((eff.data?.level | 0) + 1) : 0;
      try {
        const pkt = protocol.healthbarPoison(mob.serial, lvl);
        for (const m of query.clientsNear(mob, 18)) {
          m.client.send(pkt);
        }
      } catch (e) {
        console.error('[mood] healthbar poison broadcast failed:', e);
      }
    }
    const before = mob.flags | 0;
    if (action === 'add') mob.flags = before | bit;
    else                  mob.flags = before & ~bit;
    if (mob.flags !== before) {
      try {
        const moving = protocol.mobileMoving({
          serial: mob.serial, body: mob.body,
          x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction ?? 0, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
        });
        for (const m of query.clientsNear(mob, 18)) {
          m.client.send(moving);
        }
      } catch (e) {
        console.error('[mood] flag broadcast failed:', e);
      }
    }
  }
  if (!mob?.client?.send) return;
  try {
    if (action === 'add') {
      const remaining = Math.max(0, (eff.expiresAt ?? 0) - Date.now());
      mob.client.send(protocol.buffAdd({
        serial: mob.serial,
        icon: eff.icon ?? statusEffects.buffIconForEffect(eff.name),
        name: eff.name,
        kind: DEBUFF_NAMES.has(eff.name) ? 'debuff' : 'buff',
        remainingMs: remaining,
      }));
    } else {
      mob.client.send(protocol.buffRemove({
        serial: mob.serial,
        icon: eff.icon ?? statusEffects.buffIconForEffect(eff.name),
      }));
    }
  } catch (e) {
    console.error('[buff] failed to notify client:', e);
  }
});

const http_server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health' || req.url === '/health/live' || req.url === '/health/ready') {
    const health = runtimeGovernor.health.snapshot();
    const readiness = req.url === '/health/ready';
    res.writeHead(readiness && !health.ready ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      name: 'uo-node',
      shard: config.shardName,
      protocolMode: config.protocolMode,
      protocols: {
        uo: true,
      },
      mobiles: world.mobiles.size,
      items: world.items.size,
      live: health.live,
      ready: health.ready,
      shuttingDown: health.shuttingDown,
      checks: readiness ? health.checks : undefined,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

// Peek + classify EVERY raw TCP connection that lands on the WS port.
// We attach a one-shot `data` listener BEFORE the http parser sees the
// bytes, snapshot the first chunk, then let the chunk flow normally —
// if it's a valid HTTP request the parser handles it (WebSocket
// upgrade fires), otherwise the http parser will throw `clientError`
// and we already have the bytes logged. This catches the classic
// "ClassicUO points at the WS port" mistake AND a worse mistake we
// kept missing: the CUO Launcher pinging the WS port for "is shard
// online?" while the actual game session uses the configured TCP
// port. Without the dump we can't tell those apart.
// CUO/Razor/OSI desktop fallback for the WS port. We REPLACE Node's
// default `connection` handler with our own so the http parser is
// never attached until we've decided the socket actually carries
// HTTP. Earlier attempts (`pause()` + `once('readable')`,
// `clientError` re-read) all lost the race: as soon as Node's
// internal connection handler attached `socket.on('data', parser)`,
// the stream auto-resumed and the bytes were consumed/discarded
// before our peek could fire. Saving + clearing + re-firing the
// internal handler is the only reliable way to interpose.
let cuoFallbackId = 0;
function _looksLikeUoOpcode(b) {
  return b === 0xEF || b === 0x80 || b === 0x91 || b === 0x73;
}
const _internalHttpConn = http_server.listeners('connection').slice();
http_server.removeAllListeners('connection');
http_server.on('connection', (socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  socket.once('data', (chunk) => {
    const firstByte = chunk[0];
    // ASCII A-Z 0x41-0x5A — HTTP method ("GET", "POST", ...).
    const looksHttp = firstByte >= 0x41 && firstByte <= 0x5A;
    if (looksHttp) {
      // Real HTTP — put bytes back and fire Node's internal
      // connection handler so the parser attaches and reads them.
      socket.unshift(chunk);
      for (const h of _internalHttpConn) h.call(http_server, socket);
      return;
    }
    const byteAt4 = chunk[4];
    const isUoDirect     = _looksLikeUoOpcode(firstByte);
    const isUoBareSeeded = chunk.length >= 5 && _looksLikeUoOpcode(byteAt4);
    const head = chunk.subarray(0, Math.min(48, chunk.length));
    const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(head).map((b) => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.').join('');

    if (isUoDirect || isUoBareSeeded) {
      const cid = ++cuoFallbackId;
      console.warn(`[uo-node] WS port fallback: UO client landed on ws://${config.port} (peer ${peer}). Handing off to TcpAdapter+NetState. NB: CUO/Razor/OSI normally connect to ${config.tcpHost}:${config.tcpPort ?? 2594} — pointing your launcher there avoids this fallback path entirely.`);
      console.warn(`[uo-node]   first ${head.length}B hex   : ${hex}`);
      const adapter = new TcpAdapter(socket);

      new NetState(adapter, { ...sharedCtx, id: `tcp-fb${cid}`, remoteAddress: socket.remoteAddress });
      // Feed the chunk we already consumed off the socket. Future
      // chunks reach the adapter via its own `on('data')` listener.
      adapter._onData(chunk);
      return;
    }

    console.warn(`[uo-node] WS port got a non-HTTP, non-UO request from ${peer} — dropping.`);
    console.warn(`[uo-node]   first ${head.length}B hex   : ${hex}`);
    console.warn(`[uo-node]   first ${head.length}B ascii : ${ascii}`);
    try { socket.destroy(); } catch { /* ignore */ }
  });
});

// Belt-and-suspenders: keep clientError around for legitimate HTTP
// parse failures (truncated requests, bad versions, etc).
http_server.on('clientError', (err, socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.warn(`[uo-node] WS port clientError from ${peer} (${err.code || err.message})`);
  try { socket.destroy(); } catch { /* ignore */ }
});

let wss = null;
let connId = 0;
const wsRoutes = new Map();
wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws, req) => {
  const id = ++connId;
  const remoteAddress = req.socket.remoteAddress;
  console.log(`[net#${id}] connected from ${remoteAddress}`);

  new NetState(ws, {
    ...sharedCtx,
    id,
    remoteAddress,
    nodeUOTransport: ws.protocol === 'nodeuo.v1',
  });
});
wsRoutes.set('/game', wss);

http_server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `ws://${req.headers.host ?? 'localhost'}`);
  const target = wsRoutes.get(url.pathname);
  if (!target) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => {
    target.emit('connection', ws, req);
  });
});

// Persistence and startup scripts may bulk-insert directly for compatibility.
// Rebuild once at the readiness boundary, then make sector/typed indexes the
// authoritative hot-path source. A background validator detects and repairs
// drift without putting a full-world scan inside movement or visibility ticks.
world.enableSpatialIndexes?.();
const spatialIndexTimer = setInterval(() => {
  runtimeGovernor.background.enqueue('world:spatial-index-audit', () => {
    const result = runtimeGovernor.watchdog.measure('spatial-index-audit', () => world.sectors.validate(world, { repair: true }));
    runtimeGovernor.health.set('indexes', result.ok || result.repaired,
      result.ok ? 'sector index consistent' : `${result.issues.length} issue(s) repaired`);
    if (!result.ok) operational.structuredEvent('world.index.repaired', { issues: result.issues.slice(0, 100) });
  }, { priority: 3, sector: 'maintenance' });
  runtimeGovernor.background.drain();
}, 60_000);
spatialIndexTimer.unref?.();

http_server.listen(config.port, config.host, () => {
  runtimeGovernor.health.set('world', true, `${world.mobiles.size} mobiles, ${world.items.size} items`);
  runtimeGovernor.health.set('scripts', (scriptRuntime.profile?.failed ?? 0) === 0, `${scriptRuntime.loaded.length} loaded`);
  runtimeGovernor.health.set('indexes', world.sectors.validate(world).ok, 'sector index validated');
  runtimeGovernor.health.set('startup', true, 'listening');
  console.log(`[uo-node] listening on ws://${config.host}:${config.port} (/game)  (mode=${config.protocolMode}, shard="${config.shardName}", huffman=${config.huffmanOutgoing})`);
  console.log(`[uo-node] ready in ${Math.round(performance.now())}ms  (mobiles=${world.mobiles.size}, items=${world.items.size}, scripts=${scriptRuntime.loaded.length})`);
  operational.structuredEvent('server.ready', {
    startupMs: Math.round(performance.now()), mobiles: world.mobiles.size,
    items: world.items.size, scripts: scriptRuntime.loaded.length,
  });
});

// Optional parallel TCP listener for legacy UO clients (Razor / Steam /
// OSI / ClassicUO desktop). Same handlers, same world, just a different
// transport. Off unless UO_TCP_PORT is set to avoid surprise port use.
let tcpServer = null;
if (config.tcpPort) {
  tcpServer = startTcpListener({
    host: config.tcpHost,
    port: config.tcpPort,
    sharedCtx,
  });
} else {
  // Loud "off" log so when the user expects TCP to be reachable and it
  // isn't, the cause is obvious in the terminal. Marcin: "nie mam
  // żadnych logów w naszym terminalu" → sometimes the listener was
  // never asked to start because UO_TCP_PORT wasn't injected.
  console.log('[uo-node] TCP listener OFF (set UO_TCP_PORT=2594 or tick the toolbar TCP checkbox to enable for ClassicUO/Razor/OSI).');
}

// Optional web admin panel — accounts / characters / items / scripts /
// spawners / world ops. Off unless UO_ADMIN_PASS is set OR UO_ADMIN_PORT
// is explicitly given (the second case binds without a password and
// refuses every mutation, useful for read-only LAN dashboards).
let adminServer = null;
if (process.env.UO_ADMIN_PASS || process.env.UO_ADMIN_PORT) {
  // Keep the sizeable authoring/catalog module graph out of the normal shard
  // boot path. It is loaded only when the optional admin listener is enabled.
  const [{ startAdminServer }, { pushLogLine }] = await Promise.all([
    import('./admin/admin-server.js'),
    import('./admin/routes.js'),
  ]);
  // Tee console.log/warn/error into the admin /api/logs ring buffer
  // so the Logs tab shows recent server output without us writing a
  // separate logger.
  for (const lvl of ['log', 'warn', 'error']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...args) => {
      try { pushLogLine(args.map((a) => typeof a === 'string' ? a : safeStringify(a)).join(' ')); }
      catch { /* never block the original log */ }
      orig(...args);
    };
  }
  adminServer = startAdminServer({
    sharedCtx, scriptRuntime, scriptsDir, saveDir,
    persistence: { saveWorldSync, saveWorldAsync, loadWorldSync, requestSave, diagnostics: persistenceDiagnostics },
    accounts,
  });
}
function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Auto-save. Keep it configurable because large development worlds can make
// a too-eager interval look like a server loop in the logs.
const SAVE_INTERVAL_MS = resolveSaveIntervalMs();
let autoSaveRunning = false;
let autoSaveAgain = false;
let autoSaveFollowupTimer = null;

function resolveSaveIntervalMs() {
  const explicit = process.env.UO_SAVE_INTERVAL_MS ?? process.env.UO_AUTOSAVE_INTERVAL_MS;
  if (explicit != null) {
    const raw = Number(explicit);
    if (!Number.isFinite(raw)) return 180_000;
    if (raw <= 0) return 0;
    return Math.max(30_000, Math.round(raw));
  }
  return 180_000;
}

async function runAutoSavePass(reason = 'interval') {
  if (autoSaveRunning) {
    autoSaveAgain = true;
    return;
  }
  autoSaveRunning = true;
  try {
    // Async path: snapshot is taken sync (consistent world), disk write
    // happens off the event-loop. A second tick during a heavy save collapses
    // to one follow-up pass instead of producing duplicate log lines.
    const { bytes, ms } = await requestSave(world, saveDir);
    console.log(`[uo-node] auto-saved (${reason}; mobiles=${world.mobiles.size}, items=${world.items.size}, ${bytes}B, ${ms}ms)`);
  } catch (e) {
    console.error(`[uo-node] auto-save failed: ${e.message}`);
  } finally {
    autoSaveRunning = false;
    if (autoSaveAgain) {
      autoSaveAgain = false;
      clearTimeout(autoSaveFollowupTimer);
      autoSaveFollowupTimer = setTimeout(() => runAutoSavePass('coalesced'), 1000);
      autoSaveFollowupTimer.unref?.();
    }
  }

  // Houses live outside world.mobiles/items, so they need their own
  // pass. Cheap (one row per home, ≤ KB even for hundreds of houses)
  // and fire-and-forget — failure logs but doesn't block the world save.
  saveHousesAsync(houses, saveDir).then(({ bytes }) => {
    if (houses.houses.size > 0) {
      console.log(`[uo-node] auto-saved houses (n=${houses.houses.size}, ${bytes}B)`);
    }
  }).catch(e => {
    console.error(`[uo-node] houses save failed: ${e.message}`);
  });
  // Magincia Bazaar stalls — dynamic-import to avoid coupling the
  // top of main.js to a content-side module. Bug-hunt #5 A5.
  const stallSnap = _bazaarSerialize();
  if (stallSnap.length > 0) {
    saveBazaarAsync(stallSnap, saveDir).catch(e => {
      console.error(`[uo-node] bazaar save failed: ${e.message}`);
    });
  }
  // Day/night + weather + season state is tiny, but the interval path must
  // still avoid synchronous filesystem calls: a slow network volume can
  // otherwise pause movement acknowledgements for a full disk round-trip.
  saveWorldStateAsync({ dayNight: dayNight.serialize?.() ?? null }, saveDir)
    .catch((e) => console.error('[uo-node] world-state save failed:', e.message));
  // Bulletin boards — server parity #9 #10. Fire-and-forget async write.
  try {
    const bbPath = path.join(saveDir, 'bulletin-boards.json');
    fsp.writeFile(bbPath, JSON.stringify(serializeBoards()), 'utf8')
      .catch((e) => console.error('[uo-node] bulletin save failed:', e.message));
  } catch (e) { console.error('[uo-node] bulletin save threw:', e.message); }
}

const saveTimer = SAVE_INTERVAL_MS > 0
  ? setInterval(() => {
    runAutoSavePass();
  }, SAVE_INTERVAL_MS)
  : null;
if (saveTimer) saveTimer.unref();
else console.log('[uo-node] auto-save disabled (UO_SAVE_INTERVAL_MS=0).');

// Graceful shutdown. Stops every subsystem that owns a timer BEFORE the
// final save, so no tick mutates the world between the snapshot and the
// rename. Multiple signals in a row (user mashing Ctrl-C) must be idempotent.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeGovernor.health.beginShutdown();
  runtimeGovernor.health.set('shutdown', false, 'stopping listeners');
  const forcedExit = setTimeout(() => {
    console.error('[uo-node] graceful shutdown deadline exceeded');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  forcedExit.unref();
  console.log(`[uo-node] ${sig} received, shutting down`);
  // Stop accepting new sessions first, tell active players, then allow the
  // transport buffers a bounded drain window before snapshotting world state.
  try { wss?.close?.(); } catch { /* already closing */ }
  try { tcpServer?.close?.(); } catch { /* already closing */ }
  try { adminServer?.close?.(); } catch { /* already closing */ }
  try { http_server.close(); } catch { /* already closing */ }
  runtimeGovernor.health.set('shutdown', false, 'draining connections');
  for (const state of sharedCtx.connections) state.sendSystemMessage?.('Server is shutting down. Your character is being saved.');
  const drainUntil = Date.now() + 1000;
  while (Date.now() < drainUntil && [...sharedCtx.connections].some((state) => (Number(state.ws?.bufferedAmount) || 0) > 0)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const state of [...sharedCtx.connections]) state.close?.('server shutdown');
  // BH #12 B12 — wait for any in-flight async save to settle so our
  // sync save below doesn't race the same `.tmp` filenames.
  try { await awaitInFlightSaves(5000); }
  catch (e) { console.error(`[uo-node] awaitInFlightSaves: ${e.message}`); }
  try { ai.stop(); } catch (e) { console.error(`[uo-node] ai.stop failed: ${e.message}`); }
  try { dayNight.stop(); } catch (e) { console.error(`[uo-node] dayNight.stop failed: ${e.message}`); }
  try { scriptRuntime.stop?.(); } catch (e) { console.error(`[uo-node] scriptRuntime.stop failed: ${e.message}`); }
  clearInterval(authSweepTimer);
  clearInterval(combatTimer);
  clearInterval(corpseTimer);
  clearInterval(decayTimer);
  clearInterval(spawnerTimer);
  clearInterval(xmlAttachmentTimer);
  clearInterval(regenTimer);
  clearInterval(regionTimer);
  clearInterval(statusEffectsTimer);
  clearInterval(petHungerTimer);
  clearInterval(summonExpireTimer);
  clearInterval(worldBossTimer);
  clearInterval(spatialIndexTimer);
  clearInterval(saveTimer);
  stopRuntimeMonitor();
  clearTimeout(autoSaveFollowupTimer);
  runtimeGovernor.health.set('shutdown', false, 'writing final snapshot');
  try { saveWorldSync(world, saveDir); console.log('[uo-node] final save written'); } catch (e) { console.error(`[uo-node] final save failed: ${e.message}`); }
  try { saveHousesSync(houses, saveDir); } catch (e) { console.error(`[uo-node] final houses save failed: ${e.message}`); }
  // Bug-hunt #5 A5: final bazaar snapshot so stall auctions/bids
  // survive Ctrl-C restart, matching world/houses parity.
  try { saveBazaarSync(_bazaarSerialize(), saveDir); }
  catch (e) { console.error(`[uo-node] final bazaar save failed: ${e.message}`); }
  runtimeGovernor.health.set('shutdown', false, 'complete');
  clearTimeout(forcedExit);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
