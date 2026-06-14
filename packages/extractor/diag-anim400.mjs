import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBodyConfig, resolveIdxIndex, getStride } from './body-config.js';

const SRC = 'D:/Games/Electronic Arts/Ultima Online Classic';
const cfg = loadBodyConfig(SRC);
console.log('mobtypes 400:', cfg.mobTypes.get(400));
console.log('bodyconv 400:', cfg.bodyConv.get(400));

const stride = getStride(0, 'HUMAN');
console.log('stride for HUMAN file 0:', stride);
const idx = resolveIdxIndex(400, 0, 0, 0, cfg.bodyConv, cfg.mobTypes);
console.log('idx for body 400 action 0 dir 0:', idx);
console.log('off:', idx * 12);

const idxFd = await open(join(SRC, 'anim.idx'), 'r');
const idxStat = await idxFd.stat();
console.log('anim.idx size:', idxStat.size, 'max idx entry:', idxStat.size / 12);
const buf = Buffer.alloc(12);
await idxFd.read(buf, 0, 12, idx * 12);
console.log('entry pos:', buf.readUInt32LE(0), 'size:', buf.readInt32LE(4));
await idxFd.close();
