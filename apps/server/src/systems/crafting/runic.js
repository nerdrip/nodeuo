// Runic crafting tier table — 11 metal types in ServUO/AOS smithing
// (and analogous tiers for fletching/tailoring). When a `BaseRunicTool`
// (item with `runicTool: { resource, charges }`) is in the crafter's
// pack, the resource override is consumed once per craft and the
// produced item gets the tier's hue + stat bonus.
//
// ServUO `Items/Resource/RunicHammer.cs` + `CraftResources.cs`.

export const METAL_TIERS = {
  iron:        { hue: 0x000, dmgBonus: 0,  durBonus: 0,   acBonus: 0  },
  'dull-copper': { hue: 0x973, dmgBonus: 1, durBonus: 5,  acBonus: 1  },
  shadow:      { hue: 0x966, dmgBonus: 2,  durBonus: 10,  acBonus: 2  },
  copper:      { hue: 0x96D, dmgBonus: 3,  durBonus: 15,  acBonus: 3  },
  bronze:      { hue: 0x972, dmgBonus: 4,  durBonus: 20,  acBonus: 4  },
  gold:        { hue: 0x8A5, dmgBonus: 5,  durBonus: 25,  acBonus: 5  },
  agapite:     { hue: 0x979, dmgBonus: 6,  durBonus: 30,  acBonus: 6  },
  verite:      { hue: 0x89F, dmgBonus: 7,  durBonus: 35,  acBonus: 7  },
  valorite:    { hue: 0x8AB, dmgBonus: 8,  durBonus: 40,  acBonus: 8  },
  blaze:       { hue: 0x489, dmgBonus: 9,  durBonus: 30,  acBonus: 5  },
  ice:         { hue: 0x4F2, dmgBonus: 5,  durBonus: 30,  acBonus: 9  },
  toxic:       { hue: 0x495, dmgBonus: 7,  durBonus: 30,  acBonus: 7  },
};

/** Find a usable runic tool in the crafter's pack and return its
 *  resource tier name + the item ref so the caller can decrement
 *  charges. Returns null when no runic tool is present. */
export function findRunicTool(world, crafter, kind = 'smith') {
  if (!world?.items) return null;
  const owned = (item) => {
    let parent = item?.parent;
    for (let depth = 0; parent != null && depth < 16; depth++) {
      if ((parent >>> 0) === (crafter.serial >>> 0)) return true;
      parent = world.items.get(parent >>> 0)?.parent;
    }
    return false;
  };
  // The runic tool normally lives inside the layer-21 backpack, not as a
  // direct child of the mobile. Use the reverse index to walk that small
  // subtree and fall back to an ownership-chain check for test worlds.
  const iter = [];
  const queue = [...(world._childrenByParent?.get?.(crafter.serial) ?? [])];
  const seen = new Set();
  while (queue.length) {
    const serial = queue.shift() >>> 0;
    if (seen.has(serial)) continue;
    seen.add(serial);
    const item = world.items.get(serial);
    if (!item) continue;
    iter.push(item);
    for (const child of world._childrenByParent?.get?.(serial) ?? []) queue.push(child);
  }
  if (iter.length === 0) {
    for (const item of world.items.values()) if (owned(item)) iter.push(item);
  }
  for (const it of iter) {
    if (!it.runicTool) continue;
    if (it.runicTool.kind && it.runicTool.kind !== kind) continue;
    if ((it.runicTool.charges | 0) <= 0) continue;
    return { tool: it, tier: it.runicTool.resource ?? 'iron' };
  }
  return null;
}

/** Apply the tier overlay to a freshly-crafted item. Mutates `item`
 *  in place; idempotent if the item is already iron. */
export function applyRunicTier(item, tierName) {
  const tier = METAL_TIERS[tierName];
  if (!tier || tierName === 'iron') return item;
  item.hue = tier.hue;
  item.resource = tierName;
  if (item.weapon) {
    item.weapon = { ...item.weapon };
    item.weapon.minDmg = (item.weapon.minDmg | 0) + tier.dmgBonus;
    item.weapon.maxDmg = (item.weapon.maxDmg | 0) + tier.dmgBonus;
  }
  if (item.armor) {
    item.armor = { ...item.armor };
    item.armor.ar = (item.armor.ar | 0) + tier.acBonus;
  }
  if (item.durabilityMax) {
    item.durabilityMax += tier.durBonus;
    item.durability = item.durabilityMax;
  }
  return item;
}
