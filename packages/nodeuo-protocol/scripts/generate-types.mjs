import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNodeUOConformanceFixtures, generateNodeUOTypeDefinitions } from '../src/codegen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '..', 'generated');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'nodeuo-protocol.d.ts'), generateNodeUOTypeDefinitions());
fs.writeFileSync(path.join(output, 'conformance-fixtures.json'),
  `${JSON.stringify(buildNodeUOConformanceFixtures(), null, 2)}\n`);
console.log(`[nodeuo-codegen] wrote TypeScript declarations and conformance fixtures to ${output}`);
