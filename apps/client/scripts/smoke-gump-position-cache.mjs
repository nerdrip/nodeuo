const fail = (msg) => { console.error(`[smoke:gump-position-cache] ${msg}`); process.exit(1); };

const store = new Map();
let getCalls = 0;
let setCalls = 0;

globalThis.localStorage = {
  getItem(key) {
    getCalls++;
    return store.has(key) ? store.get(key) : null;
  },
  setItem(key, value) {
    setCalls++;
    store.set(key, String(value));
  },
  removeItem(key) {
    store.delete(key);
  },
  clear() {
    store.clear();
  },
};

const {
  readGumpPosition,
  writeGumpPosition,
  resetGumpPositionCacheForTests,
} = await import('../src/ui/gump.js');

store.set('uo.gump-positions.v2', JSON.stringify({ paperdoll: { x: 11, y: 22 } }));
resetGumpPositionCacheForTests();
getCalls = 0;
setCalls = 0;

const first = readGumpPosition('paperdoll');
if (first?.x !== 11 || first?.y !== 22) fail(`initial read mismatch: ${JSON.stringify(first)}`);

const second = readGumpPosition('paperdoll');
if (second?.x !== 11 || second?.y !== 22) fail(`cached read mismatch: ${JSON.stringify(second)}`);
if (getCalls !== 1) fail(`expected one localStorage read, got ${getCalls}`);

writeGumpPosition('journal', 33.9, 44.1);
if (setCalls !== 1) fail(`expected one localStorage write, got ${setCalls}`);

const cachedWrite = readGumpPosition('journal');
if (cachedWrite?.x !== 33 || cachedWrite?.y !== 44) fail(`write/read mismatch: ${JSON.stringify(cachedWrite)}`);
if (getCalls !== 1) fail(`write path should not reread localStorage, got ${getCalls}`);

resetGumpPositionCacheForTests();
const afterReset = readGumpPosition('journal');
if (afterReset?.x !== 33 || afterReset?.y !== 44) fail(`reset read mismatch: ${JSON.stringify(afterReset)}`);
if (getCalls !== 2) fail(`reset should force second localStorage read, got ${getCalls}`);

console.log('[smoke:gump-position-cache] ok');
