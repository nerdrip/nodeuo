import { open } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'D:/Games/Electronic Arts/Ultima Online Classic';
const fileIndex = 4;
const stride = 175;
const body = 400;

const mulFd = await open(join(SRC, `anim${fileIndex+1}.mul`), 'r');
const idxFd = await open(join(SRC, `anim${fileIndex+1}.idx`), 'r');
const idxStat = await idxFd.stat();
console.log('anim5.idx size:', idxStat.size);
const idxBuf = Buffer.alloc(idxStat.size);
await idxFd.read(idxBuf, 0, idxStat.size, 0);
await idxFd.close();

for (const action of [0, 2, 4, 6, 8, 18]) {
  console.log(`\n--- body=${body} action=${action} ---`);
  for (let dir = 0; dir < 5; dir++) {
    const idx = body * stride + action * 5 + dir;
    const off = idx * 12;
    if (off + 12 > idxBuf.length) { console.log(`  dir=${dir} OUT OF RANGE`); continue; }
    const pos  = idxBuf.readUInt32LE(off);
    const size = idxBuf.readInt32LE(off + 4);
    if (pos === 0xFFFFFFFF) { console.log(`  dir=${dir} EMPTY`); continue; }
    // Read frame data
    const buf = Buffer.alloc(size);
    await mulFd.read(buf, 0, size, pos);
    if (buf.length < 516) { console.log(`  dir=${dir} too small (${size}b)`); continue; }
    const dataStart = 512;
    const frameCount = buf.readUInt32LE(dataStart);
    if (frameCount > 200) { console.log(`  dir=${dir} bad frameCount=${frameCount}`); continue; }
    const frame0Off = buf.readUInt32LE(dataStart + 4);
    const fp = dataStart + frame0Off;
    if (fp + 8 > buf.length) { console.log(`  dir=${dir} f0 hdr OOB`); continue; }
    const cx = buf.readInt16LE(fp);
    const cy = buf.readInt16LE(fp + 2);
    const w  = buf.readInt16LE(fp + 4);
    const h  = buf.readInt16LE(fp + 6);
    console.log(`  dir=${dir} size=${size}b frames=${frameCount} f0={cx=${cx} cy=${cy} w=${w} h=${h}}`);
  }
}
await mulFd.close();
