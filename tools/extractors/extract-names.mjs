// Extract ServUO Data/names.xml namelists into JSON pools used by
// apps/scripts/src/data/npc-names.json.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const XML  = path.join(ROOT, 'templates/ServUO/Data/names.xml');
const OUT  = path.join(ROOT, 'apps/scripts/src/data/npc-names.json');

let xml = fs.readFileSync(XML, 'utf8').replace(/^\uFEFF/, '');

function pick(type) {
  const re = new RegExp('<namelist[^>]+type="' + type + '"[^>]*>([\\s\\S]*?)</namelist>', 'i');
  const m = xml.match(re);
  if (!m) return [];
  return m[1]
    .replace(/[\n\r\t]/g, ' ')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
}

const out = {
  human: { male: pick('male'), female: pick('female') },
  tokuno: { male: pick('tokuno male'), female: pick('tokuno female') },
  elf: { male: pick('Elf Male'), female: pick('Elf Female') },
  gargoyle: { male: pick('Gargoyle Male'), female: pick('Gargoyle Female') },
  monster: {
    centaur: pick('centaur'),
    pixie: pick('pixie'),
    daemon: pick('daemon'),
    'ancient lich': pick('ancient lich'),
    'demon knight': pick('demon knight'),
    'shadow knight': pick('shadow knight'),
    'darknight creeper': pick('darknight creeper'),
    'evil mage': pick('evil mage'),
    'evil mage lord': pick('evil mage lord'),
    'ethereal warrior': pick('ethereal warrior'),
    impaler: pick('impaler'),
    ratman: pick('ratman'),
    lizardman: pick('lizardman'),
    savage: pick('savage'),
    'savage rider': pick('savage rider'),
    'savage shaman': pick('savage shaman'),
    'golem controller': pick('golem controller'),
    'gargoyle vendor': pick('gargoyle vendor'),
    'gargoyle quester': pick('gargoyle quester'),
  },
};

const stats = {};
for (const [k, v] of Object.entries(out)) {
  if (Array.isArray(v)) { stats[k] = v.length; continue; }
  for (const [k2, v2] of Object.entries(v)) {
    stats[`${k}.${k2}`] = v2.length;
  }
}
console.log(JSON.stringify(stats, null, 2));

fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log('Wrote', OUT);
