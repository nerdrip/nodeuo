// Lazy, bounded visual catalogues shared by Content Studio pickers.

import fs from 'node:fs';
import path from 'node:path';

export function createStudioAssetCatalog({ clientAssetsDir, scriptsDir }) {
  const cache = new Map();
  let appearanceAssets = null;

  const readClientAssetJson = (name) => JSON.parse(
    fs.readFileSync(path.join(clientAssetsDir, name), 'utf8'),
  );

  function uoColorCss(value) {
    const color = Number(value) & 0x7fff;
    const channel = (bits) => Math.round(((color >>> bits) & 31) * 255 / 31)
      .toString(16).padStart(2, '0');
    return `#${channel(10)}${channel(5)}${channel(0)}`;
  }

  function resolveItemAppearance(artId) {
    const id = Number(artId);
    if (!Number.isInteger(id) || id < 0 || id > 0xFFFF) {
      return { error: 'artId must be in range 0..65535' };
    }
    try {
      appearanceAssets ||= {
        tiledata: readClientAssetJson('tiledata.json'),
        gumps: readClientAssetJson('gump-atlas.json'),
        mobiles: (() => {
          try { return readClientAssetJson('mobiles-atlas-index.json'); }
          catch { return readClientAssetJson('mobiles-atlas.json'); }
        })(),
      };
      const tile = appearanceAssets.tiledata?.statics?.[id] ?? null;
      const tiles = appearanceAssets.gumps?.tiles ?? {};
      const equipConv = appearanceAssets.mobiles?.equipConv ?? {};
      const convertedBase = (body) => {
        let gump = Number(equipConv?.[body]?.[id]?.gump ?? 0) | 0;
        if (gump >= 60000) gump -= 60000;
        else if (gump >= 50000) gump -= 50000;
        return gump > 0 ? gump : 0;
      };
      const base = convertedBase(400) || convertedBase(401) || (Number(tile?.animId) | 0);
      const maleCandidate = base > 0 ? base + 50000 : id + 50000;
      const femaleCandidate = base > 0 ? base + 60000 : id + 60000;
      const male = tiles[maleCandidate] ? maleCandidate : 0;
      const femaleSpecific = tiles[femaleCandidate] ? femaleCandidate : 0;
      const female = femaleSpecific || male;
      return {
        artId: id,
        tileName: String(tile?.name ?? '').trim(),
        tileLayer: Number(tile?.layer ?? 0) | 0,
        animationId: Number(tile?.animId ?? 0) | 0,
        maleGumpId: male,
        femaleGumpId: female,
        femaleSpecificGumpId: femaleSpecific,
        source: convertedBase(400) || convertedBase(401) ? 'equipconv'
          : Number(tile?.animId) > 0 ? 'tiledata' : male ? 'legacy-art-offset' : 'missing',
        renderable: !!male,
      };
    } catch (error) {
      return { artId: id, error: `appearance assets unavailable: ${error.message}`, renderable: false };
    }
  }

  // Atlas manifests are large, so materialize each picker catalogue once and
  // invalidate it only when the editable asset/profile layer changes.
  function entriesFor(kind) {
    if (cache.has(kind)) return cache.get(kind);
    let entries = [];
    let customAssets = {};
    try {
      customAssets = JSON.parse(fs.readFileSync(path.join(clientAssetsDir, 'asset-overrides.json'), 'utf8'));
    } catch { /* optional custom asset layer */ }
    if (kind === 'item') {
      const atlas = readClientAssetJson('static-atlas.json');
      let tiledata = {};
      try { tiledata = readClientAssetJson('tiledata.json'); } catch { /* optional */ }
      const seen = new Set();
      entries = Object.entries(atlas.tiles ?? {}).map(([globalId, tile]) => {
        const numeric = Number(globalId);
        const id = numeric >= 0x4000 ? numeric - 0x4000 : numeric;
        if (id < 0 || id > 0xffff || seen.has(id)) return null;
        seen.add(id);
        const name = String(tiledata.statics?.[id]?.name ?? '').trim();
        const custom = customAssets.static?.[id];
        return {
          id,
          name: custom?.name || name || `Item 0x${id.toString(16).padStart(4, '0')}`,
          width: custom?.width ?? tile.w,
          height: custom?.height ?? tile.h,
          source: custom ? 'custom-override' : 'ultima',
          preview: `/api/assets/editor/preview/static/${id}`,
        };
      }).filter(Boolean);
      for (const [rawId, custom] of Object.entries(customAssets.static ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom item ${id}`, width: custom.width,
          height: custom.height, source: 'custom', preview: `/api/assets/editor/preview/static/${id}` });
      }
    } else if (kind === 'gump') {
      const atlas = readClientAssetJson('gump-atlas.json');
      entries = Object.entries(atlas.tiles ?? {}).map(([id, tile]) => ({
        id: Number(id),
        name: `Gump 0x${Number(id).toString(16).padStart(4, '0')}`,
        width: customAssets.gump?.[id]?.width ?? tile.w,
        height: customAssets.gump?.[id]?.height ?? tile.h,
        source: customAssets.gump?.[id] ? 'custom-override' : 'ultima',
        preview: `/api/assets/editor/preview/gump/${Number(id)}`,
      }));
      const seen = new Set(entries.map((entry) => entry.id));
      for (const [rawId, custom] of Object.entries(customAssets.gump ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom gump ${id}`, width: custom.width,
          height: custom.height, source: 'custom', preview: `/api/assets/editor/preview/gump/${id}` });
      }
    } else if (kind === 'body') {
      let atlas;
      try { atlas = readClientAssetJson('mobiles-atlas-index.json'); }
      catch { atlas = readClientAssetJson('mobiles-atlas.json'); }
      const names = new Map();
      for (const relative of ['config/monsters.json', 'config/npcs.json']) {
        try {
          const rows = JSON.parse(fs.readFileSync(path.join(scriptsDir, 'data', relative), 'utf8'));
          for (const row of (Array.isArray(rows) ? rows : [])) {
            const body = Number(row?.bodyId ?? row?.body);
            if (!Number.isFinite(body)) continue;
            const label = String(row.name ?? row.definitionId ?? row.kind ?? '').trim();
            if (!label) continue;
            if (!names.has(body)) names.set(body, new Set());
            names.get(body).add(label);
          }
        } catch { /* optional authoring data */ }
      }
      const bodyIds = atlas.shards
        ? Object.values(atlas.shards).flatMap((row) => row.bodyIds ?? [])
        : Object.keys(atlas.bodies ?? {}).map(Number);
      entries = bodyIds.map((id) => {
        const body = Number(id);
        const type = atlas.mobTypes?.[id]?.type;
        const variants = [...(names.get(body) ?? [])];
        const variantLabel = variants.length
          ? `${variants.slice(0, 3).join(' / ')}${variants.length > 3 ? ` (+${variants.length - 3})` : ''}`
          : null;
        const custom = customAssets.animation?.[body];
        return {
          id: body,
          name: custom?.name ?? variantLabel ?? `${type ? `${type.toLowerCase()} ` : ''}body 0x${body.toString(16)}`,
          definitions: variants.length,
          source: custom ? 'custom-override' : 'ultima',
          preview: custom ? `/api/assets/editor/preview/animation/${body}` : `/api/studio/body-art/${body}`,
        };
      });
      const seen = new Set(entries.map((entry) => entry.id));
      for (const [rawId, custom] of Object.entries(customAssets.animation ?? {})) {
        const id = Number(rawId);
        if (!Number.isInteger(id) || seen.has(id) || custom?.mode !== 'add') continue;
        entries.push({ id, name: custom.name || `Custom mobile ${id}`, definitions: 0,
          source: 'custom', preview: `/api/assets/editor/preview/animation/${id}` });
      }
    } else if (kind === 'hue') {
      const source = readClientAssetJson('hues.json');
      entries = [{ id: 0, name: 'No hue / natural color', color: '#ffffff' },
        ...(source.hues ?? []).map((hue, index) => ({
          id: index + 1,
          name: String(hue.name ?? '').trim() || `Hue ${index + 1}`,
          color: uoColorCss(hue.tableEnd ?? hue.tableStart ?? 0),
        }))];
    }
    entries.sort((a, b) => a.id - b.id);
    cache.set(kind, entries);
    return entries;
  }

  function registerRoutes(routes, queryInt) {
    routes.push({
      method: 'GET', path: '/api/studio/asset-catalog',
      run: ({ query }) => {
        const kind = String(query?.get?.('kind') ?? '').toLowerCase();
        if (!['item', 'gump', 'body', 'hue'].includes(kind)) {
          return { error: 'kind must be item, gump, body, or hue' };
        }
        const offset = queryInt(query, 'offset', 0, 0, 1_000_000);
        const limit = queryInt(query, 'limit', 96, 1, 200);
        const q = String(query?.get?.('q') ?? '').trim().toLowerCase();
        const numeric = q ? Number.parseInt(q.replace(/^0x/, ''), /^0x/.test(q) ? 16 : 10) : Number.NaN;
        const all = entriesFor(kind);
        const filtered = q ? all.filter((entry) => entry.id === numeric
          || String(entry.name ?? '').toLowerCase().includes(q)
          || `0x${entry.id.toString(16)}`.includes(q)) : all;
        return { kind, offset, limit, total: filtered.length, entries: filtered.slice(offset, offset + limit) };
      },
    });
    routes.push({
      method: 'GET', path: '/api/studio/item-appearance',
      run: ({ query }) => resolveItemAppearance(query?.get?.('artId')),
    });
  }

  return {
    invalidate() { cache.clear(); appearanceAssets = null; },
    registerRoutes,
  };
}
