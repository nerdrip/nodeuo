// Build a stable JSON inventory for every script-authored server gump.
// Layouts that have already been migrated live in config/gumps.json and are
// fully data driven. The source-linked records below make every remaining
// send site discoverable from Content Studio and provide a conversion target
// without changing the standard UO gump packet.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const scriptsRoot = join(root, 'apps', 'scripts', 'src');
const engineRoot = join(root, 'apps', 'server', 'src');
const output = join(scriptsRoot, 'data', 'config', 'server-gump-catalog.json');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else if (entry.isFile() && ['.js', '.mjs'].includes(extname(entry.name))) out.push(absolute);
  }
  return out;
}

function kebab(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function humanize(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
}

function enclosingFunction(source, position) {
  const prefix = source.slice(0, position);
  const matches = [...prefix.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g)];
  const match = matches.at(-1);
  return match?.[1] ?? match?.[2] ?? '';
}

const records = [];
for (const sourceRoot of [
  { dir: scriptsRoot, prefix: '', namespace: 'server', kind: 'scripts' },
  { dir: engineRoot, prefix: '@server/', namespace: 'server-engine', kind: 'engine' },
]) for (const absolute of walk(sourceRoot.dir)) {
  const localRel = relative(sourceRoot.dir, absolute).replaceAll('\\', '/');
  if (sourceRoot.kind === 'scripts' && localRel.startsWith('data/')) continue;
  const rel = `${sourceRoot.prefix}${localRel}`;
  const source = readFileSync(absolute, 'utf8');
  const sendSites = [...source.matchAll(/\b(?:api\.)?gumps\.send\s*\(/g)]
    .filter((match) => {
      const position = match.index ?? 0;
      const linePrefix = source.slice(source.lastIndexOf('\n', position) + 1, position).trimStart();
      const prefix = source.slice(0, position);
      return !linePrefix.startsWith('//') && prefix.lastIndexOf('/*') <= prefix.lastIndexOf('*/');
    });
  sendSites.forEach((match, occurrence) => {
    const position = match.index ?? 0;
    const line = source.slice(0, position).split('\n').length;
    const owner = enclosingFunction(source, position);
    const stem = localRel.replace(/\.(?:js|mjs)$/i, '');
    const suffix = owner || `send-${occurrence + 1}`;
    const window = source.slice(position, position + 900);
    const generatedDefinitionId = `${sourceRoot.namespace}:${kebab(stem)}:${kebab(suffix)}${sendSites.length > 1 ? `-${occurrence + 1}` : ''}`;
    // When the call already carries a literal runtime key, catalogue that
    // exact key. A synthetic inventory-only ID would appear editable in
    // Content Studio but could never be selected by the runtime resolver.
    const definitionIdLiteral = window.match(/\bdefinitionId\s*:\s*(['"`])([^'"`]+)\1/)?.[2] ?? null;
    const gumpIdLiteral = window.match(/\bgumpId\s*:\s*(0x[\da-f]+|\d+)/i)?.[1] ?? null;
    const gumpId = gumpIdLiteral ? Number(gumpIdLiteral) : null;
    records.push({
      definitionId: definitionIdLiteral || generatedDefinitionId,
      scope: 'server',
      mode: 'source-linked',
      name: humanize(owner || `${rel.split('/').at(-1).replace(/\.(?:js|mjs)$/i, '')} ${occurrence + 1}`),
      source: rel,
      sourceKind: sourceRoot.kind,
      sourceLine: line,
      gumpId,
      enabled: false,
      x: 100,
      y: 100,
      width: 320,
      height: 240,
      controls: [],
    });
  });
}

records.sort((a, b) => a.source.localeCompare(b.source) || a.sourceLine - b.sourceLine);
if (new Set(records.map((record) => record.definitionId)).size !== records.length) throw new Error('duplicate generated server gump IDs');

if (process.argv.includes('--write')) {
  let previous = [];
  try { previous = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : []; } catch { previous = []; }
  const byId = new Map((Array.isArray(previous) ? previous : []).map((entry) => [entry?.definitionId, entry]));
  const merged = records.map((record) => {
    const authored = byId.get(record.definitionId);
    if (!authored) return record;
    return {
      ...record,
      name: authored.name ?? record.name,
      enabled: authored.enabled === true,
      x: Number.isFinite(Number(authored.x)) ? Number(authored.x) : record.x,
      y: Number.isFinite(Number(authored.y)) ? Number(authored.y) : record.y,
      width: Number.isFinite(Number(authored.width)) ? Number(authored.width) : record.width,
      height: Number.isFinite(Number(authored.height)) ? Number(authored.height) : record.height,
      controls: Array.isArray(authored.controls) ? authored.controls : [],
    };
  });
  writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`[server-gump-catalog] wrote ${relative(root, output)} (${records.length} send sites)`);
} else {
  console.log(`[server-gump-catalog] ok — ${records.length} send sites`);
}

export { records };
