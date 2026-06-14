import { createItem, destroyItem } from '../../world/items.js';

// Addons — ENGINE ONLY.
//
// Addon definitions (armoire, brazier, statue, etc. + components) live
// in apps/scripts/src/data/world/addons.json and are registered at startup by
// apps/scripts/src/systems/housing/addons.js.
//
// Engine responsibilities:
//   - hold the addon catalogue (set by script via setAddons)
//   - placeAddon (spawn all components anchored)
//   - redeedAddon (collect components back into a deed)

/** @type {Record<string, { components: Array<{dx:number, dy:number, dz?:number, id?:number, itemId?:number}> }>} */
let _addons = {};

export function setAddons(table) { _addons = { ...(table || {}) }; }
export function listAddons() { return Object.keys(_addons); }
export function getAddonDef(name) { return _addons[name] ?? null; }

function addonComponentClasses(def, c) {
  const classes = new Set([...(def.servuoClasses ?? []), ...(c.servuoClasses ?? [])].filter(Boolean));
  const isContainer = c.container ?? def.container;
  const hasLabel = (c.labelNumber ?? def.labelNumber) != null;
  classes.add(isContainer ? 'AddonContainerComponent' : 'AddonComponent');
  if (hasLabel) classes.add(isContainer ? 'LocalizedContainerComponent' : 'LocalizedAddonComponent');
  return [...classes];
}

function inferCraftAddon(name, itemId) {
  const key = String(name ?? '').toLowerCase();
  const id = itemId | 0;
  const match = (ids) => ids.includes(id);
  if (key.includes('soul-forge') || key.includes('soul forge')) return null;
  if (key.includes('spinning-lathe')) return { script: 'spinning-lathe', craftingStation: 'carpentry', addonCraftSystem: 'Carpentry' };
  if (key.includes('smithing-press')) return { script: 'smithing-press', craftingStation: 'forge', addonCraftSystem: 'Blacksmithy' };
  if (key.includes('sewing-machine')) return { script: 'sewing-machine', craftingStation: 'tailoring', addonCraftSystem: 'Tailoring' };
  if (key.includes('writing-desk')) return { script: 'writing-desk', craftingStation: 'inscription', addonCraftSystem: 'Inscription' };
  if (key.includes('fletching')) return { script: 'fletching-station', craftingStation: 'fletching', addonCraftSystem: 'Bowcraft/Fletching' };
  if (key.includes('alchemy')) return { script: 'alchemy-table', craftingStation: 'alchemy', addonCraftSystem: 'Alchemy' };
  if (key.includes('oven') || key.includes('smoker')) return { script: 'oven', craftingStation: 'oven', addonCraftSystem: 'Cooking' };
  if (key.includes('loom') || match([0x105F, 0x1060, 0x1061, 0x1062])) return { script: 'loom', craftingStation: 'tailoring', addonCraftSystem: 'Tailoring' };
  if (key.includes('spinningwheel') || key.includes('spinning-wheel') || match([0x1015, 0x1019, 0x2E3D, 0x2E3F])) return { script: 'spinning-wheel', craftingStation: 'tailoring', addonCraftSystem: 'Tailoring' };
  if (key.includes('anvil') || match([0x0FAF, 0x0FB0, 0x1987, 0x2DD5, 0x2DD6])) return { script: 'anvil', craftingStation: 'anvil', addonCraftSystem: 'Blacksmithy' };
  if (key.includes('forge') || match([0x0FB1, 0x1985, 0x1986, 0x197A, 0x197E, 0x198E, 0x1992, 0x1976, 0x197A, 0x19A2, 0x199E, 0x2DD8])) return { script: 'forge', craftingStation: 'forge', addonCraftSystem: 'Blacksmithy' };
  return null;
}

/** Place a deeded addon at (x,y,z) on `map`. Returns the component items. */
export function placeAddon(world, name, opts = {}) {
  const def = _addons[name];
  if (!def || !world?.items) return [];
  const ax = opts.x | 0, ay = opts.y | 0, az = opts.z | 0, m = opts.map | 0;
  const out = [];
  for (const c of def.components) {
    const itemId = (c.itemId ?? c.id) | 0;
    if (!itemId) continue;
    const dz = c.dz ?? c.z ?? 0;
    const craft = inferCraftAddon(name, itemId);
    const it = createItem(world, {
      itemId,
      x: ax + (c.dx | 0), y: ay + (c.dy | 0), z: az + (dz | 0),
      map: m,
      _addon: name,
      _addonAnchor: { x: ax, y: ay, z: az },
      name: c.name ?? def.name ?? name.replace(/-/g, ' '),
      hue: c.hue ?? def.hue,
      script: c.script ?? def.script ?? craft?.script,
      kind: c.kind ?? def.kind,
      container: c.container ?? def.container,
      gumpId: c.gumpId ?? def.gumpId,
      capacity: c.capacity ?? def.capacity,
      maxWeight: c.maxWeight ?? def.maxWeight,
      cleanupAddonType: c.cleanupAddonType ?? def.cleanupAddonType,
      tagId: c.tagId ?? def.tagId,
      servuoClass: c.servuoClass ?? def.servuoClass ?? ((c.container ?? def.container) ? 'AddonContainerComponent' : 'AddonComponent'),
      servuoClasses: addonComponentClasses(def, c),
      training: c.training ?? def.training,
      craftingStation: c.craftingStation ?? def.craftingStation ?? craft?.craftingStation,
      addonCraftSystem: c.addonCraftSystem ?? def.addonCraftSystem ?? craft?.addonCraftSystem,
      addonToolTurnedOn: c.addonToolTurnedOn ?? def.addonToolTurnedOn ?? (craft ? true : undefined),
      toolUsesRemaining: c.toolUsesRemaining ?? def.toolUsesRemaining,
      toolMaxUses: c.toolMaxUses ?? def.toolMaxUses,
      light: c.light ?? def.light,
      movable: c.movable ?? def.movable ?? false,
      weight: c.weight ?? def.weight,
      labelNumber: c.labelNumber ?? def.labelNumber,
      miniHouseType: c.miniHouseType ?? def.miniHouseType,
      isRewardItem: c.isRewardItem ?? def.isRewardItem,
      rewardItem: c.rewardItem ?? def.rewardItem,
      visible: c.visible ?? def.visible,
      bandageHealingBonus: c.bandageHealingBonus ?? def.bandageHealingBonus,
      fountainCharges: c.fountainCharges ?? def.fountainCharges,
      fountainMaxCharges: c.fountainMaxCharges ?? def.fountainMaxCharges,
      fountainNextRechargeAt: c.fountainNextRechargeAt ?? def.fountainNextRechargeAt,
      teleportTo: c.teleportTo ?? def.teleportTo,
      musicId: c.musicId ?? def.musicId,
      _logs: c._logs ?? def._logs,
      _nextResourceCount: c._nextResourceCount ?? def._nextResourceCount,
      waterSourceQuantity: c.waterSourceQuantity ?? def.waterSourceQuantity,
      graniteRewardCount: c.graniteRewardCount ?? def.graniteRewardCount,
      graniteNextUseAt: c.graniteNextUseAt ?? def.graniteNextUseAt,
      graniteSecureLevel: c.graniteSecureLevel ?? def.graniteSecureLevel,
      flamingHeadType: c.flamingHeadType ?? def.flamingHeadType,
      pickpocketMinSkill: c.pickpocketMinSkill ?? def.pickpocketMinSkill,
      pickpocketMaxSkill: c.pickpocketMaxSkill ?? def.pickpocketMaxSkill,
      dolphinRugType: c.dolphinRugType ?? def.dolphinRugType,
      dolphinRugState: c.dolphinRugState ?? def.dolphinRugState,
      dolphinResourceCount: c.dolphinResourceCount ?? def.dolphinResourceCount,
      dolphinNextResourceAt: c.dolphinNextResourceAt ?? def.dolphinNextResourceAt,
      addonResourceKind: c.addonResourceKind ?? def.addonResourceKind,
      addonResourceState: c.addonResourceState ?? def.addonResourceState,
      addonResourceCount: c.addonResourceCount ?? def.addonResourceCount,
      addonResourceMax: c.addonResourceMax ?? def.addonResourceMax,
      addonResourceRechargeAmount: c.addonResourceRechargeAmount ?? def.addonResourceRechargeAmount,
      addonNextResourceAt: c.addonNextResourceAt ?? def.addonNextResourceAt,
      addonResourceLabelNumber: c.addonResourceLabelNumber ?? def.addonResourceLabelNumber,
      miningCartType: c.miningCartType ?? def.miningCartType,
      miningCartState: c.miningCartState ?? def.miningCartState,
      miningCartOre: c.miningCartOre ?? def.miningCartOre,
      miningCartGems: c.miningCartGems ?? def.miningCartGems,
      miningCartNextResourceAt: c.miningCartNextResourceAt ?? def.miningCartNextResourceAt,
      sheepResourceCount: c.sheepResourceCount ?? def.sheepResourceCount,
      sheepNextResourceAt: c.sheepNextResourceAt ?? def.sheepNextResourceAt,
      harpsichordSongs: c.harpsichordSongs ?? def.harpsichordSongs,
      harpsichordState: c.harpsichordState ?? def.harpsichordState,
      harpsichordDirection: c.harpsichordDirection ?? def.harpsichordDirection,
      harpsichordRollMusic: c.harpsichordRollMusic ?? def.harpsichordRollMusic,
    });
    if (it) out.push(it);
  }
  if (def.linkTeleporters) {
    const teles = out.filter((it) => it.script === 'teleporter');
    if (teles.length === 2) {
      teles[0].teleportTo = { x: teles[1].x, y: teles[1].y, z: teles[1].z, map: teles[1].map };
      teles[1].teleportTo = { x: teles[0].x, y: teles[0].y, z: teles[0].z, map: teles[0].map };
    }
  }
  return out;
}

/** Walk components grouped by anchor, destroy them, return deed descriptor. */
export function redeedAddon(world, anchor) {
  if (!world?.items || !anchor) return null;
  const ax = anchor.x | 0, ay = anchor.y | 0, az = anchor.z | 0;
  let name = null;
  const victims = [];
  for (const it of world.items.values()) {
    const a = it._addonAnchor;
    if (!a || a.x !== ax || a.y !== ay || a.z !== az) continue;
    victims.push(it);
    name = it._addon ?? name;
  }
  for (const it of victims) {
    try { destroyItem(world, it.serial); }
    catch { /* defensive */ }
  }
  if (!name) return null;
  return { deed: 'addon-deed', addonName: name };
}
