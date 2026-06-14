// Diagnoza: porównaj nasz offset (body*175) z CUO ((body-400)*175+35000) w anim5.idx
import { open } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'D:/Games/Electronic Arts/Ultima Online Classic';

async function readIdx(path) {
  const fd = await open(path, 'r');
  const stat = await fd.stat();
  const buf = Buffer.alloc(stat.size);
  await fd.read(buf, 0, stat.size, 0);
  await fd.close();
  return buf;
}

async function readFrameMeta(mulFd, pos, size) {
  if (pos === 0xFFFFFFFF || size <= 0) return null;
  if (size < 516) return { tooSmall: true, size };
  const buf = Buffer.alloc(Math.min(size, 4096));
  await mulFd.read(buf, 0, buf.length, pos);
  const dataStart = 512;
  if (buf.length < dataStart + 8) return { tooSmall: true, size };
  const frameCount = buf.readUInt32LE(dataStart);
  if (frameCount <= 0 || frameCount > 200) return { badFrames: frameCount, size };
  const frame0Off = buf.readUInt32LE(dataStart + 4);
  const fp = dataStart + frame0Off;
  if (fp + 8 > buf.length) return { hdrOOB: true, size, frameCount };
  return {
    size,
    frameCount,
    cx: buf.readInt16LE(fp),
    cy: buf.readInt16LE(fp + 2),
    w: buf.readInt16LE(fp + 4),
    h: buf.readInt16LE(fp + 6),
  };
}

for (const [fileIndex, idxName, mulName] of [[0, 'anim.idx', 'anim.mul'], [4, 'anim5.idx', 'anim5.mul']]) {
  console.log(`\n========== file ${fileIndex} (${idxName}) ==========`);
  const idxBuf = await readIdx(join(SRC, idxName));
  const mulFd = await open(join(SRC, mulName), 'r');
  console.log(`size=${idxBuf.length}  entries=${idxBuf.length/12}`);

  for (const body of [0, 200, 400]) {
    console.log(`\n--- body=${body} ---`);
    // Nasz wzór:
    const ourIdx = body * 175;
    // CUO People:
    const cuoPeople = (body - 400) * 175 + 35000;
    // CUO High:
    const cuoHigh = body * 110;
    // CUO Low:
    const cuoLow = (body - 200) * 65 + 22000;

    for (const [label, idx] of [['ours(b*175)', ourIdx], ['CUO_People', cuoPeople], ['CUO_High', cuoHigh], ['CUO_Low', cuoLow]]) {
      const action = 0, dir = 0;
      const off = (idx + action * 5 + dir) * 12;
      if (off < 0 || off + 12 > idxBuf.length) {
        console.log(`  ${label} idx=${idx}  OOB`);
        continue;
      }
      const pos = idxBuf.readUInt32LE(off);
      const size = idxBuf.readInt32LE(off + 4);
      const meta = await readFrameMeta(mulFd, pos, size);
      console.log(`  ${label}  idx=${idx}  pos=${pos === 0xFFFFFFFF ? 'EMPTY' : pos}  size=${size}  ${JSON.stringify(meta)}`);
    }
  }
  await mulFd.close();
}
