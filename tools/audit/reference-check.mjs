import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = process.cwd();
const references = [
  {
    name: 'ServUO',
    source: 'templates/ServUO',
    scan: 'templates/ServUO/Scripts',
    minimumCsFiles: 1000,
    required: ['templates/ServUO/Server/Network/PacketHandlers.cs'],
  },
  {
    name: 'ClassicUO',
    source: 'templates/ClassicUO',
    scan: 'templates/ClassicUO/src',
    minimumCsFiles: 100,
    required: ['templates/ClassicUO/src/ClassicUO.Client/Game/Managers/SeasonManager.cs'],
  },
];

function walkCs(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walkCs(file, files);
    else if (entry.isFile() && entry.name.endsWith('.cs')) files.push(file);
  }
  return files;
}

function describe(ref) {
  const scan = resolve(root, ref.scan);
  const missing = [ref.scan, ...ref.required].filter((file) => !existsSync(resolve(root, file)));
  if (missing.length) throw new Error(`${ref.name} reference tree is incomplete (${missing.join(', ')}); see docs/reference-sources.md`);
  if (!statSync(scan).isDirectory()) throw new Error(`${ref.scan} is not a directory`);

  const files = [...new Set([...walkCs(scan), ...ref.required.map((file) => resolve(root, file))])]
    .sort((a, b) => {
      const left = relative(root, a).replaceAll('\\', '/');
      const right = relative(root, b).replaceAll('\\', '/');
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (files.length < ref.minimumCsFiles) {
    throw new Error(`${ref.name} reference source is incomplete (${files.length} C# files, expected at least ${ref.minimumCsFiles}); see docs/reference-sources.md`);
  }

  const hash = createHash('sha256');
  let bytes = 0;
  for (const file of files) {
    const contents = readFileSync(file);
    hash.update(relative(root, file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(contents);
    hash.update('\0');
    bytes += contents.length;
  }
  return { name: ref.name, source: ref.source, csFiles: files.length, bytes, sha256: hash.digest('hex') };
}

try {
  const sources = references.map(describe);
  for (const source of sources) {
    console.log(`[reference-check] ${source.name}: ${source.csFiles} C# files, sha256=${source.sha256}`);
  }

  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0) {
    const output = process.argv[jsonAt + 1];
    if (!output || output.startsWith('--')) throw new Error('--json requires a path');
    const target = resolve(root, output);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), sources }, null, 2)}\n`);
    console.log(`[reference-check] wrote ${relative(root, target)}`);
  }
} catch (error) {
  console.error(`[reference-check] ${error.message}`);
  process.exitCode = 1;
}
