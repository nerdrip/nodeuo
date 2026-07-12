/**
 * Build the equipment payload embedded in mobile-incoming packets.
 *
 * Runtime worlds maintain a parent -> children index, so the normal path is
 * proportional to the number of items worn by one mobile. The full item walk
 * is intentionally retained for small legacy/test worlds that populate the
 * item map directly without updating the reverse index.
 *
 * @param {import('../../world/world.js').World} world
 * @param {import('../../world/world.js').Mobile} mobile
 * @param {Map<number, import('../../world/world.js').Item[]> | null} [byOwner]
 * @returns {{serial:number, itemId:number, layer:number, hue:number}[]}
 */
export function equipmentFor(world, mobile, byOwner = null) {
  const equipment = [];
  if (byOwner) {
    appendEquipment(equipment, byOwner.get(mobile.serial) ?? []);
    return equipment;
  }

  const indexed = world._childrenByParent?.get?.(mobile.serial);
  if (indexed) {
    for (const serial of indexed) appendEquipmentItem(equipment, world.items.get(serial));
    return equipment;
  }

  for (const item of world.items.values()) {
    if (item.parent === mobile.serial) appendEquipmentItem(equipment, item);
  }
  return equipment;
}

/**
 * Bucket all worn items once before publishing a group of mobiles. This keeps
 * world join, teleport and resync at O(indexed items + visible mobiles), not
 * O(all world items * visible mobiles).
 *
 * @param {import('../../world/world.js').World} world
 * @returns {Map<number, import('../../world/world.js').Item[]>}
 */
export function buildEquipmentByOwner(world) {
  /** @type {Map<number, import('../../world/world.js').Item[]>} */
  const byOwner = new Map();
  const parentIndex = world._childrenByParent;

  if (parentIndex?.size) {
    for (const [parent, serials] of parentIndex) {
      for (const serial of serials) addWornItem(byOwner, parent, world.items.get(serial));
    }
    return byOwner;
  }

  for (const item of world.items.values()) addWornItem(byOwner, item.parent, item);
  return byOwner;
}

function addWornItem(byOwner, parent, item) {
  if (!parent || !item?.layer) return;
  let items = byOwner.get(parent);
  if (!items) {
    items = [];
    byOwner.set(parent, items);
  }
  items.push(item);
}

function appendEquipment(out, items) {
  for (const item of items) appendEquipmentItem(out, item);
}

function appendEquipmentItem(out, item) {
  if (!item?.layer) return;
  out.push({
    serial: item.serial,
    itemId: item.itemId,
    layer: item.layer,
    hue: item.hue ?? 0,
  });
}
