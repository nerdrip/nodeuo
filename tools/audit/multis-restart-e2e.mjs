import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from '../../apps/server/node_modules/ws/wrapper.mjs';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { config as serverConfig } from '../../apps/server/src/config.js';
import { World } from '../../apps/server/src/world/world.js';
import { createItem } from '../../apps/server/src/world/items.js';
import { snapshotWorld, restoreWorld } from '../../apps/server/src/world/persistence.js';
import { NetState, Stage } from '../../apps/server/src/net/net-state.js';
import { AuthKeyRegistry } from '../../apps/server/src/net/auth.js';
import { buildHandlers } from '../../apps/server/src/net/handlers.js';
import { CommandRegistry } from '../../apps/server/src/net/commands.js';
import { AccountDB } from '../../apps/server/src/net/accounts.js';
import { placeGalleon } from '../../apps/server/src/systems/boats.js';
import { stampMultiAt } from '../../apps/scripts/src/commands/housing/placemulti.js';
import { applyAclToTiles, newAclFor } from '../../apps/scripts/src/items/behaviors/house-acl.js';

const distRoot = resolve('apps/client/dist');
assert.ok(existsSync(join(distRoot, 'index.html')), 'client dist missing; run build first');
const multiCatalog = JSON.parse(readFileSync(resolve('apps/client/public/assets/multi.json'), 'utf8')).multis;

function expectedRenderedTiles(multiId) {
  const components = multiCatalog?.[multiId];
  assert.ok(Array.isArray(components), `missing multi definition 0x${multiId.toString(16)}`);
  return components.filter((component) => component.visible !== false).length;
}

const accountDir = mkdtempSync(join(tmpdir(), 'nodeuo-multis-restart-e2e-'));
const cfg = {
  ...serverConfig,
  port: 0,
  logPackets: false,
  huffmanOutgoing: true,
  devAutoAccept: false,
};

const users = [
  { username: 'multi-owner', password: 'owner-audit-password', character: 'MultiOwner' },
  { username: 'multi-guest', password: 'guest-audit-password', character: 'MultiGuest' },
];
const spawn = { x: 1825, y: 2728, z: 0, map: 1 };

function waitFor(predicate, message, timeoutMs = 20_000) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const poll = () => {
      let value;
      try { value = predicate(); } catch { value = null; }
      if (value) { resolveWait(value); return; }
      if (Date.now() - started >= timeoutMs) {
        rejectWait(new Error(`${message} (timeout ${timeoutMs}ms)`));
        return;
      }
      setTimeout(poll, 40);
    };
    poll();
  });
}

function seedPlayer(world, accounts, user, offset) {
  const account = accounts.createAccount(user.username, user.password);
  const mobile = world.createMobile({
    name: user.character,
    x: spawn.x + offset,
    y: spawn.y,
    z: spawn.z,
    map: spawn.map,
  });
  mobile.isPlayer = true;
  mobile.accountName = user.username;
  account.mobileSerial = mobile.serial >>> 0;
  account.characters = [{ name: mobile.name, mobileSerial: mobile.serial >>> 0 }];
  accounts.saveSync();
  return mobile;
}

function seedMultis(world, owner) {
  const statics = [];
  statics[0x1000] = { name: 'stone wall', flags: 1 << 6, height: 20 };
  statics[0x06A5] = { name: 'wooden door', flags: 1 << 29, height: 20 };
  const api = {
    world,
    items: { createItem },
    tileData: { table: () => ({ statics }) },
  };
  const house = stampMultiAt(
    api,
    0x006E,
    0,
    [
      { id: 0x1000, x: 0, y: 0, z: 0, visible: true },
      { id: 0x06A5, x: 1, y: 0, z: 0, visible: false },
    ],
    spawn.x + 4,
    spawn.y + 2,
    spawn.z,
    spawn.map,
  );
  const acl = newAclFor(owner);
  const aclParts = applyAclToTiles(world, 0x006E, spawn.map, acl, house.instanceId);
  assert.equal(aclParts, 2, 'house ACL was not attached to anchor and dynamic door');

  const boat = placeGalleon(api, {
    kind: 'small',
    // East-facing small hull extends five cells west of its origin. Keep the
    // audit structures genuinely disjoint now that placement checks the full
    // hull instead of only its origin tile.
    x: spawn.x + 16,
    y: spawn.y + 2,
    z: spawn.z,
    map: spawn.map,
    facing: 'E',
    ownerSerial: owner.serial,
    name: 'Audit Sloop',
  });
  assert.ok(boat.boat, 'boat subsystem did not create durable boat state');
  return { house, boat };
}

function startGameServer(world, accounts, generation) {
  const states = [];
  const gameHttp = createServer();
  const wss = new WebSocketServer({ server: gameHttp, path: '/game' });
  const authKeys = new AuthKeyRegistry();
  const handlers = buildHandlers();
  const commands = new CommandRegistry();
  wss.on('connection', (ws, request) => {
    const state = new NetState(ws, {
      world,
      authKeys,
      accounts,
      config: cfg,
      handlers,
      commands,
      id: generation * 100 + states.length + 1,
      remoteAddress: request.socket?.remoteAddress ?? null,
      nodeUOTransportVersion: ws.protocol,
    });
    states.push(state);
  });
  return new Promise((resolveStart, rejectStart) => {
    gameHttp.once('error', rejectStart);
    gameHttp.listen(0, '127.0.0.1', () => {
      resolveStart({
        world,
        accounts,
        states,
        gameHttp,
        wss,
        port: gameHttp.address().port,
      });
    });
  });
}

async function stopGameServer(runtime, reason = 'audit server restart') {
  for (const state of runtime.states) state.close(reason);
  try {
    await waitFor(
      () => runtime.states.every((state) => state._cleanupDone),
      'connections did not complete logout cleanup',
      3_000,
    );
  } catch {
    for (const socket of runtime.wss.clients) socket.terminate();
  }
  for (const socket of runtime.wss.clients) {
    if (socket.readyState !== socket.CLOSED) socket.terminate();
  }
  await Promise.all([
    new Promise((resolveClose) => runtime.wss.close(() => resolveClose())),
    new Promise((resolveClose) => runtime.gameHttp.close(() => resolveClose())),
  ]);
}

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.bin', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
]);

function startWebServer() {
  const web = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    const file = resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(distRoot + sep) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const size = statSync(file).size;
    const headers = {
      'content-type': mime.get(extname(file)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
    };
    const range = String(req.headers.range ?? '').match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
      if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveStart, rejectStart) => {
    web.once('error', rejectStart);
    web.listen(0, '127.0.0.1', () => {
      resolveStart({ web, url: `http://127.0.0.1:${web.address().port}` });
    });
  });
}

async function loginClient(browser, webUrl, gamePort, user, generation) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  const clickTransition = (selector) => page.locator(selector).evaluate((element) => element.click());

  await page.goto(`${webUrl}?runtimeAudit=1&generation=${generation}&user=${user.username}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('#m-account', { timeout: 30_000 });
  await page.fill('#m-account', user.username);
  await page.fill('#m-password', user.password);
  await page.locator('details summary').click();
  await page.fill('#m-host', '127.0.0.1');
  await page.fill('#m-port', String(gamePort));
  await clickTransition('#m-login');
  await page.waitForFunction(
    () => document.querySelector('#ss-next') || document.querySelector('#cs-new'),
    null,
    { timeout: 10_000 },
  );
  if (await page.locator('#cs-new').count() === 0 && await page.locator('#ss-next').count() > 0) {
    await clickTransition('#ss-next');
  }
  await page.waitForSelector('.uo-char-slot:not(.empty)', { timeout: 10_000 });
  await page.locator('.uo-char-slot:not(.empty)').first().click();
  await page.waitForFunction(() => {
    const play = document.querySelector('#cs-play');
    return play && !play.disabled;
  });
  await clickTransition('#cs-play');
  try {
    await page.waitForFunction(() => globalThis.__uo?.gc?.scene?._tiles, null, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      loginMessage: document.querySelector('#m-msg')?.textContent ?? null,
      characterMessage: document.querySelector('#cs-msg')?.textContent ?? null,
      loadingDetail: document.querySelector('#uo-loading-detail')?.textContent ?? null,
      loadingPercent: document.querySelector('#uo-loading-percent')?.textContent ?? null,
      visibleControls: ['#m-login', '#ss-next', '#cs-play'].filter(
        (selector) => document.querySelector(selector),
      ),
      runtimeReady: !!globalThis.__uo?.gc,
      scene: globalThis.__uo?.gc?.scene?.constructor?.name ?? null,
      tileRendererReady: !!globalThis.__uo?.gc?.scene?._tiles,
    })).catch((evaluateError) => ({ evaluateError: String(evaluateError) }));
    throw new Error(`${user.username}: client did not enter world: ${JSON.stringify({
      diagnostics,
      pageErrors,
    })}`, { cause: error });
  }
  return { context, page, pageErrors, user };
}

async function assertRenderedMultis(client, expected) {
  const args = {
    houseSerial: expected.houseSerial,
    houseMultiId: expected.houseMultiId,
    houseRenderedTiles: expected.houseRenderedTiles,
    boatSerial: expected.boatSerial,
    boatMultiId: expected.boatMultiId,
    boatRenderedTiles: expected.boatRenderedTiles,
  };
  try {
    await client.page.waitForFunction(({
      houseSerial, houseMultiId, houseRenderedTiles,
      boatSerial, boatMultiId, boatRenderedTiles,
    }) => {
      const runtime = globalThis.__uo;
      const house = runtime?.world?.items?.get?.(houseSerial);
      const boat = runtime?.world?.items?.get?.(boatSerial);
      const rendererItems = runtime?.gc?.scene?._tiles?.items;
      const houseVisual = rendererItems?.get?.(houseSerial);
      const boatVisual = rendererItems?.get?.(boatSerial);
      return house?.multiId === houseMultiId
        && boat?.multiId === boatMultiId
        // Each component mounts asynchronously as its art texture becomes
        // available. Waiting for merely one child made the restart audit race
        // against that queue and compare two arbitrary partial renders.
        && (houseVisual?.children?.length ?? 0) === houseRenderedTiles
        && (boatVisual?.children?.length ?? 0) === boatRenderedTiles;
    }, args, { timeout: 30_000 });
  } catch (error) {
    const diagnostics = await client.page.evaluate(({ houseSerial, boatSerial }) => {
      const runtime = globalThis.__uo;
      const inspect = (serial) => {
        const item = runtime?.world?.items?.get?.(serial);
        const visual = runtime?.gc?.scene?._tiles?.items?.get?.(serial);
        return {
          item: item ? { serial: item.serial, itemId: item.itemId, multiId: item.multiId,
            x: item.x, y: item.y, z: item.z, map: item.map } : null,
          visual: visual ? { children: visual.children?.length ?? 0, sprite: !!visual.sprite,
            mountGeneration: visual.mountGeneration } : null,
        };
      };
      return {
        player: runtime?.world?.player ? {
          serial: runtime.world.player.serial, x: runtime.world.player.x,
          y: runtime.world.player.y, map: runtime.world.player.map,
        } : null,
        rendererItems: runtime?.gc?.scene?._tiles?.items?.size ?? null,
        worldItems: runtime?.world?.items?.size ?? null,
        house: inspect(houseSerial),
        boat: inspect(boatSerial),
      };
    }, args).catch((evaluateError) => ({ evaluateError: String(evaluateError) }));
    throw new Error(`${client.user.username}: multis did not reach a rendered state: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }

  const rendered = await client.page.evaluate(({ houseSerial, boatSerial }) => {
    const runtime = globalThis.__uo;
    const house = runtime.world.items.get(houseSerial);
    const boat = runtime.world.items.get(boatSerial);
    const rendererItems = runtime.gc.scene._tiles.items;
    return {
      playerSerial: runtime.world.player?.serial >>> 0,
      house: {
        serial: house.serial >>> 0,
        multiId: house.multiId,
        x: house.x,
        y: house.y,
        renderedTiles: rendererItems.get(houseSerial)?.children?.length ?? 0,
      },
      boat: {
        serial: boat.serial >>> 0,
        multiId: boat.multiId,
        x: boat.x,
        y: boat.y,
        renderedTiles: rendererItems.get(boatSerial)?.children?.length ?? 0,
      },
    };
  }, args);
  assert.equal(
    rendered.house.renderedTiles,
    expected.houseRenderedTiles,
    `${client.user.username}: house multi render is incomplete`,
  );
  assert.equal(
    rendered.boat.renderedTiles,
    expected.boatRenderedTiles,
    `${client.user.username}: boat multi render is incomplete`,
  );
  return rendered;
}

function assertDurableServerState(world, ids, playerSerials) {
  const house = world.items.get(ids.houseSerial);
  const boat = world.items.get(ids.boatSerial);
  assert.ok(house?._multiAnchor, 'house anchor did not survive server restart');
  assert.equal(house.multiId, ids.houseMultiId);
  assert.equal(house._multiAcl?.owner?.serial >>> 0, playerSerials[0]);
  const houseParts = [...world.items.values()].filter(
    (item) => (item._multiInstance >>> 0) === ids.houseSerial,
  );
  assert.equal(houseParts.length, 2, 'house anchor/dynamic door were lost or duplicated during persistence');
  assert.ok(houseParts.every((item) => item._multiAcl === house._multiAcl), 'house ACL identity was not restored');
  assert.ok(houseParts.filter((item) => !item._multiAnchor).every((item) => item._noDecay), 'house dynamic-part durability flag was lost');
  assert.equal(house._multiComponentCount, 2, 'compact multi component count was lost');
  assert.equal(house._multiCollision?.length, 1, 'compact multi collision was lost');

  assert.ok(boat?.boat, 'boat state did not survive server restart');
  assert.equal(boat.multiId, ids.boatMultiId);
  assert.equal(boat.boat.ownerSerial >>> 0, playerSerials[0]);
  assert.equal(boat.boat.hullKind, 'small');
  assert.equal(boat.boat.name, 'Audit Sloop');
  assert.ok(boat.boat.riders instanceof Set, 'boat riders were not rehydrated as a Set');

  const players = [...world.mobiles.values()].filter((mobile) => mobile.isPlayer);
  assert.equal(players.length, 2, 'restart created or lost a persistent player mobile');
  assert.deepEqual(
    players.map((mobile) => mobile.serial >>> 0).sort((a, b) => a - b),
    [...playerSerials].sort((a, b) => a - b),
  );
}

let gameRuntime;
let webRuntime;
let browser;
let clients = [];
try {
  const firstWorld = new World();
  const firstAccounts = new AccountDB(accountDir);
  const players = users.map((user, index) => seedPlayer(firstWorld, firstAccounts, user, index));
  const playerSerials = players.map((mobile) => mobile.serial >>> 0);
  const { house, boat } = seedMultis(firstWorld, players[0]);
  const ids = {
    houseSerial: house.anchor.serial >>> 0,
    houseMultiId: house.anchor.multiId,
    houseRenderedTiles: expectedRenderedTiles(house.anchor.multiId),
    boatSerial: boat.serial >>> 0,
    boatMultiId: boat.multiId,
    boatRenderedTiles: expectedRenderedTiles(boat.multiId),
  };

  webRuntime = await startWebServer();
  gameRuntime = await startGameServer(firstWorld, firstAccounts, 1);
  browser = await chromium.launch({ headless: true });

  clients = [];
  for (const user of users) {
    clients.push(await loginClient(browser, webRuntime.url, gameRuntime.port, user, 1));
  }
  const firstStates = await Promise.all(users.map((user) => waitFor(
    () => gameRuntime.states.find(
      (state) => state.accountName === user.username && state.stage === Stage.InWorld,
    ),
    `${user.username} did not enter world before restart`,
  )));
  assert.deepEqual(
    firstStates.map((state) => state.mobile.serial >>> 0),
    playerSerials,
    'initial login did not bind the seeded characters',
  );
  const beforeRestart = [];
  for (const client of clients) beforeRestart.push(await assertRenderedMultis(client, ids));

  firstAccounts.saveSync();
  const durableSnapshot = JSON.parse(JSON.stringify(snapshotWorld(firstWorld)));
  await stopGameServer(gameRuntime);
  gameRuntime = null;
  assert.ok(players.every((mobile) => mobile.client == null), 'logout cleanup left a live client on the old world');
  await Promise.all(clients.map((client) => client.context.close()));
  clients = [];

  const restoredWorld = new World();
  restoreWorld(restoredWorld, durableSnapshot);
  const restoredAccounts = new AccountDB(accountDir);
  restoredAccounts.load();
  assertDurableServerState(restoredWorld, ids, playerSerials);

  gameRuntime = await startGameServer(restoredWorld, restoredAccounts, 2);
  for (const user of users) {
    clients.push(await loginClient(browser, webRuntime.url, gameRuntime.port, user, 2));
  }
  const restoredStates = await Promise.all(users.map((user) => waitFor(
    () => gameRuntime.states.find(
      (state) => state.accountName === user.username && state.stage === Stage.InWorld,
    ),
    `${user.username} did not relog after restart`,
  )));
  assert.deepEqual(
    restoredStates.map((state) => state.mobile.serial >>> 0),
    playerSerials,
    'relogin created duplicate characters instead of rebinding persistent ones',
  );
  const afterRestart = [];
  for (const client of clients) afterRestart.push(await assertRenderedMultis(client, ids));
  for (let index = 0; index < clients.length; index++) {
    assert.deepEqual(
      afterRestart[index].house,
      beforeRestart[index].house,
      `${users[index].username}: house render changed after restart`,
    );
    assert.deepEqual(
      afterRestart[index].boat,
      beforeRestart[index].boat,
      `${users[index].username}: boat render changed after restart`,
    );
    assert.deepEqual(clients[index].pageErrors, [], `${users[index].username}: browser page errors after restart`);
  }

  assertDurableServerState(restoredWorld, ids, playerSerials);
  console.log(JSON.stringify({
    ok: true,
    clients: users.length,
    restartCount: 1,
    reboundPlayerSerials: playerSerials.map((serial) => `0x${serial.toString(16)}`),
    house: afterRestart[0].house,
    boat: afterRestart[0].boat,
  }, null, 2));
} finally {
  await Promise.all(clients.map((client) => client.context.close().catch(() => {})));
  if (browser) await browser.close().catch(() => {});
  if (gameRuntime) await stopGameServer(gameRuntime, 'audit complete').catch(() => {});
  if (webRuntime?.web) {
    await new Promise((resolveClose) => webRuntime.web.close(() => resolveClose()));
  }
  rmSync(accountDir, { recursive: true, force: true });
}
