// Script runtime hot-reload behaviour.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptRuntime } from '../src/scripts.js';
import { defineScript } from '../../scripts/src/_script.js';
import { nearbyClients, nearbyItems, nearbyMobiles, sendToOnline } from '../../scripts/src/_spatial.js';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'uo-scripts-'));
}

/** Tiny API stub capturing log lines and counting calls. */
function stubApi() {
  const logs = [];
  return {
    world: {},
    commands: {},
    items: {},
    log: (m) => logs.push(m),
    _logs: logs,
  };
}

describe('ScriptRuntime', () => {
  it('runs disposers on reload and re-runs init', async () => {
    const dir = mkTempDir();
    const file = path.join(dir, 'a.js');
    fs.writeFileSync(file, `
      export default (api) => {
        api._initCount = (api._initCount ?? 0) + 1;
        return () => { api._disposeCount = (api._disposeCount ?? 0) + 1; };
      };
    `);
    const api = stubApi();
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect(api._initCount).toBe(1);
    expect(api._disposeCount ?? 0).toBe(0);

    await rt.load();
    expect(api._disposeCount).toBe(1);
    expect(api._initCount).toBe(2);
  });

  it('serializes overlapping full reload requests into one queued reload', async () => {
    const dir = mkTempDir();
    const file = path.join(dir, 'slow.js');
    fs.writeFileSync(file, `
      await new Promise((resolve) => setTimeout(resolve, 30));
      export default (api) => {
        api._initCount = (api._initCount ?? 0) + 1;
        return () => { api._disposeCount = (api._disposeCount ?? 0) + 1; };
      };
    `);
    const emitted = [];
    const api = {
      ...stubApi(),
      world: { events: { emit(name) { emitted.push(name); } } },
    };
    const rt = new ScriptRuntime(dir, api);

    const first = rt.load({ reason: 'first' });
    const second = rt.load({ reason: 'second', emitEvent: true });
    const third = rt.load({ reason: 'third' });
    await Promise.all([first, second, third]);

    expect(api._initCount).toBe(2);
    expect(api._disposeCount).toBe(1);
    expect(emitted).toEqual(['scripts:reloaded']);
  });

  it('debounces watch reloads and ignores watcher noise during the quiet window', async () => {
    vi.useFakeTimers();
    let watchCallback;
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation((_dir, _opts, cb) => {
      watchCallback = cb;
      return { close() {} };
    });
    try {
      const dir = mkTempDir();
      fs.writeFileSync(path.join(dir, 'watch-me.js'), `
        export default (api) => { api._initCount = (api._initCount ?? 0) + 1; };
      `);
      const emitted = [];
      const api = {
        ...stubApi(),
        world: { events: { emit(name) { emitted.push(name); } } },
      };
      const rt = new ScriptRuntime(dir, api);
      await rt.load();
      expect(api._initCount).toBe(1);

      rt._watchQuietUntil = 0;
      rt.watch();
      watchCallback('change', 'watch-me.js');
      watchCallback('change', 'ignored.tmp');
      await vi.advanceTimersByTimeAsync(rt._watchDebounceMs - 1);
      expect(api._initCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await rt._loadChain;
      expect(api._initCount).toBe(2);
      expect(emitted).toEqual(['scripts:reloaded']);

      watchCallback('change', 'watch-me.js');
      await vi.advanceTimersByTimeAsync(rt._watchDebounceMs + rt._watchQuietMs + 10);
      expect(api._initCount).toBe(2);
    } finally {
      watchSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('isolates errors in a single script', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'bad.js'), 'export default () => { throw new Error("boom"); };');
    fs.writeFileSync(path.join(dir, 'good.js'), `
      export default (api) => { api._goodRan = true; };
    `);
    const api = stubApi();
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect(api._goodRan).toBe(true);
    expect(api._logs.some((l) => /bad\.js.*boom/.test(l))).toBe(true);
  });

  it('skips modules without a default export', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'nodefault.js'), 'export const x = 1;');
    const api = stubApi();
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect(api._logs.some((l) => /no default export/.test(l))).toBe(true);
  });

  it('provides per-script lifecycle cleanup on reload', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'life.js'), `
      export default (api) => {
        api._hasLifecycle = !!api.lifecycle;
        api.lifecycle.onDispose(() => { api._lifeDisposed = (api._lifeDisposed ?? 0) + 1; });
        api.lifecycle.setInterval(() => { api._ticks = (api._ticks ?? 0) + 1; }, 1000);
      };
    `);
    const api = stubApi();
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect(api._hasLifecycle).toBe(true);
    expect(api._lifeDisposed ?? 0).toBe(0);

    await rt.load();
    expect(api._lifeDisposed).toBe(1);
  });

  it('auto-unregisters lifecycle commands on reload', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'cmd.js'), `
      export default (api) => {
        api.lifecycle.command({ name: 'hello', help: 'test', run() {} });
      };
    `);
    const registered = new Set();
    const api = {
      ...stubApi(),
      commands: {
        register(spec) { registered.add(spec.name); },
        unregister(name) { registered.delete(name); },
      },
    };
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect([...registered]).toEqual(['hello']);

    await rt.load();
    expect([...registered]).toEqual(['hello']);
  });

  it('auto-unregisters direct command registrations on reload', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'legacy-command.js'), `
      export default (api) => {
        api.commands.register({ name: 'legacy', help: 'test', run() {} });
      };
    `);
    const registered = new Set();
    const calls = [];
    const api = {
      ...stubApi(),
      commands: {
        register(spec) {
          if (registered.has(spec.name)) throw new Error(`duplicate ${spec.name}`);
          calls.push(`register:${spec.name}`);
          registered.add(spec.name);
        },
        unregister(name) {
          calls.push(`unregister:${name}`);
          registered.delete(name);
        },
      },
    };
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    expect([...registered]).toEqual(['legacy']);

    await rt.load();
    expect([...registered]).toEqual(['legacy']);
    expect(calls).toEqual(['register:legacy', 'unregister:legacy', 'register:legacy']);
  });

  it('scopes destructured command registries', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'destructured-command.js'), `
      export default (api) => {
        const { commands } = api;
        commands.register({ name: 'destructured', help: 'test', run() {} });
      };
    `);
    const registered = new Set();
    const api = {
      ...stubApi(),
      commands: {
        register(spec) {
          if (registered.has(spec.name)) throw new Error(`duplicate ${spec.name}`);
          registered.add(spec.name);
        },
        unregister(name) { registered.delete(name); },
      },
    };
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    await rt.load();
    expect([...registered]).toEqual(['destructured']);
  });

  it('does not double-unregister direct command registrations with manual disposers', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'manual-command.js'), `
      export default (api) => {
        api.commands.register({ name: 'manual', help: 'test', run() {} });
        return () => api.commands.unregister('manual');
      };
    `);
    const registered = new Set();
    const unregistered = [];
    const api = {
      ...stubApi(),
      commands: {
        register(spec) { registered.add(spec.name); },
        unregister(name) {
          unregistered.push(name);
          registered.delete(name);
        },
      },
    };
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    await rt.load();
    expect([...registered]).toEqual(['manual']);
    expect(unregistered).toEqual(['manual']);
  });

  it('auto-unsubscribes lifecycle events on reload', async () => {
    const dir = mkTempDir();
    fs.writeFileSync(path.join(dir, 'event.js'), `
      export default (api) => {
        api.lifecycle.event('demo', () => { api._events = (api._events ?? 0) + 1; });
      };
    `);
    const listeners = new Map();
    const events = {
      on(name, fn) {
        let set = listeners.get(name);
        if (!set) { set = new Set(); listeners.set(name, set); }
        set.add(fn);
        return () => set.delete(fn);
      },
      emit(name, payload) {
        for (const fn of listeners.get(name) ?? []) fn(payload);
      },
    };
    const api = { ...stubApi(), world: { events } };
    const rt = new ScriptRuntime(dir, api);
    await rt.load();
    events.emit('demo');
    expect(api._events).toBe(1);

    await rt.load();
    expect(listeners.get('demo')?.size).toBe(1);
    events.emit('demo');
    expect(api._events).toBe(2);
  });

  it('logs lifecycle timer errors without escaping the runtime', async () => {
    vi.useFakeTimers();
    try {
      const dir = mkTempDir();
      fs.writeFileSync(path.join(dir, 'timer.js'), `
        export default (api) => {
          api.lifecycle.setTimeout((value) => {
            api._timerValue = value;
            throw new Error('timer boom');
          }, 10, 'ok');
        };
      `);
      const api = stubApi();
      const rt = new ScriptRuntime(dir, api);
      await rt.load();

      vi.advanceTimersByTime(10);

      expect(api._timerValue).toBe('ok');
      expect(api._logs.some((l) => /lifecycle timeout threw: timer boom/.test(l))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defineScript wires declarative commands, events, timers, and cleanup', () => {
    vi.useFakeTimers();
    try {
      const registered = new Set();
      const listeners = new Map();
      const api = {
        ...stubApi(),
        commands: {
          register(spec) { registered.add(spec.name); },
          unregister(name) { registered.delete(name); },
        },
        world: {
          events: {
            on(name, fn) {
              let set = listeners.get(name);
              if (!set) { set = new Set(); listeners.set(name, set); }
              set.add(fn);
              return () => set.delete(fn);
            },
            emit(name, payload) {
              for (const fn of listeners.get(name) ?? []) fn(payload);
            },
          },
        },
      };
      const dispose = defineScript({
        init(a) { a._init = true; return () => { a._disposed = true; }; },
        commands: [{ name: 'declared', access: 'Player', run() {} }],
        events: { demo: (_payload, a) => { a._events = (a._events ?? 0) + 1; } },
        intervals: [{ every: 10, run(a) { a._ticks = (a._ticks ?? 0) + 1; } }],
      })(api);

      api.world.events.emit('demo', {});
      vi.advanceTimersByTime(10);

      expect(api._init).toBe(true);
      expect(api._events).toBe(1);
      expect(api._ticks).toBe(1);
      expect([...registered]).toEqual(['declared']);

      dispose();

      expect(api._disposed).toBe(true);
      expect([...registered]).toEqual([]);
      expect(listeners.get('demo')?.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('script spatial helpers delegate through api.game before raw world maps', () => {
    const sent = [];
    const near = { name: 'near', client: { send: (pkt) => sent.push(['near', pkt]) } };
    const online = { name: 'online', client: { send: (pkt) => sent.push(['online', pkt]) } };
    const api = {
      world: { mobiles: new Map([[1, online]]) },
      game: {
        clientsNear() { return [near]; },
        sendToOnline(packet) {
          online.client.send(packet);
          return 1;
        },
      },
    };

    expect([...nearbyClients(api, { x: 0, y: 0, map: 1 })]).toEqual([near]);
    expect(sendToOnline(api, { op: 'hello' })).toBe(1);
    expect(sent).toEqual([['online', { op: 'hello' }]]);
  });

  it('script spatial helpers use sector indexes when only a world is supplied', () => {
    const near = { serial: 1, x: 10, y: 10, map: 1, client: {} };
    const far = { serial: 2, x: 500, y: 500, map: 1, client: {} };
    const item = { serial: 0x40000000, x: 11, y: 10, map: 1, parent: 0 };
    const world = {
      mobiles: new Map([[near.serial, near], [far.serial, far]]),
      items: new Map([[item.serial, item]]),
      sectors: {
        mobilesIndexed: () => 2,
        itemsIndexed: () => 1,
        *mobileSerialsNear() { yield near.serial; },
        *itemSerialsNear() { yield item.serial; },
      },
    };

    expect([...nearbyMobiles(world, near, null, 18)]).toEqual([near]);
    expect([...nearbyClients(world, near, null, 18)]).toEqual([near]);
    expect([...nearbyItems(world, near, 18)]).toEqual([item]);
  });
});
