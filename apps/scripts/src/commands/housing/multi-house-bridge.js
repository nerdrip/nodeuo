import { allItems } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
import {
  applyAclToTiles, getAcl, newAclFor,
} from '../../items/behaviors/house-acl.js';
import {
  foundationForMulti, isCustomHouseMulti, isHouseMulti, nameForMulti,
} from './multi-catalog.js';

function instanceOf(item) {
  return item?._multiInstance == null ? null : (item._multiInstance >>> 0);
}

function sameInstance(item, instanceId, multiId, map) {
  if (!item || (item.map ?? 1) !== (map ?? 1)) return false;
  if (instanceId != null) return instanceOf(item) === (instanceId >>> 0);
  return (item._multi | 0) === (multiId | 0);
}

function accessRank(level) {
  return ({ Player: 0, Counselor: 1, Seer: 2, GM: 3, Admin: 4 })[level] ?? 0;
}

export function isHousingStaff(user) {
  return accessRank(user?.client?.account?.accessLevel) >= accessRank('GM');
}

function multiParts(api, reference) {
  const instanceId = instanceOf(reference);
  const multiId = reference?._multi | 0;
  const map = reference?.map ?? 1;
  return [...allItems(api)].filter((item) => sameInstance(item, instanceId, multiId, map));
}

function boundsOf(parts, fallback) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const item of parts) {
    if (item._multiAnchor) continue;
    x1 = Math.min(x1, item.x | 0); y1 = Math.min(y1, item.y | 0);
    x2 = Math.max(x2, item.x | 0); y2 = Math.max(y2, item.y | 0);
  }
  if (!Number.isFinite(x1)) {
    const x = fallback?.x | 0, y = fallback?.y | 0;
    return { x1: x, y1: y, x2: x, y2: y };
  }
  return { x1, y1, x2, y2 };
}

function signOf(parts) {
  return parts.find((item) => {
    const g = item.itemId | 0;
    return (g >= 0x0B95 && g <= 0x0BAF)
      || (g >= 0x0BC8 && g <= 0x0C26)
      || (g >= 0x0C40 && g <= 0x0C5A);
  }) ?? null;
}

function refFor(api, serial, fallbackName = null) {
  const mob = mobileBySerial(api, serial >>> 0);
  return { serial: serial >>> 0, name: mob?.name ?? fallbackName ?? `0x${(serial >>> 0).toString(16)}` };
}

/** Keep the legacy per-multi ACL synchronized with the HouseRegistry. */
export function syncRegistryHouseToMulti(api, house) {
  if (!api?.houses || !house || house.multiInstance == null) return null;
  const anchor = [...allItems(api)].find((item) =>
    instanceOf(item) === (house.multiInstance >>> 0) && item._multiAnchor === true);
  if (!anchor) return null;
  const prior = getAcl(anchor);
  const acl = prior ?? newAclFor(refFor(api, house.ownerSerial, house.ownerName));
  acl.owner = refFor(api, house.ownerSerial, house.ownerName);
  acl.coOwners = [...(house.coowners ?? [])].map((serial) => refFor(api, serial));
  acl.friends = [...(house.friends ?? [])].map((serial) => refFor(api, serial));
  acl.bans = [...(house.bans ?? [])].map((serial) => refFor(api, serial));
  acl.lockedDown = [...(house.lockdowns ?? [])];
  acl.lockdownCap = house.lockdownCap ?? acl.lockdownCap;
  acl.isPublic = house.isPublic === true;
  applyAclToTiles(api.world, house.multiId, house.map, acl, house.multiInstance);
  for (const item of multiParts(api, anchor)) {
    item._multiHouseId = house.id;
    item._multiOwner = acl.owner;
    item._multiName = house.sign?.title ?? item._multiName;
  }
  return acl;
}

/** Import changes made by the protocol-compatible legacy sign gump. */
export function syncMultiAclToRegistry(api, reference) {
  const house = api.houses?.houseByMultiInstance?.(instanceOf(reference));
  const acl = getAcl(reference);
  if (!house || !acl?.owner) return house ?? null;
  house.ownerSerial = acl.owner.serial >>> 0;
  house.ownerName = acl.owner.name ?? house.ownerName;
  house.coowners = new Set((acl.coOwners ?? []).map((entry) => entry.serial >>> 0));
  house.friends = new Set((acl.friends ?? []).map((entry) => entry.serial >>> 0));
  house.bans = new Set((acl.bans ?? []).map((entry) => entry.serial >>> 0));
  house.lockdowns = new Set((acl.lockedDown ?? []).map((serial) => serial >>> 0));
  house.isPublic = acl.isPublic === true;
  return house;
}

/**
 * Register a freshly stamped house multi (or migrate a legacy unregistered
 * one) and assign an authoritative owner. Boats/unknown multis are ignored.
 */
export function registerMultiHouse(api, reference, owner, options = {}) {
  const multiId = reference?._multi ?? reference?.multiId;
  if (!api?.houses || !reference || !owner || !isHouseMulti(multiId)) return null;
  const instanceId = instanceOf(reference) ?? (reference.serial >>> 0);
  const existing = api.houses.houseByMultiInstance?.(instanceId);
  if (existing) {
    syncRegistryHouseToMulti(api, existing);
    return existing;
  }
  const parts = multiParts(api, reference);
  const bounds = options.bounds ?? boundsOf(parts, reference);
  const signItem = signOf(parts);
  const anchorItem = parts.find((item) => item._multiAnchor) ?? options.anchor ?? reference;
  const title = String(options.title ?? signItem?._multiName ?? nameForMulti(multiId)
    ?? `House 0x${(multiId | 0).toString(16)}`).slice(0, 60);
  const house = api.houses.place(owner, {
    ...bounds,
    map: reference.map ?? 1,
    z: reference.z | 0,
    title,
    sign: signItem ? { x: signItem.x | 0, y: signItem.y | 0, z: signItem.z | 0, title } : undefined,
    foundation: foundationForMulti(multiId),
    multiId: multiId | 0,
    multiSerial: anchorItem.serial,
    multiInstance: instanceId,
    customizable: isCustomHouseMulti(multiId),
    source: options.source ?? 'multi',
  });
  syncRegistryHouseToMulti(api, house);
  return house;
}

/** Resolve or migrate a house when its sign is used. */
export function ensureHouseForMulti(api, signItem, viewer) {
  if (!isHouseMulti(signItem?._multi)) return null;
  const instanceId = instanceOf(signItem);
  let house = api.houses?.houseByMultiInstance?.(instanceId)
    ?? api.houses?.get?.(signItem?._multiHouseId);
  if (house) {
    syncRegistryHouseToMulti(api, house);
    return house;
  }
  const aclOwner = getAcl(signItem)?.owner ?? signItem?._multiOwner ?? null;
  let owner = aclOwner;
  if (!owner && isHousingStaff(viewer)) owner = viewer;
  if (!owner) return null;
  const sameOwner = (owner.serial >>> 0) === (viewer?.serial >>> 0);
  if (!sameOwner && !isHousingStaff(viewer)) return null;
  house = registerMultiHouse(api, signItem, owner, { source: 'legacy-migration' });
  if (house && !aclOwner) {
    viewer?.client?.sendSystemMessage?.('Legacy house adopted. You are now its owner.');
  }
  return house;
}

function safe(value) { return encodeURIComponent(String(value ?? '')); }

export function houseManagementPayload(api, house, viewer) {
  const nameOf = (serial) => refFor(api, serial).name;
  const role = api.houses.roleOf(house, viewer.serial);
  const mayViewAccess = role === 'owner' || role === 'coowner';
  const decay = api.houses.decayOf?.(house) ?? 'Unknown';
  const fields = [
    house.id,
    safe(house.ownerName),
    `${house.lockdowns?.size ?? 0}/${house.lockdownCap ?? 0}`,
    `${house.secures?.size ?? 0}/${house.secureCap ?? 0}`,
    safe(mayViewAccess ? [...(house.friends ?? [])].map(nameOf).join(',') : ''),
    safe(mayViewAccess ? [...(house.coowners ?? [])].map(nameOf).join(',') : ''),
    safe(mayViewAccess ? [...(house.bans ?? [])].map(nameOf).join(',') : ''),
    role,
    safe(house.sign?.title ?? nameForMulti(house.multiId) ?? `House #${house.id}`),
    house.customizable ? '1' : '0',
    house.multiSerial ?? house.id,
    decay,
    `${house.vendors?.size ?? 0}/${api.houses.vendorCapFor?.(house) ?? 0}`,
  ];
  return fields.join('|');
}

/** Open the rich NodeUO house manager; returns false for classic fallback. */
export function openHouseManagement(api, state, viewer, house) {
  if (!state || !viewer || !house) return false;
  state._activeHouseId = house.id;
  const capability = api.protocol?.NodeUOCapability?.RichGumps ?? 1;
  if (!state.supportsNodeUO?.(capability)) return false;
  state.sendSystemMessage?.(`@@OPEN_HOUSE_GUMP@@${houseManagementPayload(api, house, viewer)}`);
  return true;
}
