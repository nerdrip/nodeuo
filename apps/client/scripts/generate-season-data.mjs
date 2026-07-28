import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../');
const source = path.join(root, 'templates/ClassicUO/src/ClassicUO.Client/Game/Managers/SeasonManager.cs');
const target = path.join(root, 'apps/client/src/data/season-data.js');
const seasonIds = { spring: 0, summer: 1, fall: 2, winter: 3, desolation: 4 };
const data = Array.from({ length: 5 }, () => ({ static: {}, land: {} }));
const text = await readFile(source, 'utf8');
// ClassicUO's default file calls terrain rows `landtile` (and writes many
// of them as decimal values), while older custom season files sometimes use
// the shorter `land` spelling.  The old generator accepted only `land` plus
// hexadecimal values, silently producing five EMPTY land maps.  That made
// Winter swap vegetation but never snow-covered terrain.
const re = /writer\.WriteLine\("(spring|summer|fall|winter|desolation),(static|land(?:tile)?),(0x[0-9a-f]+|\d+),(0x[0-9a-f]+|\d+)"\);/gi;
let match;
let count = 0;
while ((match = re.exec(text))) {
  const kind = match[2].toLowerCase() === 'static' ? 'static' : 'land';
  const parseValue = (value) => /^0x/i.test(value) ? parseInt(value.slice(2), 16) : parseInt(value, 10);
  data[seasonIds[match[1].toLowerCase()]][kind][parseValue(match[3])] = parseValue(match[4]);
  count++;
}
const encode = (kind) => `Object.freeze([\n${data.map((entry) => {
  const pairs = Object.entries(entry[kind]).map(([from, to]) => `    ${from}: ${to}`).join(',\n');
  return `  Object.freeze({\n${pairs}\n  })`;
}).join(',\n')}\n])`;
const out = `// Generated from ClassicUO SeasonManager.cs by scripts/generate-season-data.mjs.\n`
  + `// Do not hand-edit: regenerate when the reference season table changes.\n\n`
  + `export const SEASON_STATIC_REMAP = ${encode('static')};\n\n`
  + `export const SEASON_LAND_REMAP = ${encode('land')};\n`;
await writeFile(target, out);
console.log(`generated ${target} (${count} ClassicUO mappings)`);
