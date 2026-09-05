import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { extractServUOBosses } from '../servuo-bosses.js';
import { extractServUOFunctional } from '../servuo-functional.js';
import { extractServUOItems } from '../servuo-items.js';
import { extractServUOMonsters } from '../servuo-monsters.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const SERVUO = join(ROOT, 'templates', 'ServUO');
const DATA = join(ROOT, 'apps', 'scripts', 'src', 'data');

test('direct ServUO importers publish canonical config schemas', async (t) => {
  if (!existsSync(SERVUO)) return t.skip('ServUO source tree is not installed');
  const root = mkdtempSync(join(tmpdir(), 'nodeuo-extractor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, 'data', 'config');
  mkdirSync(config, { recursive: true });
  cpSync(join(DATA, 'config', 'items.json'), join(config, 'items.json'));
  cpSync(join(DATA, 'config', 'monsters.json'), join(config, 'monsters.json'));

  await extractServUOBosses(SERVUO, root);
  await extractServUOMonsters(SERVUO, root);
  await extractServUOFunctional(SERVUO, root);
  await extractServUOItems(SERVUO, root);

  assert.equal(existsSync(join(root, 'data', 'items.json')), false);
  assert.equal(existsSync(join(root, 'data', 'monsters.json')), false);
  const items = JSON.parse(readFileSync(join(config, 'items.json'), 'utf8'));
  const monsters = JSON.parse(readFileSync(join(config, 'monsters.json'), 'utf8'));
  assert.ok(items.length >= 500);
  assert.ok(monsters.length >= 800);
  for (const item of items) {
    assert.ok(String(item.definitionId ?? item.id ?? item.name).trim());
    assert.ok(Number.isInteger(item.artId ?? item.itemId));
  }
  assert.equal(new Set(monsters.map((monster) => monster.kind)).size, monsters.length);
  for (const monster of monsters) {
    assert.match(monster.kind, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('standalone ServUO importers target the canonical data tree', () => {
  const expected = new Map([
    ['decoration.js', ['data/world/decorations.json', 'data/world/signs.json', 'data/world/teleporters.json']],
    ['xmlspawner.js', ['data/world/xmlspawners.json']],
    ['servuo-artifacts.js', ["'data', 'world', 'artifacts.json'"]],
    ['servuo-quests.js', ["'data', 'world', 'quests-extracted.json'"]],
    ['servuo-recipes.js', ["'data', 'config', 'recipes.json'"]],
    ['servuo-magic-gen.js', ["'data', 'config', 'magic-properties.json'"]],
  ]);
  for (const [file, paths] of expected) {
    const source = readFileSync(resolve(HERE, '..', file), 'utf8').replaceAll('\\', '/');
    for (const path of paths) assert.ok(source.includes(path), `${file} must target ${path}`);
  }
});
