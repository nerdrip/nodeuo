import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(HERE, '..', 'src');
const source = readFileSync(resolve(SOURCE_DIR, 'main.cjs'), 'utf8');
const nodeRequire = createRequire(import.meta.url);

function createLauncher() {
  const handlers = new Map();
  const children = [];
  const electron = {
    app: { whenReady: () => ({ then() {} }), on() {}, quit() {} },
    BrowserWindow: class {},
    dialog: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    shell: {},
  };
  const fakeRequire = (id) => {
    if (id === 'electron') return electron;
    if (id === 'node:child_process') {
      return {
        spawn: (command, args, options) => {
          const child = new EventEmitter();
          child.pid = 42_424 + children.length;
          child.exitCode = null;
          child.signalCode = null;
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          children.push({ command, args, options, child });
          return child;
        },
        spawnSync: nodeRequire('node:child_process').spawnSync,
      };
    }
    return nodeRequire(id);
  };
  vm.runInNewContext(source, {
    require: fakeRequire,
    __dirname: SOURCE_DIR,
    process,
    console,
    Buffer,
    setTimeout,
    clearTimeout,
  }, { filename: resolve(SOURCE_DIR, 'main.cjs') });
  return { handlers, children };
}

async function listen(server, port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function stopFakeChild(child) {
  child.exitCode = 0;
  child.emit('exit', 0, null);
}

test('launcher leaves an unrelated listener untouched when a service port is occupied', async () => {
  const listener = net.createServer();
  const port = await listen(listener);
  try {
    const { handlers, children } = createLauncher();
    const result = await handlers.get('start-service')(null, {
      id: 'server', envOverride: { UO_PORT: String(port) }, options: {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /already in use/);
    assert.equal(children.length, 0);
    assert.equal(listener.listening, true);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test('blocked admin port does not stop the running game server', async () => {
  const gameProbe = net.createServer();
  const gamePort = await listen(gameProbe);
  await new Promise((resolve) => gameProbe.close(resolve));
  const adminListener = net.createServer();
  const adminPort = await listen(adminListener);
  try {
    const { handlers, children } = createLauncher();
    const started = await handlers.get('start-service')(null, {
      id: 'server', envOverride: { UO_PORT: String(gamePort) }, options: {},
    });
    assert.equal(started.ok, true);
    const blocked = await handlers.get('start-service')(null, {
      id: 'admin', envOverride: {
        UO_PORT: String(gamePort), UO_ADMIN_PORT: String(adminPort),
      }, options: {},
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /already in use/);
    assert.equal(children.length, 1);
    assert.equal(handlers.get('list-services')().server.running, true);
  } finally {
    await new Promise((resolve) => adminListener.close(resolve));
  }
});

test('LAN game bind disables development account creation and bridge target is locked', async () => {
  const gameProbe = net.createServer();
  const gamePort = await listen(gameProbe);
  await new Promise((resolve) => gameProbe.close(resolve));
  const bridgeProbe = net.createServer();
  const bridgePort = await listen(bridgeProbe);
  await new Promise((resolve) => bridgeProbe.close(resolve));
  const { handlers, children } = createLauncher();
  const game = await handlers.get('start-service')(null, {
    id: 'server', envOverride: {
      UO_HOST: '0.0.0.0', UO_PORT: String(gamePort),
      UO_BOOTSTRAP_ADMIN_PASSWORD: 'a-long-bootstrap-secret',
    }, options: {},
  });
  assert.equal(game.ok, true);
  assert.equal(children[0].options.env.UO_DEV_AUTO_ACCEPT, '0');
  const bridge = await handlers.get('start-service')(null, {
    id: 'bridge-out', envOverride: {
      UO_BRIDGE_PORT: String(bridgePort),
      UO_BRIDGE_DEFAULT: '127.0.0.1:2594',
    }, options: {},
  });
  assert.equal(bridge.ok, true);
  assert.equal(children[1].options.env.UO_BRIDGE_ALLOW, '127.0.0.1:2594');
});

test('launcher stops a server through its private control token and preserves it on rejection', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const { handlers, children } = createLauncher();
  const started = await handlers.get('start-service')(null, {
    id: 'server', envOverride: { UO_PORT: String(port) }, options: {},
  });
  assert.equal(started.ok, true);
  assert.equal(children.length, 1);
  const { options, child } = children[0];
  assert.match(options.env.UO_CONTROL_TOKEN, /^[0-9a-f]{64}$/);

  let accepted = false;
  const control = createServer((request, response) => {
    assert.equal(request.url, '/internal/shutdown');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, `Bearer ${options.env.UO_CONTROL_TOKEN}`);
    response.writeHead(accepted ? 202 : 401).end();
    if (accepted) setTimeout(() => stopFakeChild(child), 20);
  });
  await listen(control, port);
  try {
    const rejected = await handlers.get('stop-service')(null, { id: 'server' });
    assert.equal(rejected.ok, false);
    assert.equal(child.exitCode, null);
    accepted = true;
    const stopped = await handlers.get('stop-service')(null, { id: 'server' });
    assert.equal(stopped.ok, true);
    assert.equal(child.exitCode, 0);
  } finally {
    await new Promise((resolve) => control.close(resolve));
  }
});

test('launcher uses the configured IPv6 loopback address for graceful shutdown', async (context) => {
  const probe = net.createServer();
  let port;
  try { port = await listen(probe, 0, '::1'); }
  catch { context.skip('IPv6 loopback is unavailable'); return; }
  await new Promise((resolve) => probe.close(resolve));
  const { handlers, children } = createLauncher();
  const started = await handlers.get('start-service')(null, {
    id: 'server', envOverride: { UO_HOST: '::1', UO_PORT: String(port) }, options: {},
  });
  assert.equal(started.ok, true);
  const { child, options } = children[0];
  const control = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${options.env.UO_CONTROL_TOKEN}`);
    response.writeHead(202).end();
    setTimeout(() => stopFakeChild(child), 20);
  });
  await listen(control, port, '::1');
  try {
    const stopped = await handlers.get('stop-service')(null, { id: 'server' });
    assert.equal(stopped.ok, true);
  } finally {
    await new Promise((resolve) => control.close(resolve));
  }
});
