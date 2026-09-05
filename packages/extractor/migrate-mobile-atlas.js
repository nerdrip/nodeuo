// Upgrade an existing monolithic mobile atlas in place. This is useful when
// the decoded Ultima files are not available on a deployment host: coordinates
// stay byte-for-byte identical while metadata/pages gain immutable names.

import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAnimationShards, validateAnimationManifest, validateAnimationShardIndex } from './anim.js';
import { hashFile, installImmutableFile, replaceFile } from './immutable-file.js';
import { publishMobileKtx2Index } from './mobile-atlas-ktx2.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const outDir = resolve(process.argv[2] || join(REPO_ROOT, 'apps', 'client', 'public', 'assets'));

const manifest = JSON.parse(await readFile(join(outDir, 'mobiles-atlas.json'), 'utf8'));
validateAnimationManifest(manifest);
const pages = {};
for (let page = 0; page < manifest.pageCount; page++) {
  const source = join(outDir, `mobiles-atlas-${String(page).padStart(2, '0')}.png`);
  const metadata = await hashFile(source);
  const file = `mobiles-atlas-page-${String(page).padStart(3, '0')}-${metadata.sha256.slice(0, 16)}.png`;
  await installImmutableFile(source, join(outDir, file), metadata);
  pages[page] = { file, ...metadata };
}

const sharded = buildAnimationShards(manifest, 64, pages);
validateAnimationShardIndex(sharded.index, sharded.payloads);
for (const [file, payload] of sharded.payloads) {
  const temp = join(outDir, `${file}.next`);
  await unlink(temp).catch(() => {});
  await writeFile(temp, payload);
  await replaceFile(temp, join(outDir, file));
}
const indexFile = join(outDir, 'mobiles-atlas-index.json');
const indexTemp = `${indexFile}.next`;
await unlink(indexTemp).catch(() => {});
await writeFile(indexTemp, JSON.stringify(sharded.index));
await replaceFile(indexTemp, indexFile);
await removeStale(outDir, new Set(Object.values(pages).map((row) => row.file)),
  new Set(sharded.payloads.keys()));
const compressed = await publishMobileKtx2Index(outDir);
console.log(`[mobile-atlas:migrate] pages=${manifest.pageCount} shards=${sharded.payloads.size} ktx2=${compressed.published} revision=${compressed.revision ?? sharded.index.revision}`);

async function removeStale(directory, activePages, activeShards) {
  for (const name of await readdir(directory)) {
    const stalePage = /^mobiles-atlas-page-\d+-[a-f0-9]{16}\.png$/i.test(name) && !activePages.has(name);
    const staleShard = /^mobiles-atlas-bodies-[a-f0-9-]+\.json$/i.test(name) && !activeShards.has(name);
    if (stalePage || staleShard) await unlink(join(directory, name));
  }
}
