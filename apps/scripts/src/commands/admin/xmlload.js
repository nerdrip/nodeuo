// `[xmlload` / `[xmlwipe` — bulk-register every entry in
// `apps/scripts/src/data/world/xmlspawners.json` (extracted from ServUO's
// Spawns/*.xml + RevampedSpawns/*.xml) with our spawner. Mirrors ServUO's
// `XmlLoad` / `XmlSpawnerCleanup` admin commands.
//
// 6788 spawn rectangles cover every classic facet (Felucca/Trammel +
// Ilshenar/Malas/Tokuno/TerMur), all the revamped dungeons, Eodon, the
// solen hives, and assorted SA / TOL content.
//
// XmlSpawner type names are PascalCase C# class names (Rat, Ratman,
// EarthElemental, OrcLord). We normalise to our kebab-case `kind` ids
// and silently drop spawn types not in our monster catalog — running
// [xmlload on a sparsely-stocked shard still places the spawn rect for
// the *known* kinds and ignores the rest.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { allItems } from '../../_spatial.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// admin → commands → src, then data/{world,config}. Single-`..` left
// these at `commands/data/...` which never existed → applyXmlSpawners
// returned +0 every time.
const DATA_PATH    = resolve(__dirname, '..', '..', 'data', 'world', 'xmlspawners.json');
const MONSTERS     = resolve(__dirname, '..', '..', 'data', 'config', 'monsters.json');

let _cache = null;
let _knownKinds = null;

function loadCatalog() {
  if (_cache) return _cache;
  if (!existsSync(DATA_PATH)) return [];
  try { _cache = JSON.parse(readFileSync(DATA_PATH, 'utf8')); }
  catch (e) { console.warn('[xmlload] read failed', e.message); _cache = []; }
  return _cache;
}

function loadKnownKinds() {
  if (_knownKinds) return _knownKinds;
  _knownKinds = new Set();
  if (!existsSync(MONSTERS)) return _knownKinds;
  try {
    const arr = JSON.parse(readFileSync(MONSTERS, 'utf8'));
    for (const m of arr) if (m?.kind) _knownKinds.add(m.kind);
  } catch (e) { console.warn('[xmlload] monsters read failed', e.message); }
  return _knownKinds;
}

// Map ServUO PascalCase class name → our kebab-case `kind` id. Most of the
// catalog follows the canonical pattern (`MountainGoat` → `mountain-goat`,
// `LichLord` → `lich-lord`); the override table picks up the handful of
// historical mismatches (e.g. `BlackBear` → `black-bear`, but `GiantSerpent`
// → `giant-serpent` works automatically).
const NAME_OVERRIDES = {
  // ServUO class → our kebab-case kind. Add only when pascalToKebab is
  // wrong — typically all-lowercase compound names ServUO writes
  // without a case separator (`giantspider` vs the camel-case form
  // pascalToKebab handles natively).
  //
  // Survey 2026-05-18 of `xmlspawners.json`: 8090 of 24917 spawn-kind
  // references were silently dropped before this table. Top offenders
  // mapped here recover ~95% of the loss; the rest are TreasureLevel*
  // (chests, not mobs — correctly dropped) and one-off variant
  // spellings.
  giantspider:      'giant-spider',
  airelemental:     'air-elemental',
  direwolf:         'dire-wolf',
  headlessone:      'headless-one',
  timberwolf:       'timber-wolf',
  blackbear:        'black-bear',
  brownbear:        'brown-bear',
  grizzlybear:      'grizzly-bear',
  polarbear:        'polar-bear',
  fireelemental:    'fire-elemental',
  waterelemental:   'water-elemental',
  earthelemental:   'earth-elemental',
  poisonelemental:  'poison-elemental',
  bloodelemental:   'blood-elemental',
  snowleopard:      'snow-leopard',
  greywolf:         'grey-wolf',
  sewerrat:         'sewer-rat',
  jackrabbit:       'jack-rabbit',
  greathart:        'great-hart',
  forestostard:     'forest-ostard',
  ridablellama:     'llama',
  rideablellama:    'llama',
  giantserpent:     'giant-serpent',
  giantrat:         'giant-rat',
  giantblackwidow:  'giant-black-widow',
  giantbeetle:      'giant-beetle',
  ancientlich:      'ancient-lich',
  boneknight:       'bone-knight',
  bonemage:         'bone-mage',
  liche:            'lich',
  lichlord:         'lich-lord',
  orclord:          'orc-lord',
  orccaptain:       'orc-captain',
  orcbomber:        'orc-bomber',
  orcishlord:       'orc-lord',
  orcishmage:       'orc-mage',
  evilmage:         'evil-mage',
  evilmagelord:     'evil-mage-lord',
  skeletalknight:   'skeletal-knight',
  skeletalmage:     'skeletal-mage',
  ettin:            'ettin',
  cyclops:          'cyclops',
  titan:            'titan',
  // WanderingHealer is a roaming healer-vendor in ServUO. Route to our
  // 'healer' vendor kind; the standard wander-AI shipped with vendor.js
  // will keep it pacing the world map.
  wanderinghealer:  'healer',
  whitewolf:        'white-wolf',
  plaguebeast:      'plague-beast',
  bullfrog:         'bull-frog',
  corrosiveslime:   'corrosive-slime',
  // ServUO vendor aliases that lack a case separator (the `pascal-to-
  // kebab` regex can't insert one). vendor.js VENDOR_ALIAS handles
  // these too at spawnAt time, but pre-normalising here lets xmlload
  // pass them through `hasKind`. Without the entry, the `hasKind` call
  // (lowercase check + alias) ALSO accepts them — kept here just for
  // log clarity (the dropped count drops from 21% → 4%).
  tailorguildmaster:    'tailor',
  mageguildmaster:      'mage',
  healerguildmaster:    'healer',
  blacksmithguildmaster:'blacksmith',
  tinkerguildmaster:    'tinker',
  fishermanguildmaster: 'fisherman',
  cartographerguildmaster: 'cartographer',
  rangerguildmaster:    'wanderer',
  weaponsmith:          'blacksmith',
  armorer:              'blacksmith',
  plaguespawn:          'plague-spawn',
  toxicelemental:       'toxic-elemental',
  silverserpent:        'silver-serpent',
  // ServUO `Ophidian*` class hierarchy doesn't match ours 1:1. Map to
  // the closest behavioural analog in monsters.json (justicar = mid-
  // tier mage, knight-errant = sword/shield, warrior = brawler).
  ophidianwarrior:      'ophidian-warrior',
  ophidianmage:         'ophidian-justicar',
  ophidianknight:       'ophidian-knight-errant',
  ophidianarchmage:     'ophidian-justicar',
  ophidianapprenticemage: 'ophidian-apprentice-mage',
  ophidianmatriarch:    'ophidian-matriarch',
  ophidianshaman:       'ophidian-shaman',
  ophidianavenger:      'ophidian-avenger',
  ophidianberserker:    'ophidian-berserker-warrior',
  ophidianjusticar:     'ophidian-justicar',
  // Compound mob names (ServUO writes them without a case separator
  // in many XML files — `deathwatchbeetle` instead of `DeathWatchBeetle`).
  deathwatchbeetle:     'death-watch-beetle',
  deathwatchbeetlehatchling: 'death-watch-beetle-hatchling',
  lavalizard:           'lava-lizard',
  lavasnake:            'lava-snake',
  jukawarrior:          'juka-warrior',
  jukamage:             'juka-mage',
  jukalord:             'juka-lord',
  snowelemental:        'snow-elemental',
  dreadspider:          'dread-spider',
  bogthing:             'bog-thing',
  frosttroll:           'frost-troll',
  iceserpent:           'ice-serpent',
  icesnake:             'ice-snake',
  terathanavenger:      'terathan-avenger',
  terathandrone:        'terathan-drone',
  terathanmatriarch:    'terathan-matriarch',
  terathanwarrior:      'terathan-warrior',
  strongmongbat:        'strong-mongbat',
  fandancer:            'fan-dancer',
  mountaingoat:         'mountain-goat',
  stonegargoyle:        'stone-gargoyle',
  ratmanarcher:         'ratman-archer',
  yomotsuwarrior:       'yomotsu-warrior',
  seaserpent:           'sea-serpent',
  vampirebat:           'vampire-bat',
  gazerlarva:           'gazer-larva',
  stoneharpy:           'stone-harpy',
  shadowknight:         'shadow-knight',
  shadowwyrm:           'shadow-wyrm',
  shadowwisp:           'shadow-wisp',
  shadowiron:           'shadow-iron-elemental',
  shadowironelemental:  'shadow-iron-elemental',
  // Camps spawn a parent monster of the camp type + child NPCs. Map
  // them to a placeholder for now — the camp itself is just an
  // ambient orcs / ratmen cluster.
  orccamp:              'orc',
  ratcamp:              'ratman',
  lizardmencamp:        'lizardman',
  ophidiancamp:         'ophidian-warrior',
  // Ratman variants.
  ratmanmage:           'ratman',         // no dedicated mage in our catalog
  // Misc compound-name variants present in xmlspawners.json.
  lizardman:            'lizardman',      // direct (defensive)
  vampirelord:          'vampire-bat',    // no vampire-lord; closest analog
  // Tropical fauna (no catalog entry — pick closest analog).
  tropicalbird:         'bird',
  // Quest-only NPCs without combat stats — fall back to wanderer so
  // the spawner places something visible instead of dropping silently.
  escortablemage:       'wanderer',
  seekerofadventure:    'wanderer',
  evilhealer:           'healer',
  realestatebroker:     'provisioner',
  // Missing-from-catalog mobs — map to generic 'wanderer' so the
  // spawner places SOMETHING instead of leaving the rect empty.
  // These can be promoted to dedicated monsters.json entries later.
  diabolicalseaweed:    'wanderer',
  paralithode:          'wanderer',
  nightmare:            'nightmare-piranha',  // closest visual analog
  shadowfiend:          'shadow-dweller',
  miniaturemushroom:    'wanderer',
  eliteninja:           'wanderer',
  serpentsfangassassin: 'wanderer',
  dragonsflamemage:     'wanderer',
  changeling:           'wanderer',
  customhairstylist:    'hairstylist',
  // Tokuno facet mobs (xmlspawners writes lowercase).
  tsukiwolf:            'tsuki-wolf',
  kazekemono:           'kaze-kemono',
  // Despise Revamped mobs — RevampedSpawns/DespiseRevamped.xml lists
  // ~15 unique kinds with the `,{RND,4,8}` random-count suffix (handled
  // by pascalToKebab). Most aren't in monsters.json yet; fall back to
  // a generic monster so the spawner places SOMETHING instead of
  // dropping the entire rect.
  phantom:              'wraith',
  naba:                 'ettin',
  darkmane:             'nightmare-piranha',
  skeletrex:            'skeleton',
  hellion:              'demon',
  echidnite:            'giant-serpent',
  prometheoid:          'fire-elemental',
  silenii:              'satyr',
  birlingblades:        'wisp',
  forestnymph:          'pixie',
  sagittarri:           'centaur',
  despiseunicorn:       'unicorn',
  fairy:                'pixie',
  ursadane:             'grizzly-bear',
  divineguardian:       'titan',
  dendrite:             'satyr',
  eldergazer:           'gazer',
  // Tail of remaining drops from the xmlspawners.json audit — most
  // compound mob names that exist in monsters.json under proper
  // kebab-case, plus a handful of fallbacks for entries with no
  // direct catalog match (mapped to the closest behavioural analog).
  bonemagi:             'bone-magi',
  gianttoad:            'giant-toad',
  iceelemental:         'ice-elemental',
  dullcopperelemental:  'dull-copper-elemental',
  runebeetle:           'rune-beetle',
  frostspider:          'frost-spider',
  frostooze:            'frost-ooze',
  patchworkskeleton:    'patchwork-skeleton',
  ogrelord:             'ogre-lord',
  arcticogrelord:       'arctic-ogre-lord',
  orcbrute:             'orc-brute',
  swamptentacle:        'swamp-tentacle',
  desertostard:         'desert-ostard',
  bakekitsune:          'bake-kitsune',
  lavaserpent:          'lava-serpent',
  lavaelemental:        'lava-elemental',
  insanedryad:          'insane-dryad',
  redsolenworker:       'red-solen-worker',
  redsolenwarrior:      'red-solen-warrior',
  blacksolenworker:     'black-solen-worker',
  blacksolenwarrior:    'black-solen-warrior',
  lesserhiryu:          'lesser-hiryu',
  revenantlion:         'revenant-lion',
  whippingvine:         'whipping-vine',
  hordeminion:          'horde-minion',
  yomotsupriest:        'yomotsu-priest',
  rottingcorpse:        'rotting-corpse',
  chaosdaemon:          'chaos-daemon',
  greaterdragon:        'greater-dragon',
  firegargoyle:         'fire-gargoyle',
  firedaemon:           'fire-daemon',
  sandvortex:           'sand-vortex',
  khaldunsummoner:      'khaldun-summoner',
  khaldunzealot:        'khaldun-zealot',
  khaldunrevenant:      'khaldun-revenant',
  exodusminion:         'exodus-minion',
  // Closest analogs for kinds not in monsters.json.
  golemcontroller:      'golem',         // the golem itself, controller is a flag
  savagerider:          'savage',        // rider's body; mount is separate
  savageshaman:         'savage',
  mudpie:               'slime',
  lizardmandefender:    'lizardman-defender',
  lizardmansquatter:    'lizardman-squatter',
  wanderingshaman:      'lizardman-shaman',
  demonicjailor:        'demonic-jailor',
  interredgrizzle:      'monstrous-interred-grizzle',
  greaterwaterelemental:'water-elemental',
  vilemage:             'evil-mage',
  eternalgazer:         'gazer',
  mudelemental:         'earth-elemental',
  corruptedmage:        'evil-mage',
  moltenearthelemental: 'fire-elemental',
  hungryogre:           'hungry-ogre',
  speckledscorpion:     'scorpion',
  pumpkin:              'pumpkin-head',
  dragonsflamegrandmage:'evil-mage-lord',
  cavetroll:            'troll',
  cavetrollwrong:       'cave-troll-wrong',
  minorrevenant:        'revenant',
  haochisguardsman:     'ronin',
  // Quest / faction / role NPCs — fall back to wanderer (ambient
  // villager flavor without a shop). These are role-flavor mobs that
  // ServUO's XmlSpawner places for story dressing; using wanderer
  // ensures the spawner places a body instead of leaving the rect
  // empty. Promote individual entries to dedicated monsters.json
  // entries later if they need combat stats.
  tigersclawthief:      'wanderer',
  agentofthecrown:      'wanderer',
  wrongprisoner:        'wrong-prisoner',
  elfbrigand:           'wanderer',
  elfbrigandcamp:       'wanderer',
  hiddenfigure:         'wanderer',
  cursed:               'wanderer',     // closest: cursed-soul exists but is undead — wanderer is safer
  hirepeasant:          'wanderer',
  // Guild masters without dedicated shop kinds → wanderer behavior
  // (ambient NPC). xmlspawners doesn't reach the alias system for
  // these because they don't end in `guildmaster` of an existing
  // VENDOR_KINDS slot.
  warriorguildmaster:   'wanderer',
  bardguildmaster:      'bard',         // bard IS in VENDOR_ALIAS → ambient flavour
  minerguildmaster:     'wanderer',
  // Misc one-offs.
  exoduschest:          'wanderer',     // not actually a mob (treasure-like) — skip via wanderer fallback
  // Final-tail audit additions — recovered from the residual 3.7% drop.
  trapdoorspider:       'trapdoor-spider',
  ladyofthesnow:        'lady-of-the-snow',
  wildtiger:            'wild-tiger',
  plagueeagle:          'plague-rat',     // closest analog (no plague-eagle in catalog)
  desertscorpion:       'scorpion',
  myrmidexlarvae:       'wanderer',       // no myrmidex line in catalog
  prisonercamp:         'wanderer',
  // Quest / role NPCs with no combat template.
  executioner:          'wanderer',
  impresario:           'bard',
  jwilson:              'wanderer',
  // ServUO's `fisherguildmaster` short form (vs `fishermanguildmaster`).
  fisherguildmaster:    'fisherman',
  // Residual long-tail (≤5 occurrences each) — wraps up the last 3.4%
  // of xmlspawners.json references. Direct kebab where it exists,
  // closest analog where it doesn't.
  wildwhitetiger:       'wild-tiger',
  wildblacktiger:       'wild-tiger',
  // Eodon dinosaur line — no dino entries in monsters.json yet, so
  // route to drake/saurian-warrior etc. (closest behavioural fits).
  anchisaur:            'drake',
  archaeosaurus:        'drake',
  dimetrosaur:          'drake',
  gallusaurus:          'drake',
  saurian:              'saurian-brute',
  // Misc.
  plaguebeastlord:      'plague-beast-lord',
  icefiend:             'ice-fiend',
  ancientwyrm:          'ancient-wyrm',
  spectralarmour:       'spectral-armour',
  spectralarmor:        'spectral-armour',
  swampdragon:          'swamp-dragon',
  nestwithegg:          'wanderer',     // not a mob; treasure-like
  // Faction / order / chaos guards — ServUO town guards. wanderer
  // gives them a body; faction logic comes from a different system.
  peasant:              'wanderer',
  orderguard:           'wanderer',
  chaosguard:           'wanderer',
  // Final residual additions.
  crystalelemental:     'crystal-elemental',
  skitteringhopper:     'skittering-hopper',
  antlion:              'ant-lion',
  greatermongbat:       'greater-mongbat',
  graygoblin:           'gray-goblin',
  beetle:               'giant-beetle',
  mushroomtrap:         'wanderer',     // not a mob, world trap
  powergenerator:       'wanderer',     // exodus dungeon prop
  serpentnest:          'giant-serpent',
  eggs:                 'wanderer',     // hatch-triggers, not mobs
  graygoblinmage:       'gray-goblin-mage',
  wolfspider:           'wolf-spider',
  greaterearthelemental:'earth-elemental',
  shameearthelemental:  'earth-elemental',
  flameelemental:       'fire-elemental',
  unboundenergyvortex:  'energy-vortex',
  chaosvortex:          'energy-vortex',
  barrelofbarley:       'wanderer',     // barrel item, not a mob
};

function splitTopLevel(text, sep = '/') {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseXmlValue(value) {
  const s = String(value ?? '').trim();
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\{RND\s*,/i.test(s)) {
    const parts = splitTopLevel(s.replace(/^\{|\}$/g, ''), ',');
    const lo = Number(parts[1] ?? 0) | 0;
    const hi = Number(parts[2] ?? lo) | 0;
    return lo + Math.floor(Math.random() * Math.max(1, hi - lo + 1));
  }
  return s;
}

function baseKindToken(name) {
  if (!name) return null;
  // Strip XmlSpawner directives — ServUO RevampedSpawns/*.xml writes
  // entries like `Phantom,{RND,4,8}` (spawn 4-8 random) or
  // `Skeleton/z/100` (z-anchor override). Everything from the first
  // `,` or `/` is metadata, not part of the mob class name.
  const cleaned = String(name).split(/[,/]/)[0].trim();
  return cleaned || null;
}

function parseSpawnDirectives(rawName) {
  const parts = splitTopLevel(rawName, '/');
  parts.shift(); // base type + ctor args
  const props = {};
  const attachments = [];
  const actions = [];
  for (let i = 0; i < parts.length;) {
    const token = (parts[i++] ?? '').trim();
    const upper = token.toUpperCase();
    if (!token) continue;
    if (upper === 'ATTACH') {
      const arg = parts[i++] ?? '';
      const bits = splitTopLevel(arg, ',');
      const type = bits.shift()?.trim();
      const opts = {};
      for (const bit of bits) {
        const eq = bit.indexOf('=');
        if (eq > 0) opts[bit.slice(0, eq).trim()] = parseXmlValue(bit.slice(eq + 1));
        else if (opts.amount == null) opts.amount = parseXmlValue(bit);
      }
      if (type) attachments.push({ type, opts });
      continue;
    }
    if (upper === 'MSG' || upper === 'SENDMSG' || upper === 'PRIVMSG') {
      actions.push({ type: 'message', text: parts[i++] ?? '' });
      continue;
    }
    if (upper === 'SAY' || upper === 'SPEECH') {
      actions.push({ type: 'say', text: parts[i++] ?? '' });
      continue;
    }
    if (upper === 'SOUND') {
      actions.push({ type: 'sound', soundId: parseXmlValue(parts[i++] ?? '0') });
      continue;
    }
    const value = parts[i++];
    if (value !== undefined) props[token] = parseXmlValue(value);
  }
  return { props, attachments, actions };
}

function pascalToKebab(name) {
  const cleaned = baseKindToken(name);
  if (!cleaned) return null;
  // Case-insensitive override lookup — ServUO XML mixes casing for the
  // same kind (`Ridablellama` vs `ridablellama` both appear in
  // `Spawns/trammel.xml`). Match the lowercase form so one override
  // entry covers both spellings.
  const lc = cleaned.toLowerCase();
  if (NAME_OVERRIDES[lc]) return NAME_OVERRIDES[lc];
  if (NAME_OVERRIDES[cleaned]) return NAME_OVERRIDES[cleaned];
  // Insert a dash between (lowercase|number)→Uppercase boundaries.
  return cleaned
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/** Detect `TreasureLevel<N>` (any case) and return the level 1..5, or 0.
 *  Tolerant of XmlSpawner directives — `TreasureLevel3,{RND,1,2}` etc. */
function treasureLevelOf(rawName) {
  if (!rawName) return 0;
  const base = rawName.split(/[,/]/)[0].trim();
  const m = /^treasure\s*level\s*(\d)/i.exec(base);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= 5 ? n : 0;
}

function normaliseKinds(rawKinds, known, vendorHas) {
  const out = [];
  for (const k of rawKinds) {
    // Treasure chests are spawned through a separate item-spawn path
    // (see `applyTreasureChests` below). Skip from the mob normaliser
    // so they don't get rejected as unknown monster kinds.
    if (treasureLevelOf(k.name)) continue;
    const kind = pascalToKebab(k.name);
    if (!kind) continue;
    // Two acceptance paths: monster catalog (hostile aggro mobs) OR
    // vendor registry (banker / blacksmith / tailor / etc.). ServUO's
    // XmlSpawner files list vendors alongside monsters using the same
    // <Objects2>banker:MX=1...</Objects2> notation, so we accept both
    // and let `spawnFactory` route to the right spawn path at tick
    // time. Without the vendor branch, 50 banker spawners + ~6000
    // other vendor entries silently get `dropped` on every [createworld
    // and Britain Bank ends up empty.
    const isKnownMonster = known.size && known.has(kind);
    const isKnownVendor  = typeof vendorHas === 'function' && vendorHas(kind);
    if (!isKnownMonster && !isKnownVendor) continue;
    const meta = parseSpawnDirectives(k.name);
    out.push({
      kind,
      weight: Math.max(1, k.max | 0),
      raw: k.name,
      ...meta,
      z: meta.props?.Z ?? meta.props?.z,
    });
  }
  return out;
}

/** Extract `TreasureLevel<N>` entries from a spawner's kinds list. */
function treasureKindsFor(rawKinds) {
  const out = [];
  for (const k of rawKinds) {
    const lvl = treasureLevelOf(k.name);
    if (lvl) out.push({ level: lvl, max: Math.max(1, k.max | 0) });
  }
  return out;
}

export function applyXmlSpawners(api, opts = {}) {
  const catalog = loadCatalog();
  if (!catalog.length) return { added: 0, dropped: 0, chests: 0 };
  const known = loadKnownKinds();
  if (!api.spawner) {
    api.log?.('[xmlload] api.spawner missing — cannot register');
    return { added: 0, dropped: catalog.length, chests: 0 };
  }
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const fileFilter = opts.fileFilter ?? null;
  const world = api.world;
  if (!world._xmlSpawnersApplied) world._xmlSpawnersApplied = new Set();
  if (!world._treasureChestsApplied) world._treasureChestsApplied = new Set();
  // Self-heal: rebuild the treasure-chest applied set from existing items
  // so a server restart doesn't double-spawn chests beside the persisted
  // ones (matches the moongate self-heal pattern).
  for (const it of allItems({ world })) {
    if (it.script === 'treasure-chest' && it._xmlTreasureId) {
      world._treasureChestsApplied.add(it._xmlTreasureId);
    }
  }
  let added = 0; let dropped = 0; let chests = 0;
  for (let i = 0; i < catalog.length; i++) {
    const sp = catalog[i];
    if (!sp.isRunning) continue;
    if (wantFacets && !wantFacets.has(sp.map)) continue;
    if (fileFilter && !sp.name?.toLowerCase?.().includes(fileFilter)) continue;
    // Treasure chests: ServUO writes them as XmlSpawner entries with a
    // `TreasureLevel<N>` kind. Skip the mob-spawner registration and
    // place a single treasure-chest-N item at the spawner's centre tile.
    // The chest is permanent (no respawn timer) — once looted/destroyed
    // it stays gone until the next [createworld pass. Mirrors ServUO's
    // behaviour where treasure chests are static decorations the
    // spawner places once at boot.
    const treasures = treasureKindsFor(sp.kinds);
    if (treasures.length) {
      const cx = sp.x1 + Math.floor((sp.x2 - sp.x1) / 2);
      const cy = sp.y1 + Math.floor((sp.y2 - sp.y1) / 2);
      for (const t of treasures) {
        const tid = `xml-treasure-${sp.map}-${cx}-${cy}-${t.level}-${i}`;
        if (world._treasureChestsApplied.has(tid)) continue;
        try {
          const item = createItem(api, world, {
            itemId: 0x09AB, hue: 0,
            x: cx, y: cy, z: 0, map: sp.map,
            movable: false,
          });
          item.script = 'treasure-chest';
          item.treasureLevel = t.level;
          item._xmlTreasureId = tid;
          item.isDecoration = true;
          world._treasureChestsApplied.add(tid);
          chests++;
        } catch (e) {
          api.log?.(`[xmlload] treasure chest L${t.level} @ map=${sp.map} (${cx},${cy}): ${e.message}`);
        }
      }
    }
    const kinds = normaliseKinds(sp.kinds, known, api.vendors?.hasKind);
    if (!kinds.length) {
      if (!treasures.length) dropped++;
      continue;
    }
    const id = `xml-${sp.map}-${sp.x1}-${sp.y1}-${i}`;
    // `_xmlSpawnersApplied` is persisted with the world, while
    // `api.spawner.groups` is runtime-only. After a restart the marker
    // survived but every actual group was gone, so CreateWorld reported
    // success and towns remained empty forever. Skip only when the live
    // registry really contains the group; otherwise reconstruct it.
    if (world._xmlSpawnersApplied.has(id) && api.spawner.groups?.has?.(id)) continue;
    try {
      api.spawner.add({
        id, map: sp.map,
        rect: { x1: sp.x1, y1: sp.y1, x2: sp.x2, y2: sp.y2 },
        maxCount: Math.max(1, sp.maxCount | 0),
        respawnMs: [Math.max(1000, sp.minDelayMs), Math.max(2000, sp.maxDelayMs)],
        kinds,
        proximityRange: sp.proximityRange > 0 ? sp.proximityRange : 0,
        team: sp.team | 0,
      });
      world._xmlSpawnersApplied.add(id);
      added++;
    } catch (e) { dropped++; api.log?.(`[xmlload] add failed ${id}: ${e.message}`); }
  }
  return { added, dropped, chests };
}

/** Make shop NPCs available immediately after an explicit population or a
 * runtime-registry restore. Hostile/ambient groups keep their stagger. */
export function primeVendorSpawners(api, passes = 4) {
  if (!api.spawner?.tick || !api.spawner.groups) return 0;
  const isVendorKind = (entry) => {
    const raw = Array.isArray(entry) ? entry[0] : (entry?.kind ?? entry?.name ?? entry);
    return !!raw && api.vendors?.hasKind?.(String(raw).toLowerCase());
  };
  let primed = 0;
  for (let pass = 0; pass < Math.max(1, passes | 0); pass++) {
    const now = Date.now() + pass;
    for (const group of api.spawner.groups.values()) {
      if (group.spawnedSerials?.size >= group.maxCount) continue;
      if (!group.kinds?.some?.(isVendorKind)) continue;
      group.nextSpawnAt = now;
      primed++;
    }
    api.spawner.tick(now);
  }
  return primed;
}

export function deleteXmlSpawners(api, opts = {}) {
  const wantFacets = opts.facets ? new Set(opts.facets) : null;
  const world = api.world;
  // Destroy treasure-chest items too — `[xmlwipe` should clear the
  // same surface `applyXmlSpawners` placed.
  if (world._treasureChestsApplied) {
    const victims = [];
    for (const it of allItems({ world })) {
      if (it.script !== 'treasure-chest') continue;
      if (!it._xmlTreasureId) continue;
      if (wantFacets && !wantFacets.has(it.map)) continue;
      victims.push(it.serial);
    }
    for (const s of victims) {
      try { destroyItemBySerial(api, s); }
      catch { /* gone */ }
    }
    if (wantFacets) {
      for (const tid of world._treasureChestsApplied) {
        const m = tid.match(/^xml-treasure-(\d+)-/);
        const map = m ? parseInt(m[1], 10) : null;
        if (map != null && wantFacets.has(map)) world._treasureChestsApplied.delete(tid);
      }
    } else {
      world._treasureChestsApplied.clear();
    }
  }
  if (!world._xmlSpawnersApplied) return { removed: 0 };
  let removed = 0;
  const keep = new Set();
  for (const id of world._xmlSpawnersApplied) {
    if (wantFacets) {
      const m = id.match(/^xml-(\d+)-/);
      const map = m ? parseInt(m[1], 10) : null;
      if (map != null && !wantFacets.has(map)) { keep.add(id); continue; }
    }
    // XmlWipe/DeleteWorld owns both the definition and every creature it
    // spawned. Leaving those mobiles behind produced thousands of orphaned
    // AI actors after a nominally successful delete/recreate cycle.
    try { api.spawner.remove(id, { despawn: true }); removed++; }
    catch { /* ignore */ }
  }
  world._xmlSpawnersApplied = keep;
  return { removed };
}

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'xmlload',
    help: '[xmlload [facet...] [filename-substring] — register every ServUO XmlSpawner rect for the given facets.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = []; let fileFilter = null;
      for (const a of args) {
        const n = parseInt(a, 10);
        if (Number.isFinite(n) && n >= 0 && n <= 5) facets.push(n);
        else fileFilter = String(a).toLowerCase();
      }
      const opts = {};
      if (facets.length) opts.facets = facets;
      if (fileFilter)    opts.fileFilter = fileFilter;
      const r = applyXmlSpawners(api, opts);
      ctx.state.sendSystemMessage(
        `XmlLoad: +${r.added} groups, +${r.chests | 0} chests (dropped ${r.dropped} unknown).`,
      );
    },
  });

  api.commands.register({
    name: 'xmlwipe',
    help: '[xmlwipe [facet...] — unregister every spawner [xmlload registered.',
    access: 'Admin',
    run(ctx) {
      const args = ctx.args ?? [];
      const facets = args.map((s) => parseInt(s, 10)).filter(Number.isFinite);
      const opts = facets.length ? { facets } : {};
      const r = deleteXmlSpawners(api, opts);
      ctx.state.sendSystemMessage(`XmlWipe: -${r.removed} groups removed.`);
    },
  });

  // Spawner groups themselves are intentionally not persisted. Restore
  // them after all scripts (especially vendor kinds) have had a chance to
  // register. This also repairs existing worlds without requiring another
  // destructive [recreateworld pass.
  let restoreTimer = null;
  // Old saves persisted `_createWorldDone` but, before the world-meta fix,
  // lost `_xmlSpawnersApplied`. Rebuild for either marker so an upgraded
  // shard cannot boot with decorations present and every NPC/vendor group
  // missing. A brand-new world remains empty until CreateWorld is requested.
  const createWorldDone = Object.prototype.hasOwnProperty.call(api.world ?? {}, '_createWorldDone')
    && api.world._createWorldDone;
  if (createWorldDone || api.world?._xmlSpawnersApplied?.size) {
    const restore = () => {
      const result = applyXmlSpawners(api);
      const primed = primeVendorSpawners(api);
      api.log?.(`[xmlload] runtime restore: +${result.added} groups, primed=${primed}`);
    };
    if (api.lifecycle?.setTimeout) api.lifecycle.setTimeout(restore, 1500);
    else {
      restoreTimer = setTimeout(restore, 1500);
      restoreTimer.unref?.();
    }
  }

  return () => { if (restoreTimer) clearTimeout(restoreTimer); };
}
