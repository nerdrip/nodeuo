// Runtime application and loading of shard-authored visual overrides.

import { Assets } from 'pixi.js';

const BASE = '/assets';

/** Install same-id PNG replacements, multi definitions and custom animations. */
export function applyAssetOverrideManifest(manager, manifest) {
  if (!manifest || typeof manifest !== 'object') return;
  // Restore extracted TileData before replacing the custom layer. Baselines
  // belong to a specific loaded collection and must never leak across reloads.
  for (const kind of ['land', 'static']) {
    const collection = manager.tiledata?.[kind === 'land' ? 'land' : 'statics'];
    if (collection && manager._assetOverrideTiledataOwner[kind] === collection) {
      for (const [id, base] of manager._assetOverrideTiledataBase[kind]) {
        if (base.exists) collection[id] = base.value;
        else delete collection[id];
      }
    }
    manager._assetOverrideTiledataBase[kind].clear();
    manager._assetOverrideTiledataOwner[kind] = null;
  }

  const multis = manager.multis?.multis;
  if (multis && manager._assetOverrideMultiOwner === multis) {
    for (const [id, base] of manager._assetOverrideMultiBase) {
      if (base.exists) multis[id] = base.value;
      else delete multis[id];
    }
  }
  manager._assetOverrideMultiBase.clear();
  manager._assetOverrideMultiOwner = null;

  const cacheByKind = {
    land: manager._landTextures,
    static: manager._staticTextures,
    gump: manager._gumpTextures,
    texmap: manager._texmapTextures,
  };
  for (const kind of ['land', 'static', 'gump', 'texmap']) {
    const target = manager._assetOverrides[kind];
    const changedIds = new Set(target.keys());
    target.clear();
    const source = manifest[kind];
    for (const [rawId, rawValue] of Object.entries(source && typeof source === 'object' ? source : {})) {
      const id = Number(rawId);
      const file = typeof rawValue === 'string' ? rawValue : rawValue?.file;
      if (!Number.isInteger(id) || id < 0 || typeof file !== 'string' || !file || file.includes('..')) continue;
      changedIds.add(id);
      target.set(id, {
        file: file.replace(/^\/+/, ''),
        width: Number(rawValue?.width) || 0,
        height: Number(rawValue?.height) || 0,
        revision: Number(rawValue?.updatedAt) || 0,
        metadata: rawValue?.metadata && typeof rawValue.metadata === 'object'
          ? { ...rawValue.metadata } : {},
      });
      if ((kind === 'land' || kind === 'static') && rawValue?.metadata && typeof rawValue.metadata === 'object') {
        const collection = manager.tiledata?.[kind === 'land' ? 'land' : 'statics'];
        if (collection) {
          manager._assetOverrideTiledataOwner[kind] = collection;
          manager._assetOverrideTiledataBase[kind].set(id, {
            exists: Object.prototype.hasOwnProperty.call(collection, id),
            value: collection[id],
          });
          collection[id] = { ...(collection[id] ?? {}), ...rawValue.metadata };
        }
      }
    }
    for (const id of changedIds) {
      manager._releaseCachedTexture(cacheByKind[kind].get(id));
      cacheByKind[kind].delete(id);
      manager._overrideTextureLoads.delete(`${kind}:${id}`);
    }
  }

  if (multis) {
    for (const [rawId, rawValue] of Object.entries(manifest.multi && typeof manifest.multi === 'object'
      ? manifest.multi : {})) {
      const id = Number(rawId);
      if (!Number.isInteger(id) || id < 0 || id > 0xffff || !Array.isArray(rawValue?.components)) continue;
      manager._assetOverrideMultiOwner = multis;
      manager._assetOverrideMultiBase.set(id, {
        exists: Object.prototype.hasOwnProperty.call(multis, id),
        value: multis[id],
      });
      multis[id] = rawValue.components.map((part) => ({
        id: Number(part?.id) || 0,
        x: Number(part?.x) || 0,
        y: Number(part?.y) || 0,
        z: Number(part?.z) || 0,
        visible: part?.visible !== false,
      }));
    }
    manager.multis.count = Object.keys(multis).length;
  }

  manager._customMobileBodies.clear();
  for (const [rawBody, rawValue] of Object.entries(manifest.animation && typeof manifest.animation === 'object'
    ? manifest.animation : {})) {
    const body = Number(rawBody);
    if (!Number.isInteger(body) || body < 0 || body > 0xffff || !rawValue || typeof rawValue !== 'object') continue;
    const actions = {};
    for (const [rawAction, rawActionValue] of Object.entries(rawValue.actions ?? {})) {
      const action = Number(rawAction);
      if (!Number.isInteger(action) || action < 0 || action > 255) continue;
      const dirs = {};
      for (const [rawDirection, rawFrames] of Object.entries(rawActionValue?.dirs ?? {})) {
        const direction = Number(rawDirection);
        if (!Number.isInteger(direction) || direction < 0 || direction > 7 || !Array.isArray(rawFrames)) continue;
        const frames = rawFrames
          .filter((frame) => frame?.file && !String(frame.file).includes('..'))
          .map((frame) => ({
            customFile: String(frame.file).replace(/^\/+/, ''),
            customRevision: Number(rawValue.updatedAt) || 0,
            w: Number(frame.w ?? frame.width) || 0,
            h: Number(frame.h ?? frame.height) || 0,
            cx: Number(frame.cx) || 0,
            cy: Number(frame.cy) || 0,
          }))
          .filter((frame) => frame.w > 0 && frame.h > 0);
        if (frames.length) dirs[direction] = frames;
      }
      if (Object.keys(dirs).length) actions[action] = { dirs };
    }
    if (Object.keys(actions).length) manager._customMobileBodies.set(body, {
      name: String(rawValue.name ?? `Custom mobile ${body}`),
      type: String(rawValue.type ?? 'MONSTER').toUpperCase(),
      actions,
    });
  }
  for (const wrapped of manager._mobileTextures.values()) manager._releaseCachedTexture(wrapped);
  manager._mobileTextures.clear();
  manager._customMobileTextureLoads.clear();
}

export async function loadGraphicOverride(manager, kind, id, cache, limit) {
  const record = manager._assetOverrides?.[kind]?.get(id | 0);
  if (!record) return null;
  const cached = cache.get(id | 0);
  if (cached) return manager._touchCache(cache, id | 0, cached);
  const key = `${kind}:${id | 0}`;
  const pending = manager._overrideTextureLoads.get(key);
  if (pending) return pending;
  const load = manager._decodePool.run(`override:${key}`, async () => {
    try {
      const url = `${BASE}/${record.file}${record.revision ? `?v=${record.revision}` : ''}`;
      const texture = await Assets.load(url);
      if (!texture?.source) return null;
      texture.source.scaleMode = 'nearest';
      texture._uoAssetOverride = true;
      texture._uoAssetOverrideUrl = url;
      cache.set(id | 0, texture);
      manager._capCache(cache, limit);
      return texture;
    } catch (error) {
      console.warn(`[assets] override load failed ${key}:`, error?.message ?? error);
      return null;
    }
  }, { priority: 0 });
  manager._overrideTextureLoads.set(key, load);
  try {
    return await load;
  } finally {
    if (manager._overrideTextureLoads.get(key) === load) manager._overrideTextureLoads.delete(key);
  }
}

export async function loadCustomMobileFrame(manager, info, key, mobileFrameCacheMax) {
  const existing = manager._mobileTextures.get(key);
  if (existing) return existing;
  let pending = manager._customMobileTextureLoads.get(key);
  if (!pending) {
    pending = manager._decodePool.run(`custom-animation:${key}`, async () => {
      const url = `${BASE}/${info.meta.customFile}${info.meta.customRevision ? `?v=${info.meta.customRevision}` : ''}`;
      const texture = await Assets.load(url);
      if (!texture?.source) return null;
      texture.source.scaleMode = 'nearest';
      texture._uoCustomAnimation = true;
      texture._uoAssetOverrideUrl = url;
      const wrapped = {
        texture,
        cx: info.meta.cx,
        cy: info.meta.cy,
        w: info.meta.w,
        h: info.meta.h,
        frameCount: info.frameCount,
      };
      manager._mobileTextures.set(key, wrapped);
      manager._capCache(manager._mobileTextures, manager._cacheLimit('mobile', mobileFrameCacheMax));
      return wrapped;
    }, { priority: 0 }).catch((error) => {
      console.warn(`[assets] custom animation frame failed ${key}:`, error?.message ?? error);
      return null;
    }).finally(() => manager._customMobileTextureLoads.delete(key));
    manager._customMobileTextureLoads.set(key, pending);
  }
  return pending;
}
