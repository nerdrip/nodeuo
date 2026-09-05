// Publish optional mobile-atlas KTX2 pages through the same content-addressed
// index as the canonical PNG pages. Keeping this separate from the decoder
// lets `ktx2.js` update an already-extracted atlas without loading its large
// body manifests or pixel buffers.

import { createHash } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile, installImmutableFile, replaceFile } from './immutable-file.js';

export async function publishMobileKtx2Index(outDir) {
  const indexFile = join(outDir, 'mobiles-atlas-index.json');
  let index;
  try { index = JSON.parse(await readFile(indexFile, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return { published: 0, skipped: true };
    throw error;
  }
  if (index?.format !== 'nodeuo.mobile-atlas-shards' || !index.pages) {
    return { published: 0, skipped: true };
  }

  const active = new Set();
  let published = 0;
  for (const [pageId, page] of Object.entries(index.pages)) {
    const pageIndex = Number(pageId);
    if (!Number.isInteger(pageIndex) || pageIndex < 0) continue;
    const source = join(outDir, `mobiles-atlas-${String(pageIndex).padStart(2, '0')}.ktx2`);
    let metadata;
    try { metadata = await hashFile(source); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      delete page.ktx2;
      continue;
    }
    if (metadata.bytes <= 0) throw new Error(`empty KTX2 atlas page: ${source}`);
    const file = `mobiles-atlas-page-${String(pageIndex).padStart(3, '0')}-${metadata.sha256.slice(0, 16)}.ktx2`;
    const destination = join(outDir, file);
    await installImmutableFile(source, destination, metadata);
    page.ktx2 = { file, ...metadata };
    active.add(file);
    published++;
  }

  // Revision covers every optional representation as well as PNG coordinates.
  // The index is swapped last, so readers always observe a complete generation.
  delete index.revision;
  index.revision = createHash('sha256').update(JSON.stringify(index)).digest('hex');
  const temp = `${indexFile}.next`;
  await writeFile(temp, JSON.stringify(index));
  await replaceFile(temp, indexFile);
  await removeStaleMobileKtx2(outDir, active);
  return { published, skipped: false, revision: index.revision };
}

async function removeStaleMobileKtx2(outDir, active) {
  for (const name of await readdir(outDir).catch(() => [])) {
    if (!/^mobiles-atlas-page-\d+-[a-f0-9]{16}\.ktx2$/i.test(name) || active.has(name)) continue;
    await unlink(join(outDir, name)).catch(() => {});
  }
}
