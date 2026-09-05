import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateScript,
  registerScriptStudioRoutes,
  SCRIPT_STUDIO_TYPES,
} from '../src/admin/script-studio-routes.js';

const created = [];
afterEach(() => { for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function generatedModule(spec) {
  const generated = generateScript(spec);
  expect(generated.ok, generated.errors?.join('; ')).toBe(true);
  const encoded = Buffer.from(generated.source).toString('base64');
  return { generated, mod: await import(`data:text/javascript;base64,${encoded}`) };
}

describe('Script Studio executable templates', () => {
  it('generates every advertised type as an executable lifecycle registration', async () => {
    const calls = [];
    const api = {
      lifecycle: {
        guard: (name, fn) => { calls.push(['guard', name]); return fn; },
        command: (spec) => calls.push(['command', spec.name]),
        event: (name) => calls.push(['event', name]),
        setInterval: (_fn, ms) => calls.push(['interval', ms]),
        onDispose: (_off, kind) => calls.push(['dispose', kind]),
      },
      itemScripts: { register: (behavior) => calls.push(['item', behavior.name]), unregister: vi.fn() },
      ai: { registerBehavior: (behavior) => calls.push(['ai', behavior.name]), unregisterBehavior: vi.fn() },
      systems: { regionOnEnter: {
        onEnterRegion: (name) => { calls.push(['region-enter', name]); return vi.fn(); },
        onLeaveRegion: (name) => { calls.push(['region-leave', name]); return vi.fn(); },
      } },
      log: vi.fn(),
    };
    const specs = [
      { type: 'item', id: 'test-item', hooks: ['onUse'] },
      { type: 'mobile', id: 'test-mobile', mobileKind: 'orc', hooks: ['mobile:created'] },
      { type: 'ai', id: 'test-ai' },
      { type: 'command', id: 'test-command', access: 'GM' },
      { type: 'region', id: 'test-region', region: 'Britain', hooks: ['onEnter', 'onLeave'] },
      { type: 'event', id: 'test-event', eventNames: ['world:saved'] },
      { type: 'service', id: 'test-service', intervalMs: 1000 },
    ];
    for (const spec of specs) {
      const { generated, mod } = await generatedModule(spec);
      expect(generated.path).toContain(`/test-${spec.type}.js`);
      expect(typeof mod.default).toBe('function');
      mod.default(api);
    }
    expect(calls).toEqual(expect.arrayContaining([
      ['item', 'test-item'], ['event', 'mobile:created'], ['ai', 'test-ai'],
      ['command', 'test-command'], ['region-enter', 'Britain'], ['region-leave', 'Britain'],
      ['event', 'world:saved'], ['interval', 1000],
    ]));
    expect(SCRIPT_STUDIO_TYPES.map((row) => row.id)).toEqual(specs.map((row) => row.type));
  });

  it('rejects unsafe paths and unsupported hooks before source generation', () => {
    expect(generateScript({ type: 'item', id: '../escape', hooks: ['onUse'] })).toMatchObject({ ok: false, source: '' });
    expect(generateScript({ type: 'item', id: 'valid', hooks: ['runShell'] })).toMatchObject({ ok: false, source: '' });
  });

  it('validates, publishes, archives and restores executable modules', async () => {
    const scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-script-studio-'));
    created.push(scriptsDir);
    const routes = []; const reloadOne = vi.fn(async () => ({ ok: true, initMs: 1 }));
    registerScriptStudioRoutes(routes, {
      scriptsDir, scriptRuntime: { loaded: [], reloadOne, invalidateManifest: vi.fn() },
      sharedCtx: { contentDependencies: { impact: () => ({ ok: false, error: 'new module' }) } },
    });
    const route = (method, routePath) => routes.find((entry) => entry.method === method && entry.path === routePath).run;
    const generated = generateScript({ type: 'command', id: 'recoverable', access: 'Admin' });
    const validated = await route('POST', '/api/script-studio/validate')({
      body: { path: generated.path, source: generated.source },
    });
    expect(validated).toMatchObject({ ok: true, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });

    const published = await route('PUT', '/api/script-studio/file')({
      body: { path: generated.path, source: generated.source, activate: true },
    });
    expect(published).toMatchObject({ ok: true, hash: validated.hash });
    expect(fs.existsSync(path.join(scriptsDir, generated.path))).toBe(true);

    const archived = await route('DELETE', '/api/script-studio/file')({
      query: new URLSearchParams({ path: generated.path }),
    });
    expect(archived).toMatchObject({ ok: true, recoverable: true });
    const archives = route('GET', '/api/script-studio/archives')({});
    expect(archives.archives[0]).toMatchObject({ originalPath: generated.path });

    const restored = await route('POST', '/api/script-studio/restore')({
      body: { archive: archives.archives[0].name, path: generated.path },
    });
    expect(restored).toMatchObject({ ok: true, archiveRetained: true });
    expect(reloadOne).toHaveBeenCalledWith(generated.path);
  });
});
