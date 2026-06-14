import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SERVUO_ROOT = path.join(ROOT, 'templates', 'ServUO', 'Scripts');
const NODE_ROOTS = [
  path.join(ROOT, 'apps', 'server', 'src'),
  path.join(ROOT, 'apps', 'scripts', 'src'),
];
const TEST_ROOTS = [
  path.join(ROOT, 'apps', 'server', 'test'),
  path.join(ROOT, 'apps', 'client', 'test'),
];
const DATA_FILES = [
  'apps/scripts/src/data/config/items.json',
  'apps/scripts/src/data/config/item-types.json',
  'apps/scripts/src/data/config/servuo-p2-admin-parity.json',
  'apps/scripts/src/data/config/servuo-runtime-parity.json',
  'apps/scripts/src/data/config/servuo-spell-parity.json',
  'apps/scripts/src/data/config/monsters.json',
  'apps/scripts/src/data/config/npcs.json',
  'apps/scripts/src/data/config/vendor-inventory.json',
  'apps/scripts/src/data/config/loot-tables.json',
  'apps/scripts/src/data/config/loot-packs.json',
  'apps/scripts/src/data/world/quest-chains.json',
  'apps/scripts/src/data/world/quests-extracted.json',
  'apps/scripts/src/data/world/artifacts.json',
  'apps/scripts/src/data/world/addons.json',
  'apps/scripts/src/data/world/addons.generated.json',
  'apps/scripts/src/data/world/books.servuo.generated.json',
  'apps/scripts/src/data/world/revamped-dungeons.json',
  'apps/scripts/src/data/world/termur-content.json',
  'apps/scripts/src/data/world/teleporters.json',
  'apps/scripts/src/data/world/xmlspawners.json',
];
const PARITY_CLASS_LIST_FILES = [
  'apps/scripts/src/quests/servuo-p1-quest-parity.js',
  'apps/scripts/src/npcs/servuo-p1-mobiles.js',
  'apps/scripts/src/systems/servuo-p1-multis.js',
  'apps/scripts/src/systems/servuo-p1-services.js',
];

const SERVICE_MAP = new Map(Object.entries({
  'Armor Refinement': ['apps/server/src/systems/refinement.js'],
  Astronomy: ['apps/server/src/systems/astronomy.js'],
  BasketWeaving: ['apps/server/src/systems/housing/basket-weaving.js'],
  BulkOrders: ['apps/server/src/systems/economy/bods.js'],
  ChampionSystem: ['apps/server/src/systems/bosses/champion.js'],
  Chat: ['apps/server/src/chat-channels.js'],
  'City Loyalty System': ['apps/server/src/systems/city-loyalty.js'],
  CleanUpBritannia: ['apps/server/src/systems/economy/cleanup-britannia.js'],
  CommunityCollections: ['apps/server/src/systems/community-collections.js'],
  Craft: ['apps/server/src/systems/crafting/index.js', 'apps/scripts/src/crafting'],
  Doom: ['apps/server/src/systems/bosses/doom-gauntlet.js', 'apps/server/src/systems/bosses/doom-lever-puzzle.js'],
  Ethics: ['apps/server/src/systems/pvp/ethics.js'],
  Expansions: ['apps/server/src/systems/expansion-flags.js'],
  ExploringTheDeep: ['apps/server/src/systems/boats.js', 'apps/server/src/systems/cannons.js', 'apps/server/src/systems/ocean-encounters.js'],
  Factions: ['apps/server/src/systems/pvp/factions.js', 'apps/server/src/systems/pvp/sigils.js'],
  FireCasino: ['apps/server/src/systems/economy/fire-casino.js'],
  GiftGiving: ['apps/server/src/systems/events/gift-giving.js'],
  Harvest: ['apps/server/src/systems/economy/harvest.js'],
  Help: ['apps/server/src/help-queue.js'],
  HuntmasterChallenge: ['apps/server/src/systems/bosses/huntmaster-challenge.js'],
  InstancedPeerless: ['apps/server/src/systems/bosses/instanced-peerless.js'],
  Khaldun: ['apps/server/src/systems/bosses/khaldun-puzzles.js'],
  LootGeneration: ['apps/server/src/world/loot.js'],
  LoyaltySystem: ['apps/server/src/systems/city-loyalty.js'],
  MiniChampionSystem: ['apps/server/src/systems/bosses/mini-champion.js'],
  MondainsLegacyQuests: ['apps/server/src/systems/quests/mlquests.js', 'apps/scripts/src/quests/mondains-legacy.js'],
  'Monster Stealing': ['apps/server/src/systems/monster-stealing.js'],
  'New Magincia': ['apps/server/src/systems/economy/magincia-bazaar.js', 'apps/server/src/systems/economy/magincia-distillation.js'],
  Party: ['apps/server/src/party.js'],
  Pathing: ['apps/server/src/world/pathfind.js'],
  Peerless: ['apps/server/src/systems/bosses/peerless.js', 'apps/server/src/systems/bosses/peerless-bosses.js'],
  'Pet Training': ['apps/server/src/systems/pets/pet-training.js'],
  Plants: ['apps/server/src/systems/housing/plants.js'],
  PointsSystems: ['apps/server/src/systems/economy/points-systems.js'],
  'PVP Arena System': ['apps/server/src/systems/pvp/pvp-arena.js'],
  Quests: ['apps/server/src/systems/quests/quests.js', 'apps/scripts/src/quests'],
  RemoteAdmin: ['apps/server/src/admin'],
  Reports: ['apps/server/src/systems/reports.js'],
  'Revamped Dungeons': ['apps/server/src/systems/bosses/revamped-dungeons.js'],
  'Seasonal Events': ['apps/server/src/systems/events/seasonal-events.js'],
  Spawner: ['apps/server/src/spawner.js'],
  'Tomb of Kings': ['apps/scripts/src/quests', 'apps/scripts/src/data/world/quest-chains.json'],
  TownCryer: ['apps/server/src/systems/town-cryer.js'],
  'Town Cryer': ['apps/server/src/systems/town-cryer.js'],
  TreasureMaps: ['apps/server/src/systems/treasure-maps.js'],
  UltimaStore: ['apps/server/src/systems/economy/ultima-store.js'],
  Underworld: ['apps/server/src/systems/bosses/termur-content.js'],
  'Vendor Searching': ['apps/server/src/systems/economy/vendor-search.js'],
  VeteranRewards: ['apps/server/src/systems/rewards/veteran-rewards.js'],
  ViceVsVirtue: ['apps/server/src/systems/pvp/vvv.js'],
  Virtues: ['apps/server/src/systems/rewards/virtues.js'],
  XmlSpawner: ['apps/server/src/systems/xml-spawner.js', 'apps/server/src/systems/world/xml-attachments.js'],
}));

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { summary: false, json: null, markdown: null, category: null, limit: 40, failOpen: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') out.summary = true;
    else if (arg === '--json') out.json = argv[++i];
    else if (arg.startsWith('--json=')) out.json = arg.slice('--json='.length);
    else if (arg === '--markdown') out.markdown = argv[++i];
    else if (arg.startsWith('--markdown=')) out.markdown = arg.slice('--markdown='.length);
    else if (arg === '--category') out.category = argv[++i];
    else if (arg.startsWith('--category=')) out.category = arg.slice('--category='.length);
    else if (arg === '--limit') out.limit = Number(argv[++i]) || out.limit;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length)) || out.limit;
    else if (arg === '--fail-open') out.failOpen = true;
  }
  if (!out.summary && !out.json && !out.markdown) out.summary = true;
  return out;
}

function walk(abs, predicate = () => true, out = []) {
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = path.join(abs, entry.name);
    if (entry.isDirectory()) walk(child, predicate, out);
    else if (entry.isFile() && predicate(child)) out.push(child);
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs).replaceAll('\\', '/');
}

function splitWords(input) {
  return String(input ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\\/]+/g, ' ')
    .trim();
}

function norm(input) {
  return splitWords(input).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function kebab(input) {
  return splitWords(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function classAliases(className) {
  const base = String(className);
  const shortAllowed = new Set(['IP']);
  const variants = [
    base,
    base.replace(/^Base/, ''),
    base.replace(/^Xml/, ''),
    base.replace(/(Addon|Deed|Gump|Quest|AI|Info|Entry|Component|Container|Reward|Scroll|Stone|Vendor)$/i, ''),
    kebab(base),
  ];
  return unique(variants.map(norm).filter((value) => value.length >= 3 || shortAllowed.has(base)));
}

function categoryOf(csRel) {
  const parts = csRel.split('/');
  const idx = parts.indexOf('Scripts');
  const category = idx >= 0 ? parts[idx + 1] : parts[0];
  const service = category === 'Services' ? parts[idx + 2] : null;
  return { category, service };
}

function parseClasses(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const text = stripCSharpComments(raw);
  const classes = [];
  const re = /\b(?:public|private|protected|internal|abstract|sealed|static|partial|\s)*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match;
  while ((match = re.exec(text))) {
    classes.push({
      name: match[1],
      abstract: /\babstract\s+class\s+/.test(text.slice(Math.max(0, match.index - 80), match.index + 40)),
    });
  }
  if (classes.length === 0) {
    classes.push({ name: path.basename(file, '.cs'), abstract: false, inferred: true });
  }
  return classes;
}

function stripCSharpComments(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ');
}

function collectServuoClasses() {
  const files = walk(SERVUO_ROOT, (file) => file.endsWith('.cs'));
  const records = [];
  for (const file of files) {
    const csRel = rel(file);
    const meta = categoryOf(csRel);
    for (const cls of parseClasses(file)) {
      records.push({
        servuoPath: csRel,
        servuoClass: cls.name,
        category: meta.category,
        service: meta.service,
        abstract: cls.abstract,
        inferred: cls.inferred === true,
      });
    }
  }
  return records;
}

function collectStrings(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (value.length >= 3 && value.length <= 120) out.add(value);
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (key.length >= 3 && key.length <= 120) out.add(key);
    if (['name', 'kind', 'label', 'title', 'id', 'key', 'script', 'tagId', 'type', 'resource', 'target', 'giver'].includes(key)) {
      collectStrings(val, out, depth + 1);
    } else if (depth < 2) {
      collectStrings(val, out, depth + 1);
    }
  }
}

function collectParityClassListStrings(text, out) {
  const listRe = /export\s+const\s+SERVUO_[A-Z0-9_]+_CLASSES\s*=\s*Object\.freeze\(\s*\[([\s\S]*?)\]\s*\)/g;
  let listMatch;
  while ((listMatch = listRe.exec(text))) {
    const body = listMatch[1];
    const stringRe = /['"]([A-Za-z_][A-Za-z0-9_]{2,})['"]/g;
    let stringMatch;
    while ((stringMatch = stringRe.exec(body))) out.add(stringMatch[1]);
  }
}

function collectNodeIndex() {
  const nodeFiles = NODE_ROOTS.flatMap((root) => walk(root, (file) => /\.(?:js|mjs|cjs)$/.test(file)));
  const files = [];
  for (const file of nodeFiles) {
    const st = fs.statSync(file);
    const text = st.size <= 300_000 ? fs.readFileSync(file, 'utf8') : '';
    const fileRel = rel(file);
    files.push({
      path: fileRel,
      pathNorm: norm(fileRel),
      stemNorm: norm(path.basename(file, path.extname(file))),
      contentNorm: text ? norm(text) : '',
    });
  }

  const testFiles = [];
  for (const file of TEST_ROOTS.flatMap((root) => walk(root, (entry) => /\.(?:test\.)?(?:js|mjs|cjs|ts|tsx)$/.test(entry)))) {
    const st = fs.statSync(file);
    const text = st.size <= 300_000 ? fs.readFileSync(file, 'utf8') : '';
    const fileRel = rel(file);
    testFiles.push({
      path: fileRel,
      pathNorm: norm(fileRel),
      stemNorm: norm(path.basename(file, path.extname(file))),
      contentNorm: text ? norm(text) : '',
    });
  }

  const dataEntries = [];
  for (const fileRel of DATA_FILES) {
    const file = path.join(ROOT, fileRel);
    if (!fs.existsSync(file)) continue;
    try {
      const st = fs.statSync(file);
      if (st.size > 3_000_000) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const strings = new Set();
      collectStrings(data, strings);
      for (const value of strings) {
        const valueNorm = norm(value);
        if (valueNorm.length >= 3) dataEntries.push({ value, valueNorm, path: fileRel });
      }
    } catch {
      // The audit should keep running if one data file is malformed.
    }
  }

  for (const fileRel of PARITY_CLASS_LIST_FILES) {
    const file = path.join(ROOT, fileRel);
    if (!fs.existsSync(file)) continue;
    try {
      const strings = new Set();
      collectParityClassListStrings(fs.readFileSync(file, 'utf8'), strings);
      for (const value of strings) {
        const valueNorm = norm(value);
        if (valueNorm.length >= 3) dataEntries.push({ value, valueNorm, path: fileRel });
      }
    } catch {
      // Explicit parity lists are advisory for the audit only.
    }
  }

  return { files, testFiles, dataEntries };
}

function serviceMapMatch(record) {
  if (record.category !== 'Services' || !record.service) return null;
  const mapped = SERVICE_MAP.get(record.service);
  if (!mapped) return null;
  const existing = mapped.filter((entry) => fs.existsSync(path.join(ROOT, entry)));
  if (existing.length === 0) return null;
  return {
    score: 72,
    path: existing[0],
    kind: 'service-map',
    reason: `service ${record.service} mapped to ${existing[0]}`,
  };
}

function findBestMatch(record, index) {
  const aliases = classAliases(record.servuoClass);
  const candidates = [];
  const mapped = serviceMapMatch(record);
  if (mapped) candidates.push(mapped);

  for (const alias of aliases) {
    for (const file of index.files) {
      if (file.stemNorm === alias) {
        candidates.push({ score: 100, path: file.path, kind: 'file-stem', reason: 'exact JS file stem match' });
      } else if (file.pathNorm.includes(alias)) {
        candidates.push({ score: 84, path: file.path, kind: 'file-path', reason: 'JS path contains class alias' });
      } else if (file.contentNorm && file.contentNorm.includes(alias)) {
        const definitionBoost = file.path.includes('/items/definitions/') || file.path.includes('/data/');
        candidates.push({
          score: definitionBoost ? 62 : 54,
          path: file.path,
          kind: 'file-content',
          reason: definitionBoost ? 'definition content contains class alias' : 'JS content contains class alias',
        });
      }
    }
    for (const entry of index.dataEntries) {
      if (entry.valueNorm === alias) {
        candidates.push({ score: 82, path: entry.path, kind: 'data-exact', reason: `data entry "${entry.value}"` });
      } else if (entry.valueNorm.includes(alias) || alias.includes(entry.valueNorm)) {
        candidates.push({ score: 58, path: entry.path, kind: 'data-fuzzy', reason: `fuzzy data entry "${entry.value}"` });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return candidates[0] ?? null;
}

function statusFor(record, match) {
  if (record.category === 'Deprecated' || record.category === 'bin' || record.category === 'obj') return 'IGNORED';
  if (record.abstract || /^Base[A-Z]/.test(record.servuoClass)) {
    return match && match.score >= 54 ? 'INFRA_MATCHED' : 'INFRA_UNMAPPED';
  }
  if (!match) return 'MISSING';
  if (match.score >= 80) return 'MATCHED';
  if (match.score >= 58) return 'PARTIAL';
  return 'WEAK';
}

function findBestTest(record, index) {
  const aliases = classAliases(record.servuoClass);
  const candidates = [];
  for (const alias of aliases) {
    for (const file of index.testFiles) {
      if (file.stemNorm.includes(alias) || file.pathNorm.includes(alias)) {
        candidates.push({ score: 90, path: file.path });
      } else if (file.contentNorm && file.contentNorm.includes(alias)) {
        candidates.push({ score: 60, path: file.path });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return candidates[0]?.path ?? null;
}

function ownerSystemFor(record, nodePath) {
  if (!nodePath) {
    if (record.category === 'Services' && record.service) return `service:${record.service}`;
    return `servuo:${record.category}`;
  }
  const parts = nodePath.split('/');
  const systemsIdx = parts.indexOf('systems');
  if (systemsIdx >= 0) return ['systems', ...parts.slice(systemsIdx + 1, -1)].join('/');
  const scriptsIdx = parts.indexOf('src');
  if (scriptsIdx >= 0 && parts[scriptsIdx + 1]) {
    return parts.slice(scriptsIdx + 1, Math.min(parts.length - 1, scriptsIdx + 3)).join('/');
  }
  return path.dirname(nodePath).replaceAll('\\', '/');
}

function isBehaviorCritical(record, status) {
  if (['IGNORED', 'INFRA_MATCHED', 'INFRA_UNMAPPED'].includes(status)) return false;
  if (record.abstract || /^Base[A-Z]/.test(record.servuoClass)) return false;
  return ['Items', 'Mobiles', 'Services', 'Spells', 'Skills', 'Quests', 'Multis'].includes(record.category);
}

function manualDecisionFor(record, status) {
  if (record.category === 'Deprecated' || record.category === 'obj' || record.category === 'bin') {
    return 'IGNORED_GENERATED_OR_DEPRECATED';
  }
  if (record.category === 'Services' && record.service === 'RemoteAdmin') {
    return 'REPLACED_BY_WEB_ADMIN';
  }
  if (!isBehaviorCritical(record, status) && status === 'MISSING') {
    return 'LOW_PRIORITY_INFRA_OR_DATA';
  }
  return null;
}

function priorityFor(record, status) {
  if (status === 'MATCHED' || status === 'INFRA_MATCHED' || status === 'IGNORED') return 'P3';
  if (['Items', 'Mobiles', 'Services', 'Spells', 'Skills', 'Quests', 'Multis'].includes(record.category)) {
    if (status === 'MISSING') return 'P1';
    return 'P2';
  }
  return status === 'MISSING' ? 'P2' : 'P3';
}

function buildMatrix() {
  const classes = collectServuoClasses();
  const index = collectNodeIndex();
  return classes
    .filter((record) => !args.category || record.category === args.category || record.service === args.category)
    .map((record) => {
      const match = findBestMatch(record, index);
      const status = statusFor(record, match);
      return {
        ...record,
        status,
        priority: priorityFor(record, status),
        nodePath: match?.path ?? null,
        testPath: findBestTest(record, index),
        ownerSystem: ownerSystemFor(record, match?.path ?? null),
        behaviorCritical: isBehaviorCritical(record, status),
        manualDecision: manualDecisionFor(record, status),
        matchKind: match?.kind ?? null,
        matchScore: match?.score ?? 0,
        reason: match?.reason ?? 'no Node data/script/system match found',
      };
    });
}

function groupCounts(records, keyFn) {
  const map = new Map();
  for (const record of records) {
    const key = keyFn(record);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function printTable(rows, columns) {
  const widths = columns.map((col) => Math.max(col.length, ...rows.map((row) => String(row[col] ?? '').length)));
  console.log(`| ${columns.map((col, i) => col.padEnd(widths[i])).join(' | ')} |`);
  console.log(`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
  for (const row of rows) {
    console.log(`| ${columns.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join(' | ')} |`);
  }
}

function toMarkdown(records) {
  const lines = [];
  lines.push('# ServUO class parity map');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Records: ${records.length}`);
  lines.push('');
  lines.push('## Status Counts');
  lines.push('');
  const statusRows = groupCounts(records, (record) => record.status)
    .map(([status, count]) => `| ${status} | ${count} |`);
  lines.push('| Status | Count |');
  lines.push('| --- | ---: |');
  lines.push(...statusRows);
  lines.push('');
  lines.push('## Missing / Weak Gameplay Classes');
  lines.push('');
  lines.push('| Priority | Category | Service | Class | ServUO Path | Best Node Path | Reason |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  const interesting = records
    .filter((record) => ['MISSING', 'WEAK', 'PARTIAL', 'INFRA_UNMAPPED'].includes(record.status))
    .filter((record) => record.priority !== 'P3')
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.category.localeCompare(b.category) || a.servuoClass.localeCompare(b.servuoClass));
  for (const record of interesting) {
    lines.push(`| ${record.priority} | ${record.category} | ${record.service ?? ''} | ${record.servuoClass} | ${record.servuoPath} | ${record.nodePath ?? ''} | ${record.reason} |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeFileEnsured(target, content) {
  const abs = path.resolve(ROOT, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

const matrix = buildMatrix();

if (args.json) {
  const abs = writeFileEnsured(args.json, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    root: ROOT,
    records: matrix,
  }, null, 2)}\n`);
  console.log(`[servuo-class-map] wrote ${path.relative(ROOT, abs)}`);
}

if (args.markdown) {
  const abs = writeFileEnsured(args.markdown, toMarkdown(matrix));
  console.log(`[servuo-class-map] wrote ${path.relative(ROOT, abs)}`);
}

if (args.summary) {
  console.log('# ServUO class parity map');
  console.log();
  console.log(`Records: ${matrix.length}`);
  console.log();
  console.log('## By Status');
  printTable(groupCounts(matrix, (record) => record.status).map(([status, count]) => ({ status, count })), ['status', 'count']);
  console.log();
  console.log('## By Category');
  printTable(groupCounts(matrix, (record) => record.category).map(([category, count]) => ({ category, count })), ['category', 'count']);
  console.log();
  console.log(`## Top ${args.limit} P1 Missing/Weak`);
  const rows = matrix
    .filter((record) => record.priority === 'P1' && ['MISSING', 'WEAK', 'PARTIAL', 'INFRA_UNMAPPED'].includes(record.status))
    .sort((a, b) => a.category.localeCompare(b.category) || String(a.service ?? '').localeCompare(String(b.service ?? '')) || a.servuoClass.localeCompare(b.servuoClass))
    .slice(0, args.limit)
    .map((record) => ({
      category: record.category,
      service: record.service ?? '',
      class: record.servuoClass,
      status: record.status,
      node: record.nodePath ?? '',
    }));
  printTable(rows, ['category', 'service', 'class', 'status', 'node']);
}

if (args.failOpen) {
  const open = matrix
    .filter((record) => ['MISSING', 'WEAK', 'PARTIAL', 'INFRA_UNMAPPED'].includes(record.status))
    .sort((a, b) => a.priority.localeCompare(b.priority) || a.category.localeCompare(b.category) || a.servuoClass.localeCompare(b.servuoClass));
  if (open.length > 0) {
    console.error(`[servuo-class-map] open records: ${open.length}`);
    for (const record of open.slice(0, args.limit)) {
      console.error(`${record.priority}\t${record.status}\t${record.category}\t${record.servuoClass}\t${record.reason}`);
    }
    process.exitCode = 1;
  }
}
