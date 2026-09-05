import { UPDATE_RANGE } from './world/visibility.js';
import {
  findStandingZ as findWorldStandingZ,
  resolveStandingZ as resolveWorldStandingZ,
} from './world/movement.js';
import { createItem as createWorldItem } from './world/items.js';

function serialOf(v) {
  return typeof v === 'number' ? v >>> 0 : v?.serial >>> 0;
}

function centerOf(center) {
  return {
    x: center?.x | 0,
    y: center?.y | 0,
    z: center?.z | 0,
    map: center?.map ?? 1,
  };
}

function trySend(client, packet) {
  if (!client || !packet) return false;
  try {
    client.send?.(packet);
    return true;
  } catch {
    return false;
  }
}

function directMoveMobile(world, mob, dest = {}) {
  if (!mob) return null;
  const before = { x: mob.x, y: mob.y, z: mob.z, map: mob.map };
  if (dest.x != null) mob.x = dest.x | 0;
  if (dest.y != null) mob.y = dest.y | 0;
  if (dest.z != null) mob.z = dest.z | 0;
  if (dest.map != null) mob.map = dest.map | 0;
  world.sectors?.moveMobile?.(mob);
  return { mob, before, mapChanged: before.map !== mob.map };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function directSetItemParent(world, item, newParent) {
  if (!item) return null;
  const oldParent = item.parent;
  item.parent = newParent ?? null;
  const idx = world?._childrenByParent;
  if (!idx || oldParent === item.parent) return item;
  if (oldParent != null) {
    const set = idx.get(oldParent);
    if (set) {
      set.delete(item.serial);
      if (set.size === 0) idx.delete(oldParent);
    }
  }
  if (item.parent != null) {
    let set = idx.get(item.parent);
    if (!set) { set = new Set(); idx.set(item.parent, set); }
    set.add(item.serial);
  }
  return item;
}

function directMoveItem(world, item, dest = {}) {
  if (!item || !dest) return null;
  const before = {
    x: item.x, y: item.y, z: item.z, map: item.map, parent: item.parent,
  };
  if (hasOwn(dest, 'parent')) directSetItemParent(world, item, dest.parent);
  if (dest.x != null) item.x = dest.x | 0;
  if (dest.y != null) item.y = dest.y | 0;
  if (dest.z != null) item.z = dest.z | 0;
  if (dest.map != null) item.map = dest.map | 0;
  world?.sectors?.moveItem?.(item);
  return {
    item,
    before,
    mapChanged: before.map !== item.map,
    parentChanged: before.parent !== item.parent,
  };
}

function directDestroyItem(world, itemOrSerial) {
  const serial = serialOf(itemOrSerial);
  if (!world || !serial) return false;
  if (typeof world.destroyItem === 'function') {
    world.destroyItem(serial);
    return true;
  }
  const item = world.items?.get?.(serial);
  world.items?.delete?.(serial);
  world.sectors?.removeItem?.(serial);
  if (item?.parent != null) {
    const set = world._childrenByParent?.get?.(item.parent);
    if (set) {
      set.delete(serial);
      if (set.size === 0) world._childrenByParent.delete(item.parent);
    }
  }
  world._childrenByParent?.delete?.(serial);
  return true;
}

function directDestroyMobile(world, mobileOrSerial) {
  const serial = serialOf(mobileOrSerial);
  if (!world || !serial) return false;
  if (typeof world.destroyMobile === 'function') {
    world.destroyMobile(serial);
    return true;
  }
  world.mobiles?.delete?.(serial);
  world.sectors?.removeMobile?.(serial);
  return true;
}

/**
 * High-level gameplay facade for scripts.
 *
 * `api.world` stays a low-level escape hatch, while this facade is the
 * preferred path for common script work: nearby fanout, inventory walks,
 * and teleport/move operations that must keep world indexes in sync.
 */
export function createScriptGameApi({
  world,
  query,
  ops,
  protocol,
  handlers,
  items,
} = {}) {
  function spatialOpts(options = {}, defaultRange = UPDATE_RANGE) {
    const opts = typeof options === 'number' ? { range: options } : options;
    return {
      range: opts.range ?? defaultRange,
      self: opts.self ?? null,
    };
  }

  function* clientsNear(center, options = {}) {
    const { range, self } = spatialOpts(options);
    if (query?.clientsNear) {
      yield* query.clientsNear(center, range, self);
      return;
    }
    const c = centerOf(center);
    for (const m of world.mobiles.values()) {
      if (m === self) continue;
      if (!m.client || m.map !== c.map) continue;
      if (Math.abs(m.x - c.x) > range || Math.abs(m.y - c.y) > range) continue;
      yield m;
    }
  }

  function* mobilesNear(center, options = {}) {
    const { range, self } = spatialOpts(options);
    if (query?.mobilesNear) {
      yield* query.mobilesNear(center, range, self);
      return;
    }
    const c = centerOf(center);
    for (const m of world.mobiles.values()) {
      if (m === self) continue;
      if (m.map !== c.map) continue;
      if (Math.abs(m.x - c.x) > range || Math.abs(m.y - c.y) > range) continue;
      yield m;
    }
  }

  function* itemsNear(center, options = {}) {
    const { range } = spatialOpts(options);
    if (query?.itemsNear) {
      yield* query.itemsNear(center, range);
      return;
    }
    const c = centerOf(center);
    for (const it of world.items.values()) {
      if (it.parent) continue;
      if (it.map !== c.map) continue;
      if (Math.abs(it.x - c.x) > range || Math.abs(it.y - c.y) > range) continue;
      yield it;
    }
  }

  function* mobilesAt(center, options = {}) {
    const { self } = spatialOpts(options, 0);
    if (query?.mobilesAt) {
      yield* query.mobilesAt(center, self);
      return;
    }
    const c = centerOf(center);
    for (const m of mobilesNear(c, { range: 0, self })) {
      if ((m.x | 0) === c.x && (m.y | 0) === c.y && (m.map ?? 1) === c.map) yield m;
    }
  }

  function* itemsAt(center) {
    if (query?.itemsAt) {
      yield* query.itemsAt(center);
      return;
    }
    const c = centerOf(center);
    for (const it of itemsNear(c, { range: 0 })) {
      if ((it.x | 0) === c.x && (it.y | 0) === c.y && (it.map ?? 1) === c.map) yield it;
    }
  }

  function* allMobiles(predicate = null) {
    if (query?.allMobiles) {
      yield* query.allMobiles(predicate);
      return;
    }
    for (const m of world.mobiles.values()) {
      if (!predicate || predicate(m)) yield m;
    }
  }

  function* allItems(predicate = null) {
    if (query?.allItems) {
      yield* query.allItems(predicate);
      return;
    }
    for (const it of world.items.values()) {
      if (!predicate || predicate(it)) yield it;
    }
  }

  function findMobile(predicate) {
    if (query?.findMobile) return query.findMobile(predicate);
    if (typeof predicate !== 'function') return null;
    for (const m of allMobiles(predicate)) return m;
    return null;
  }

  function findItem(predicate) {
    if (query?.findItem) return query.findItem(predicate);
    if (typeof predicate !== 'function') return null;
    for (const it of allItems(predicate)) return it;
    return null;
  }

  function mobileBySerial(serialOrMobile) {
    if (query?.mobileBySerial) return query.mobileBySerial(serialOrMobile);
    const serial = serialOf(serialOrMobile);
    return serial ? (world.mobiles.get(serial) ?? null) : null;
  }

  function itemBySerial(serialOrItem) {
    if (query?.itemBySerial) return query.itemBySerial(serialOrItem);
    const serial = serialOf(serialOrItem);
    return serial ? (world.items.get(serial) ?? null) : null;
  }

  function entityBySerial(serialOrEntity) {
    if (query?.entityBySerial) return query.entityBySerial(serialOrEntity);
    const serial = serialOf(serialOrEntity);
    if (!serial) return null;
    return world.mobiles.get(serial) ?? world.items.get(serial) ?? null;
  }

  function* onlineMobiles() {
    if (query?.onlineMobiles) {
      yield* query.onlineMobiles();
      return;
    }
    if (typeof world.onlineMobiles === 'function') {
      yield* world.onlineMobiles();
      return;
    }
    for (const m of world.mobiles.values()) {
      if (m.client) yield m;
    }
  }

  function onlineCount() {
    if (query?.onlineCount) return query.onlineCount();
    let count = 0;
    for (const _ of onlineMobiles()) count++;
    return count;
  }

  function findOnline(predicate) {
    if (query?.findOnline) return query.findOnline(predicate);
    if (typeof predicate !== 'function') return null;
    for (const m of onlineMobiles()) {
      if (predicate(m)) return m;
    }
    return null;
  }

  function findOnlineByName(name) {
    if (query?.findOnlineByName) return query.findOnlineByName(name);
    const lower = String(name ?? '').trim().toLowerCase();
    if (!lower) return null;
    return findOnline((m) => (m.name ?? '').toLowerCase() === lower);
  }

  function findClientNear(center, predicate, options = {}) {
    const { range, self } = spatialOpts(options);
    if (query?.findClientNear) return query.findClientNear(center, predicate, range, self);
    if (typeof predicate !== 'function') return null;
    for (const m of clientsNear(center, { range, self })) {
      if (predicate(m)) return m;
    }
    return null;
  }

  function findMobileNear(center, predicate, options = {}) {
    const { range, self } = spatialOpts(options);
    if (query?.findMobileNear) return query.findMobileNear(center, predicate, range, self);
    if (typeof predicate !== 'function') return null;
    for (const m of mobilesNear(center, { range, self })) {
      if (predicate(m)) return m;
    }
    return null;
  }

  function findItemNear(center, predicate, options = {}) {
    const { range } = spatialOpts(options);
    if (query?.findItemNear) return query.findItemNear(center, predicate, range);
    if (typeof predicate !== 'function') return null;
    for (const it of itemsNear(center, { range })) {
      if (predicate(it)) return it;
    }
    return null;
  }

  function sendToClientsNear(center, packet, options = {}) {
    const { range, self } = spatialOpts(options);
    if (query?.sendToClientsNear) {
      return query.sendToClientsNear(center, packet, range, self);
    }
    let sent = 0;
    for (const m of clientsNear(center, { range, self })) {
      if (trySend(m.client, packet)) sent++;
    }
    return sent;
  }

  function sendToOnline(packet, predicate = null) {
    if (query?.sendToOnline) return query.sendToOnline(packet, predicate);
    let sent = 0;
    for (const m of onlineMobiles()) {
      if (predicate && !predicate(m)) continue;
      if (trySend(m.client, packet)) sent++;
    }
    return sent;
  }

  function resolveStandingZ(facet, x, y, requestedZ = 0) {
    return query?.resolveStandingZ?.(facet, x, y, requestedZ)
        ?? resolveWorldStandingZ(facet, x, y, requestedZ);
  }

  function findStandingZ(facet, x, y, requestedZ = 0) {
    if (query?.findStandingZ) return query.findStandingZ(facet, x, y, requestedZ);
    return findWorldStandingZ(facet, x, y, requestedZ);
  }

  function* childrenOf(parentOrSerial) {
    const parent = serialOf(parentOrSerial);
    if (!parent) return;
    if (query?.childrenOf) {
      yield* query.childrenOf(parent);
      return;
    }
    const bucket = world._childrenByParent?.get?.(parent);
    if (bucket) {
      for (const serial of bucket) {
        const it = world.items.get(serial);
        if (it && it.parent === parent) yield it;
      }
      return;
    }
    for (const it of world.items.values()) {
      if (it.parent === parent) yield it;
    }
  }

  function* descendantsOf(parentOrSerial) {
    if (query?.descendantsOf) {
      yield* query.descendantsOf(parentOrSerial);
      return;
    }
    const root = serialOf(parentOrSerial);
    if (!root) return;
    const seen = new Set([root]);
    const stack = [root];
    while (stack.length) {
      const parent = stack.pop();
      for (const it of childrenOf(parent)) {
        if (seen.has(it.serial)) continue;
        seen.add(it.serial);
        yield it;
        stack.push(it.serial);
      }
    }
  }

  function isContainedBy(item, ancestorOrSerial, options = {}) {
    const root = serialOf(ancestorOrSerial);
    if (!item || !root) return false;
    const maxDepth = options.maxDepth ?? 64;
    let parent = item.parent;
    for (let depth = 0; depth < maxDepth && parent != null; depth++) {
      if (parent === root) return true;
      parent = world.items.get(parent)?.parent;
    }
    return false;
  }

  function findBackpack(mob) {
    for (const it of childrenOf(mob)) {
      if ((it.layer ?? 0) === 21) return it;
    }
    return null;
  }

  function* equipped(mob) {
    for (const it of childrenOf(mob)) {
      if ((it.layer ?? 0) > 0) yield it;
    }
  }

  function findEquipped(mob, layerOrPredicate) {
    const predicate = typeof layerOrPredicate === 'function'
      ? layerOrPredicate
      : (it) => (it.layer ?? 0) === (layerOrPredicate | 0);
    for (const it of equipped(mob)) {
      if (predicate(it)) return it;
    }
    return null;
  }

  function findChild(parentOrSerial, predicate) {
    if (query?.findChild) return query.findChild(parentOrSerial, predicate);
    for (const it of childrenOf(parentOrSerial)) {
      if (predicate(it)) return it;
    }
    return null;
  }

  function findDescendant(parentOrSerial, predicate) {
    if (query?.findDescendant) return query.findDescendant(parentOrSerial, predicate);
    for (const it of descendantsOf(parentOrSerial)) {
      if (predicate(it)) return it;
    }
    return null;
  }

  function findInPack(mob, predicate) {
    const pack = findBackpack(mob);
    if (!pack) return null;
    for (const it of descendantsOf(pack)) {
      if (predicate(it)) return it;
    }
    return null;
  }

  function* packItems(mob) {
    const pack = findBackpack(mob);
    if (!pack) return;
    yield* descendantsOf(pack);
  }

  function isInPack(item, mob) {
    const pack = findBackpack(mob);
    return !!pack && isContainedBy(item, pack);
  }

  function moveMobile(mob, dest) {
    return ops?.moveMobile?.(mob, dest) ?? directMoveMobile(world, mob, dest);
  }

  function teleportMobile(mob, dest = {}, options = {}) {
    if (!mob || !dest) return null;
    const {
      range = UPDATE_RANGE,
      removeFromOld = true,
      notifyNew = true,
      selfUpdate = true,
      mapChange = true,
      refresh = false,
      state = null,
    } = options;

    const oldObservers = removeFromOld ? [...clientsNear(mob, { range, self: mob })] : [];
    if (removeFromOld && protocol?.removeEntity) {
      const rm = protocol.removeEntity(mob.serial);
      for (const other of oldObservers) trySend(other.client, rm);
    }

    const moved = moveMobile(mob, dest);
    if (!moved) return null;

    if (selfUpdate && mob.client && mapChange && moved.mapChanged && protocol?.extMapChange) {
      trySend(mob.client, protocol.extMapChange(mob.map));
    }
    if (selfUpdate && protocol?.mobileUpdate) {
      const pkt = protocol.mobileUpdate({
        serial: mob.serial,
        body: mob.body,
        hue: mob.hue ?? 0,
        flags: mob.flags ?? 0,
        x: mob.x,
        y: mob.y,
        z: mob.z,
        direction: mob.direction ?? 0,
      });
      if (!trySend(mob.client, pkt)) state?.send?.(pkt);
    }

    let newObservers = [];
    if (notifyNew && protocol?.mobileMoving) {
      const moving = protocol.mobileMoving({
        serial: mob.serial,
        body: mob.body,
        x: mob.x,
        y: mob.y,
        z: mob.z,
        direction: mob.direction ?? 0,
        hue: mob.hue ?? 0,
        flags: mob.flags ?? 0,
        notoriety: mob.notoriety ?? 1,
      });
      newObservers = [...clientsNear(mob, { range, self: mob })];
      for (const other of newObservers) trySend(other.client, moving);
    }

    if (refresh) {
      const refreshState = typeof refresh === 'object' ? refresh : state;
      try {
        handlers?.refreshSurroundings?.(refreshState);
      } catch {
        /* test harnesses may not have a full NetState */
      }
    }

    return {
      ...moved,
      oldObservers,
      newObservers,
    };
  }

  function moveItem(itemOrSerial, dest = {}) {
    const item = itemBySerial(itemOrSerial);
    if (!item || !dest) return null;
    return ops?.moveItem?.(item, dest) ?? directMoveItem(world, item, dest);
  }

  function setItemParent(itemOrSerial, parentOrSerial = null) {
    const item = itemBySerial(itemOrSerial);
    if (!item) return null;
    const parent = parentOrSerial == null ? null : serialOf(parentOrSerial);
    return ops?.setItemParent?.(item, parent) ?? directSetItemParent(world, item, parent);
  }

  function destroyItem(itemOrSerial) {
    const serial = serialOf(itemOrSerial);
    if (!serial) return false;
    return !!(ops?.destroyItem?.(serial) ?? directDestroyItem(world, serial));
  }

  function destroyMobile(mobileOrSerial) {
    const serial = serialOf(mobileOrSerial);
    if (!serial) return false;
    return !!(ops?.destroyMobile?.(serial) ?? directDestroyMobile(world, serial));
  }

  function createItem(data = {}) {
    const factory = items?.createItem ?? createWorldItem;
    return factory(world, data);
  }

  function createMobile(data = {}) {
    const mob = world?.createMobile?.(data) ?? null;
    if (!mob) return null;
    for (const [key, value] of Object.entries(data)) {
      if (key === 'serial') continue;
      if (!(key in mob)) mob[key] = value;
    }
    return mob;
  }

  function giveItem(mobileOrSerial, data = {}, options = {}) {
    const mob = mobileBySerial(mobileOrSerial);
    if (!mob) return null;
    const {
      requireBackpack = true,
      notify = true,
      randomGrid = false,
    } = options;
    const pack = findBackpack(mob);
    if (!pack && requireBackpack) return null;

    const gridX = data.gridX ?? data.x ?? (randomGrid ? 60 + ((Math.random() * 80) | 0) : 60);
    const gridY = data.gridY ?? data.y ?? (randomGrid ? 60 + ((Math.random() * 60) | 0) : 60);
    const desc = {
      ...data,
      parent: data.parent ?? pack?.serial ?? mob.serial,
      map: data.map ?? mob.map ?? 1,
      x: data.x ?? gridX,
      y: data.y ?? gridY,
      z: data.z ?? 0,
      gridX,
      gridY,
      gridLocation: data.gridLocation ?? 0,
    };
    const item = createItem(desc);
    if (item?.accountBound && !item.boundAccount) {
      const account = String(mob.accountName ?? mob.client?.accountName
        ?? mob.client?.account?.username ?? '').trim().toLowerCase();
      if (account) item.boundAccount = account;
    }
    if (item && notify && pack && protocol?.containerContentUpdate && mob.client) {
      trySend(mob.client, protocol.containerContentUpdate(item, pack.serial));
    }
    return item;
  }

  function resolveEntity(value) {
    if (value instanceof ScriptEntityRef) return value.entity;
    return entityBySerial(value) ?? value ?? null;
  }

  class ScriptEntityRef {
    constructor(entityOrSerial) {
      this.serial = serialOf(entityOrSerial);
    }

    get entity() { return entityBySerial(this.serial); }
    get exists() { return !!this.entity; }
    get x() { return this.entity?.x ?? 0; }
    get y() { return this.entity?.y ?? 0; }
    get z() { return this.entity?.z ?? 0; }
    get map() { return this.entity?.map ?? 1; }
    get name() { return this.entity?.name ?? ''; }

    position() {
      const entity = this.entity;
      return entity ? {
        x: entity.x | 0,
        y: entity.y | 0,
        z: entity.z | 0,
        map: entity.map ?? 1,
      } : null;
    }

    distanceTo(other) {
      const self = this.entity;
      const target = resolveEntity(other);
      if (!self || !target || (self.map ?? 1) !== (target.map ?? 1)) return Infinity;
      return Math.max(Math.abs((self.x | 0) - (target.x | 0)), Math.abs((self.y | 0) - (target.y | 0)));
    }

    inRange(other, range = UPDATE_RANGE) {
      return this.distanceTo(other) <= range;
    }

    nearbyMobiles(options = {}) {
      const self = this.entity;
      if (!self) return [];
      return [...mobilesNear(self, options)];
    }

    nearbyItems(options = {}) {
      const self = this.entity;
      if (!self) return [];
      return [...itemsNear(self, options)];
    }

    nearbyClients(options = {}) {
      const self = this.entity;
      if (!self) return [];
      return [...clientsNear(self, options)];
    }

    findMobileNear(predicate, options = {}) {
      const self = this.entity;
      return self ? findMobileNear(self, predicate, options) : null;
    }

    findItemNear(predicate, options = {}) {
      const self = this.entity;
      return self ? findItemNear(self, predicate, options) : null;
    }

    broadcast(packet, options = {}) {
      const self = this.entity;
      return self ? sendToClientsNear(self, packet, options) : 0;
    }
  }

  class ScriptMobileRef extends ScriptEntityRef {
    get mobile() { return mobileBySerial(this.serial); }
    get entity() { return this.mobile; }
    get client() { return this.mobile?.client ?? null; }

    send(packet) {
      return trySend(this.client, packet);
    }

    sendSystemMessage(text, hue) {
      const client = this.client;
      if (!client?.sendSystemMessage) return false;
      try {
        client.sendSystemMessage(text, hue);
        return true;
      } catch {
        return false;
      }
    }

    backpack() {
      const pack = findBackpack(this.mobile);
      return pack ? itemRef(pack) : null;
    }

    packItems(predicate = null) {
      const mob = this.mobile;
      if (!mob) return [];
      const items = [...packItems(mob)];
      return typeof predicate === 'function' ? items.filter(predicate) : items;
    }

    equipped(predicate = null) {
      const mob = this.mobile;
      if (!mob) return [];
      const items = [...equipped(mob)];
      return typeof predicate === 'function' ? items.filter(predicate) : items;
    }

    findInPack(predicate) {
      const mob = this.mobile;
      return mob && typeof predicate === 'function' ? findInPack(mob, predicate) : null;
    }

    move(dest = {}) {
      return moveMobile(this.mobile, dest);
    }

    teleport(dest = {}, options = {}) {
      return teleportMobile(this.mobile, dest, options);
    }

    giveItem(data = {}, options = {}) {
      return giveItem(this.mobile, data, options);
    }

    destroy() {
      return destroyMobile(this.serial);
    }
  }

  class ScriptItemRef extends ScriptEntityRef {
    get item() { return itemBySerial(this.serial); }
    get entity() { return this.item; }
    get parent() { return this.item?.parent ?? null; }

    children(predicate = null) {
      const item = this.item;
      if (!item) return [];
      const items = [...childrenOf(item)];
      return typeof predicate === 'function' ? items.filter(predicate) : items;
    }

    descendants(predicate = null) {
      const item = this.item;
      if (!item) return [];
      const items = [...descendantsOf(item)];
      return typeof predicate === 'function' ? items.filter(predicate) : items;
    }

    contains(other, options = {}) {
      const item = this.item;
      const child = resolveEntity(other);
      return !!item && !!child && isContainedBy(child, item, options);
    }

    isInPackOf(mob) {
      const item = this.item;
      return !!item && isInPack(item, mob);
    }

    move(dest = {}) {
      return moveItem(this.item, dest);
    }

    setParent(parentOrSerial = null) {
      return setItemParent(this.item, parentOrSerial);
    }

    destroy() {
      return destroyItem(this.serial);
    }
  }

  function mobileRef(mobileOrSerial) {
    const mob = mobileBySerial(mobileOrSerial);
    return mob ? new ScriptMobileRef(mob) : null;
  }

  function itemRef(itemOrSerial) {
    const item = itemBySerial(itemOrSerial);
    return item ? new ScriptItemRef(item) : null;
  }

  function ref(entityOrSerial) {
    const serial = serialOf(entityOrSerial);
    if (!serial) return null;
    const mob = mobileBySerial(serial);
    if (mob) return new ScriptMobileRef(mob);
    const item = itemBySerial(serial);
    if (item) return new ScriptItemRef(item);
    return null;
  }

  const inventory = Object.freeze({
    childrenOf,
    descendantsOf,
    isContainedBy,
    isInPack,
    packItems,
    equipped,
    findBackpack,
    findEquipped,
    findChild,
    findDescendant,
    findInPack,
  });

  const mobile = Object.freeze({
    create: createMobile,
    move: moveMobile,
    teleport: teleportMobile,
    giveItem,
    destroy: destroyMobile,
  });

  const item = Object.freeze({
    create: createItem,
    move: moveItem,
    setParent: setItemParent,
    destroy: destroyItem,
  });

  const refs = Object.freeze({
    EntityRef: ScriptEntityRef,
    MobileRef: ScriptMobileRef,
    ItemRef: ScriptItemRef,
  });

  const movement = Object.freeze({
    resolveStandingZ,
    findStandingZ,
  });

  return Object.freeze({
    clientsNear,
    mobilesNear,
    itemsNear,
    mobilesAt,
    itemsAt,
    allMobiles,
    allItems,
    mobileBySerial,
    itemBySerial,
    entityBySerial,
    findMobile,
    findItem,
    onlineMobiles,
    onlineCount,
    findOnline,
    findOnlineByName,
    findClientNear,
    findMobileNear,
    findItemNear,
    sendToClientsNear,
    sendToOnline,
    ref,
    mobileRef,
    itemRef,
    refs,
    inventory,
    mobile,
    item,
    movement,
  });
}
