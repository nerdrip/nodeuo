// World items.
//
// Items are stored in world.items (keyed by serial). Each has a world position
// (x, y, z, map) or a container/mobile parent (phase 4+). For MVP we only
// handle ground items.

import { dispatchItemEvent } from './item-scripts.js';
import { staticWeightFor } from './movement.js';
import {
  getItemByDefinition as contentItemByDefinition,
  getItemByTag as contentItemByTag,
} from '../content/items/index.js';
import { runtimeGovernor } from '../systems/runtime-governor.js';
import { EntityDirty } from './interest-management.js';

// Content definitions are trusted, server-owned data. Keep their serializable
// gameplay fields on runtime instances instead of maintaining a second,
// inevitably incomplete hand-written property list. The explicit list below
// remains useful documentation for common fields, while this fallback covers
// new content attributes (for example `farm`, `shipKind`, `powerHour` and
// quiver bonuses) on day one.
const CONTENT_DEFINITION_SKIP = new Set([
  'serial', 'id', 'definitionId', 'artId', 'itemId', 'effect', 'onCreate', 'contentDef',
]);
const PERSISTENCE_MARK_SKIP = new Set([
  ...CONTENT_DEFINITION_SKIP,
  'hue', 'amount', 'x', 'y', 'z', 'map', 'name', 'movable', 'parent',
  'gumpId', 'gridX', 'gridY', 'gridLocation', 'layer',
]);
const PERSISTENT_ITEM_FIELDS = Symbol.for('uo.itemPersistentFields');

function markPersistentItemField(item, key) {
  if (!item || PERSISTENCE_MARK_SKIP.has(key)) return;
  let fields = item[PERSISTENT_ITEM_FIELDS];
  if (!(fields instanceof Set)) {
    fields = new Set();
    Object.defineProperty(item, PERSISTENT_ITEM_FIELDS, {
      value: fields, writable: true, configurable: true, enumerable: false,
    });
  }
  fields.add(key);
}

function cloneItemData(value, seen = new WeakMap()) {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const entry of value) out.push(cloneItemData(entry, seen));
    return out;
  }
  if (value instanceof Set) {
    const out = new Set();
    seen.set(value, out);
    for (const entry of value) out.add(cloneItemData(entry, seen));
    return out;
  }
  if (value instanceof Map) {
    const out = new Map();
    seen.set(value, out);
    for (const [key, entry] of value) out.set(cloneItemData(key, seen), cloneItemData(entry, seen));
    return out;
  }
  if (value instanceof Date) return new Date(value.getTime());
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  seen.set(value, out);
  for (const [key, entry] of Object.entries(value)) {
    const cloned = cloneItemData(entry, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  return out;
}

/**
 * Fill absent runtime properties from a canonical content definition.
 * Existing instance state always wins, so restoring a growing crop or a
 * partially charged tool cannot be reset by a catalogue default.
 */
export function applyItemDefinitionDefaults(item, definition) {
  if (!item || !definition) return 0;
  let changed = 0;
  for (const [key, value] of Object.entries(definition)) {
    if (CONTENT_DEFINITION_SKIP.has(key) || value == null || typeof value === 'function') continue;
    markPersistentItemField(item, key);
    if (item[key] != null) continue;
    const cloned = cloneItemData(value);
    if (cloned === undefined) continue;
    item[key] = cloned;
    changed++;
  }
  return changed;
}

function applyItemCreationExtensions(item, data) {
  if (!item || !data) return 0;
  let changed = 0;
  for (const [key, value] of Object.entries(data)) {
    if (CONTENT_DEFINITION_SKIP.has(key) || value == null || typeof value === 'function') continue;
    markPersistentItemField(item, key);
    // Creation payloads are explicit overrides. Base identity/position fields
    // have already been normalised above; assigning them again is harmless and
    // keeps extension handling deterministic.
    const cloned = cloneItemData(value);
    if (cloned === undefined) continue;
    item[key] = cloned;
    changed++;
  }
  return changed;
}

/**
 * @typedef {Object} Item
 * @property {number} serial
 * @property {string} [definitionId] stable gameplay/content identity
 * @property {number} artId      graphic id from art.mul / UO wire id
 * @property {number} itemId     compatibility alias of artId
 * @property {number} hue
 * @property {number} amount
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} map
 * @property {string} [name]     optional display name (cliloc lookups come later)
 * @property {boolean} [movable]
 * @property {number | null} [parent]   serial of container/mobile holding the item, null = on ground
 * @property {number} [gumpId]          non-zero marks this item as a container; gump shown on 0x24
 * @property {number} [paperdollGumpId] equipped-paperdoll art, independent of itemId/artId
 * @property {number} [paperdollMaleGumpId] optional sex-specific equipped-paperdoll art
 * @property {number} [paperdollFemaleGumpId] optional sex-specific equipped-paperdoll art
 * @property {number} [gridX]           grid position inside parent container (0..~160)
 * @property {number} [gridY]
 * @property {number} [gridLocation]    SA slot index
 * @property {number} [layer]           equip layer (1..29) when worn on a mobile
 * @property {string} [template]        name of the template that spawned it
 */

/**
 * @param {import('./world.js').World} world
 * @param {Partial<Item> & {x:number, y:number, z:number, itemId?:number, artId?:number, definitionId?:string}} data
 * @returns {Item}
 */
export function createItem(world, data) {
  const contentDef = resolveContentDefinition(data);
  const serial = world.serial.allocItem();
  const artId = Number(
    data.artId
      ?? data.itemId
      ?? contentDef?.artId
      ?? contentDef?.itemId
      ?? (typeof contentDef?.id === 'number' ? contentDef.id : undefined),
  );
  if (!Number.isInteger(artId) || artId < 0 || artId > 0xFFFF) {
    throw new Error(`createItem: missing valid artId for ${data.definitionId ?? data.tagId ?? data.name ?? '<unnamed item>'}`);
  }
  const definitionId = String(
    data.definitionId
      ?? (typeof data.id === 'string' ? data.id : null)
      ?? contentDef?.definitionId
      ?? data.tagId
      ?? '',
  ).trim() || undefined;
  /** @type {Item} */
  const item = {
    serial,
    ...(definitionId ? { definitionId } : {}),
    artId,
    itemId: artId,
    hue: data.hue ?? contentDef?.hue ?? 0,
    amount: data.amount ?? 1,
    x: data.x, y: data.y, z: data.z,
    map: data.map ?? 1,
    name: data.name ?? contentDef?.name ?? contentDef?.title,
    movable: data.movable ?? contentDef?.movable ?? true,
    parent: data.parent ?? null,
    gumpId: data.gumpId ?? contentDef?.gumpId ?? 0,
    gridX: data.gridX ?? 0,
    gridY: data.gridY ?? 0,
    gridLocation: data.gridLocation ?? 0,
    // Equipment layer (1..29). Zero/undefined means the item is not worn —
    // it's either in a container, on the ground, or held by a player. The
    // starter outfit relies on this being round-tripped through createItem.
    layer: data.layer ?? 0,
  };
  Object.defineProperty(item, '_world', {
    value: world, writable: true, configurable: true, enumerable: false,
  });
  if (data.addonName != null) item.addonName = data.addonName;
  if (data.addonNames != null) item.addonNames = data.addonNames;
  if (data.training != null) item.training = data.training;
  for (const key of [
    '_addon', '_addonAnchor', 'addonName', 'addonNames', 'craftingStation', 'addonCraftSystem',
    'addonToolTurnedOn', 'toolUsesRemaining', 'toolMaxUses', '_spinningWheelBaseItemId',
    '_spinningWheelSpinningUntil', 'light', 'labelNumber', 'weight', 'stackable',
    'bandageHealingBonus',
    'firstAidBelt', 'firstAidMaxBandages', 'firstAidHealingBonus', 'firstAidWeightReduction',
    'blessed', 'newbied', 'accountBound', 'boundAccount', 'schemaDiscoveries',
    '_logs', '_nextResourceCount', 'waterSourceQuantity',
    'tagId', 'kind', 'category', 'resource', 'title', 'author', 'pages', 'writable',
    'readOnly', 'bookContentClilocs', 'bookPageDetails', 'noteString', 'servuoClass', 'servuoClasses', 'servuoPath',
    'poison', 'poisonLevel', 'poisonKind', 'poisonCharges', 'minPoisoningSkill',
    'cureTier', 'cureLevelInfo',
    'damage', 'aoeDamage', 'aoeRadius', 'damageType', 'throwRange',
    'statusEffect', 'statusDurationMs',
    'eodonEffect', 'eodonDurationMs',
    'content', 'quantity', 'maxQuantity', 'linked', 'linkLocation', 'linkMap',
    'attributes', 'resist', '_magicProps', '_magicResists', '_artifact',
    'weapon', 'shield', 'ar', 'strReq', 'twoHanded', 'skill', 'minDamage', 'maxDamage', 'speed', 'range', 'ammoId',
    'setId', 'setPieces', 'setAttributes', 'setResist', 'setSelfRepair',
    'equipLayer', 'slot', 'clothing', 'spellbook',
    'spellFocusing', 'spellCastTargetSerial', 'spellCastCount', 'spellId', 'customSpellId',
    'powerScroll', 'statScroll', 'treasureMap', 'seed',
    'container', 'capacity', 'maxWeight', 'lootTable', 'autoFillLoot', 'cleanupAddonType',
    'contentType', 'fillableType', 'fillableContentType', 'fillableMaxSpawnCount',
    'fillableSpawnThreshold', 'fillableNextRespawnAt', 'fillableNextCheckAt', 'fillableTotalTraps',
    'locked', 'lockedDown', 'lockDifficulty', 'lockpickDifficulty', 'lockLevel', 'requiredSkill',
    'trapped', 'trapPower', 'treasureLevel', 'paragonChest',
    'treasureMinSpawnMinutes', 'treasureMaxSpawnMinutes', 'treasureResetAt',
    'treasureDeleteAt', 'treasureChestMod',
    'charges', 'maxCharges', 'usesRemaining', 'toolKind', 'craftSystem', 'tool',
    'runicMaterial', 'runicBudget', '_runicTool',
    'replica', 'hitchingPostCost', 'magicSpell', 'magicCharges',
    'wandSpell', 'wandIdentify', 'defaultCharges',
    'nextUseTime', 'itemSockets', 'caddellite', 'caddelliteInfused', 'caddelliteTool',
    'canFortify', 'antique', 'negativeAttributes',
    'slayer', 'accessLevel', 'minorArtifact', 'artifactRarity', 'displayWeight',
    'armorAttributes', 'mageArmor', 'epiphanyAlignment', 'epiphanyType',
    'crystalKind', 'crystalActive', 'crystalCharges', 'crystalReceivers', 'crystalSender', 'crystalRechargeInfo',
    'salvageMode', 'mahjong', 'deck',
    'flipId', 'flipIds', 'secureLevel', 'sendingNextRechargeAt',
    'boundBraceletSerial', 'recharges', 'maxRecharges', 'inscription', 'transportPendingUntil',
    'staffOrbOwnerSerial', 'staffOrbHome', 'staffOrbStaffLevel', 'staffOrbAutoRes',
    'obsidianQuantity', 'obsidianStatueName',
    'secretWallLocked', 'secretWallActive', 'secretWallDest', 'secretWallSerial',
    'secretSwitchOn', 'secretSwitchBaseId', 'secretSwitchReturnId',
    'maabusFullItemId', 'maabusEmptyItemId', 'maabusSpawnLocation', 'maabusMobileSerial',
    'petWhistlePetSerial', 'petWhistlePetName', 'petWhistleAccount', 'petWhistleNextLinkAt',
    'secretKey', 'secretChestAccess', 'secretChestTrials', 'secretChestExpiresAt',
    'ethereal', 'etherealMountSerial', 'mountKind', 'mount', 'staffOnly',
    'freeAfterMs', 'forceShowProperties',
    'moonstoneType', 'moonstoneSettling', 'moonstoneGate', 'gateOwnerSerial', 'gateExpiresAt',
    'rentalDurationId', 'rentalPrice', 'rentalLandlordRenew', 'rentalOffereeSerial',
    'rentalOfferExpiresAt', 'rentalLandlordSerial', 'rentalHouseSerial',
    'aquarium', 'aquariumFish', 'fishKind', 'breed', 'servuoBaseClass', 'aquariumDecoration',
    'ballot', 'playerBB', 'ownerSerial',
    'imprisonedSummon', 'imprisonedServuoClass', 'summonKind', 'monsterStatuetteType',
    'emptyAt',
    'givesToothAche', 'toothAcheAcidity', 'gingerBreadMessages', 'holidaySweet',
    'visible', '_stewHiddenUntil', '_nextSolenSpawnAt',
    'fountainCharges', 'fountainMaxCharges', 'fountainNextRechargeAt',
    'graniteRewardCount', 'graniteNextUseAt', 'graniteSecureLevel',
    'flamingHeadType', '_flamingHeadBaseItemId', '_flamingHeadBreathingUntil',
    'pickpocketMinSkill', 'pickpocketMaxSkill', '_pickpocketBaseItemId', '_pickpocketSwingUntil',
    'dolphinRugType', 'dolphinRugState', 'dolphinResourceCount', 'dolphinNextResourceAt',
    'addonResourceKind', 'addonResourceState', 'addonResourceCount', 'addonResourceMax',
    'addonResourceRechargeAmount', 'addonNextResourceAt', 'addonResourceLabelNumber',
    'miningCartType', 'miningCartState', 'miningCartOre', 'miningCartGems', 'miningCartNextResourceAt',
    'sheepResourceCount', 'sheepNextResourceAt',
    'harpsichordSongs', 'harpsichordState', 'harpsichordDirection', 'harpsichordRollMusic',
    'archeryButteMinSkill', 'archeryButteMaxSkill', 'archeryButteArrows', 'archeryButteBolts',
    'archeryButteLastUseAt', 'archeryButteEntries', 'archeryButteFacing',
    'portraitFacing', '_portraitFacing', '_portraitNextUpdateAt',
    'bedOfNailsFacing', '_bedOfNailsFacing', '_bedOfNailsTrail',
    'musicId', 'musicTracks', 'musicDurationMs',
    '_musicTracks', '_musicActualSong', '_musicPlayingUntil', '_musicOriginalItemId', '_musicNextAnimAt',
    'args', 'displayName', 'anniversaryChoice', '_timepiece', '_dailyRare', '_ancientWall',
    '_sphynxFortune',
    // ServUO multis / boats. These fields are intentionally data-like:
    // scripts stamp them after placement, and templates/give can also pass
    // them through when spawning deeds or docked ships.
    'boat', 'boatPlank', 'boatKey', 'boatDeed',
    'cannon', '_mountSerial', '_mountDx', '_mountDy',
    '_deedMulti', '_deedOffset', '_contestHouse', '_previewHouse',
    '_multi', '_multiInstance', '_multiAnchor', '_multiHouseId', 'multiId',
    '_multiCollision', '_multiSurfaces', '_multiFootprint', '_multiBounds', '_multiBlueprintHash', '_multiComponentCount',
    '_multiAcl', '_multiOwner', '_multiName',
    '_customHouseId', '_customHouseKind', '_houseId', '_houseAclMode', '_movableBeforeLockdown', '_secureAddedLockdown', 'teleportTo', 'pairSerial',
    'miniHouseType', 'isRewardItem', 'rewardItem',
    'isDecoration', 'height',
    'door', 'solid', 'surface', 'bridge', 'sign', 'teleporter', 'destination', 'spawner', 'xmlSpawner', 'areaEffect', 'fieldSpell',
  ]) {
    if (data[key] != null) item[key] = data[key];
    else if (contentDef?.[key] != null) item[key] = contentDef[key];
  }
  // Close the global data-loss gap left by the legacy whitelist. Definitions
  // and explicit factories may add JSON-like gameplay fields without also
  // patching this engine file. Clone nested data so mutating one runtime item
  // never mutates the shared catalogue row or a sibling item.
  applyItemDefinitionDefaults(item, contentDef);
  applyItemCreationExtensions(item, data);
  if (item.kind === 'shield' && item.shield == null) item.shield = true;
  // Runtime behaviour is selected exclusively by stable definition identity.
  // `artId` is presentation data and is intentionally NOT consulted: any
  // number of unrelated item definitions may share the same UO graphic.
  // Factories must pass `definitionId` (preferred) or an explicit `script`.
  if (data.script != null) {
    item.script = data.script;
  } else if (contentDef?.script) {
    item.script = contentDef.script;
  }
  world.items.set(serial, item);
  world.interest?.mark?.(serial, EntityDirty.Created | EntityDirty.All, 'item');
  world.sectors?.addItem(item);
  if (!item.parent) world._groundItemCount = Math.max(0, (world._groundItemCount | 0) + 1);
  world.syncSpatialItem?.(item);
  // Tick index — register scripted items that opt into `onTick`. The
  // 1-Hz tick loop walks this Set instead of every world.items entry
  // (110k after [createworld). `_scriptHasTick` is a cached predicate
  // exported by item-scripts.js (lazy module ref to avoid circular).
  if (item.script && _itemScriptsMod?._scriptHasTick?.(item.script)) {
    world._tickingItems ||= new Set();
    world._tickingItems.add(serial);
  }
  // Reverse parent → children index. Updated on create / destroy /
  // setItemParent so callers that need "every item owned by mob X"
  // (corpse.killMobile, insurance.collectInsuredItems, bank cap check,
  // archery ammo lookup, container weight) can read in O(|children|)
  // instead of walking 110k world.items. Lazy-initialised here.
  if (item.parent != null) {
    world._childrenByParent ||= new Map();
    let set = world._childrenByParent.get(item.parent);
    if (!set) { set = new Set(); world._childrenByParent.set(item.parent, set); }
    set.add(serial);
  }
  // Item-history advisory log — best-effort, swallows missing module.
  try {
    _historyMod ??= maybeLoadHistory();
    _historyMod?.record?.(serial, 'create', { where: `${item.x},${item.y}` });
  } catch { /* ignore */ }
  return item;
}

function resolveContentDefinition(data = {}) {
  if (data.contentDef && typeof data.contentDef === 'object') return data.contentDef;
  const definitionId = data.definitionId ?? (typeof data.id === 'string' ? data.id : null);
  if (definitionId) {
    try {
      const byDefinition = contentItemByDefinition?.(definitionId);
      if (byDefinition) return byDefinition;
    } catch {
      // Content registry can be absent in minimal test harnesses.
    }
  }
  const tag = data.tagId ?? data.contentTag ?? data.itemTag;
  if (tag) {
    try {
      const byTag = contentItemByTag?.(tag);
      if (byTag) return byTag;
    } catch {
      // Content registry can be absent in minimal test harnesses.
    }
  }
  // Never infer a gameplay definition from art. Even a currently unique
  // graphic can gain another definition after a content reload, which used
  // to make behaviour depend on registration order.
  return null;
}

/**
 * Rehydrate old persisted items after content scripts have registered their
 * definitions. Only stable identity (`definitionId` / `tagId`) is used here;
 * art-id fallback is deliberately excluded because many unrelated UO items
 * share one graphic. Returns diagnostics for startup logs and tests.
 */
export function rehydrateWorldItemDefinitions(world) {
  const result = { items: 0, fields: 0, scripts: 0 };
  for (const item of world?.items?.values?.() ?? []) {
    let definition = null;
    try {
      if (item.definitionId) definition = contentItemByDefinition?.(item.definitionId) ?? null;
      if (!definition && item.tagId) definition = contentItemByTag?.(item.tagId) ?? null;
    } catch {
      definition = null;
    }
    if (!definition) continue;
    const hadScript = !!item.script;
    let fields = applyItemDefinitionDefaults(item, definition);
    // Definition-owned appearance is also a migration boundary. Old saves may
    // contain the pre-audit ground graphic, worn layer, or explicit zero gump
    // placeholders. Stable definition identity lets us repair those safely;
    // no lookup or precedence decision is ever made from shared artwork.
    const definitionArtId = Number(definition.artId);
    if (Number.isInteger(definitionArtId) && definitionArtId > 0) {
      const previousBaseArt = Number(item.artId ?? item.itemId);
      if (item.artId !== definitionArtId) { item.artId = definitionArtId; fields++; }
      // Preserve stateful graphic flips (open doors, active lights): update the
      // wire graphic only when it still equals the persisted base graphic.
      if (!Number.isFinite(previousBaseArt) || Number(item.itemId) === previousBaseArt) {
        if (item.itemId !== definitionArtId) { item.itemId = definitionArtId; fields++; }
      }
    }
    for (const key of ['paperdollGumpId', 'paperdollMaleGumpId', 'paperdollFemaleGumpId']) {
      const configured = Number(definition[key]);
      if (configured > 0 && !(Number(item[key]) > 0)) { item[key] = configured; fields++; }
    }
    const owner = world?.mobiles?.get?.(item.parent);
    const configuredLayer = Number(definition.equipLayer) | 0;
    if (owner && configuredLayer > 0 && item.layer !== configuredLayer
        && item.layer !== 21 && item.layer !== 0x1D) {
      item.layer = configuredLayer;
      fields++;
    }
    if (!fields) continue;
    result.items++;
    result.fields += fields;
    if (!hadScript && item.script) result.scripts++;
  }
  return result;
}

let _itemScriptsMod = null;
/** Late-bind from main.js so we can mark ticking items without a cycle. */
export function setItemScriptsModule(mod) { _itemScriptsMod = mod ?? null; }

let _historyMod = undefined;
function maybeLoadHistory() {
  try {
    return globalThis.__uoItemHistory ?? null;
  } catch { return null; }
}
/** Late-bind from main.js (avoids top-level circular import). */
export function setItemHistoryModule(mod) { _historyMod = mod ?? null; }

/** Remove an item from the world. */
export function destroyItem(world, serial) {
  // PHASE BN: dispatch onDestroy BEFORE deletion so the script still
  // sees the item ref (timers can clear, allies can be notified, etc).
  const it = world.items?.get?.(serial);
  if (it) {
    if (it._multiAnchor) world.multiSpatial?.unregister?.(it.serial);
    try { dispatchItemEvent(world, it, 'onDestroy'); }
    catch { /* ignore */ }
    // Wave 8: release a unique artifact's name back into the pool when
    // the item is destroyed so a future loot roll can re-spawn it.
    // Lazy require — this module loads before loot.js so a top-level
    // import would create a cycle.
    if (it._artifact) {
      try {

        import('./loot.js').then(({ artifactUniqueness }) => {
          artifactUniqueness?.release?.(it._artifact);
        }).catch(() => { /* loot module not ready — fine */ });
      } catch { /* ignore */ }
    }
  }
  world.items.delete(serial);
  world.interest?.mark?.(serial, EntityDirty.Removed, 'item');
  world.sectors?.removeItem(serial);
  if (it && !it.parent) world._groundItemCount = Math.max(0, (world._groundItemCount | 0) - 1);
  world.removeSpatialItem?.(serial);
  world._tickingItems?.delete?.(serial);
  world._xmlAttachmentEntities?.delete?.(serial);
  world._corpses?.delete?.(serial);
  world.clearPropertySubject?.(serial);
  // Reverse parent index — drop this serial from the bucket it lived in
  // AND drop any children bucket where this serial was the parent
  // (would otherwise leak a dangling Set keyed by a stale serial).
  if (it?.parent != null) {
    const set = world._childrenByParent?.get(it.parent);
    if (set) {
      set.delete(serial);
      if (set.size === 0) world._childrenByParent.delete(it.parent);
    }
  }
  world._childrenByParent?.delete?.(serial);
  try { _historyMod?.record?.(serial, 'destroy'); } catch { /* ignore */ }
}

/**
 * Re-parent an item from `oldParent` to `newParent` while keeping the
 * reverse index consistent. Use this from drag/drop, trade transfer,
 * banking — anywhere the parent field changes after creation. Falls
 * back to a direct assignment when the index is missing.
 */
export function setItemParent(world, item, newParent) {
  if (!item) return;
  const oldParent = item.parent;
  item.parent = newParent;
  runtimeGovernor.transactions.auditParent(item, oldParent, newParent);
  if (oldParent == null && newParent != null) world._groundItemCount = Math.max(0, (world._groundItemCount | 0) - 1);
  else if (oldParent != null && newParent == null) world._groundItemCount = Math.max(0, (world._groundItemCount | 0) + 1);
  // A parent transition is also a spatial transition: parented objects must
  // disappear from sector/tile/typed indexes immediately, while a drop to
  // ground becomes queryable before the next visibility refresh.
  world.sectors?.moveItem?.(item);
  world.interest?.mark?.(item.serial, EntityDirty.Parent | EntityDirty.Position, 'item');
  world.syncSpatialItem?.(item);
  const idx = world._childrenByParent;
  if (!idx) return;
  if (oldParent != null) {
    const set = idx.get(oldParent);
    if (set) {
      set.delete(item.serial);
      if (set.size === 0) idx.delete(oldParent);
    }
  }
  if (newParent != null) {
    let set = idx.get(newParent);
    if (!set) { set = new Set(); idx.set(newParent, set); }
    set.add(item.serial);
  }
}

/**
 * O(|children|) lookup for the items currently parented to `parentSerial`.
 * Falls back to a full walk when the index isn't initialised (test
 * fixtures that populate `world.items` directly without createItem).
 * Skips entries whose `world.items.get` returns undefined — guards
 * against stale entries persistence might leave behind.
 */
export function* childrenOf(world, parentSerial) {
  const idx = world._childrenByParent;
  if (idx) {
    const set = idx.get(parentSerial);
    if (!set) return;
    for (const s of set) {
      const it = world.items.get(s);
      if (it) yield it;
    }
    return;
  }
  for (const it of world.items.values()) {
    if (it.parent === parentSerial) yield it;
  }
}

/**
 * Iterate direct children of a container by serial.
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 * @returns {Iterable<Item>}
 */
export function* containerChildren(world, containerSerial) {
  // Reverse parent index — walks ~|children| instead of all 110k items.
  // Hot path: corpse decay, vendor stock, trade transfer, BOD crafting,
  // stealing, container deserialize.
  const idx = world._childrenByParent;
  if (idx) {
    const set = idx.get(containerSerial);
    if (!set) return;
    for (const s of set) {
      const it = world.items.get(s);
      if (it && it.parent === containerSerial) yield it;
    }
    return;
  }
  for (const it of world.items.values()) {
    if (it.parent === containerSerial) yield it;
  }
}

/**
 * Recursively walk every item inside `containerSerial` and any nested
 * containers below it. Order is depth-first; visit-once guard prevents
 * infinite loops on cyclic parent chains (which shouldn't exist but
 * have shown up in past save corruption). Mirrors ServUO
 * Container.cs `EnumerateItems()`.
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 * @returns {Generator<Item>}
 */
export function* containerChildrenRecursive(world, containerSerial) {
  const seen = new Set([containerSerial >>> 0]);
  const stack = [containerSerial >>> 0];
  const idx = world._childrenByParent;
  while (stack.length) {
    const cur = stack.pop();
    if (idx) {
      const set = idx.get(cur);
      if (!set) continue;
      for (const s of set) {
        if (seen.has(s)) continue;
        const it = world.items.get(s);
        if (!it || it.parent !== cur) continue;
        seen.add(s);
        yield it;
        if (it.gumpId) stack.push(it.serial);
      }
      continue;
    }
    for (const it of world.items.values()) {
      if (it.parent !== cur) continue;
      if (seen.has(it.serial)) continue;
      seen.add(it.serial);
      yield it;
      // Containers (have gumpId) descend.
      if (it.gumpId) stack.push(it.serial);
    }
  }
}

/**
 * Find the first item inside `containerSerial` (or its sub-containers)
 * matching a predicate. Mirrors ServUO `Container.FindItemByType<T>`.
 * Common predicates:
 *   `(it) => it.itemId === 0x0EED`        — first gold pile
 *   `(it) => it.tag === 'reagent:nightshade'` — first nightshade
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 * @param {(it: Item) => boolean} predicate
 * @param {boolean} [recursive=true]
 */
export function findItemBy(world, containerSerial, predicate, recursive = true) {
  const iter = recursive ? containerChildrenRecursive(world, containerSerial) : containerChildren(world, containerSerial);
  for (const it of iter) {
    if (predicate(it)) return it;
  }
  return null;
}

/**
 * Consume up to `amount` of items matching `predicate` from
 * `containerSerial`. Stackable items are decremented, non-stackable
 * destroyed. Returns the actual amount consumed.
 *
 * Mirrors ServUO `Container.ConsumeUpTo(Type, amount)` — used by the
 * crafting / spell-reagent / arrow systems to "take N from the bag".
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 * @param {(it: Item) => boolean} predicate
 * @param {number} amount
 */
export function consumeUpTo(world, containerSerial, predicate, amount) {
  let remaining = amount | 0;
  if (remaining <= 0) return 0;
  const matches = [];
  for (const it of containerChildrenRecursive(world, containerSerial)) {
    if (predicate(it)) matches.push(it);
  }
  let consumed = 0;
  for (const it of matches) {
    if (remaining <= 0) break;
    const have = it.amount ?? 1;
    if (have <= remaining) {
      consumed += have;
      remaining -= have;
      destroyItem(world, it.serial);
    } else {
      it.amount = have - remaining;
      consumed += remaining;
      remaining = 0;
    }
  }
  return consumed;
}

/**
 * Sum the gold-item (gold pile, gold ingot) amounts inside a container,
 * walking nested containers. Mirrors ServUO `Container.TotalGold`.
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 */
export function totalGold(world, containerSerial) {
  const GOLD_IDS = new Set([0x0EED, 0x0EEE, 0x0EEF]);
  let sum = 0;
  for (const it of containerChildrenRecursive(world, containerSerial)) {
    if (GOLD_IDS.has(it.itemId | 0)) sum += (it.amount ?? 1);
  }
  return sum;
}

/**
 * Count the items inside a container (recursive). Mirrors ServUO
 * `Container.TotalItems`.
 */
export function totalItems(world, containerSerial) {
  let n = 0;

  for (const _ of containerChildrenRecursive(world, containerSerial)) n++;
  return n;
}

/**
 * Sum the weight (in stones) of every item inside a container,
 * walking nested bags. Mirrors ServUO `Container.TotalWeight`.
 *
 * Per-item weight comes from tiledata (1 byte per static, 0..254).
 * Stackable items multiply by `amount`. Stored `_weight` overrides
 * tiledata for special items (treasure deeds, runebooks with charge
 * mass, etc.) — set on the item by content scripts.
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 */
export function totalWeight(world, containerSerial) {
  let w = 0;
  for (const it of containerChildrenRecursive(world, containerSerial)) {
    const per = (it._weight != null) ? (it._weight | 0) : staticWeightFor(it.itemId | 0);
    if (per <= 0) continue;
    w += per * (it.amount ?? 1);
  }
  return w;
}

/** Quick lookup for paperdoll layers — sums weight on every worn item
 *  (so a chainmail tunic adds 8st even though it's not in a container).
 *  Combined with `totalWeight(backpack)` you get the player's full load. */
export function wornWeight(world, mobSerial) {
  let w = 0;
  // Reverse parent index — walks ~10 worn layers instead of 110k items.
  const idx = world._childrenByParent?.get?.(mobSerial);
  const iter = idx
    ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
    : [...world.items.values()].filter((it) => it.parent === mobSerial);
  for (const it of iter) {
    if ((it.layer ?? 0) === 0) continue;     // skip backpack itself (handled separately)
    if (it.layer === 21) continue;
    const per = (it._weight != null) ? (it._weight | 0) : staticWeightFor(it.itemId | 0);
    if (per <= 0) continue;
    w += per * (it.amount ?? 1);
  }
  return w;
}

/**
 * PHASE CT — stackable art-id table. ServUO derives this from
 * tiledata.flags bit 0x08 (Stackable); we don't yet wire tiledata
 * into the server runtime, so keep an explicit list of canon
 * stackable graphics. Adding a new stackable: drop the art id here
 * (and ideally `stackable: true` in items.json so callers know).
 */
const STACKABLE_ITEM_IDS = new Set([
  0x0EED, 0x0EEF,                     // gold (pile + small pile)
  0x0F7A, 0x0F7B, 0x0F84, 0x0F85,     // reagents: black pearl, blood moss, garlic, ginseng
  0x0F86, 0x0F88, 0x0F8C, 0x0F8D,     // mandrake, nightshade, sulfurous ash, spider silk
  0x0F78, 0x0F7D, 0x0F8F, 0x0F8E,     // necromancy reagents
  0x0F8A,                              // pig iron
  0x0F7E, 0x0F80, 0x0F81, 0x4077,     // mysticism reagents
  0x1BD7, 0x1BDD, 0x1BD4, 0x1BFB,     // logs / boards / shafts / arrows
  0x1BF2,                              // iron ingot (other ingots same id, different hue)
  0x103B, 0x097B,                      // bread, roll
  0x09D0, 0x09EB, 0x09E9,              // apple, pear, peach
  0x1F4E, 0x1F4F, 0x1F50, 0x1F51,     // gems variants (rough)
  0x14EB, 0x14EE,                      // scroll, blank scroll
  0x1F14,                              // map / blank scroll
  0x0E21,                              // bandages
  0x0F18,                              // emerald
  0x0F19, 0x0F1A, 0x0F1B,              // ruby / sapphire / diamond
  0x14F0,                              // gold ingot (legacy)
]);

const COIN_BASE_START = 0x0EEA;
const COIN_BASE_END = 0x0EF2;

export function coinBaseItemId(itemId) {
  const id = itemId | 0;
  if (id < COIN_BASE_START || id > COIN_BASE_END) return 0;
  return COIN_BASE_START + Math.floor((id - COIN_BASE_START) / 3) * 3;
}

export function stackKeyItemId(itemId) {
  return coinBaseItemId(itemId) || (itemId | 0);
}

export function displayItemIdForAmount(itemId, amount = 1) {
  const base = coinBaseItemId(itemId);
  if (!base) return itemId | 0;
  const n = Math.max(1, amount | 0);
  if (n > 5) return base + 2;
  if (n > 1) return base + 1;
  return base;
}

for (let id = COIN_BASE_START; id <= COIN_BASE_END; id++) {
  STACKABLE_ITEM_IDS.add(id);
}

// PHASE DR: ServUO Magery scrolls span 0x1F2D..0x1F6C (64 spells × 1
// itemId each, 8 circles). Each spell scroll is stackable per ServUO
// `BaseScroll.cs Stackable=true`. We register the entire range up
// front so spell scrolls auto-merge in containers and after casts.
for (let id = 0x1F2D; id <= 0x1F6C; id++) STACKABLE_ITEM_IDS.add(id);
// Necromancy scrolls 0x2260..0x2272.
for (let id = 0x2260; id <= 0x2272; id++) STACKABLE_ITEM_IDS.add(id);

export function isStackableItemId(itemId) {
  return STACKABLE_ITEM_IDS.has(itemId | 0);
}

/**
 * Find an existing item in `containerSerial` that can absorb `incoming`
 * — same itemId + same hue + stackable. Returns null when no merge is
 * possible. Excludes the incoming item itself when it's already in the
 * container (e.g. a re-drop within the same bag).
 *
 * @param {import('./world.js').World} world
 * @param {number} containerSerial
 * @param {Item} incoming
 */
export function findMergeableStack(world, containerSerial, incoming) {
  if (!incoming) return null;
  if (!isStackableItemId(incoming.itemId)) return null;
  const incomingKey = stackKeyItemId(incoming.itemId);
  const incomingDefinitionId = String(incoming.definitionId ?? incoming.tagId ?? '').trim();
  // BH #12 B1 — use reverse parent index. Was a full 110k items walk
  // for every container drop (gold pickup, ingot stack, …).
  const idx = world._childrenByParent?.get?.(containerSerial);
  const iter = idx
    ? (function* () {
        for (const s of idx) {
          const it = world.items.get(s);
          if (it) yield it;
        }
      })()
    : (function* () {
        for (const it of world.items.values()) {
          if (it.parent === containerSerial) yield it;
        }
      })();
  for (const it of iter) {
    if (it === incoming) continue;
    if (it.serial === incoming.serial) continue;
    if ((it.layer ?? 0) > 0) continue;        // worn — never merge
    if (stackKeyItemId(it.itemId) !== incomingKey) continue;
    const existingDefinitionId = String(it.definitionId ?? it.tagId ?? '').trim();
    // Configured items are the same stack only when their stable identities
    // match. Graphic equality is merely a presentation check and must never
    // merge two definitions which intentionally reuse the same UO art.
    if ((incomingDefinitionId || existingDefinitionId)
      && incomingDefinitionId !== existingDefinitionId) continue;
    if ((it.hue ?? 0) !== (incoming.hue ?? 0)) continue;
    return it;
  }
  return null;
}

export function splitStack(world, item, amount) {
  if (!item || !isStackableItemId(item.itemId)) return null;
  const have = Math.max(1, item.amount | 0);
  const take = Math.max(1, Math.min(have, amount | 0));
  if (take >= have) return null;
  const coinBase = coinBaseItemId(item.itemId);
  if (coinBase) item.itemId = coinBase;
  const remainderData = { ...item, itemId: coinBase || item.itemId, amount: have - take };
  const remainder = createItem(world, remainderData);
  item.amount = take;
  return remainder;
}

/**
 * Merge `incoming` into `target`. Caller must ensure compatibility via
 * `findMergeableStack`. Returns the post-merge target so callers can
 * forward the new amount to clients. Destroys `incoming` after merge.
 *
 * @param {import('./world.js').World} world
 * @param {Item} target
 * @param {Item} incoming
 */
// Stack cap mirrors ServUO's `Item.MaxStackable` (60000 default). Without
// a clamp the client interprets `amount` as uint16 and wraps; a 100000
// pile would display as 34464, letting an attacker split-then-merge to
// dupe gold. Bug-hunt #2 A6 / C2.
const MAX_STACK = 60000;

export function mergeStacks(world, target, incoming) {
  const coinBase = coinBaseItemId(target?.itemId) || coinBaseItemId(incoming?.itemId);
  if (coinBase) {
    target.itemId = coinBase;
    incoming.itemId = coinBase;
  }
  const want = (target.amount ?? 1) + (incoming.amount ?? 1);
  if (want <= MAX_STACK) {
    target.amount = want;
    destroyItem(world, incoming.serial);
    return target;
  }
  // Partial merge — pour as much as fits, leave the remainder on the
  // incoming pile. The caller already moved `incoming` into the same
  // container; we leave it parented there too so the player ends up
  // with two stacks (one capped, one residual) instead of having the
  // top-up silently truncated.
  // Bug-hunt #12 B2: if target already at MAX_STACK, moved=0 and the
  // function would leave `incoming` un-merged but the protocol layer
  // typically already removed it from the source — leaving a zombie.
  // Short-circuit cleanly when nothing can move.
  if ((target.amount ?? 1) >= MAX_STACK) {
    return target;     // caller must keep `incoming` intact
  }
  const moved = MAX_STACK - (target.amount ?? 1);
  target.amount = MAX_STACK;
  incoming.amount = (incoming.amount ?? 1) - moved;
  if ((incoming.amount | 0) <= 0) {
    destroyItem(world, incoming.serial);
  }
  return target;
}
