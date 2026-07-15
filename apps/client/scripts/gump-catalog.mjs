import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const gumpRoot = join(appRoot, 'src', 'ui', 'gumps');
const files = readdirSync(gumpRoot)
  .filter((name) => name.endsWith('-gump.js'))
  .sort((a, b) => a.localeCompare(b));

function matches(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]).filter(Boolean);
}

function stateHints(source) {
  const states = ['default'];
  for (const state of ['loading', 'empty', 'error', 'selected', 'disabled', 'expanded', 'compact']) {
    if (new RegExp(`\\b${state}\\b`, 'i').test(source)) states.push(state);
  }
  return states;
}

const catalog = files.map((file) => {
  const absolute = join(gumpRoot, file);
  const source = readFileSync(absolute, 'utf8');
  const classes = matches(source, /export\s+class\s+(\w+)/g);
  const types = matches(source, /get\s+type\s*\(\)\s*\{\s*return\s+['"`]([^'"`]+)/g);
  const size = /(?:super|setSize)\s*\(\s*(?:\{[\s\S]{0,180}?width:\s*)?(\d+)[\s,]+(?:height:\s*)?(\d+)/.exec(source);
  return {
    id: basename(file, '.js'),
    module: `src/ui/gumps/${file}`,
    exports: classes,
    types,
    preview: {
      states: stateHints(source),
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : null,
    },
    sourceBytes: Buffer.byteLength(source),
  };
});

const failures = [];
if (catalog.length < 90) failures.push(`expected at least 90 gump modules, found ${catalog.length}`);
for (const entry of catalog) {
  if (!entry.id || !entry.module) failures.push('catalog entry lacks a stable id/module');
  if (entry.sourceBytes > 512 * 1024) failures.push(`${entry.module} exceeds the 512 KiB source budget`);
  if (!entry.preview.states.includes('default')) failures.push(`${entry.module} lacks a default preview state`);
}
if (new Set(catalog.map((entry) => entry.id)).size !== catalog.length) failures.push('duplicate gump catalogue ids');

if (process.argv.includes('--write')) {
  const output = join(appRoot, '.generated', 'gump-catalog.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), count: catalog.length, gumps: catalog }, null, 2)}\n`);
  console.log(`[gump-catalog] wrote ${relative(appRoot, output)}`);
}

if (failures.length) {
  for (const failure of failures) console.error(`[gump-catalog] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[gump-catalog] ok — ${catalog.length} modules, ${catalog.reduce((sum, entry) => sum + entry.exports.length, 0)} exported classes`);
}

export { catalog };
