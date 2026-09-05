import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAllItemScripts } from '../../scripts/src/items/scripts/index.js';
import { registerItem } from '../src/content/items/registry.js';
import {
  createItem,
  rehydrateWorldItemDefinitions,
} from '../src/world/items.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';
import { World } from '../src/world/world.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsRoot = path.resolve(here, '..', '..', 'scripts', 'src');
const definitionsRoot = path.join(scriptsRoot, 'items', 'definitions');
const itemScriptsRoot = path.join(scriptsRoot, 'items', 'scripts');

// These scripts intentionally live in top-level runtime modules because they
// need their owning engine system during registration. Everything under
// items/scripts belongs to the canonical manifest tested below.
const EXTERNAL_ITEM_SCRIPTS = new Set([
  'ancient-wall', 'anniversary-22-token', 'anniversary-card',
  'bulk-order-deed', 'copper-anniversary-deco', 'enchanted-timepiece',
  'house-deed', 'sa-quest-blocker', 'servuo-boat-deed', 'shrine', 'tinker-trap',
]);

function jsFiles(root, { skipShared = false } = {}) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (skipShared && entry.name === '_shared') continue;
      out.push(...jsFiles(full, { skipShared }));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

async function collectDefinitions() {
  const definitions = [];
  const logs = [];
  for (const file of jsFiles(definitionsRoot)) {
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.default !== 'function') continue;
    mod.default({
      catalog: { items: { registerItem: (definition) => definitions.push({ ...definition, __file: file }) } },
      npcs: { register() {} },
      log: (message) => logs.push(String(message)),
    });
  }
  return { definitions, logs };
}

describe('global item content contract', () => {
  it('imports every item script file through the canonical manifest', () => {
    const manifest = fs.readFileSync(path.join(itemScriptsRoot, 'index.js'), 'utf8').replace(/\\/g, '/');
    const omitted = jsFiles(itemScriptsRoot, { skipShared: true })
      .filter((file) => path.basename(file) !== 'index.js')
      .map((file) => `./${path.relative(itemScriptsRoot, file).replace(/\\/g, '/')}`)
      .filter((relative) => !manifest.includes(relative));
    expect(omitted).toEqual([]);
  });

  it('resolves every scripted item definition to a registered runtime script', async () => {
    const registered = [];
    const failures = [];
    const names = registerAllItemScripts({
      itemScripts: { register: (script) => registered.push(script) },
      commands: { register() {}, unregister() {} },
      log: (message) => {
        if (/failed/i.test(String(message))) failures.push(String(message));
      },
    });
    const { definitions } = await collectDefinitions();
    definitions.push(...JSON.parse(fs.readFileSync(path.join(scriptsRoot, 'data', 'config', 'items.json'), 'utf8')));
    const available = new Set([...names, ...EXTERNAL_ITEM_SCRIPTS]);
    const missing = [...new Set(definitions.map((definition) => definition.script).filter(Boolean))]
      .filter((name) => !available.has(name))
      .sort();

    expect(failures).toEqual([]);
    expect(new Set(names).size).toBe(names.length);
    expect(registered.map((script) => script.name)).toEqual(names);
    expect(missing).toEqual([]);
  });

  it('resolves literal item-script references across gameplay source files', () => {
    const names = registerAllItemScripts({
      commands: { register() {}, unregister() {} },
      log() {},
    });
    const available = new Set([...names, ...EXTERNAL_ITEM_SCRIPTS]);
    const references = new Map();
    const literalScript = /\bscript\s*:\s*['"]([^'"]+)['"]/g;
    for (const file of jsFiles(scriptsRoot)) {
      const relative = path.relative(scriptsRoot, file).replace(/\\/g, '/');
      if (relative.startsWith('spells/')) continue; // Spell effect-module paths use the same data key.
      const source = fs.readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const match of source.matchAll(literalScript)) {
        const name = match[1];
        const sites = references.get(name) ?? [];
        sites.push(relative);
        references.set(name, sites);
      }
    }
    // NPC loot descriptors use `script` for a mobile behavior selector, not
    // the item lifecycle registry audited here.
    references.delete('stained-ooze');
    const missing = [...references]
      .filter(([name]) => !available.has(name))
      .map(([name, sites]) => ({ name, sites: [...new Set(sites)] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(missing).toEqual([]);
  });

  it('preserves and clones new definition/factory fields without an engine whitelist edit', () => {
    const definition = registerItem({
      definitionId: 'contract-dynamic-item',
      artId: 0x14F0,
      name: 'contract dynamic item',
      script: 'power-hour-scroll',
      farm: { kind: 'wheat', mature: false },
      customDefinitionPayload: { rank: 7, flags: ['a', 'b'] },
    });
    const world = new World();
    const item = createItem(world, {
      definitionId: definition.definitionId,
      x: 10, y: 20, z: 0, map: 1,
      customFactoryPayload: { source: 'reward', amount: 3 },
    });

    expect(item).toMatchObject({
      script: 'power-hour-scroll',
      farm: { kind: 'wheat', mature: false },
      customDefinitionPayload: { rank: 7, flags: ['a', 'b'] },
      customFactoryPayload: { source: 'reward', amount: 3 },
    });
    expect(item.farm).not.toBe(definition.farm);
    expect(item.customDefinitionPayload).not.toBe(definition.customDefinitionPayload);

    item.farm.mature = true;
    expect(definition.farm.mature).toBe(false);

    const restoredWorld = new World();
    restoreWorld(restoredWorld, JSON.parse(JSON.stringify(snapshotWorld(world))));
    expect(restoredWorld.items.get(item.serial)).toMatchObject({
      script: 'power-hour-scroll',
      farm: { kind: 'wheat', mature: true },
      customDefinitionPayload: { rank: 7, flags: ['a', 'b'] },
      customFactoryPayload: { source: 'reward', amount: 3 },
    });
  });

  it('rehydrates old stable-identity items before players can use them', () => {
    registerItem({
      definitionId: 'contract-legacy-item',
      artId: 0x14F0,
      name: 'legacy contract item',
      script: 'power-hour-scroll',
      powerHour: true,
      customDefinitionPayload: { repaired: true },
    });
    const world = new World();
    const legacy = {
      serial: 0x4000F001,
      definitionId: 'contract-legacy-item',
      itemId: 0x14F0,
      artId: 0x14F0,
      x: 0, y: 0, z: 0, map: 1,
    };
    world.items.set(legacy.serial, legacy);

    expect(rehydrateWorldItemDefinitions(world)).toEqual({ items: 1, fields: 4, scripts: 1 });
    expect(legacy).toMatchObject({
      name: 'legacy contract item',
      script: 'power-hour-scroll',
      powerHour: true,
      customDefinitionPayload: { repaired: true },
    });
  });

  it('migrates persisted base art, worn layer and zero gumps by stable identity', () => {
    registerItem({
      definitionId: 'contract-katana-v2', artId: 0x13FF, name: 'a katana', script: null,
      clothing: true, equipLayer: 1,
      paperdollGumpId: 50627, paperdollMaleGumpId: 50627, paperdollFemaleGumpId: 50627,
    });
    const world = new World();
    const owner = { serial: 0x100, name: 'Owner' };
    const legacy = {
      serial: 0x4000F002, definitionId: 'contract-katana-v2',
      artId: 0x13FE, itemId: 0x13FE, parent: owner.serial, layer: 13,
      paperdollGumpId: 0, paperdollMaleGumpId: 0, paperdollFemaleGumpId: 0,
      x: 0, y: 0, z: 0, map: 1,
    };
    world.mobiles.set(owner.serial, owner);
    world.items.set(legacy.serial, legacy);

    expect(rehydrateWorldItemDefinitions(world).fields).toBeGreaterThan(0);
    expect(legacy).toMatchObject({
      artId: 0x13FF, itemId: 0x13FF, layer: 1,
      paperdollGumpId: 50627, paperdollMaleGumpId: 50627, paperdollFemaleGumpId: 50627,
    });
  });
});
