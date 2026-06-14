import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function walk(rel, predicate = () => true, out = []) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) {
      walk(childRel, predicate, out);
    } else if (entry.isFile() && predicate(childRel)) {
      out.push(childRel);
    }
  }
  return out;
}

function countFiles(rel, ext = null) {
  return walk(rel, (file) => !ext || file.endsWith(ext)).length;
}

function countImmediateDirs(rel, ext = null) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const child = path.join(rel, entry.name);
      return { name: entry.name, count: countFiles(child, ext) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readJsonCount(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') return Object.keys(data).length;
  return 1;
}

function scanMarkers() {
  const roots = ['apps/server/src', 'apps/scripts/src'];
  const marker = /\b(TODO|FIXME|deferred|placeholder|partial|not wired|engine API missing|missing api|unavailable; skipping|registerItem missing|registerRecipe|skipping)\b/i;
  const files = roots.flatMap((rel) => walk(rel, (file) => /\.(?:mjs|cjs|js)$/.test(file)));
  const hits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (marker.test(lines[i])) {
        hits.push({ file: rel.replaceAll('\\', '/'), line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

function printTable(rows, columns) {
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').length)));
  console.log(`| ${columns.map((col, i) => col.padEnd(widths[i])).join(' | ')} |`);
  console.log(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  for (const row of rows) {
    console.log(`| ${columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join(' | ')} |`);
  }
}

const servuoScripts = countImmediateDirs('templates/ServUO/Scripts', '.cs');
const servuoServices = countImmediateDirs('templates/ServUO/Scripts/Services', '.cs');
const oursTop = [
  ...countImmediateDirs('apps/server/src', '.js').map((row) => ({ name: `server/${row.name}`, count: row.count })),
  ...countImmediateDirs('apps/scripts/src', '.js').map((row) => ({ name: `scripts/${row.name}`, count: row.count })),
].sort((a, b) => a.name.localeCompare(b.name));
const dataFiles = [
  'apps/scripts/src/data/config/items.json',
  'apps/scripts/src/data/config/item-types.json',
  'apps/scripts/src/data/config/monsters.json',
  'apps/scripts/src/data/config/npcs.json',
  'apps/scripts/src/data/config/recipes.json',
  'apps/scripts/src/data/config/vendor-inventory.json',
  'apps/scripts/src/data/world/decorations.json',
  'apps/scripts/src/data/world/xmlspawners.json',
  'apps/scripts/src/data/world/quest-chains.json',
  'apps/scripts/src/data/world/quests-extracted.json',
  'apps/scripts/src/data/world/teleporters.json',
].filter(exists).map((file) => ({ file: file.replaceAll('\\', '/'), entries: readJsonCount(file) }));
const markers = scanMarkers();

console.log(`# ServUO server audit snapshot`);
console.log();
console.log(`Generated: ${new Date().toISOString()}`);
console.log(`Root: ${ROOT}`);
console.log();
console.log(`- ServUO files: ${countFiles('templates/ServUO')}`);
console.log(`- ServUO C# scripts: ${countFiles('templates/ServUO/Scripts', '.cs')}`);
console.log(`- Our server/scripts files: ${countFiles('apps/server/src') + countFiles('apps/scripts/src')}`);
console.log(`- Our JS server/scripts files: ${countFiles('apps/server/src', '.js') + countFiles('apps/scripts/src', '.js')}`);
console.log(`- Marker hits: ${markers.length}`);
console.log();
console.log(`## ServUO Scripts`);
printTable(servuoScripts.map((row) => ({ dir: row.name, cs: row.count })), ['dir', 'cs']);
console.log();
console.log(`## ServUO Services`);
printTable(servuoServices.map((row) => ({ service: row.name, cs: row.count })), ['service', 'cs']);
console.log();
console.log(`## Our Server/Script Buckets`);
printTable(oursTop.map((row) => ({ bucket: row.name.replaceAll('\\', '/'), js: row.count })), ['bucket', 'js']);
console.log();
console.log(`## Data Catalogues`);
printTable(dataFiles, ['file', 'entries']);
console.log();
console.log(`## Marker Hotspots`);
const grouped = new Map();
for (const hit of markers) {
  const stat = grouped.get(hit.file) ?? { file: hit.file, hits: 0, sample: `${hit.line}: ${hit.text}` };
  stat.hits++;
  grouped.set(hit.file, stat);
}
const hotspots = [...grouped.values()]
  .sort((a, b) => b.hits - a.hits || a.file.localeCompare(b.file))
  .slice(0, 80);
printTable(hotspots, ['file', 'hits', 'sample']);
