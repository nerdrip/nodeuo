import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { startAdminServer } from '../../apps/server/src/admin/admin-server.js';
import { ContentDependencyGraph } from '../../apps/server/src/systems/content-dependency-graph.js';
import { PlatformOperations } from '../../apps/server/src/systems/platform-operations.js';
import { World } from '../../apps/server/src/world/world.js';

/* global ed -- global lexical binding provided by admin/editor.html */

const saveDir = mkdtempSync(join(tmpdir(), 'nodeuo-admin-e2e-'));
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const account = { username: 'admin', accessLevel: 'Admin', banned: false, characters: [] };
const accounts = {
  accounts: new Map([['admin', account]]),
  authenticate: (username, password) => username === 'admin' && password === 'audit-secret'
    ? { ok: true, account }
    : { ok: false, reason: 'bad credentials' },
};
const world = new World();
world.createMobile({ name: 'browser-audit-admin', x: 1495, y: 1625, map: 1 });
const scriptsDir = join(ROOT, 'apps/scripts/src');
const platformOperations = new PlatformOperations({ saveDir, scriptsDir });
const contentDependencies = new ContentDependencyGraph({ scriptsDir, assetsDir: join(ROOT, 'apps/client/public') });
const server = startAdminServer({
  port: 0, host: '127.0.0.1', accounts, sharedCtx: { world, platformOperations, contentDependencies },
  scriptsDir, saveDir,
});
if (!server.listening) await new Promise((ok) => server.once('listening', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const serverErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const location = message.location?.();
  consoleErrors.push(`${message.text()}${location?.url ? ` @ ${location.url}` : ''}`);
});
page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

async function auditAccessibility(label) {
  const report = await page.evaluate(() => ({
    duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id,index,all)=>all.indexOf(id)!==index),
    unnamedButtons: [...document.querySelectorAll('button')].filter(node => node.offsetParent && !(node.textContent.trim() || node.getAttribute('aria-label') || node.title)).map(node => node.outerHTML.slice(0,160)),
    unnamedInputs: [...document.querySelectorAll('input,select,textarea')].filter(node => node.offsetParent && !(
      node.getAttribute('aria-label') || node.title || node.placeholder || node.closest('label') || node.labels?.length
    )).map(node => `${node.tagName.toLowerCase()}#${node.id || '-'}[${node.type || '-'}]`),
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter(node => !node.hasAttribute('alt')).map(node => node.src),
  }));
  assert.deepEqual(report.duplicateIds, [], `${label}: duplicate DOM IDs: ${report.duplicateIds.join(', ')}`);
  assert.deepEqual(report.unnamedButtons, [], `${label}: visible unnamed buttons: ${report.unnamedButtons.join(', ')}`);
  assert.deepEqual(report.unnamedInputs, [], `${label}: visible unnamed inputs: ${report.unnamedInputs.join(', ')}`);
  assert.deepEqual(report.imagesWithoutAlt, [], `${label}: images without alt: ${report.imagesWithoutAlt.join(', ')}`);
}

try {
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('#u', 'admin');
  await page.fill('#p', 'audit-secret');
  await Promise.all([page.waitForURL(`${base}/`), page.click('#btn')]);
  await page.waitForSelector('nav#tabs');
  await page.keyboard.press('Control+K');
  await page.waitForSelector('.admin-palette[role="dialog"] input[aria-label]');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#admin-view-settings').count(), 1, 'global view preferences button missing');
  const runtimePrimitives = await page.evaluate(async () => {
    const AdminCore = globalThis.AdminCore;
    const originalFetch = window.fetch;
    let fetches = 0;
    window.fetch = async () => { fetches++; await new Promise((resolve) => setTimeout(resolve, 10)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const broker = new AdminCore.RequestBroker({ maxConcurrent: 2, cacheEntries: 8 });
    const [requestA, requestB] = await Promise.all([broker.request('GET', '/runtime-wave2'), broker.request('GET', '/runtime-wave2')]);
    const cached = await broker.request('GET', '/runtime-wave2');
    window.fetch = originalFetch;

    const abortController = new AbortController();
    abortController.abort();
    const aborted = await broker.request('GET', '/runtime-aborted', null, { signal: abortController.signal })
      .then(() => false, (error) => error?.name === 'AbortError');
    let mutationFetches = 0;
    window.fetch = async () => { mutationFetches++; return new Response(JSON.stringify({ error: 'no retry' }), { status: 503, headers: { 'content-type': 'application/json' } }); };
    await broker.request('POST', '/runtime-mutation', { value: 1 }, { retries: 9 }).catch(() => {});
    window.fetch = originalFetch;

    const host = document.createElement('div'); host.style.cssText = 'height:240px;width:320px;overflow:auto'; document.body.appendChild(host);
    const list = new AdminCore.VirtualList(host, { itemHeight: 30, renderItem: (item) => `<span>${item.name}</span>` });
    list.setItems(Array.from({ length: 100_000 }, (_, id) => ({ id, name: `Record ${id}` })));
    list.scrollToIndex(90_000, 'start'); const listMetrics = list.snapshot(); list.destroy(); host.remove();

    const tableHost = document.createElement('div'); tableHost.style.cssText = 'height:240px;width:720px;overflow:auto'; document.body.appendChild(tableHost);
    const table = new AdminCore.VirtualTable(tableHost, {
      columns: [{ label: 'ID' }, { label: 'Name' }], maxDomNodes: 48,
      key: (item) => item.id, renderCells: (item) => [item.id, item.name],
    });
    const rows = Array.from({ length: 100_000 }, (_, id) => ({ id, name: `Row ${id}` }));
    table.setItems(rows); table.scrollToIndex(99_000, 'start');
    const tableMetrics = table.snapshot(); const stableKeys = tableHost.querySelectorAll('[data-key]').length === new Set([...tableHost.querySelectorAll('[data-key]')].map((node) => node.dataset.key)).size;
    table.destroy(); tableHost.remove();

    let value = 0; const history = new AdminCore.EditHistory({ limit: 20 });
    await history.execute({ label: 'Increment', do: () => { value++; }, undo: () => { value--; } });
    await history.undo(); const undone = value; await history.redo();
    history.begin('Atomic map batch');
    await history.execute({ label: 'Add static', do: () => { value += 10; }, undo: () => { value -= 10; } });
    await history.execute({ label: 'Move spawner', do: () => { value += 100; }, undo: () => { value -= 100; } });
    history.commit();
    await history.undo(); const batchUndone = value; await history.redo(); const batchRedone = value;
    const form = new AdminCore.FormSession({ id: 'e2e-form', initial: { name: '' }, rules: { name: (next) => next ? '' : 'Required' }, autosaveMs: 5 });
    const invalid = form.validate(); form.set('name', 'valid'); const valid = form.validate();
    const diff = form.diff(); form.commit();
    const validatorResults = {
      facet: AdminCore.AdminValidators.facet(6), x: AdminCore.AdminValidators.x(9000, { facet: 0 }),
      y: AdminCore.AdminValidators.y(-1, { facet: 0 }), z: AdminCore.AdminValidators.z(128),
      hue: AdminCore.AdminValidators.hue(0x10000), graphic: AdminCore.AdminValidators.graphic(-1),
      body: AdminCore.AdminValidators.body(0x10000), template: AdminCore.AdminValidators.templateName('../bad name'),
    };
    const tabs = new AdminCore.WorkTabs(AdminCore.workspaceState, 'e2e');
    tabs.open({ id: 'one', label: 'One' }); tabs.open({ id: 'two', label: 'Two' }); tabs.activate('one'); tabs.close('two');
    const conflictState = new AdminCore.MutationState(); let rolledBack = false;
    await conflictState.run('record:1', () => ({ revision: 1 }), async () => { const error = new Error('conflict'); error.conflict = true; error.payload = { token: 'secret', revision: 2 }; throw error; }, () => { rolledBack = true; }).catch(() => {});
    return {
      fetches, mutationFetches, aborted, requestA, requestB, cached, broker: broker.snapshot(), listMetrics, tableMetrics, stableKeys,
      history: { value, undone, batchUndone, batchRedone, canUndo: history.canUndo, preview: history.preview() },
      form: { invalid, valid, diff, dirtyAfterCommit: form.dirty },
      validatorResults, tabs: tabs.snapshot(), mutation: { rolledBack, ...conflictState.snapshot() },
      diagnosticShape: Object.keys(AdminCore.diagnostics.snapshot()).sort(),
    };
  });
  assert.equal(runtimePrimitives.fetches, 1, 'request broker did not deduplicate/cache GET requests');
  assert.deepEqual(runtimePrimitives.requestA, { ok: true });
  assert.equal(runtimePrimitives.broker.deduped, 1);
  assert.equal(runtimePrimitives.aborted, true, 'request broker did not honor AbortSignal');
  assert.equal(runtimePrimitives.mutationFetches, 1, 'mutation request was retried');
  assert.ok(runtimePrimitives.listMetrics.domNodes < 40, `virtual list DOM budget exceeded: ${runtimePrimitives.listMetrics.domNodes}`);
  assert.equal(runtimePrimitives.listMetrics.items, 100_000);
  assert.ok(runtimePrimitives.tableMetrics.domNodes <= 48, `virtual table DOM budget exceeded: ${runtimePrimitives.tableMetrics.domNodes}`);
  assert.equal(runtimePrimitives.tableMetrics.items, 100_000);
  assert.equal(runtimePrimitives.stableKeys, true, 'virtual table row keys are unstable');
  assert.deepEqual(runtimePrimitives.history, { value: 111, undone: 0, batchUndone: 1, batchRedone: 111, canUndo: true, preview: ['Increment', 'Atomic map batch'] });
  assert.equal(runtimePrimitives.form.invalid.ok, false);
  assert.equal(runtimePrimitives.form.valid.ok, true);
  assert.equal(runtimePrimitives.form.diff.length, 1);
  assert.equal(runtimePrimitives.form.dirtyAfterCommit, false);
  assert.ok(Object.values(runtimePrimitives.validatorResults).every(Boolean), 'one or more invalid admin values passed validation');
  assert.deepEqual(runtimePrimitives.tabs.tabs.map((tab) => tab.id), ['one']);
  assert.equal(runtimePrimitives.tabs.active, 'one');
  assert.equal(runtimePrimitives.mutation.rolledBack, true);
  assert.equal(runtimePrimitives.mutation.conflicts.length, 1);
  assert.equal(runtimePrimitives.mutation.conflicts[0].payload.token, '[REDACTED]');
  assert.ok(runtimePrimitives.diagnosticShape.includes('broker') && runtimePrimitives.diagnosticShape.includes('longTasks'));
  const internalTabs = ['dashboard', 'accounts', 'characters', 'items', 'scripts', 'data', 'world-design', 'spawners',
    'ai-graphs', 'simulators', 'animations', 'platform', 'operations', 'logs', 'world'];
  for (const tab of internalTabs) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(125);
    assert.ok((await page.locator('#main').innerText()).trim().length > 0, `admin tab ${tab} rendered empty`);
    if (tab === 'spawners') {
      assert.equal(await page.locator('#sp-bulk-dx').count(), 1, 'spawner bulk tools missing');
      assert.ok(await page.locator('button', { hasText: 'Vendor' }).count(), 'spawner templates missing');
    }
    if (tab === 'operations') {
      for (const id of ['ops-runtime','ops-network','ops-ai','ops-intelligence','ops-storage','ops-alerts','ops-health','ops-backups','ops-migrations','ops-flags','ops-nodeuo-delivery','ops-nodeuo-theme','ops-tests','ops-budgets'])
        assert.equal(await page.locator(`#${id}`).count(), 1, `operations section ${id} missing`);
    }
    if (tab === 'platform') {
      for (const id of ['pf-cases', 'pf-preview-resources', 'pf-approvals', 'pf-contracts', 'pf-live-events', 'pf-incidents'])
        assert.equal(await page.locator(`#${id}`).count(), 1, `platform section ${id} missing`);
    }
    await auditAccessibility(`admin:${tab}`);
  }
  await Promise.all([
    page.waitForURL(`${base}/docs`),
    page.click('[data-tab="docs"]'),
  ]);
  await page.waitForSelector('#article h1');
  assert.match(await page.locator('#article').innerText(), /NodeUO Scriptbook/i);
  assert.ok(await page.locator('#page-nav [data-page]').count() >= 6, 'scripting documentation navigation incomplete');
  await page.fill('#search', 'client-gumps.json');
  await page.waitForSelector('#search-results [data-result-page]');
  assert.ok(await page.locator('#search-results [data-result-page]').count(), 'documentation full-text search returned no result');
  await page.keyboard.press('Escape');
  await auditAccessibility('admin:docs');
  await page.goto(`${base}/script-studio`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-type="ai"]');
  assert.equal(await page.locator('[data-type]').count(), 7, 'Script Studio type catalog incomplete');
  await page.click('[data-type="ai"]');
  await page.fill('#id', 'browser-audit-ai');
  await page.click('#generate');
  await page.waitForFunction(() => document.querySelector('#source')?.value.includes('registerBehavior'));
  assert.match(await page.locator('#path').innerText(), /authored\/ai\/browser-audit-ai\.js/);
  await auditAccessibility('admin:script-studio');
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav#tabs');
  // Content Studio is a full-screen top-level workbench. Keeping it out of an
  // iframe removes the X-Frame-Options/CSP failure mode and gives its dense
  // three-column editor the complete viewport.
  await Promise.all([
    page.waitForURL(`${base}/studio`),
    page.click('[data-tab="studio"]'),
  ]);
  await page.waitForSelector('[data-domain="items"]');
  assert.equal(await page.locator('a[href="/"]', { hasText: 'Admin' }).count(), 1, 'studio return-to-admin link missing');
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav#tabs');

  // Exercise the two compact editors that remain embedded in the shell.
  for (const embedded of [
    { tab: 'data-editor', selector: '#file-tree' },
    { tab: 'isoeditor', selector: '#cv' },
  ]) {
    await page.click(`[data-tab="${embedded.tab}"]`);
    const iframe = page.locator('#main iframe');
    await iframe.waitFor({ state: 'visible' });
    await page.frameLocator('#main iframe').locator(embedded.selector).waitFor({ state: 'attached', timeout: 12_000 });
    const frameUrl = await iframe.getAttribute('src');
    assert.ok(frameUrl?.startsWith('/'), `embedded ${embedded.tab} has invalid src ${frameUrl}`);
  }
  // A stale admin document can remain visible after its Node process exits.
  // Verify that the workbench wrapper replaces Chromium's opaque refused-page
  // iframe with an actionable offline state and that Retry mounts the editor
  // again once the health probe recovers.
  await page.evaluate(() => {
    window.__adminE2EFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url === '/healthz') return Promise.reject(new TypeError('simulated admin backend outage'));
      return window.__adminE2EFetch(input, init);
    };
    globalThis.activate('isoeditor');
  });
  await page.locator('[data-embedded-offline]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-embedded-offline]').innerText(), /Server \+ Admin/i);
  await page.evaluate(() => { window.fetch = window.__adminE2EFetch; });
  await page.click('[data-embedded-retry]');
  await page.frameLocator('#main iframe').locator('#cv').waitFor({ state: 'attached', timeout: 12_000 });
  await page.evaluate(() => {
    window.__adminE2EFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url === '/data-editor') {
        return Promise.resolve(new Response('<!doctype html><title>stale data editor</title>', {
          status: 200,
          headers: {
            'content-type': 'text/html',
            'x-frame-options': 'DENY',
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
          },
        }));
      }
      return window.__adminE2EFetch(input, init);
    };
    globalThis.activate('data-editor');
  });
  await page.locator('[data-embedded-offline]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-embedded-offline]').innerText(), /old non-embeddable security policy/i);
  await page.evaluate(() => { window.fetch = window.__adminE2EFetch; });
  await page.click('[data-embedded-retry]');
  await page.frameLocator('#main iframe').locator('#file-tree').waitFor({ state: 'attached', timeout: 12_000 });
  await page.evaluate(() => {
    window.__adminE2EFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url === '/healthz') return Promise.reject(new TypeError('simulated post-mount outage'));
      return window.__adminE2EFetch(input, init);
    };
  });
  await page.locator('[data-embedded-offline]').waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await page.locator('[data-embedded-offline]').innerText(), /stopped while this editor was open/i);
  await page.evaluate(() => { window.fetch = window.__adminE2EFetch; });
  await page.goto(`${base}/studio?domain=items`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-domain="items"]');
  await page.waitForSelector('[data-record]', { timeout: 12_000 }).catch(async (error) => {
    const status = await page.locator('#status').innerText().catch(() => '(missing status)');
    const editor = await page.locator('#editor').innerText().catch(() => '(missing editor)');
    throw new Error(`studio records did not render; status=${status}; editor=${editor}; pageErrors=${pageErrors.join(' | ')}; ${error.message}`);
  });
  const studio = await page.evaluate(() => ({
    domains: document.querySelectorAll('[data-domain]').length,
    records: document.querySelectorAll('[data-record]').length,
    editorFields: document.querySelectorAll('[data-field]').length,
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.ok(studio.domains >= 15, `studio domains ${studio.domains}`);
  assert.ok(studio.records > 0, 'studio item catalogue rendered empty');
  assert.ok(studio.editorFields > 0, 'studio item editor rendered no fields');
  assert.equal(await page.locator('.domain-workbench').count(), 1, 'studio domain workbench missing');
  assert.equal(await page.locator('[data-special-editor="item"]').count(), 1, 'specialized item workbench missing');
  assert.ok(await page.locator('[data-special-editor="item"] [data-quick-path="definitionId"]').count(), 'item identity editor missing');
  assert.ok(await page.locator('[data-open-bound-script="item"]').count(), 'item script editor action missing');
  assert.ok(studio.overflow <= 2, `studio horizontal overflow ${studio.overflow}px`);
  // Regression: renderState() used to replace the records host while the
  // cached VirtualList kept rendering into its detached viewport. The first
  // domain loaded, every later domain/file remained on "Loading records…".
  for (const domain of ['items', 'spells', 'crafting', 'mobiles']) {
    await page.click(`[data-domain="${domain}"]`);
    await page.waitForFunction((id) => {
      const active = document.querySelector(`[data-domain="${id}"]`)?.classList.contains('active');
      const records = document.querySelector('#records');
      return active && !records?.textContent?.includes('Loading records')
        && records?.querySelectorAll('[data-record]').length > 0;
    }, domain, { timeout: 12_000 });
    assert.ok(await page.locator('#records [data-record]').count(), `studio ${domain} rendered no records after switch`);
    if (domain === 'spells') {
      assert.equal(await page.locator('[data-special-editor="spell"]').count(), 1, 'specialized spell workbench missing');
      assert.ok(await page.locator('[data-open-bound-script="spell"]').count(), 'bound spell script action missing');
      assert.ok(await page.locator('[data-open-script-picker="spell"]').count(), 'spell script catalogue action missing');
      await page.click('[data-open-script-picker="spell"]');
      await page.waitForSelector('.modal-bg [data-script-choice]');
      assert.ok(await page.locator('.modal-bg [data-script-choice] option').count(), 'spell script catalogue rendered empty');
      await page.click('.modal-bg [data-close]');
    }
  }
  const sourceOptions = await page.locator('#source option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(sourceOptions.length >= 2, 'mobiles studio domain should expose multiple source files');
  await page.selectOption('#source', sourceOptions[1]);
  await page.waitForFunction((file) => {
    const records = document.querySelector('#records');
    return document.querySelector('#source')?.value === file
      && !records?.textContent?.includes('Loading records')
      && records?.querySelectorAll('[data-record]').length > 0;
  }, sourceOptions[1], { timeout: 12_000 });
  // Deliberately overlap changes: only the last selection may commit.
  await page.evaluate(() => {
    document.querySelector('[data-domain="items"]')?.click();
    document.querySelector('[data-domain="spells"]')?.click();
    document.querySelector('[data-domain="mobiles"]')?.click();
  });
  await page.waitForFunction(() => {
    const records = document.querySelector('#records');
    return document.querySelector('[data-domain="mobiles"]')?.classList.contains('active')
      && !records?.textContent?.includes('Loading records')
      && records?.querySelectorAll('[data-record]').length > 0;
  }, null, { timeout: 12_000 });
  assert.equal(await page.locator('[data-special-editor="mobile"]').count(), 1, 'specialized mobile workbench missing');
  assert.ok(await page.locator('[data-special-editor="mobile"] [data-quick-path="ai"]').count(), 'mobile AI binding editor missing');
  await page.click('[data-special-editor="mobile"] [data-visual-picker="body"]');
  await page.waitForSelector('.asset-picker-grid [data-asset-id]', { timeout: 12_000 });
  assert.ok(await page.locator('.asset-picker-grid [data-asset-id]').count(), 'visual mobile body picker rendered empty');
  await page.click('.modal-bg [data-close]');
  await page.click('[data-open-script-picker="ai"]');
  await page.waitForSelector('.modal-bg [data-script-choice]');
  assert.ok(await page.locator('.modal-bg [data-script-choice] option').count(), 'AI script catalogue rendered empty');
  await page.click('.modal-bg [data-close]');

  await page.click('[data-domain="gumps"]');
  await page.waitForFunction(() => {
    const records = document.querySelector('#records');
    return document.querySelector('[data-domain="gumps"]')?.classList.contains('active')
      && !records?.textContent?.includes('Loading records')
      && records?.querySelectorAll('[data-record]').length > 0;
  }, null, { timeout: 12_000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent,
      records: document.querySelector('#records')?.textContent?.slice(0, 500),
      source: document.querySelector('#source')?.value,
      active: document.querySelector('.domain.active')?.dataset?.domain,
      broker: globalThis.AdminCore?.requestBroker?.snapshot?.(),
    }));
    console.error('[audit:admin] gump switch diagnostics', { state, pageErrors, consoleErrors, serverErrors });
    throw error;
  });
  assert.equal(await page.locator('[data-special-editor="gump"]').count(), 1, 'visual gump designer missing');
  assert.equal(await page.locator('[data-gump-stage]').count(), 1, 'gump design canvas missing');
  assert.ok(await page.locator('[data-gump-control]').count(), 'gump definition rendered no visual controls');
  assert.ok(await page.locator('[data-add-control="button"]').count(), 'gump control palette missing');
  assert.ok(await page.locator('[data-control-field="x"]').count(), 'gump control inspector missing');
  assert.ok(await page.locator('[data-visual-picker="gump"]').count(), 'visual gump art picker missing');
  await page.click('[data-browse-client-gumps]');
  await page.waitForSelector('[data-client-gump]');
  assert.ok(await page.locator('[data-client-gump]').count(), 'built-in client gump source catalogue rendered empty');
  await page.click('.modal-bg [data-close]');
  const gumpSources = await page.locator('#source option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(gumpSources.includes('@client/client-gumps.json'), 'bundled client gump JSON source missing');
  await page.selectOption('#source', '@client/client-gumps.json');
  await page.waitForFunction(() => {
    const records = document.querySelector('#records');
    return document.querySelector('#source')?.value === '@client/client-gumps.json'
      && !records?.textContent?.includes('Loading records')
      && records?.querySelectorAll('[data-record]').length > 0;
  }, null, { timeout: 12_000 });
  assert.equal(await page.locator('[data-special-editor="client-gump"]').count(), 1, 'bundled client gump override editor missing');
  assert.ok(await page.locator('[data-open-client-gump-source]').count(), 'client gump source editor action missing');
  assert.ok(await page.locator('[data-add-client-control]').count(), 'client gump control override action missing');
  await page.fill('#filter', 'Npc Dialog');
  await page.waitForFunction(() => document.querySelectorAll('#records [data-record]').length === 1);
  await page.click('#records [data-record]');
  await page.waitForFunction(() => document.querySelector('[data-special-editor="client-gump"]')?.textContent?.includes('action-24'));
  assert.equal(await page.locator('.client-control-override').count(), 35, 'NPC dialog stable control catalogue is incomplete');
  assert.equal(await page.locator('[data-quick-path="source"]').inputValue(), 'npc-dialog-gump.js');
  const clientGumpLayout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    inspectorColumns: window.getComputedStyle(
      document.querySelector('.gump-inspector .gump-control-fields') ?? document.body,
    ).gridTemplateColumns,
  }));
  assert.ok(clientGumpLayout.overflow <= 2, `client gump editor horizontal overflow ${clientGumpLayout.overflow}px`);
  await auditAccessibility('studio:domain-switching');
  await page.goto(`${base}/data-editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#file-tree');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#btn-save').count(), 1, 'data editor save workflow missing');
  await auditAccessibility('editor:data-tree');
  await page.goto(`${base}/editor`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#cv');
  await page.waitForFunction(() => document.querySelector('#map-perf')?.textContent?.includes('ms'), null, { timeout: 12_000 });
  const editor = await page.evaluate(() => ({
    canvas: !!document.querySelector('#cv'),
    palette: !!document.querySelector('#palette'),
    spawnerButton: !!document.querySelector('#add-spawner'),
    layers: document.querySelectorAll('[data-opacity]').length,
    regions: !!document.querySelector('#show-regions'),
    paletteMemory: !!document.querySelector('#palette-memory'),
    hueVariants: document.querySelectorAll('#brush-hue-preset option').length,
    patchIo: !!document.querySelector('#patch-file'),
    workerMetrics: document.querySelector('#map-perf')?.textContent ?? '',
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  assert.equal(editor.canvas, true);
  assert.equal(editor.palette, true);
  assert.equal(editor.layers, 7, 'iso editor does not expose all map layer opacities');
  assert.equal(editor.regions, true);
  assert.equal(editor.paletteMemory, true);
  assert.ok(editor.hueVariants >= 8, 'iso editor hue variants are missing');
  assert.equal(editor.patchIo, true);
  assert.match(editor.workerMetrics, /ms/, 'iso editor worker timing is missing');
  assert.ok(editor.overflow <= 2, `iso editor horizontal overflow ${editor.overflow}px`);
  const history = await page.evaluate(() => {
    ed.pendingAdds = [];
    ed.undoStack = []; ed.redoStack = [];
    ed.recordHistory();
    ed.pendingAdds.push({ _id: 1, x: 10, y: 20, z: 0, itemId: 1, hue: 0 });
    ed.undoPending();
    const afterUndo = ed.pendingAdds.length;
    ed.redoPending();
    return { afterUndo, afterRedo: ed.pendingAdds.length };
  });
  assert.deepEqual(history, { afterUndo: 0, afterRedo: 1 });
  await auditAccessibility('editor:iso');
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(100);
  const tabletOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(tabletOverflow <= 2, `iso editor tablet overflow ${tabletOverflow}px`);
  assert.deepEqual(pageErrors, [], `admin page errors: ${pageErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `admin console errors: ${consoleErrors.join('\n')}`);
  assert.deepEqual(serverErrors, [], `admin HTTP 5xx responses: ${serverErrors.join('\n')}`);
} finally {
  await context.close();
  await browser.close();
  await new Promise((ok) => server.close(ok));
  rmSync(saveDir, { recursive: true, force: true });
}

console.log('[audit:admin-browser-e2e] ok tabs=15 editors=studio,data-tree,iso a11y=clean');
