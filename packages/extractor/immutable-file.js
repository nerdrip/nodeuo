import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, rename, stat, unlink } from 'node:fs/promises';

export async function hashFile(file) {
  const digest = createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on('data', (chunk) => { digest.update(chunk); bytes += chunk.length; });
    input.on('error', reject);
    input.on('end', resolve);
  });
  return { sha256: digest.digest('hex'), bytes };
}

export async function installImmutableFile(source, destination, expected) {
  try {
    const current = await stat(destination);
    if (current.size === expected.bytes) return;
    throw new Error(`content-addressed file size conflict: ${destination}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Prefer a hard link: compatibility and immutable names share disk blocks.
  try { await link(source, destination); }
  catch (error) {
    if (error?.code === 'EEXIST') return;
    await copyFile(source, destination);
  }
}

export async function replaceFile(from, to) {
  try { await rename(from, to); }
  catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
    await unlink(to).catch((nested) => { if (nested?.code !== 'ENOENT') throw nested; });
    await rename(from, to);
  }
}
