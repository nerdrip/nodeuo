import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INCOMING_OPCODES } from '../../packages/protocol/src/opcodes.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const servuo = read('../../templates/ServUO/Server/Network/PacketHandlers.cs');
const handlers = read('../../apps/server/src/net/handlers.js');

// ServUO is the compatibility reference. Later Register6017 entries replace
// legacy packet sizes, just as a modern 7.x client negotiates them.
const reference = new Map();
const register = /Register(?:6017)?\s*\(\s*0x([0-9A-Fa-f]{2})\s*,\s*(-?\d+)\s*,\s*(true|false)\s*,\s*([A-Za-z0-9_]+)/g;
let match;
while ((match = register.exec(servuo))) {
  reference.set(Number.parseInt(match[1], 16), {
    size: Math.max(0, Number(match[2])),
    ingame: match[3] === 'true',
    name: match[4],
  });
}
assert.ok(reference.size > 50, 'ServUO packet registration table should be discoverable');

const mismatches = [];
let compared = 0;
for (const [opcode, expected] of reference) {
  const actual = INCOMING_OPCODES[opcode];
  if (!actual) continue; // unsupported reference packets are covered by the coverage audit
  compared++;
  if (actual.size !== expected.size || actual.ingame !== expected.ingame) {
    mismatches.push({ opcode: `0x${opcode.toString(16).padStart(2, '0')}`, expected, actual });
  }
}
assert.deepEqual(mismatches, [], `protocol metadata drifted from ServUO: ${JSON.stringify(mismatches.slice(0, 8))}`);

const implemented = new Set();
for (const m of handlers.matchAll(/^\s*0x([0-9A-Fa-f]{2}):\s*handle[A-Za-z0-9_]+/gm)) {
  implemented.add(Number.parseInt(m[1], 16));
}
for (const opcode of implemented) {
  assert.ok(INCOMING_OPCODES[opcode], `server handler 0x${opcode.toString(16)} lacks framer metadata`);
}

// Private NodeUO features must remain inside the standard 0xBF extended
// envelope. This preserves compatibility with unmodified emulators.
assert.match(handlers, /0xBF:\s*handleExtendedCommand/);
assert.doesNotMatch(handlers, /^\s*0xF1:\s*handleNodeUO/gm);

console.log(`[audit:protocol-differential] ok servuo=${reference.size} compared=${compared} handlers=${implemented.size}`);
