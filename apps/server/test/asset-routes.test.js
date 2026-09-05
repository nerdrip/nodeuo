import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { registerAssetRoutes } from '../src/admin/asset-routes.js';
import sharp from '../src/admin/safe-sharp.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-assets-'));
  const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  write('tiledata.json', {
    landCount: 2, staticCount: 1,
    land: [{ flags: 0, flagsHi: 0, texId: 0, name: 'grass' }, { flags: 1, flagsHi: 0, texId: 1, name: 'rock' }],
    statics: [{ flags: 0, flagsHi: 0, height: 1, name: 'chair' }],
  });
  write('patches.json', { gumps: {}, statics: {}, hues: {} });
  for (const [name, value] of Object.entries({
    'gump-atlas.json': { tiles: {} }, 'static-atlas.json': { tiles: {} },
    'land-atlas.json': { tiles: {} }, 'texmap-atlas.json': { tiles: {} },
    'mobiles-atlas.json': { bodies: {} }, 'animdata.json': { entries: {} },
    'hues.json': { hues: [] }, 'multi.json': { multis: {} },
    'radarcol.json': { land: [], static: [] }, 'cliloc.json': { entries: {} },
    'sounds.json': { entries: {} }, 'music.json': { entries: {} },
    'lights.json': { entries: {} }, 'fonts.json': { fonts: [] }, 'cursors.json': { cursors: {} },
  })) write(name, value);
  return root;
}

function route(routes, method, routePath) {
  return routes.find((entry) => entry.method === method && entry.path === routePath);
}

describe('admin asset routes', () => {
  it('protects native graphic metadata and stores visual properties in the custom layer', async () => {
    const assetsDir = fixture();
    const routes = [];
    const changes = [];
    registerAssetRoutes(routes, { assetsDir, onChanged: (change) => changes.push(change) });
    const query = new URLSearchParams({ q: 'rock', limit: '20' });
    const list = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({ params: { kind: 'land' }, query });
    expect(list).toMatchObject({ total: 2, filtered: 1, entries: [{ id: '1' }] });
    const blocked = await route(routes, 'PUT', '/api/assets/editor/entry/:kind/:id').run({
      params: { kind: 'land', id: '1' },
      body: { expectedMtime: list.mtime, value: { flags: 7, flagsHi: 0, texId: 4, name: 'new rock' } },
    });
    expect(blocked.error).toMatch(/protected/i);
    const pngBase64 = (await sharp({ create: { width: 4, height: 4, channels: 4,
      background: { r: 80, g: 120, b: 20, alpha: 1 } } }).png().toBuffer()).toString('base64');
    await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'land', id: '1' }, body: { pngBase64, name: 'custom rock', metadata: { flags: 7, texId: 4, name: 'custom rock' } },
    });
    const saved = await route(routes, 'PUT', '/api/assets/editor/entry/:kind/:id').run({
      params: { kind: 'land', id: '1' }, body: { value: { flags: 9, flagsHi: 2, texId: 5, name: 'edited custom rock' } },
    });
    expect(saved).toMatchObject({ ok: true, value: { flags: 9, flagsHi: 2, texId: 5, name: 'edited custom rock' } });
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'tiledata.json'))).land[1]).toMatchObject({ flags: 1, name: 'rock' });
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'asset-overrides.json'))).land[1]).toMatchObject({
      mode: 'override', metadata: { flags: 9, flagsHi: 2, texId: 5, name: 'edited custom rock' },
    });
    expect(changes).toEqual([
      { type: 'override', action: 'upsert', kind: 'land', id: 1 },
      { type: 'override', action: 'metadata', kind: 'land', id: 1 },
    ]);
  });

  it('imports and removes a reversible PNG override', async () => {
    const assetsDir = fixture();
    const routes = [];
    const changes = [];
    registerAssetRoutes(routes, { assetsDir, onChanged: (change) => changes.push(change) });
    const pngBase64 = (await sharp({ create: { width: 1, height: 1, channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()).toString('base64');
    const imported = await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'gump', id: '3000' }, body: { pngBase64 },
    });
    expect(imported).toMatchObject({ ok: true, kind: 'gump', id: 3000, width: 1, height: 1 });
    const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'asset-overrides.json')));
    expect(manifest.gump['3000']).toMatchObject({ width: 1, height: 1 });
    expect(fs.existsSync(path.join(assetsDir, manifest.gump['3000'].file))).toBe(true);

    const removed = route(routes, 'DELETE', '/api/assets/editor/override/:kind/:id').run({ params: { kind: 'gump', id: '3000' } });
    expect(removed).toMatchObject({ ok: true, removed: manifest.gump['3000'] });
    expect(changes).toEqual([
      { type: 'override', action: 'upsert', kind: 'gump', id: 3000 },
      { type: 'override', action: 'remove', kind: 'gump', id: 3000 },
    ]);
  });

  it('keeps new custom IDs separate from native assets and labels native overrides', async () => {
    const assetsDir = fixture();
    fs.writeFileSync(path.join(assetsDir, 'land-atlas.json'), JSON.stringify({
      tiles: { 1: { page: 0, u: 0, v: 0, w: 44, h: 44 } },
    }));
    const routes = [];
    registerAssetRoutes(routes, { assetsDir });
    const pngBase64 = (await sharp({ create: { width: 3, height: 4, channels: 4,
      background: { r: 30, g: 220, b: 90, alpha: 1 } } }).png().toBuffer()).toString('base64');

    const added = await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'static', id: '60000' }, body: { pngBase64, name: 'emerald katana art' },
    });
    expect(added).toMatchObject({ ok: true, kind: 'static', id: 60000, mode: 'add' });
    const custom = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({
      params: { kind: 'static' }, query: new URLSearchParams({ source: 'custom' }),
    });
    expect(custom.entries).toEqual([expect.objectContaining({
      id: '60000', source: 'custom', value: expect.objectContaining({ name: 'emerald katana art' }),
    })]);

    const overridden = await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'land', id: '1' }, body: { pngBase64, name: 'custom rock' },
    });
    expect(overridden).toMatchObject({ ok: true, mode: 'override' });
    const nativeList = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({
      params: { kind: 'land' }, query: new URLSearchParams({ q: 'rock' }),
    });
    expect(nativeList.entries[0]).toMatchObject({ id: '1', source: 'custom-override' });
    const ultimaView = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({
      params: { kind: 'land' }, query: new URLSearchParams({ source: 'ultima', q: 'rock' }),
    });
    expect(ultimaView.entries[0]).toMatchObject({ id: '1', source: 'custom-override' });
    const customView = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({
      params: { kind: 'land' }, query: new URLSearchParams({ source: 'custom' }),
    });
    expect(customView.entries[0]).toMatchObject({ id: '1', source: 'custom-override' });
  });

  it('stores multi blueprints as reversible custom overlays without rewriting Ultima multi.json', async () => {
    const assetsDir = fixture();
    const native = { multis: { 7: [{ id: 0x4000, x: 0, y: 0, z: 0, visible: true }] } };
    fs.writeFileSync(path.join(assetsDir, 'multi.json'), JSON.stringify(native));
    const routes = [];
    const changes = [];
    registerAssetRoutes(routes, { assetsDir, onChanged: (change) => changes.push(change) });

    const saved = await route(routes, 'PUT', '/api/assets/editor/entry/:kind/:id').run({
      params: { kind: 'multi', id: '7' },
      body: { value: { name: 'custom keep', components: [{ id: 0x4001, x: 1, y: -2, z: 3, visible: true }] } },
    });
    expect(saved).toMatchObject({ ok: true, nativeAvailable: true,
      value: { name: 'custom keep', mode: 'override', components: [{ id: 0x4001, x: 1, y: -2, z: 3, visible: true }] } });
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'multi.json')))).toEqual(native);
    expect(JSON.parse(fs.readFileSync(path.join(assetsDir, 'asset-overrides.json'))).multi['7']).toMatchObject({
      source: 'custom', mode: 'override', name: 'custom keep',
    });

    const effective = await route(routes, 'GET', '/api/assets/editor/entry/:kind/:id').run({
      params: { kind: 'multi', id: '7' },
    });
    expect(effective).toMatchObject({ source: 'custom-override', nativeAvailable: true,
      nativeValue: native.multis[7], value: saved.value });
    const removed = route(routes, 'DELETE', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'multi', id: '7' },
    });
    expect(removed).toMatchObject({ ok: true, kind: 'multi', id: 7 });
    const restored = await route(routes, 'GET', '/api/assets/editor/entry/:kind/:id').run({
      params: { kind: 'multi', id: '7' },
    });
    expect(restored).toMatchObject({ source: 'ultima', value: {
      name: 'Multi 0x7', kind: 'other', components: native.multis[7],
    } });
    expect(changes).toEqual([
      { type: 'override', action: 'metadata', kind: 'multi', id: 7 },
      { type: 'override', action: 'remove', kind: 'multi', id: 7 },
    ]);
  });

  it('authors persistent custom mobile animation frames outside the native atlas', async () => {
    const assetsDir = fixture();
    const routes = [];
    registerAssetRoutes(routes, { assetsDir });
    const pngBase64 = (await sharp({ create: { width: 7, height: 9, channels: 4,
      background: { r: 100, g: 60, b: 210, alpha: 1 } } }).png().toBuffer()).toString('base64');
    const saved = await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'animation', id: '50000' },
      body: { pngBase64, name: 'voidling', type: 'MONSTER', action: 0, direction: 0, frameIndex: 0, cx: 3, cy: 8 },
    });
    expect(saved).toMatchObject({ ok: true, kind: 'animation', id: 50000, mode: 'add', width: 7, height: 9 });
    const manifest = JSON.parse(fs.readFileSync(path.join(assetsDir, 'asset-overrides.json')));
    expect(manifest).toMatchObject({ schemaVersion: 2, animation: { 50000: {
      name: 'voidling', source: 'custom', mode: 'add',
      actions: { 0: { dirs: { 0: [{ w: 7, h: 9, cx: 3, cy: 8 }] } } },
    } } });
    const list = await route(routes, 'GET', '/api/assets/editor/entries/:kind').run({
      params: { kind: 'animation' }, query: new URLSearchParams({ source: 'custom' }),
    });
    expect(list.entries).toEqual([expect.objectContaining({ id: '50000', source: 'custom' })]);

    const response = new PassThrough();
    const chunks = [];
    response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
    response.on('data', (chunk) => chunks.push(chunk));
    await route(routes, 'GET', '/api/assets/editor/preview/:kind/:id').run({
      params: { kind: 'animation', id: '50000' }, res: response,
    });
    await new Promise((resolve) => response.once('finish', resolve));
    expect(response.status).toBe(200);
    expect(Buffer.concat(chunks).length).toBeGreaterThan(8);
  });

  it('extracts an atlas preview while parsing its manifest in a worker', async () => {
    const assetsDir = fixture();
    fs.writeFileSync(path.join(assetsDir, 'gump-atlas.json'), JSON.stringify({
      tiles: { 5: { page: 0, u: 0, v: 0, w: 2, h: 2 } },
    }));
    await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 0, g: 160, b: 255, alpha: 1 } } }).png()
      .toFile(path.join(assetsDir, 'gump-atlas-000.png'));
    const routes = [];
    registerAssetRoutes(routes, { assetsDir });
    const preview = async (query = new URLSearchParams()) => {
      const response = new PassThrough();
      const chunks = [];
      response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
      response.on('data', (chunk) => chunks.push(chunk));
      await route(routes, 'GET', '/api/assets/editor/preview/:kind/:id').run({
        params: { kind: 'gump', id: '5' }, query, res: response,
      });
      await new Promise((resolve) => response.once('finish', resolve));
      return { response, png: Buffer.concat(chunks) };
    };
    const native = await preview();
    expect(native.response.status).toBe(200);
    expect(native.response.headers['content-type']).toBe('image/png');
    const png = native.png;
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const customPng = await sharp({ create: { width: 2, height: 2, channels: 4,
      background: { r: 240, g: 20, b: 30, alpha: 1 } } }).png().toBuffer();
    const imported = await route(routes, 'PUT', '/api/assets/editor/override/:kind/:id').run({
      params: { kind: 'gump', id: '5' }, body: { pngBase64: customPng.toString('base64') },
    });
    expect(imported.mode).toBe('override');
    const active = await preview();
    const untouchedNative = await preview(new URLSearchParams({ layer: 'ultima' }));
    const activePixels = await sharp(active.png).removeAlpha().raw().toBuffer();
    expect([...activePixels.subarray(0, 3)]).toEqual([240, 20, 30]);
    expect(untouchedNative.png.equals(png)).toBe(true);
  });

  it('runs complete manifest validation as a pollable background job', async () => {
    const assetsDir = fixture();
    const routes = [];
    registerAssetRoutes(routes, { assetsDir });
    const started = route(routes, 'POST', '/api/assets/editor/validation-jobs').run({});
    expect(started).toMatchObject({ ok: true, job: { status: 'running' } });
    const statusRoute = route(routes, 'GET', '/api/assets/editor/validation-jobs/:id');
    let status;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = statusRoute.run({ params: { id: started.job.id } });
      if (status.job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status).toMatchObject({ ok: true, job: { status: 'completed', result: { ok: true } } });
    expect(status.job.result.checks.length).toBeGreaterThan(10);
  });
});
