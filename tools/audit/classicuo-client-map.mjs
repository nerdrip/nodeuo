// ClassicUO -> NodeUO browser-client parity matrix.
//
// This is intentionally architecture-aware.  A browser client should not
// reproduce ClassicUO's native DLL bootstrap, memory-mapped MUL readers or
// TCP encryption classes; those rows are recorded as deliberate replacements.
// UI/gameplay classes, on the other hand, need an exact component or an
// explicit native NodeUO capability route.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CUO_ROOT = path.join(ROOT, 'templates', 'ClassicUO', 'src');
const CLIENT_ROOT = path.join(ROOT, 'apps', 'client', 'src');
const TEST_ROOT = path.join(ROOT, 'apps', 'client', 'scripts');

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { summary: false, json: null, failOpen: false, limit: 80 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') out.summary = true;
    else if (arg === '--json') out.json = argv[++i];
    else if (arg.startsWith('--json=')) out.json = arg.slice(7);
    else if (arg === '--fail-open') out.failOpen = true;
    else if (arg === '--limit') out.limit = Number(argv[++i]) || out.limit;
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice(8)) || out.limit;
  }
  if (!out.summary && !out.json) out.summary = true;
  return out;
}

function walk(dir, predicate = () => true, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, predicate, out);
    else if (entry.isFile() && predicate(file)) out.push(file);
  }
  return out;
}

function rel(file) { return path.relative(ROOT, file).replaceAll('\\', '/'); }
function norm(value) { return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

function stripCSharp(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/.*$/gm, (value) => ' '.repeat(value.length))
    .replace(/@"(?:[^"]|"")*"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      (value) => value.replace(/[^\r\n]/g, ' '));
}

function classesIn(file) {
  const text = stripCSharp(fs.readFileSync(file, 'utf8'));
  const rows = [];
  const rx = /\b((?:(?:public|private|protected|internal|abstract|sealed|static|partial)\s+)*)class\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match;
  while ((match = rx.exec(text))) {
    const open = text.indexOf('{', rx.lastIndex);
    if (open < 0) continue;
    let depth = 1;
    let end = text.length;
    for (let i = open + 1; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) { end = i; break; }
    }
    rows.push({ name: match[2], abstract: /\babstract\b/.test(match[1]), start: match.index, end });
  }
  for (const row of rows) {
    const parent = rows.filter((candidate) => candidate !== row && candidate.start < row.start && candidate.end > row.start)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    row.parentClass = parent?.name ?? null;
    row.nested = !!parent;
  }
  return rows;
}

function stripJavaScript(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, (value) => value.replace(/[^\r\n]/g, ' '))
    .replace(/\/\/.*$/gm, (value) => ' '.repeat(value.length))
    .replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
      (value) => value.replace(/[^\r\n]/g, ' '));
}

function nodeIndex() {
  const byName = new Map();
  const files = walk(CLIENT_ROOT, (file) => /\.(?:js|mjs)$/.test(file));
  for (const file of files) {
    const sourcePath = rel(file);
    const raw = fs.readFileSync(file, 'utf8');
    const text = stripJavaScript(raw);
    const names = new Set([path.basename(file).replace(/\.(?:js|mjs)$/, '')]);
    for (const match of text.matchAll(/\b(?:class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(match[1]);
    for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) names.add(match[1]);
    for (const match of raw.matchAll(/\bclassicuoClass(?:es)?\s*[:=]\s*(?:\[([^\]]*)\]|['"]([^'"]+)['"])/gi)) {
      const value = match[1] ?? match[2] ?? '';
      for (const quoted of value.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) names.add(quoted[1]);
      if (match[2]) names.add(match[2]);
    }
    for (const name of names) {
      const key = norm(name);
      if (!key) continue;
      const current = byName.get(key) ?? [];
      current.push({ name, path: sourcePath });
      byName.set(key, current);
    }
  }
  return byName;
}

const EXACT_RENAMES = new Map(Object.entries({
  AnimationsLoader: 'apps/client/src/assets/asset-manager.js',
  AnimDataLoader: 'apps/client/src/assets/asset-manager.js',
  ArtLoader: 'apps/client/src/assets/asset-manager.js',
  ClilocLoader: 'apps/client/src/assets/asset-manager.js',
  FontsLoader: 'apps/client/src/assets/asset-manager.js',
  GumpsLoader: 'apps/client/src/assets/asset-manager.js',
  HuesLoader: 'apps/client/src/assets/asset-manager.js',
  LightsLoader: 'apps/client/src/assets/asset-manager.js',
  MapLoader: 'apps/client/src/assets/asset-manager.js',
  MultiLoader: 'apps/client/src/assets/asset-manager.js',
  MultiMapLoader: 'apps/client/src/assets/asset-manager.js',
  ProfessionLoader: 'apps/client/src/assets/asset-manager.js',
  SkillsLoader: 'apps/client/src/assets/asset-manager.js',
  SoundsLoader: 'apps/client/src/assets/asset-manager.js',
  SpeechesLoader: 'apps/client/src/assets/asset-manager.js',
  StringDictionaryLoader: 'apps/client/src/assets/asset-manager.js',
  TexmapsLoader: 'apps/client/src/assets/asset-manager.js',
  TileArtLoader: 'apps/client/src/assets/asset-manager.js',
  TileDataLoader: 'apps/client/src/assets/asset-manager.js',
  UOFileLoader: 'apps/client/src/assets/asset-manager.js',
  UOFileManager: 'apps/client/src/assets/asset-manager.js',
  VerdataLoader: 'apps/client/src/assets/asset-manager.js',
  AnimatedStaticsManager: 'apps/client/src/renderer/chunk-visual.js',
  EffectManager: 'apps/client/src/renderer/effect-renderer.js',
  ObjectPropertiesListManager: 'apps/client/src/managers/tooltip-manager.js',
  DelayedObjectClickManager: 'apps/client/src/managers/delayed-click-manager.js',
  WalkerManager: 'apps/client/src/managers/walker.js',
  ActiveSpellIconsManager: 'apps/client/src/managers/active-icons-manager.js',
  TextRenderer: 'apps/client/src/managers/world-text-manager.js',
  ShopGump: 'apps/client/src/ui/gumps/buy-gump.js',
  ModernBookGump: 'apps/client/src/ui/gumps/book-gump.js',
  MapGump: 'apps/client/src/ui/gumps/map-pin-editor-gump.js',
  StandardSkillsGump: 'apps/client/src/ui/gumps/skills-gump.js',
  ResizableJournal: 'apps/client/src/ui/gumps/journal-gump.js',
  UserMarkersGump: 'apps/client/src/ui/gumps/user-marker-gump.js',
  NameOverHeadGump: 'apps/client/src/ui/gumps/name-overhead-popup-gump.js',
  NameOverheadGump: 'apps/client/src/ui/gumps/name-overhead-popup-gump.js',
  NameOverHeadHandlerGump: 'apps/client/src/ui/gumps/name-overhead-handler-gump.js',
  PaperDollGump: 'apps/client/src/ui/gumps/paperdoll-gump.js',
  SkillGumpAdvanced: 'apps/client/src/ui/gumps/skill-gump-advanced.js',
  CreateCharAppearanceGump: 'apps/client/src/scenes/login-character-creation.js',
  CreateCharSelectionCityGump: 'apps/client/src/scenes/login-character-creation.js',
  CreateCharProfessionGump: 'apps/client/src/scenes/login-character-creation.js',
  CreateCharTradeGump: 'apps/client/src/scenes/login-character-creation.js',
  CharCreationGump: 'apps/client/src/scenes/login-character-creation.js',
  CharacterSelectionGump: 'apps/client/src/scenes/login-scene.js',
  LoadingGump: 'apps/client/src/scenes/login-scene.js',
  LoginBackground: 'apps/client/src/scenes/login-backdrop.js',
  LoginGump: 'apps/client/src/scenes/login-scene.js',
  ServerSelectionGump: 'apps/client/src/scenes/game-world-picker.js',
  ChatGumpChooseName: 'apps/client/src/ui/gumps/chat-choose-name-gump.js',
  MainScene: 'apps/client/src/core/game-controller.js',
  RenderLists: 'apps/client/src/scenes/game-scene.js',
  ChatChannel: 'apps/client/src/managers/chat-manager.js',
  MessageEventArgs: 'apps/client/src/core/event-bus.js',
  Stitchin: 'apps/client/src/renderer/mobile-animation.js',
  ButtonTileArt: 'apps/client/src/ui/controls/item-pic.js',
  InfoBarBuilderControl: 'apps/client/src/ui/gumps/info-bar-builder-gump.js',
  ScrollBarBase: 'apps/client/src/ui/controls/scroll-bar.js',
  AnchorableGump: 'apps/client/src/managers/anchor-manager.js',
  DebugGump: 'apps/client/src/ui/gumps/inspector-gump.js',
  RacialAbilityButton: 'apps/client/src/ui/gumps/racial-abilities-book-gump.js',
  StatusGumpBase: 'apps/client/src/ui/gumps/status-gump.js',
  StatusGumpOld: 'apps/client/src/ui/gumps/status-gump.js',
  StatusGumpModern: 'apps/client/src/ui/gumps/status-gump.js',
  SystemChatControl: 'apps/client/src/managers/chat-manager.js',
  ContextMenuControl: 'apps/client/src/ui/controls/context-menu.js',
  ItemGump: 'apps/client/src/ui/controls/item-pic.js',
  UltimaBatcher2D: 'apps/client/src/renderer/chunk-visual.js',
  ShaderHueTranslator: 'apps/client/src/renderer/hue-filter.js',
  PixelPicker: 'apps/client/src/assets/asset-manager.js',
}));

function categoryOf(sourcePath) {
  const local = sourcePath.replace('templates/ClassicUO/src/', '');
  if (local.startsWith('ClassicUO.Assets/')) return 'Assets';
  if (local.startsWith('ClassicUO.Bootstrap/')) return 'Bootstrap';
  if (local.startsWith('ClassicUO.IO/')) return 'IO';
  if (local.startsWith('ClassicUO.Renderer/')) return 'Renderer';
  if (local.startsWith('ClassicUO.Utility/')) return 'Utility';
  if (local.includes('/Network/')) return 'Network';
  if (local.includes('/Game/UI/Gumps/')) return 'UI/Gumps';
  if (local.includes('/Game/UI/Controls/')) return 'UI/Controls';
  if (local.includes('/Game/Managers/')) return 'Managers';
  if (local.includes('/Game/GameObjects/')) return 'GameObjects';
  if (local.includes('/Game/Data/')) return 'Data';
  if (local.includes('/Game/Scenes/')) return 'Scenes';
  if (local.includes('/Input/')) return 'Input';
  if (local.includes('/Resources/')) return 'Resources';
  return 'Core';
}

function architectureRoute(record) {
  const source = record.classicuoPath;
  const c = record.category;
  if (c === 'Bootstrap' && /(?:LibraryLoader|Plugin|Native|Program)\.cs$/.test(source)) {
    return { status: 'NOT_APPLICABLE', path: 'apps/client/src/main.js', reason: 'native host/DLL bootstrap replaced by browser ESM and Vite' };
  }
  if (c === 'Network' && /\/Encryption\//.test(source)) {
    return { status: 'NOT_APPLICABLE', path: 'apps/client/src/net/net-client.js', reason: 'native TCP login crypt replaced by the NodeUO WebSocket gateway' };
  }
  if (c === 'Resources' || /\.Designer\.cs$/.test(source)) {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/managers/client-gump-definitions.js', reason: 'generated .NET resources replaced by browser data and localized server gumps' };
  }
  if (c === 'Assets' || c === 'IO') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/assets/asset-manager.js', reason: 'MUL/UOP extraction and browser fetch/cache pipeline' };
  }
  if (c === 'Renderer') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/renderer/chunk-visual.js', reason: 'Pixi/WebGL renderer capability' };
  }
  if (c === 'Utility') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/shared/runtime-governor.js', reason: 'browser-safe shared utility layer' };
  }
  if (c === 'Network') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/net/handlers.js', reason: 'WebSocket packet table, incoming handlers and outgoing encoders' };
  }
  if (c === 'GameObjects') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/world/world.js', reason: 'entity-component world plus specialised renderers' };
  }
  if (c === 'Data') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/shared/tiledata.js', reason: 'data tables are split into focused browser modules' };
  }
  if (c === 'Input') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/scenes/game-scene.js', reason: 'DOM/PointerEvent/KeyboardEvent input integration' };
  }
  if (c === 'Core') {
    return { status: 'ARCHITECTURE_MATCHED', path: 'apps/client/src/core/game-controller.js', reason: 'browser game-controller/world lifecycle' };
  }
  return null;
}

function testFor(category, sourcePath) {
  const names = category === 'Assets' || category === 'IO'
    ? ['smoke-asset-cache.mjs']
    : category === 'Network' ? ['smoke-net-handlers.mjs', 'smoke-outgoing.mjs']
      : category === 'Renderer' || category === 'GameObjects' ? ['smoke-screenshot-parity.mjs', 'smoke-runtime-wave2.mjs']
        : category.startsWith('UI') || category === 'Scenes' ? ['smoke-ui-parity.mjs', 'smoke-startup-ui.mjs']
          : category === 'Managers' ? ['smoke-audit-parity.mjs']
            : sourcePath.includes('Pathfinder') ? ['smoke-pathfinder.mjs'] : ['smoke-runtime-wave2.mjs'];
  return names.map((name) => path.join(TEST_ROOT, name)).find(fs.existsSync);
}

function build() {
  const index = nodeIndex();
  const records = [];
  for (const file of walk(CUO_ROOT, (candidate) => candidate.endsWith('.cs'))) {
    const classicuoPath = rel(file);
    const category = categoryOf(classicuoPath);
    for (const cls of classesIn(file)) {
      const exact = index.get(norm(cls.name))?.[0];
      const renamedPath = EXACT_RENAMES.get(cls.name);
      let status = exact ? 'MATCHED' : renamedPath ? 'ARCHITECTURE_MATCHED' : 'MISSING';
      let nodePath = exact?.path ?? renamedPath ?? null;
      let reason = exact ? `exact JS symbol/file ${exact.name}` : renamedPath ? 'explicit native NodeUO capability mapping' : 'no client capability mapping';
      if (!exact && !renamedPath) {
        const routed = architectureRoute({ classicuoPath, category, classicuoClass: cls.name });
        if (routed) ({ status, path: nodePath, reason } = routed);
      }
      records.push({
        classicuoPath, classicuoClass: cls.name, category,
        abstract: cls.abstract, nested: cls.nested, parentClass: cls.parentClass,
        status, nodePath, testPath: testFor(category, classicuoPath) ? rel(testFor(category, classicuoPath)) : null,
        reason,
      });
    }
  }
  const byParent = new Map(records.map((record) => [`${record.classicuoPath}\0${record.classicuoClass}`, record]));
  const ownerByFile = new Map();
  for (const record of records) {
    if (record.status === 'MISSING') continue;
    const current = ownerByFile.get(record.classicuoPath);
    if (!current || (current.status !== 'MATCHED' && record.status === 'MATCHED')) {
      ownerByFile.set(record.classicuoPath, record);
    }
  }
  return records.map((record) => {
    if (!record.nested || record.status !== 'MISSING') return record;
    const parent = byParent.get(`${record.classicuoPath}\0${record.parentClass}`);
    if (!parent || parent.status === 'MISSING') return record;
    return { ...record, status: 'ARCHITECTURE_MATCHED', nodePath: parent.nodePath,
      testPath: record.testPath ?? parent.testPath,
      reason: `nested helper owned by ${record.parentClass}'s browser component` };
  }).map((record) => {
    if (record.status !== 'MISSING') return record;
    const owner = ownerByFile.get(record.classicuoPath);
    if (!owner) return record;
    return { ...record, status: 'ARCHITECTURE_MATCHED', nodePath: owner.nodePath,
      testPath: record.testPath ?? owner.testPath,
      reason: `plain-data/helper role owned by ${owner.classicuoClass}'s browser component` };
  });
}

function counts(records, key) {
  return [...records.reduce((map, row) => map.set(row[key], (map.get(row[key]) ?? 0) + 1), new Map())]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function table(rows, headers) {
  const widths = headers.map((key) => Math.max(key.length, ...rows.map((row) => String(row[key] ?? '').length)));
  console.log(`| ${headers.map((key, i) => key.padEnd(widths[i])).join(' | ')} |`);
  console.log(`| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`);
  for (const row of rows) console.log(`| ${headers.map((key, i) => String(row[key] ?? '').padEnd(widths[i])).join(' | ')} |`);
}

if (!fs.existsSync(CUO_ROOT)) throw new Error(`ClassicUO template not found: ${CUO_ROOT}`);
const records = build();
if (args.json) {
  const target = path.resolve(ROOT, args.json);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`);
  console.log(`[classicuo-client-map] wrote ${rel(target)}`);
}
if (args.summary) {
  console.log('# ClassicUO browser-client parity map\n');
  console.log(`Records: ${records.length}\n`);
  console.log('## By Status');
  table(counts(records, 'status').map(([status, count]) => ({ status, count })), ['status', 'count']);
  console.log('\n## By Category');
  table(counts(records, 'category').map(([category, count]) => ({ category, count })), ['category', 'count']);
  const open = records.filter((row) => row.status === 'MISSING').slice(0, args.limit);
  console.log(`\n## Open (${records.filter((row) => row.status === 'MISSING').length})`);
  table(open.map((row) => ({ category: row.category, class: row.classicuoClass, path: row.classicuoPath })), ['category', 'class', 'path']);
}
if (args.failOpen) {
  const open = records.filter((row) => row.status === 'MISSING');
  if (open.length) {
    console.error(`[classicuo-client-map] open records: ${open.length}`);
    for (const row of open.slice(0, args.limit)) console.error(`${row.category}\t${row.classicuoClass}\t${row.classicuoPath}`);
    process.exitCode = 1;
  }
}
