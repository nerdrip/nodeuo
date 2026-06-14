import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const indexPath = join(dist, 'index.html');
const COMPRESS_EXT = /\.(?:html|css|js|mjs|json|svg|wasm|txt)$/i;

function fail(message) {
  console.error(`[smoke:dist] ${message}`);
  process.exitCode = 1;
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    fail(`missing ${label}: ${path}`);
    return false;
  }
  const size = statSync(path).size;
  if (size <= 0) {
    fail(`empty ${label}: ${path}`);
    return false;
  }
  return true;
}

if (requireFile(indexPath, 'index.html')) {
  const html = readFileSync(indexPath, 'utf8');
  const assetRefs = [...html.matchAll(/(?:src|href)="\/assets\/([^"#?]+)(?:[?#][^"]*)?"/g)]
    .map((m) => m[1]);
  const uniqueRefs = [...new Set(assetRefs)];

  if (!uniqueRefs.some((name) => /^index-.*\.js$/.test(name))) {
    fail('index.html does not reference a hashed index module');
  }
  if (!uniqueRefs.some((name) => /^pixi-.*\.js$/.test(name))) {
    fail('index.html does not preload the Pixi vendor chunk');
  }

  for (const name of uniqueRefs) {
    const full = join(dist, 'assets', name);
    if (!requireFile(full, `asset ${name}`)) continue;
    if (COMPRESS_EXT.test(name) && statSync(full).size >= 1024) {
      requireFile(`${full}.br`, `brotli asset ${name}.br`);
      requireFile(`${full}.gz`, `gzip asset ${name}.gz`);
    }
  }
}

for (const name of ['hues.json', 'tiledata.json']) {
  const full = join(dist, 'assets', name);
  if (!requireFile(full, name)) continue;
  if (statSync(full).size >= 1024) {
    requireFile(`${full}.br`, `brotli asset ${name}.br`);
    requireFile(`${full}.gz`, `gzip asset ${name}.gz`);
  }
}

if (process.exitCode) process.exit();
console.log('[smoke:dist] ok');
