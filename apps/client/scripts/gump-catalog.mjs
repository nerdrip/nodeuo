import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const gumpRoot = join(appRoot, 'src', 'ui', 'gumps');
const files = readdirSync(gumpRoot)
  .filter((name) => name.endsWith('-gump.js'))
  .sort((a, b) => a.localeCompare(b));
const allSourceFiles = readdirSync(gumpRoot)
  .filter((name) => name.endsWith('.js'))
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

function kebab(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function humanize(value) {
  return String(value).replace(/Gump$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
}

function sizeHint(source) {
  const match = /(?:super|setSize)\s*\(\s*(?:\{[\s\S]{0,220}?width:\s*)?(\d+)[\s,]+(?:height:\s*)?(\d+)/.exec(source);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 320, height: 240 };
}

// Canonical editable catalogue consumed by the browser at runtime. It is
// intentionally an array: Content Studio can treat every concrete class as
// one record without special casing metadata keys. Functional behavior stays
// in JavaScript; this JSON owns optional frame/behavior/control overrides.
const editableGumps = [];
for (const file of allSourceFiles) {
  const source = readFileSync(join(gumpRoot, file), 'utf8');
  const classMatches = [...source.matchAll(/(?:export\s+)?class\s+(\w*Gump\w*)\s+extends\s+(\w+)/g)];
  const hint = sizeHint(source);
  classMatches.forEach((match, index) => {
    const className = match[1];
    const blockStart = match.index ?? 0;
    const blockEnd = classMatches[index + 1]?.index ?? source.length;
    const block = source.slice(blockStart, blockEnd);
    const type = block.match(/get\s+type\s*\(\)\s*\{\s*return\s+['"`]([^'"`]+)/)?.[1] ?? null;
    editableGumps.push({
      definitionId: `client:${kebab(className)}`,
      scope: 'client',
      name: humanize(className),
      className,
      type,
      source: file,
      abstract: ['WindowGump', 'BaseShopGump'].includes(className),
      frame: { enabled: false, x: 0, y: 0, width: hint.width, height: hint.height, opacity: 1 },
      behavior: { enabled: false, canMove: true, canClose: true, canCloseWithEsc: true, canCloseWithRMB: true },
      controlOverrides: [],
    });
  });
}
editableGumps.sort((a, b) => a.name.localeCompare(b.name) || a.className.localeCompare(b.className));

const failures = [];
if (catalog.length < 90) failures.push(`expected at least 90 gump modules, found ${catalog.length}`);
for (const entry of catalog) {
  if (!entry.id || !entry.module) failures.push('catalog entry lacks a stable id/module');
  if (entry.sourceBytes > 512 * 1024) failures.push(`${entry.module} exceeds the 512 KiB source budget`);
  if (!entry.preview.states.includes('default')) failures.push(`${entry.module} lacks a default preview state`);
}
if (new Set(catalog.map((entry) => entry.id)).size !== catalog.length) failures.push('duplicate gump catalogue ids');
if (editableGumps.length < 90) failures.push(`expected at least 90 editable gump classes, found ${editableGumps.length}`);
if (new Set(editableGumps.map((entry) => entry.definitionId)).size !== editableGumps.length) failures.push('duplicate editable gump definitionIds');

// The checked-in runtime catalogue is the admin-editable source of truth for
// local gump appearance. Keep it complete and validate stable control IDs so
// an innocent constructor reorder cannot silently retarget an override.
let runtimeDefinitions = [];
const checkedRuntimeOutput = join(appRoot, 'public', 'client-gumps.json');
try {
  runtimeDefinitions = JSON.parse(readFileSync(checkedRuntimeOutput, 'utf8'));
  if (!Array.isArray(runtimeDefinitions)) throw new Error('root must be an array');
} catch (error) {
  failures.push(`client-gumps.json is invalid: ${error.message}`);
  runtimeDefinitions = [];
}
const runtimeById = new Map(runtimeDefinitions.map((entry) => [entry?.definitionId, entry]));
for (const entry of editableGumps) {
  if (!runtimeById.has(entry.definitionId)) failures.push(`client-gumps.json is missing ${entry.definitionId}`);
}
for (const definition of runtimeDefinitions) {
  const stableIds = new Set();
  for (const [index, override] of (definition?.controlOverrides ?? []).entries()) {
    const stableId = String(override?.controlId ?? '').trim();
    const path = String(override?.path ?? '').trim();
    const className = String(override?.className ?? '').trim();
    if (!stableId && !path && !className) failures.push(`${definition?.definitionId} override ${index + 1} has no target`);
    if (stableId && stableIds.has(stableId)) failures.push(`${definition?.definitionId} duplicates controlId '${stableId}'`);
    if (stableId) stableIds.add(stableId);
  }
}
const houseDefinition = runtimeById.get('client:house-aclgump');
const houseControlIds = new Set((houseDefinition?.controlOverrides ?? []).map((entry) => entry.controlId));
if (!houseDefinition?.frame?.enabled) failures.push('House Management must use its JSON frame definition');
for (const requiredId of ['actions-panel', 'ownership-panel', 'access-panel', 'demolish-button', 'demolition-hint']) {
  if (!houseControlIds.has(requiredId)) failures.push(`House Management JSON is missing stable control '${requiredId}'`);
}

if (process.argv.includes('--write')) {
  const output = join(appRoot, '.generated', 'gump-catalog.json');
  const runtimeOutput = join(appRoot, 'public', 'client-gumps.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), count: catalog.length, gumps: catalog }, null, 2)}\n`);
  mkdirSync(dirname(runtimeOutput), { recursive: true });
  let previous = [];
  try { previous = existsSync(runtimeOutput) ? JSON.parse(readFileSync(runtimeOutput, 'utf8')) : []; } catch { previous = []; }
  const previousById = new Map((Array.isArray(previous) ? previous : []).map((entry) => [entry?.definitionId, entry]));
  const generatedIds = new Set(editableGumps.map((entry) => entry.definitionId));
  const runtimeCatalog = editableGumps.map((entry) => {
    const authored = previousById.get(entry.definitionId);
    if (!authored) return entry;
    return {
      ...entry,
      name: authored.name ?? entry.name,
      type: authored.type ?? entry.type,
      frame: authored.frame && typeof authored.frame === 'object' ? authored.frame : entry.frame,
      behavior: authored.behavior && typeof authored.behavior === 'object' ? authored.behavior : entry.behavior,
      controlOverrides: Array.isArray(authored.controlOverrides) ? authored.controlOverrides : [],
    };
  });
  for (const authored of Array.isArray(previous) ? previous : []) {
    if (authored?.definitionId && !generatedIds.has(authored.definitionId)) runtimeCatalog.push({ ...authored, orphaned: true });
  }
  writeFileSync(runtimeOutput, `${JSON.stringify(runtimeCatalog, null, 2)}\n`);
  console.log(`[gump-catalog] wrote ${relative(appRoot, output)}`);
  console.log(`[gump-catalog] wrote ${relative(appRoot, runtimeOutput)} (${runtimeCatalog.length} editable records)`);
}

if (failures.length) {
  for (const failure of failures) console.error(`[gump-catalog] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[gump-catalog] ok — ${catalog.length} modules, ${catalog.reduce((sum, entry) => sum + entry.exports.length, 0)} exported classes`);
}

export { catalog, editableGumps };
