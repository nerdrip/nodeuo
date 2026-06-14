import { openUop } from './uop.js';
import { hashFileName } from './hash.js';

const { fd, entries, totalFiles } = await openUop('D:/Games/Electronic Arts/Ultima Online Classic/gumpartLegacyMUL.uop');
console.log('entries:', totalFiles);
console.log('first 3 hashes:', entries.slice(0, 3).map((e) => '0x' + e.hash.toString(16)));
const tryNames = [
  'build/gumpartlegacymul/00000000.tga',
  'build/gumpartLegacyMUL/00000000.tga',
  'build/gumpart/00000000.tga',
  'build/gumpart/0.tga',
];
for (const n of tryNames) {
  const h = hashFileName(n);
  const found = entries.find((e) => e.hash === h);
  console.log(`${n} → 0x${h.toString(16)} ${found ? 'FOUND' : ''}`);
}
// inspect distribution of decompressed sizes
const sizes = entries.map((e) => e.decompressedSize);
console.log('size dist: min', Math.min(...sizes), 'max', Math.max(...sizes), 'mean', (sizes.reduce((a,b)=>a+b,0) / sizes.length).toFixed(0));
console.log('flag dist:', Object.entries(entries.reduce((acc,e)=>{ acc[e.compressionFlag]=(acc[e.compressionFlag]||0)+1; return acc; }, {})));
// brute force: find an entry that matches some integer in template up to 1000
let pat = 'build/gumpartlegacymul/%08d.tga';
let hits = 0;
for (let i = 0; i < 1000; i++) {
  const n = pat.replace('%08d', String(i).padStart(8, '0'));
  const h = hashFileName(n);
  const f = entries.find((e) => e.hash === h);
  if (f) hits++;
}
console.log(`brute hits in 0..999: ${hits}`);
// inspect first matched entry
const firstName = 'build/gumpartlegacymul/00000000.tga';
const firstHash = hashFileName(firstName);
const e0 = entries.find((e) => e.hash === firstHash);
console.log('entry 0:', e0);
import { readEntryContent } from './uop.js';
const content = await readEntryContent(fd, e0);
console.log('content len:', content.length);
console.log('first bytes:', content.subarray(0, 16).toString('hex'));
const w = content.readUInt32LE(0);
const h = content.readUInt32LE(4);
console.log('reported w/h:', w, h);
await fd.close();
