import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../apps/client/node_modules/playwright/index.mjs';
import { startAdminServer } from '../../apps/server/src/admin/admin-server.js';
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
const server = startAdminServer({
  port: 0, host: '127.0.0.1', accounts, sharedCtx: { world },
  scriptsDir: join(ROOT, 'apps/scripts/src'), saveDir,
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
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
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
    'ai-graphs', 'simulators', 'animations', 'operations', 'logs', 'world'];
  for (const tab of internalTabs) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(125);
    assert.ok((await page.locator('#main').innerText()).trim().length > 0, `admin tab ${tab} rendered empty`);
    if (tab === 'spawners') {
      assert.equal(await page.locator('#sp-bulk-dx').count(), 1, 'spawner bulk tools missing');
      assert.ok(await page.locator('button', { hasText: 'Vendor' }).count(), 'spawner templates missing');
    }
    if (tab === 'operations') {
      for (const id of ['ops-runtime','ops-network','ops-ai','ops-storage','ops-alerts','ops-health','ops-backups','ops-migrations','ops-flags','ops-tests','ops-budgets'])
        assert.equal(await page.locator(`#${id}`).count(), 1, `operations section ${id} missing`);
    }
    await auditAccessibility(`admin:${tab}`);
  }
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
  assert.ok(studio.overflow <= 2, `studio horizontal overflow ${studio.overflow}px`);
  await auditAccessibility('studio:items');
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

console.log('[audit:admin-browser-e2e] ok tabs=14 editors=studio,data-tree,iso a11y=clean');
