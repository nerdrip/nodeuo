// Addons loader — reads scripts/data/world/addons.json and pushes the
// catalogue into the server engine via setAddons.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/addons.json');
const GENERATED = path.resolve(HERE, '../data/world/addons.generated.json');

function titleizeAddonName(key) {
  return String(key ?? '')
    .replace(/-(south|east|north|west)$/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildDirectionalDeeds(json) {
  const groups = new Map();
  for (const key of Object.keys(json)) {
    const m = /^(.*)-(south|east|north|west)$/i.exec(key);
    if (!m) continue;
    const base = m[1];
    const dir = m[2].toLowerCase();
    if (!groups.has(base)) groups.set(base, {});
    groups.get(base)[dir] = key;
  }
  const handled = new Set();
  const deeds = [];
  for (const [base, dirs] of groups) {
    if (Object.keys(dirs).length < 2) continue;
    for (const key of Object.values(dirs)) handled.add(key);
    deeds.push({
      id: 0x14F0,
      name: `${titleizeAddonName(base)} Deed`,
      tagId: `${base}-deed`,
      script: 'addon-deed',
      weight: 1,
      addonNames: dirs,
      ...(json[Object.values(dirs)[0]]?.deed ?? {}),
    });
  }
  for (const key of Object.keys(json)) {
    if (handled.has(key)) continue;
    if (json[key]?.noDeed) continue;
    deeds.push({
      id: 0x14F0,
      name: `${titleizeAddonName(key)} Deed`,
      tagId: `${key}-deed`,
      script: 'addon-deed',
      weight: 1,
      addonName: key,
      ...(json[key]?.deed ?? {}),
    });
  }
  return deeds;
}

export default function register(api) {
  const sys = api.systems?.addons;
  if (!sys?.setAddons) {
    api.log?.('addons: engine API missing, skipping');
    return () => {};
  }
  let json = {};
  try {
    const generated = fs.existsSync(GENERATED)
      ? JSON.parse(fs.readFileSync(GENERATED, 'utf8'))
      : {};
    const authored = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    json = { ...generated, ...authored };
  }
  catch (e) { api.log?.(`addons: ${e.message}`); return () => {}; }
  sys.setAddons(json);
  const reg = api.catalog?.items?.registerItem;
  let deedCount = 0;
  if (reg) {
    for (const deed of buildDirectionalDeeds(json)) {
      try { reg(deed); deedCount++; }
      catch (e) { api.log?.(`addons: deed ${deed.tagId}: ${e.message}`); }
    }
  }
  api.log?.(`addons: loaded ${Object.keys(json).length} addon catalogue entries, registered ${deedCount} deeds`);
  return () => sys.setAddons({});
}
