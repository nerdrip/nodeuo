import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBodyConfig, resolveIdxIndex, pickAnimFile, getStride } from './body-config.js';

const SRC = 'D:/Games/Electronic Arts/Ultima Online Classic';
const cfg = loadBodyConfig(SRC);
console.log('pickAnimFile(400):', pickAnimFile(400, cfg.bodyConv, cfg.mobTypes));

for (const fileIdx of [0, 4]) {
  const idxName = fileIdx === 0 ? 'anim.idx' : `anim${fileIdx + 1}.idx`;
  const fd = await open(join(SRC, idxName), 'r');
  const stat = await fd.stat();
  const buf = Buffer.alloc(stat.size);
  await fd.read(buf, 0, stat.size, 0);
  await fd.close();
  console.log(`file ${fileIdx} (${idxName}): size=${stat.size}, entries=${stat.size/12}`);

  const stride = getStride(fileIdx, 'HUMAN');
  console.log(`  stride for HUMAN: ${stride}`);
  const idx = resolveIdxIndex(400, fileIdx, 0, 0, cfg.bodyConv, cfg.mobTypes);
  console.log(`  idx = ${idx}`);
  if (idx >= 0 && idx * 12 + 12 <= stat.size) {
    console.log(`  pos=${buf.readUInt32LE(idx * 12)}, size=${buf.readInt32LE(idx * 12 + 4)}`);
  }
  // Brute search for body 400 in this file: scan first 3000 indices
  let valid = 0, firstValid = -1;
  for (let i = 0; i < Math.min(stat.size / 12, 100000); i++) {
    const pos = buf.readUInt32LE(i * 12);
    if (pos !== 0xFFFFFFFF) {
      valid++;
      if (firstValid < 0) firstValid = i;
    }
  }
  console.log(`  valid in file ${fileIdx}: ${valid}, first valid idx ${firstValid}`);
}
