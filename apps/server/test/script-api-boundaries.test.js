import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, '..', '..', 'scripts', 'src');

const ALLOW_PRIVATE_PARENT_INDEX = new Set([
  '_inventory.js',
]);
const ALLOW_RAW_WORLD_ENTITY_MAP_ACCESS = new Set([
  '_entities.js',
  '_inventory.js',
  '_items.js',
  '_mobiles.js',
  '_spatial.js',
]);
const ALLOW_SCRIPT_ITEM_CREATE_FACADE = new Set([
  '_items.js',
]);
const ALLOW_SCRIPT_ITEM_DESTROY_FACADE = new Set([
  '_items.js',
]);
const ALLOW_SCRIPT_MOBILE_LIFECYCLE_FACADE = new Set([
  '_mobiles.js',
]);
const ALLOW_SCRIPT_MOVEMENT_FACADE = new Set([
  '_movement.js',
]);

function collectJs(dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) collectJs(full, out);
    else if (st.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function rel(file) {
  return path.relative(scriptsDir, file).replaceAll(path.sep, '/');
}

// The policy suite applies several independent rules to the same immutable
// source generation. Scan and strip once so the test cost stays O(files), not
// O(rules × files), which also avoids slow-disk flakes on Windows CI.
const scriptFiles = collectJs(scriptsDir);
const strippedSources = new Map(scriptFiles.map((file) => [file,
  stripComments(fs.readFileSync(file, 'utf8'))]));
function sourceOf(file) { return strippedSources.get(file); }

describe('script API boundaries', () => {
  it('does not import server world internals directly from scripts', () => {
    const offenders = [];
    const directWorldImport = /\bfrom\s+['"][^'"]*server\/src\/world\/[^'"]*['"]/;
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (directWorldImport.test(source.replaceAll('\\', '/'))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps gameplay scripts behind the runtime ScriptAPI instead of direct server imports', () => {
    const offenders = [];
    const directServerImport = /\bfrom\s+['"][^'"]*server\/src\/[^'"]*['"]|\bimport\s*\(\s*['"][^'"]*server\/src\/[^'"]*['"]\s*\)/;
    const directServerRuntimePath = /['"][^'"]*server\/src\/[^'"]*['"]/;
    for (const file of scriptFiles) {
      const source = sourceOf(file).replaceAll('\\', '/');
      if (directServerImport.test(source) || directServerRuntimePath.test(source)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps shared rule helpers behind the script-side rules facade', () => {
    const offenders = [];
    const directRulesImport = /\bfrom\s+['"][^'"]*server\/src\/combat-formulas\.js['"]/;
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (directRulesImport.test(source.replaceAll('\\', '/'))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it('keeps visibility fanout behind script-side spatial helpers', () => {
    const offenders = [];
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (/server\/src\/world\/visibility\.js|server\\src\\world\\visibility\.js/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps world item lifecycle calls behind script-side item helpers', () => {
    const offenders = [];
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (/server\/src\/world\/items\.js|server\\src\\world\\items\.js/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps world movement internals behind script-side movement helpers', () => {
    const offenders = [];
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (/server\/src\/world\/movement\.js|server\\src\\world\\movement\.js/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps item-script registry access behind api.itemScripts', () => {
    const offenders = [];
    for (const file of scriptFiles) {
      const source = sourceOf(file);
      if (/server\/src\/world\/item-scripts\.js|server\\src\\world\\item-scripts\.js/.test(source)) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes script item destruction through the script-side item facade', () => {
    const offenders = [];
    const directDestroy = /\b(?:api|apiOrWorld)\??\.items\??\.(?:destroyItem|removeItem)\b|\bitems\.(?:destroyItem|removeItem)\??\.|\b(?:api\.world|world)\??\.destroyItem\b|\b(?:api\.world|world)\??\.(?:items)\??\.delete\??\.?\s*\(/;
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_SCRIPT_ITEM_DESTROY_FACADE.has(relative)) continue;
      const source = sourceOf(file);
      if (directDestroy.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('routes script item creation through the script-side item facade', () => {
    const offenders = [];
    const directCreate = /\b(?:api|apiOrWorld)\??\.items\??\.createItem\b|\bitems\.createItem\??\.|\b(?:api\.world|world)\??\.createItem\b/;
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_SCRIPT_ITEM_CREATE_FACADE.has(relative)) continue;
      const source = sourceOf(file);
      if (directCreate.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('routes script mobile creation and destruction through the script-side mobile facade', () => {
    const offenders = [];
    const directMobileLifecycle = /\b(?:api\.world|world)\??\.(?:createMobile|destroyMobile)\b|\b(?:api\.world|world)\??\.mobiles\??\.(?:delete|set|clear)\??\.?\s*\(/;
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_SCRIPT_MOBILE_LIFECYCLE_FACADE.has(relative)) continue;
      const source = sourceOf(file);
      if (directMobileLifecycle.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('routes script item reparenting through the script-side movement facade', () => {
    const offenders = [];
    const directReparent = /\b(?:api|apiOrWorld)\??\.items\??\.setItemParent\b|\bitems\.setItemParent\??\.|\.\s*parent\s*=(?!=)/;
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_SCRIPT_MOVEMENT_FACADE.has(relative)) continue;
      const source = sourceOf(file);
      if (directReparent.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the private parent index inside inventory compatibility helpers', () => {
    const offenders = [];
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_PRIVATE_PARENT_INDEX.has(relative)) continue;
      const source = sourceOf(file);
      if (source.includes('_childrenByParent')) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps raw world entity map access behind script-side helpers', () => {
    const offenders = [];
    const rawMapAccess = /\b(?:api\.world|ctx\.world|world)\??\.(?:items|mobiles)\b/;
    for (const file of scriptFiles) {
      const relative = rel(file);
      if (ALLOW_RAW_WORLD_ENTITY_MAP_ACCESS.has(relative)) continue;
      const source = sourceOf(file);
      if (rawMapAccess.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
