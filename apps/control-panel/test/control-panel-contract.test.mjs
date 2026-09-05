import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, '..');
const ROOT = resolve(APP, '..', '..');
const renderer = readFileSync(resolve(APP, 'src', 'renderer.html'), 'utf8');
const main = readFileSync(resolve(APP, 'src', 'main.cjs'), 'utf8');
const preload = readFileSync(resolve(APP, 'src', 'preload.cjs'), 'utf8');
const extractor = readFileSync(resolve(ROOT, 'packages', 'extractor', 'extract.js'), 'utf8');

function stringArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  assert.ok(match, `${name} must remain a literal array so the launcher contract is auditable`);
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

test('renderer script is syntactically valid', () => {
  const scripts = [...renderer.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0][1]));
});

test('control panel exposes every importer supported by the orchestrator', () => {
  const defaultSteps = stringArray(extractor, 'DEFAULT_STEPS');
  const optionalSteps = stringArray(extractor, 'OPTIONAL_SERVUO_REFRESH');
  const uiAssets = stringArray(renderer, 'EXTRACT_ASSET_STEPS');
  const uiServuo = stringArray(renderer, 'EXTRACT_SERVUO_STEPS');
  const dispatched = [...extractor.matchAll(/only\.has\(['"]([^'"]+)['"]\)/g)].map((entry) => entry[1]);
  const checkboxes = [...renderer.matchAll(/<input[^>]+data-extract-step="([^"]+)"/g)].map((entry) => entry[1]);

  assert.deepEqual(sortedUnique(uiAssets), sortedUnique(defaultSteps));
  assert.deepEqual(sortedUnique(uiServuo), sortedUnique(optionalSteps));
  assert.deepEqual(sortedUnique(checkboxes), sortedUnique(uiAssets));
  assert.deepEqual(
    sortedUnique(dispatched),
    sortedUnique([...defaultSteps, ...optionalSteps, 'ktx2']),
  );
});

test('every renderer IPC request is bridged and handled', () => {
  const rendererMethods = [...preload.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
  const handlers = [...main.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map((entry) => entry[1]);
  assert.deepEqual(sortedUnique(rendererMethods), sortedUnique(handlers));
});

test('panel retains its operational surfaces and secure Electron boundary', () => {
  for (const id of ['toolbar', 'tabs', 'pane', 'settings-bar', 'extract-scope', 'modal-host']) {
    assert.match(renderer, new RegExp(`id=["']${id}["']`));
  }
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /nodeIntegration:\s*true/);
  assert.match(main, /UO_CONTROL_PANEL_SMOKE/);
});
