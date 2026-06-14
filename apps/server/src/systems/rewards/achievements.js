// Achievements + Titles — server-side bookkeeping for player progress
// milestones. Mirrors ServUO `Engines/PointsSystems/PlayerMobileProps`
// achievement hooks + the title catalog that ML/SA shipped.
//
// Storage on account:
//   account.achievements = { unlocked: Set<string>, progress: { [key]: number } }
//   account.titles       = { active: 'titleId' | null, unlocked: Set<string> }
//
// The catalog below is data-only; gameplay code calls `progress(account,
// key, amount=1)` to bump a counter, then `unlock(account, achievement)`
// completes it. Unlocking grants any reward listed (currently a title +
// optional item drop).

const _achievements = new Map();

function register(def) {
  _achievements.set(def.id, Object.freeze(def));
}

// =====================================================================
//  COMBAT achievements
// =====================================================================
register({ id: 'first-blood',     name: 'First Blood',
  description: 'Defeat your first hostile creature.',
  trigger: { kind: 'kill-count', target: 1 },
  reward: { title: 'first-blood' } });
register({ id: 'centurion',        name: 'Centurion',
  description: 'Defeat 100 hostile creatures.',
  trigger: { kind: 'kill-count', target: 100 },
  reward: { title: 'centurion' } });
register({ id: 'slayer-of-many',   name: 'Slayer of Many',
  description: 'Defeat 1000 hostile creatures.',
  trigger: { kind: 'kill-count', target: 1000 },
  reward: { title: 'slayer-of-many' } });

register({ id: 'dragonslayer',     name: 'Dragonslayer',
  description: 'Defeat a dragon.', trigger: { kind: 'kill-kind', mobKind: 'Dragon' },
  reward: { title: 'dragonslayer' } });
register({ id: 'liche-bane',       name: 'Liche Bane',
  description: 'Defeat an Ancient Lich.', trigger: { kind: 'kill-kind', mobKind: 'AncientLich' },
  reward: { title: 'liche-bane' } });
register({ id: 'demon-hunter',     name: 'Demon Hunter',
  description: 'Defeat a Balron.', trigger: { kind: 'kill-kind', mobKind: 'Balron' },
  reward: { title: 'demon-hunter' } });

// =====================================================================
//  CRAFTING achievements
// =====================================================================
register({ id: 'first-crafted',    name: 'Apprentice Crafter',
  description: 'Craft your first item.',
  trigger: { kind: 'craft-count', target: 1 },
  reward: { title: 'apprentice-crafter' } });
register({ id: 'master-crafter',   name: 'Master Crafter',
  description: 'Craft 1000 items.',
  trigger: { kind: 'craft-count', target: 1000 },
  reward: { title: 'master-crafter' } });
register({ id: 'exceptional',      name: 'Exceptional Hands',
  description: 'Craft 100 exceptional items.',
  trigger: { kind: 'exceptional-craft', target: 100 },
  reward: { title: 'exceptional-hands' } });
register({ id: 'imbuer',           name: 'Imbuer',
  description: 'Imbue 50 properties.',
  trigger: { kind: 'imbue-count', target: 50 },
  reward: { title: 'imbuer' } });

// =====================================================================
//  EXPLORATION achievements
// =====================================================================
register({ id: 'first-mapped',     name: 'Cartographer',
  description: 'Decode your first treasure map.',
  trigger: { kind: 'tmap-decoded', target: 1 },
  reward: { title: 'cartographer' } });
register({ id: 'expert-cartographer','name': 'Expert Cartographer',
  description: 'Decode 50 treasure maps.',
  trigger: { kind: 'tmap-decoded', target: 50 },
  reward: { title: 'expert-cartographer' } });
register({ id: 'lost-lands-traveler','name': 'Lost Lands Traveler',
  description: 'Visit Ilshenar.', trigger: { kind: 'visit-facet', facet: 2 },
  reward: { title: 'lost-lands-traveler' } });
register({ id: 'tokuno-traveler',   name: 'Tokuno Traveler',
  description: 'Visit Tokuno Islands.', trigger: { kind: 'visit-facet', facet: 5 },
  reward: { title: 'tokuno-traveler' } });

// =====================================================================
//  VIRTUE achievements
// =====================================================================
for (const v of ['honesty', 'compassion', 'valor', 'justice',
                  'sacrifice', 'honor', 'spirituality', 'humility']) {
  register({ id: `virtue-${v}`,  name: `Virtue: ${v[0].toUpperCase()+v.slice(1)}`,
    description: `Reach Knight rank in ${v}.`,
    trigger: { kind: 'virtue', virtue: v, threshold: 20000 },
    reward: { title: `virtuous-${v}` } });
}

// =====================================================================
//  COLLECTOR achievements
// =====================================================================
register({ id: 'pet-keeper',        name: 'Pet Keeper',
  description: 'Tame 10 pets.', trigger: { kind: 'tame-count', target: 10 },
  reward: { title: 'pet-keeper' } });
register({ id: 'master-tamer',      name: 'Master Tamer',
  description: 'Tame 100 pets.', trigger: { kind: 'tame-count', target: 100 },
  reward: { title: 'master-tamer' } });
register({ id: 'gold-hoarder',      name: 'Gold Hoarder',
  description: 'Carry 1,000,000 gold at once.',
  trigger: { kind: 'gold-snapshot', target: 1_000_000 },
  reward: { title: 'gold-hoarder' } });
register({ id: 'plutocrat',         name: 'Plutocrat',
  description: 'Carry 10,000,000 gold at once.',
  trigger: { kind: 'gold-snapshot', target: 10_000_000 },
  reward: { title: 'plutocrat' } });

// =====================================================================
//  COMBAT achievements (extended)
// =====================================================================
register({ id: 'paragon-slayer',    name: 'Paragon Slayer',
  description: 'Defeat 25 paragon-flagged creatures.',
  trigger: { kind: 'paragon-kill', target: 25 },
  reward: { title: 'paragon-slayer' } });
register({ id: 'pvp-rookie',        name: 'PvP Rookie',
  description: 'Defeat 10 player characters in PvP.',
  trigger: { kind: 'pvp-kill', target: 10 },
  reward: { title: 'pvp-rookie' } });
register({ id: 'pvp-veteran',       name: 'PvP Veteran',
  description: 'Defeat 100 player characters in PvP.',
  trigger: { kind: 'pvp-kill', target: 100 },
  reward: { title: 'pvp-veteran' } });
register({ id: 'champion-slayer',   name: 'Champion Slayer',
  description: 'Land the killing blow on a champion boss.',
  trigger: { kind: 'champion-kill', target: 1 },
  reward: { title: 'champion-slayer' } });

// =====================================================================
//  SKILL milestones (GM-tier per skill)
// =====================================================================
for (const skill of ['Magery', 'Swordsmanship', 'Tactics', 'Healing',
                     'Tailoring', 'Blacksmithy', 'AnimalTaming', 'Mining',
                     'Lumberjacking', 'Fishing']) {
  register({ id: `gm-${skill.toLowerCase()}`, name: `GM ${skill}`,
    description: `Reach 100.0 in ${skill}.`,
    trigger: { kind: 'skill-cap', skill, threshold: 1000 },
    reward: { title: `gm-${skill.toLowerCase()}` } });
}

// =====================================================================
//  EXPLORATION (extended facet sweep)
// =====================================================================
register({ id: 'malas-traveler',    name: 'Malas Traveler',
  description: 'Visit Malas.',
  trigger: { kind: 'visit-facet', facet: 3 },
  reward: { title: 'malas-traveler' } });
register({ id: 'termur-traveler',   name: 'Ter Mur Traveler',
  description: 'Visit Ter Mur (Stygian Abyss).',
  trigger: { kind: 'visit-facet', facet: 5 },
  reward: { title: 'termur-traveler' } });
register({ id: 'shrine-pilgrim',    name: 'Shrine Pilgrim',
  description: 'Visit all 8 virtue shrines.',
  trigger: { kind: 'shrine-count', target: 8 },
  reward: { title: 'shrine-pilgrim' } });

// =====================================================================
//  HOLIDAY / SEASONAL
// =====================================================================
register({ id: 'first-christmas',   name: 'Holiday Cheer',
  description: 'Receive your first Christmas gift.',
  trigger: { kind: 'xmas-claim', target: 1 },
  reward: { title: 'merry' } });
register({ id: 'trick-or-treater',  name: 'Trick or Treater',
  description: 'Trick or treat 25 different NPCs.',
  trigger: { kind: 'trick-treat-count', target: 25 },
  reward: { title: 'trick-or-treater' } });

// =====================================================================
//  WEALTH / TRADE
// =====================================================================
register({ id: 'first-vendor',      name: 'Shopkeeper',
  description: 'Open your first player vendor.',
  trigger: { kind: 'vendor-open', target: 1 },
  reward: { title: 'shopkeeper' } });
register({ id: 'auctioneer',        name: 'Auctioneer',
  description: 'Win 10 auction-house bids.',
  trigger: { kind: 'auction-win', target: 10 },
  reward: { title: 'auctioneer' } });

// =====================================================================
//  HOUSING
// =====================================================================
register({ id: 'first-house',       name: 'Homesteader',
  description: 'Place your first house.',
  trigger: { kind: 'house-place', target: 1 },
  reward: { title: 'homesteader' } });
register({ id: 'house-customizer',  name: 'Architect',
  description: 'Customise a house 25 times.',
  trigger: { kind: 'house-customize', target: 25 },
  reward: { title: 'architect' } });

// =====================================================================
//  FISHING / GATHERING
// =====================================================================
register({ id: 'first-rare-fish',   name: 'Fish Whisperer',
  description: 'Catch a Big Fish (rare).',
  trigger: { kind: 'rare-fish', target: 1 },
  reward: { title: 'fish-whisperer' } });
register({ id: 'master-fisherman',  name: 'Master Fisherman',
  description: 'Catch 1000 fish.',
  trigger: { kind: 'fish-count', target: 1000 },
  reward: { title: 'master-fisherman' } });
register({ id: 'master-miner',      name: 'Master Miner',
  description: 'Mine 10000 ore.',
  trigger: { kind: 'ore-count', target: 10_000 },
  reward: { title: 'master-miner' } });
register({ id: 'master-lumberjack', name: 'Master Lumberjack',
  description: 'Chop 10000 logs.',
  trigger: { kind: 'log-count', target: 10_000 },
  reward: { title: 'master-lumberjack' } });

// =====================================================================
//  MAGIC / SPELLCASTING
// =====================================================================
register({ id: 'first-cast',        name: 'Apprentice Mage',
  description: 'Cast your first spell.',
  trigger: { kind: 'spell-cast', target: 1 },
  reward: { title: 'apprentice-mage' } });
register({ id: 'spell-junkie',      name: 'Spell Junkie',
  description: 'Cast 10000 spells.',
  trigger: { kind: 'spell-cast', target: 10_000 },
  reward: { title: 'spell-junkie' } });
register({ id: 'necromancer',       name: 'Necromancer',
  description: 'Cast 1000 Necromancy spells.',
  trigger: { kind: 'necro-cast', target: 1000 },
  reward: { title: 'necromancer' } });
register({ id: 'paladin',           name: 'Paladin',
  description: 'Cast 1000 Chivalry spells.',
  trigger: { kind: 'chiv-cast', target: 1000 },
  reward: { title: 'paladin' } });
register({ id: 'spellweaver',       name: 'Spellweaver',
  description: 'Cast 500 Spellweaving spells in an Arcane Circle.',
  trigger: { kind: 'sw-cast', target: 500 },
  reward: { title: 'spellweaver' } });
register({ id: 'mystic',            name: 'Mystic',
  description: 'Cast 500 Mysticism spells.',
  trigger: { kind: 'mys-cast', target: 500 },
  reward: { title: 'mystic' } });

// =====================================================================
//  TITLE catalog (cosmetic display)
// =====================================================================
const TITLES = {
  'first-blood':           { display: 'the Bold' },
  'centurion':             { display: 'the Centurion' },
  'slayer-of-many':        { display: 'the Slayer of Many' },
  'dragonslayer':          { display: 'the Dragonslayer' },
  'liche-bane':            { display: 'the Liche-bane' },
  'demon-hunter':          { display: 'the Demon Hunter' },
  'apprentice-crafter':    { display: 'the Apprentice' },
  'master-crafter':        { display: 'the Master Crafter' },
  'exceptional-hands':     { display: 'the Exceptional' },
  'imbuer':                { display: 'the Imbuer' },
  'cartographer':          { display: 'the Cartographer' },
  'expert-cartographer':   { display: 'the Expert Cartographer' },
  'lost-lands-traveler':   { display: 'the Lost Lands Traveler' },
  'tokuno-traveler':       { display: 'the Tokuno Traveler' },
  'pet-keeper':            { display: 'the Pet Keeper' },
  'master-tamer':          { display: 'the Master Tamer' },
  'gold-hoarder':          { display: 'the Gold Hoarder' },
  'plutocrat':             { display: 'the Plutocrat' },
  'virtuous-honesty':      { display: 'the Honest' },
  'virtuous-compassion':   { display: 'the Compassionate' },
  'virtuous-valor':        { display: 'the Valorous' },
  'virtuous-justice':      { display: 'the Just' },
  'virtuous-sacrifice':    { display: 'the Sacrificing' },
  'virtuous-honor':        { display: 'the Honorable' },
  'virtuous-spirituality': { display: 'the Spiritual' },
  'virtuous-humility':     { display: 'the Humble' },
  // Combat extras
  'paragon-slayer':        { display: 'the Paragon Slayer' },
  'pvp-rookie':            { display: 'the Duellist' },
  'pvp-veteran':           { display: 'the Bloody-Handed' },
  'champion-slayer':       { display: 'the Champion Slayer' },
  // GM skill titles
  'gm-magery':             { display: 'the Grandmaster Mage' },
  'gm-swordsmanship':      { display: 'the Grandmaster Sword' },
  'gm-tactics':            { display: 'the Tactician' },
  'gm-healing':            { display: 'the Healer' },
  'gm-tailoring':          { display: 'the Master Tailor' },
  'gm-blacksmithy':        { display: 'the Master Smith' },
  'gm-animaltaming':       { display: 'the Beastmaster' },
  'gm-mining':             { display: 'the Master Miner' },
  'gm-lumberjacking':      { display: 'the Master Woodworker' },
  'gm-fishing':            { display: 'the Master Fisherman' },
  // Exploration extras
  'malas-traveler':        { display: 'the Malas Traveler' },
  'termur-traveler':       { display: 'the Ter Mur Traveler' },
  'shrine-pilgrim':        { display: 'the Pilgrim' },
  // Seasonal
  'merry':                 { display: 'the Merry' },
  'trick-or-treater':      { display: 'the Trick-or-Treater' },
  // Trade
  'shopkeeper':            { display: 'the Shopkeeper' },
  'auctioneer':            { display: 'the Auctioneer' },
  // Housing
  'homesteader':           { display: 'the Homesteader' },
  'architect':             { display: 'the Architect' },
  // Gathering
  'fish-whisperer':        { display: 'the Fish Whisperer' },
  'master-fisherman':      { display: 'the Master Fisherman' },
  'master-miner':          { display: 'the Master Miner' },
  'master-lumberjack':     { display: 'the Master Lumberjack' },
  // Magic
  'apprentice-mage':       { display: 'the Apprentice Mage' },
  'spell-junkie':          { display: 'the Spell-Junkie' },
  'necromancer':           { display: 'the Necromancer' },
  'paladin':               { display: 'the Paladin' },
  'spellweaver':           { display: 'the Spellweaver' },
  'mystic':                { display: 'the Mystic' },
};

// =====================================================================
//  API
// =====================================================================

function ensure(account) {
  account.achievements ??= { unlocked: new Set(), progress: {} };
  account.titles       ??= { active: null, unlocked: new Set() };
  if (Array.isArray(account.achievements.unlocked)) {
    account.achievements.unlocked = new Set(account.achievements.unlocked);
  }
  if (Array.isArray(account.titles.unlocked)) {
    account.titles.unlocked = new Set(account.titles.unlocked);
  }
}

/** Map from progress-counter key → expected trigger kind. Centralised
 *  so we don't fan out into a ladder of `if` branches every time we
 *  add a new counter category. */
const PROGRESS_KIND_MAP = {
  kills:           'kill-count',
  crafts:          'craft-count',
  imbues:          'imbue-count',
  tmaps:           'tmap-decoded',
  tames:           'tame-count',
  exceptionals:    'exceptional-craft',
  // New counters wired by the achievement-extension batch.
  'paragon-kills': 'paragon-kill',
  'pvp-kills':     'pvp-kill',
  'champion-kills':'champion-kill',
  'xmas-claims':   'xmas-claim',
  'trick-treats':  'trick-treat-count',
  vendors:         'vendor-open',
  'auction-wins':  'auction-win',
  'house-places':  'house-place',
  'house-customizes': 'house-customize',
  'rare-fish':     'rare-fish',
  'fish':          'fish-count',
  'ore':           'ore-count',
  'logs':          'log-count',
  spells:          'spell-cast',
  'necro-casts':   'necro-cast',
  'chiv-casts':    'chiv-cast',
  'sw-casts':      'sw-cast',
  'mys-casts':     'mys-cast',
};

/** Bump a per-key counter; auto-unlock matching achievements. */
export function progress(account, key, amount = 1) {
  if (!account) return [];
  ensure(account);
  account.achievements.progress[key] = (account.achievements.progress[key] | 0) + amount;
  const newUnlocks = [];
  const expectedKind = PROGRESS_KIND_MAP[key];
  if (!expectedKind) return newUnlocks;
  for (const a of _achievements.values()) {
    if (a.trigger.kind !== expectedKind) continue;
    if (account.achievements.progress[key] >= a.trigger.target) {
      newUnlocks.push(...unlock(account, a.id));
    }
  }
  return newUnlocks;
}

/** Trigger a kill-kind / visit-facet / virtue / gold / skill check. */
export function trigger(account, kind, payload = {}) {
  if (!account) return [];
  ensure(account);
  const newUnlocks = [];
  for (const a of _achievements.values()) {
    const t = a.trigger;
    if (t.kind !== kind) continue;
    if (kind === 'kill-kind'   && payload.kind !== t.mobKind) continue;
    if (kind === 'visit-facet' && payload.facet !== t.facet) continue;
    if (kind === 'virtue'      && (payload.virtue !== t.virtue || (payload.amount | 0) < t.threshold)) continue;
    if (kind === 'gold-snapshot' && (payload.amount | 0) < t.target) continue;
    // Skill-cap unlock: payload `{ skill: 'Magery', value: 1000 }`.
    // Threshold is base-100 ×10 (1000 = 100.0 skill), mirroring the
    // server's internal skill storage where 1 unit = 0.1 skill point.
    if (kind === 'skill-cap'   && (payload.skill !== t.skill || (payload.value | 0) < t.threshold)) continue;
    // Shrine-count: each shrine visit fires once; we count via a
    // dedicated Set on the account so revisits don't double-count.
    if (kind === 'shrine-count') {
      account.achievements.progress._shrinesVisited ??= new Set();
      if (payload.shrine) account.achievements.progress._shrinesVisited.add(payload.shrine);
      if ((account.achievements.progress._shrinesVisited.size | 0) < t.target) continue;
    }
    newUnlocks.push(...unlock(account, a.id));
  }
  return newUnlocks;
}

/** Mark an achievement complete + apply reward. Returns array of grants
 *  (one entry per fresh unlock). */
export function unlock(account, achievementId) {
  if (!account) return [];
  ensure(account);
  if (account.achievements.unlocked.has(achievementId)) return [];
  const a = _achievements.get(achievementId);
  if (!a) return [];
  account.achievements.unlocked.add(achievementId);
  const out = [{ achievement: a }];
  if (a.reward?.title) {
    account.titles.unlocked.add(a.reward.title);
    out[0].grantedTitle = a.reward.title;
  }
  return out;
}

export function setActiveTitle(account, titleId) {
  ensure(account);
  if (titleId && !account.titles.unlocked.has(titleId)) return false;
  account.titles.active = titleId || null;
  return true;
}

export function activeTitleDisplay(account) {
  if (!account?.titles?.active) return null;
  return TITLES[account.titles.active]?.display ?? null;
}

export function listAchievements()      { return [..._achievements.values()]; }
export function listTitles()            { return Object.entries(TITLES).map(([id, t]) => ({ id, ...t })); }
export function isUnlocked(account, id) { return !!account?.achievements?.unlocked?.has?.(id); }

export const ACHIEVEMENTS_CONST = Object.freeze({ TITLES });
